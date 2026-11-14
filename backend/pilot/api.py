"""Authenticated pilot API: practice setup/membership, practice rules, and referral intake.

Every route derives the account from the verified Supabase bearer token, then
resolves the account's own practice membership server-side. No route accepts a
user id, practice id, owner-scope id, or role from the client.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Annotated
from urllib.parse import quote

from fastapi import APIRouter, Depends, Header, HTTPException, Request, Response
from pydantic import BaseModel, ConfigDict, Field

from backend.auth import AuthenticatedUser, require_authenticated_user

from .assistant import AssistantService, history_days
from .documents import MAX_DOCUMENT_BYTES
from .home import HomeService
from .intake import IntakeService
from .learning import LearningService
from .messaging import MailSender, mail_sender_from_environment
from .metrics import practice_metrics, weekly_summary
from .missing_info import MissingInformationService, SenderService
from .models import (
    DispositionInput,
    IntakeReferralInput,
    InvitationInput,
    PracticeInput,
    PracticeRuleInput,
    ReasonInput,
    RecordItemInput,
    ReferralTypeInput,
    RequestInformationInput,
    TriageEditInput,
    VerifyItemInput,
)
from .practice import PilotError, PracticeContext, PracticeService
from .publication import PublicationService
from .rules import PracticeRules, RuleConflictError, RuleNotFoundError
from .store import PilotStore, pilot_store_for
from .teaching import TeachingService

router = APIRouter(prefix="/api/me/practice", tags=["pilot-practice"])
internal_router = APIRouter(prefix="/api/internal/pilot-metrics", tags=["pilot-admin"])
RequiredUser = Annotated[AuthenticatedUser, Depends(require_authenticated_user)]


@dataclass
class PilotServices:
    store: PilotStore
    practice: PracticeService
    rules: PracticeRules
    intake: IntakeService
    missing: MissingInformationService
    sender: SenderService
    teaching: TeachingService
    learning: LearningService
    publication: PublicationService
    home: HomeService
    assistant: AssistantService

    @classmethod
    def build(
        cls, store: PilotStore, intake: IntakeService | None = None, mailer: MailSender | None = None,
        teaching_client: object | None = None, assistant_client: object | None = None,
    ) -> PilotServices:
        intake = intake or IntakeService(store)
        rules = PracticeRules(store)
        missing = MissingInformationService(store, intake, mailer or mail_sender_from_environment(store))
        sender = SenderService(store, intake, missing)
        teaching = TeachingService(rules, teaching_client)
        learning = LearningService(store, rules, teaching)
        publication = PublicationService(store, rules)
        home = HomeService(store, intake, missing, rules, learning)
        assistant = AssistantService(store, intake, missing, rules, teaching, home, assistant_client)
        # Wire the workflow: drafts go through the persistent request entity; every
        # re-triage reconciles open requests; human corrections feed pattern detection.
        intake.request_projection = missing
        intake.after_triage.append(lambda context, referral_id, recommendation:
                                   missing.reconcile(context.practice_id, referral_id, recommendation))
        intake.after_decision.append(learning.on_decision)
        intake.detail_extensions.append(lambda context, referral_id: {
            "information_requests": missing.for_referral(context.practice_id, referral_id),
            "sender_responses": sender.responses(context.practice_id, referral_id),
        })
        return cls(store, PracticeService(store), rules, intake, missing, sender, teaching, learning,
                   publication, home, assistant)


_default: dict[str, PilotServices] = {}


def get_pilot_services() -> PilotServices:
    """Bound to the same workflow database as physician onboarding, so owner scopes,
    claims, and pilot rows always live in one store."""
    from backend.api import physician_onboarding

    store = pilot_store_for(physician_onboarding.onboarding_service.store)
    key = str(store.path)
    if key not in _default or _default[key].store is not store:
        _default[key] = PilotServices.build(store)
    return _default[key]


Services = Annotated[PilotServices, Depends(get_pilot_services)]


def _run(action):
    try:
        return action()
    except PilotError as error:
        raise HTTPException(error.status_code, {"code": error.code, "message": error.message}) from error
    except RuleNotFoundError as error:
        raise HTTPException(404, {"code": "rule_not_found", "message": "Rule not found"}) from error
    except RuleConflictError as error:
        raise HTTPException(409, {"code": "rule_conflict", "message": str(error)}) from error


def require_practice(user: RequiredUser, services: Services) -> PracticeContext:
    """The one guard for every practice-scoped pilot route."""
    return _run(lambda: services.practice.context(user.id))


Practice = Annotated[PracticeContext, Depends(require_practice)]


class _Strict(BaseModel):
    model_config = ConfigDict(extra="forbid")


class TokenInput(_Strict):
    token: str = Field(min_length=10, max_length=200)


class NoteInput(_Strict):
    note: str | None = Field(default=None, max_length=2000)


# ---------------------------------------------------------------- practice


@router.get("/status")
def practice_status(user: RequiredUser, services: Services) -> dict:
    from backend.api import physician_onboarding

    onboarding = physician_onboarding._run(
        lambda: physician_onboarding.onboarding_service.status(user.id)
    )
    return _run(lambda: services.practice.status(user.id, onboarding))


@router.post("", status_code=201)
def create_practice(update: PracticeInput, user: RequiredUser, services: Services) -> dict:
    return _run(lambda: services.practice._practice_view(
        services.practice.create_practice(user.id, update.model_dump())
    ))


@router.put("")
def update_practice(update: PracticeInput, context: Practice, services: Services) -> dict:
    return _run(lambda: services.practice.update_practice(context, update.model_dump()))


@router.get("/members")
def members(context: Practice, services: Services) -> dict:
    return services.practice.members_view(context)


@router.post("/invitations", status_code=201)
def invite(update: InvitationInput, context: Practice, services: Services) -> dict:
    return _run(lambda: services.practice.invite(context, update.role, update.label))


@router.delete("/invitations/{invitation_id}", status_code=204)
def revoke_invitation(invitation_id: str, context: Practice, services: Services) -> Response:
    _run(lambda: services.practice.revoke_invitation(context, invitation_id))
    return Response(status_code=204)


@router.delete("/members/{member_id}", status_code=204)
def remove_member(member_id: str, context: Practice, services: Services) -> Response:
    _run(lambda: services.practice.remove_member(context, member_id))
    return Response(status_code=204)


@router.post("/invitations/preview")
def preview_invitation(update: TokenInput, user: RequiredUser, services: Services) -> dict:
    del user  # Signed-in only, so practice names are not enumerable anonymously.
    return _run(lambda: services.practice.preview_invitation(update.token))


@router.post("/invitations/accept")
def accept_invitation(update: TokenInput, user: RequiredUser, services: Services) -> dict:
    _run(lambda: services.practice.accept_invitation(user.id, update.token))
    return practice_status(user, services)


# ------------------------------------------------------------------- rules


@router.get("/rules")
def list_rules(context: Practice, services: Services, include_history: bool = False) -> list[dict]:
    return [
        rule.model_dump(mode="json")
        for rule in services.rules.list(context.practice_id, include_history=include_history)
    ]


def _physician_key(context: PracticeContext, services: PilotServices) -> str:
    scope = services.store.workflow.physician_owner_scope(context.owner_scope_id or "")
    return (scope or {}).get("physician_id") or context.owner_scope_id or "practice"


@router.post("/rules", status_code=201)
def create_rule(update: PracticeRuleInput, context: Practice, services: Services) -> dict:
    _run(lambda: context.require_physician("change practice rules"))
    return _run(lambda: services.rules.create(
        context.practice_id, _physician_key(context, services), update, actor=context.actor
    ).model_dump(mode="json"))


@router.put("/rules/{rule_id}")
def revise_rule(rule_id: str, update: PracticeRuleInput, context: Practice, services: Services) -> dict:
    _run(lambda: context.require_physician("change practice rules"))
    return _run(lambda: services.rules.revise(
        context.practice_id, rule_id, _physician_key(context, services), update, actor=context.actor
    ).model_dump(mode="json"))


@router.post("/rules/{rule_id}/retire")
def retire_rule(rule_id: str, context: Practice, services: Services) -> dict:
    _run(lambda: context.require_physician("change practice rules"))
    return _run(lambda: services.rules.retire(
        context.practice_id, rule_id, actor=context.actor
    ).model_dump(mode="json"))


@router.get("/rules/{rule_id}/history")
def rule_history(rule_id: str, context: Practice, services: Services) -> list[dict]:
    return _run(lambda: [
        rule.model_dump(mode="json") for rule in services.rules.history(context.practice_id, rule_id)
    ])


# --------------------------------------------------------------- referrals


@router.get("/referrals")
def list_referrals(context: Practice, services: Services) -> list[dict]:
    return services.intake.list(context)


@router.post("/referrals", status_code=201)
def create_referral(update: IntakeReferralInput, context: Practice, services: Services) -> dict:
    return _run(lambda: services.intake.create(context, update))


@router.get("/referrals/{referral_id}")
def referral_detail(referral_id: str, context: Practice, services: Services) -> dict:
    return _run(lambda: services.intake.detail(context, referral_id))


@router.post("/referrals/{referral_id}/documents", status_code=201)
async def upload_document(
    referral_id: str,
    request: Request,
    context: Practice,
    services: Services,
    content_type: Annotated[str, Header()] = "application/octet-stream",
    x_filename: Annotated[str | None, Header()] = None,
) -> dict:
    """Raw-body upload (no multipart dependency). The body is size-capped while read."""
    declared = request.headers.get("content-length")
    if declared and declared.isdigit() and int(declared) > MAX_DOCUMENT_BYTES:
        raise HTTPException(413, {"code": "document_too_large", "message": "Files must be 15 MB or smaller"})
    chunks, size = [], 0
    async for chunk in request.stream():
        size += len(chunk)
        if size > MAX_DOCUMENT_BYTES:
            raise HTTPException(413, {"code": "document_too_large", "message": "Files must be 15 MB or smaller"})
        chunks.append(chunk)
    filename = None
    if x_filename:
        from urllib.parse import unquote

        filename = unquote(x_filename)
    return _run(lambda: services.intake.add_document(
        context, referral_id, content=b"".join(chunks), content_type=content_type, filename=filename,
    ))


@router.get("/documents/{document_id}")
def download_document(document_id: str, context: Practice, services: Services) -> Response:
    row, content = _run(lambda: services.intake.document_content(context, document_id))
    return Response(
        content=content,
        media_type=row["content_type"],
        headers={
            "Content-Disposition": f"attachment; filename*=UTF-8''{quote(row['filename'])}",
            "Cache-Control": "no-store, private",
            "X-Content-Type-Options": "nosniff",
            "Content-Security-Policy": "default-src 'none'; sandbox",
        },
    )


@router.post("/referrals/{referral_id}/triage")
def retriage(referral_id: str, context: Practice, services: Services) -> dict:
    return _run(lambda: services.intake.run_triage(context, referral_id))


@router.post("/referrals/{referral_id}/approve")
def approve(referral_id: str, context: Practice, services: Services) -> dict:
    return _run(lambda: services.intake.approve(context, referral_id))


@router.post("/referrals/{referral_id}/edit")
def edit(referral_id: str, update: TriageEditInput, context: Practice, services: Services) -> dict:
    return _run(lambda: services.intake.edit(context, referral_id, update))


@router.post("/referrals/{referral_id}/reject")
def reject(referral_id: str, update: ReasonInput, context: Practice, services: Services) -> dict:
    return _run(lambda: services.intake.reject(context, referral_id, update.reason))


@router.post("/referrals/{referral_id}/request-information")
def request_information(
    referral_id: str, update: RequestInformationInput, context: Practice, services: Services
) -> dict:
    return _run(lambda: services.intake.request_information(context, referral_id, update))


@router.post("/referrals/{referral_id}/escalate")
def escalate(referral_id: str, update: NoteInput, context: Practice, services: Services) -> dict:
    return _run(lambda: services.intake.escalate(context, referral_id, update.note))


@router.post("/referrals/{referral_id}/items")
def record_item(referral_id: str, update: RecordItemInput, context: Practice, services: Services) -> dict:
    return _run(lambda: services.intake.record_item(context, referral_id, update))


@router.post("/referrals/{referral_id}/items/{item_key}/verify")
def verify_item(
    referral_id: str, item_key: str, update: VerifyItemInput, context: Practice, services: Services
) -> dict:
    """A practice member confirms a value the referring office supplied (staff or physician)."""
    return _run(lambda: services.intake.verify_item(context, referral_id, item_key, update.note))


@router.post("/referrals/{referral_id}/referral-type")
def set_referral_type(
    referral_id: str, update: ReferralTypeInput, context: Practice, services: Services
) -> dict:
    """Confirm which of the practice's referral types this is; the submitted wording is kept."""
    return _run(lambda: services.intake.set_referral_type(context, referral_id, update.referral_type))


@router.post("/referrals/{referral_id}/disposition")
def disposition(
    referral_id: str, update: DispositionInput, context: Practice, services: Services
) -> dict:
    return _run(lambda: services.intake.dispose(context, referral_id, update))


# ------------------------------------------------------------------ events


@router.get("/events")
def practice_events(
    context: Practice, services: Services, event_type: str | None = None,
    referral_id: str | None = None,
) -> list[dict]:
    """Queryable append-only pilot log for this practice (physician only)."""
    _run(lambda: context.require_physician("view the practice activity log"))
    return [
        {key: event[key] for key in (
            "id", "event_type", "referral_id", "actor", "autonomy", "metadata", "created_at"
        )}
        for event in services.store.events(
            practice_id=context.practice_id, event_type=event_type, referral_id=referral_id
        )
    ]


# ----------------------------------------------------- missing information


class RequestEditInput(_Strict):
    message: str | None = Field(default=None, max_length=6000)
    recipient: str | None = Field(default=None, max_length=200)
    subject: str | None = Field(default=None, max_length=200)


class SendInput(_Strict):
    mode: str = Field(pattern=r"^(send|mark_sent)$")


@router.put("/information-requests/{request_id}")
def edit_information_request(
    request_id: str, update: RequestEditInput, context: Practice, services: Services
) -> dict:
    return _run(lambda: services.missing.edit_draft(
        context, request_id, message=update.message, recipient=update.recipient, subject=update.subject))


@router.post("/information-requests/{request_id}/send")
def send_information_request(
    request_id: str, update: SendInput, context: Practice, services: Services
) -> dict:
    return _run(lambda: services.missing.approve_and_send(context, request_id, update.mode))


@router.post("/information-requests/{request_id}/reissue-link")
def reissue_information_request_link(
    request_id: str, update: SendInput, context: Practice, services: Services
) -> dict:
    return _run(lambda: services.missing.reissue_link(context, request_id, update.mode))


@router.post("/information-requests/{request_id}/cancel")
def cancel_information_request(request_id: str, context: Practice, services: Services) -> dict:
    return _run(lambda: services.missing.cancel(context, request_id))


@router.post("/information-requests/{request_id}/resolve")
def resolve_information_request(request_id: str, context: Practice, services: Services) -> dict:
    return _run(lambda: services.missing.mark_resolved(context, request_id))


# -------------------------------------------------------------------- home


@router.get("/home")
def home(context: Practice, services: Services) -> dict:
    return services.home.projection(context)


# --------------------------------------------------------------- assistant


class AssistantInput(_Strict):
    text: str = Field(min_length=1, max_length=2000)
    # Optional page context ("this patient"). Resolved only against the caller's own
    # practice; an id from another practice is simply ignored.
    referral_id: str | None = Field(default=None, max_length=80)


@router.get("/assistant")
def assistant_history(context: Practice, services: Services) -> dict:
    """The signed-in user's own conversation in this practice (never another member's)."""
    return {"messages": services.assistant.history(context), "retention_days": history_days(),
            "model_available": services.assistant.model() is not None}


@router.post("/assistant/messages", status_code=201)
def assistant_message(update: AssistantInput, context: Practice, services: Services) -> dict:
    return _run(lambda: services.assistant.respond(context, update.text, update.referral_id))


@router.delete("/assistant/history", status_code=204)
def clear_assistant_history(context: Practice, services: Services) -> Response:
    services.assistant.clear(context)
    return Response(status_code=204)


# ---------------------------------------------------------------- teaching


class TeachInput(_Strict):
    text: str = Field(min_length=3, max_length=2000)


class ClarifyInput(_Strict):
    answer: str = Field(min_length=1, max_length=200)


class ConfirmInput(_Strict):
    edits: PracticeRuleInput | None = None


class AnswerInput(_Strict):
    answer: str = Field(pattern=r"^(yes|edit|depends|ignore)$")
    note: str | None = Field(default=None, max_length=1000)
    edits: PracticeRuleInput | None = None


@router.get("/teach")
def list_proposals(context: Practice, services: Services) -> dict:
    question = None
    if context.role == "physician":
        question = services.learning.question_for_today(context.practice_id, mark_shown=False)
    return {
        "proposals": [services.teaching.view(rule) for rule in services.rules.proposals(context.practice_id)],
        "question": question,
        "referral_types": services.rules.referral_types(context.practice_id),
    }


@router.post("/teach", status_code=201)
def teach(update: TeachInput, context: Practice, services: Services) -> dict:
    return _run(lambda: services.teaching.propose(context, update.text))


@router.post("/teach/{proposal_id}/clarify")
def clarify(proposal_id: str, update: ClarifyInput, context: Practice, services: Services) -> dict:
    return _run(lambda: services.teaching.clarify(context, proposal_id, update.answer))


@router.post("/teach/{proposal_id}/confirm")
def confirm_proposal(proposal_id: str, update: ConfirmInput, context: Practice, services: Services) -> dict:
    return _run(lambda: services.teaching.confirm(context, proposal_id, update.edits))


@router.post("/teach/{proposal_id}/reject")
def reject_proposal(proposal_id: str, update: ReasonInput, context: Practice, services: Services) -> dict:
    return _run(lambda: services.teaching.reject(context, proposal_id, update.reason))


@router.post("/learning/questions/{question_id}/answer")
def answer_learning_question(
    question_id: str, update: AnswerInput, context: Practice, services: Services
) -> dict:
    return _run(lambda: services.learning.answer(context, question_id, update.answer, update.note, update.edits))


# ---------------------------------------------------------- public profile


class PublicSettingsInput(_Strict):
    slug: str | None = Field(default=None, max_length=60)
    intro: str | None = Field(default=None, max_length=600)
    insurance: str | None = Field(default=None, max_length=800)
    how_to_refer: str | None = Field(default=None, max_length=800)
    hours: str | None = Field(default=None, max_length=300)
    locations: list[str] | None = Field(default=None, max_length=5)
    show_physicians: bool | None = None
    accepts_public_referrals: bool | None = None


class PublishableInput(_Strict):
    publishable: bool


@router.get("/public-profile")
def public_profile_preview(context: Practice, services: Services) -> dict:
    return _run(lambda: services.publication.preview(context))


@router.put("/public-profile")
def public_profile_settings(update: PublicSettingsInput, context: Practice, services: Services) -> dict:
    settings = update.model_dump(exclude_none=True, exclude={"slug"})
    return _run(lambda: services.publication.update_settings(context, update.slug, settings))


@router.post("/public-profile/publish")
def public_profile_publish(context: Practice, services: Services) -> dict:
    return _run(lambda: services.publication.publish(context))


@router.post("/public-profile/unpublish")
def public_profile_unpublish(context: Practice, services: Services) -> dict:
    return _run(lambda: services.publication.unpublish(context))


@router.put("/rules/{rule_id}/publishable")
def rule_publishable(rule_id: str, update: PublishableInput, context: Practice, services: Services) -> dict:
    _run(lambda: context.require_physician("change what is published"))
    return _run(lambda: services.rules.set_publishable(
        context.practice_id, rule_id, update.publishable, actor=context.actor).model_dump(mode="json"))


# ----------------------------------------------------------------- metrics


@router.get("/metrics")
def metrics(context: Practice, services: Services) -> dict:
    _run(lambda: context.require_physician("view pilot metrics"))
    return {"all_time": practice_metrics(services.store, context.practice_id),
            "weekly": weekly_summary(services.store, context.practice_id)}


def _require_admin(user: RequiredUser) -> AuthenticatedUser:
    from backend.api.physician_onboarding import pilot_admin_user_ids

    if user.id not in pilot_admin_user_ids():
        raise HTTPException(404, "Not Found")
    return user


@internal_router.get("")
def internal_metrics(
    admin: Annotated[AuthenticatedUser, Depends(_require_admin)], services: Services
) -> list[dict]:
    del admin
    return [
        {"practice_id": practice["id"], "practice_name": practice["name"],
         "weekly": weekly_summary(services.store, practice["id"]),
         "all_time": practice_metrics(services.store, practice["id"])}
        for practice in services.store.fetch_all("SELECT id, name FROM practices ORDER BY created_at")
    ]
