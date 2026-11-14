"""Unauthenticated public routes: published practice profile + bounded agent, public
referral submission, and the sender status/upload link.

These routes can read only: published snapshots (`public_snapshot`), and — through a
valid sender token — the sender-safe view in `SenderService`. They never accept or
return internal ids beyond the opaque slug/token, never expose rules or triage, and
are rate limited per client.
"""

from __future__ import annotations

import hashlib
from collections import defaultdict, deque
from threading import Lock
from time import monotonic
from typing import Annotated
from urllib.parse import unquote

from fastapi import APIRouter, Header, HTTPException, Request, Response
from pydantic import BaseModel, ConfigDict, Field

from backend.config import environment

from .api import PilotServices, Services, _run
from .documents import MAX_DOCUMENT_BYTES
from .models import IntakePatient, IntakeReferralInput, ReferralSender
from .practice import PilotError, PracticeContext
from .public_agent import answer_question
from .publication import public_snapshot

router = APIRouter(prefix="/api/public", tags=["pilot-public"])


class RateLimiter:
    """In-process sliding window. A multi-worker deployment needs shared storage."""

    def __init__(self) -> None:
        self._hits: dict[str, deque[float]] = defaultdict(deque)
        self._lock = Lock()

    def check(self, key: str, limit: int, window_seconds: float) -> None:
        now = monotonic()
        with self._lock:
            hits = self._hits[key]
            while hits and now - hits[0] >= window_seconds:
                hits.popleft()
            if len(hits) >= limit:
                raise HTTPException(429, {"code": "rate_limited", "message": "Too many requests. Please wait a few minutes and try again"})
            hits.append(now)

    def reset(self) -> None:
        with self._lock:
            self._hits.clear()


limiter = RateLimiter()
LIMITS = {"view": (120, 600), "ask": (20, 600), "submit": (5, 3600), "sender_view": (60, 600),
          "sender_upload": (20, 3600), "sender_respond": (10, 3600), "started": (30, 600)}


def _client(request: Request) -> str:
    host = request.client.host if request.client else "unknown"
    if environment.get("LAMINA_TRUST_PROXY", "false").casefold() == "true":
        forwarded = request.headers.get("x-forwarded-for", "").split(",")[0].strip()
        host = forwarded or host
    return hashlib.sha256(host.encode()).hexdigest()[:16]


def _limit(request: Request, bucket: str, scope: str = "") -> None:
    limit, window = LIMITS[bucket]
    limiter.check(f"{bucket}:{scope}:{_client(request)}", limit, window)


class _Strict(BaseModel):
    model_config = ConfigDict(extra="forbid")


class AskInput(_Strict):
    question: str = Field(min_length=2, max_length=500)
    referral_context: str | None = Field(default=None, max_length=1500)


class PublicReferralInput(_Strict):
    sender: ReferralSender
    patient: IntakePatient
    referral_type: str = Field(min_length=1, max_length=120)
    reason: str = Field(min_length=3, max_length=4000)
    clinical_context: str | None = Field(default=None, max_length=8000)
    sender_priority: str | None = Field(default=None, pattern=r"^(routine|soon|urgent)$")
    # Honeypot: humans never fill this hidden field.
    website: str | None = Field(default=None, max_length=200)


class SenderItem(_Strict):
    key: str = Field(min_length=1, max_length=100)
    value: str = Field(min_length=1, max_length=1000)
    observed_date: str | None = Field(default=None, pattern=r"^\d{4}-\d{2}-\d{2}$")


class SenderResponseInput(_Strict):
    message: str | None = Field(default=None, max_length=4000)
    items: list[SenderItem] = Field(default_factory=list, max_length=20)


def _published(services: PilotServices, slug: str) -> tuple[dict, dict]:
    found = public_snapshot(services.store, slug)
    if not found:
        raise HTTPException(404, {"code": "profile_not_found", "message": "This practice page isn’t available"})
    return found


def _event(services: PilotServices, meta: dict, event_type: str, metadata: dict | None = None,
           referral_id: str | None = None) -> None:
    services.store.append_event(event_type, actor="public:anonymous", autonomy="human",
                                practice_id=meta["practice_id"], referral_id=referral_id,
                                metadata={"snapshot_version": meta["version"], **(metadata or {})})


# ------------------------------------------------------------------ profile


@router.get("/p/{slug}")
def public_profile(slug: str, request: Request, services: Services) -> dict:
    _limit(request, "view", slug)
    snapshot, meta = _published(services, slug)
    _event(services, meta, "public_page_viewed")
    return {"slug": meta["slug"], "version": meta["version"], "profile": snapshot}


@router.post("/p/{slug}/ask")
def public_ask(slug: str, update: AskInput, request: Request, services: Services) -> dict:
    _limit(request, "ask", slug)
    snapshot, meta = _published(services, slug)
    answer = answer_question(snapshot, update.question, update.referral_context)
    # Question text may contain PHI: log only its category and size, never its content.
    _event(services, meta, "public_agent_question",
           {"category": answer["category"], "generator": answer["generator"],
            "question_chars": len(update.question), "has_referral_context": bool(update.referral_context)})
    if not answer["in_scope"]:
        _event(services, meta, "public_agent_out_of_scope", {"category": answer["category"]})
    return {"answer": answer["answer"], "category": answer["category"], "in_scope": answer["in_scope"],
            "suggest_referral": bool(answer.get("suggest_referral")), "fit": answer.get("fit"),
            "disclaimer": "Answers come only from this practice’s published referral information. Not medical advice."}


@router.post("/p/{slug}/referral-started", status_code=204)
def public_referral_started(slug: str, request: Request, services: Services) -> None:
    _limit(request, "started", slug)
    _, meta = _published(services, slug)
    _event(services, meta, "public_agent_referral_started")


@router.post("/p/{slug}/referrals", status_code=201)
def public_submit(slug: str, update: PublicReferralInput, request: Request, services: Services) -> dict:
    _limit(request, "submit", slug)
    snapshot, meta = _published(services, slug)
    if not snapshot.get("accepts_public_referrals", True):
        raise HTTPException(409, {"code": "public_referrals_closed", "message": "This practice isn’t accepting referrals online"})
    if update.website:
        # Honeypot tripped: accept silently without creating anything.
        return {"status_url": None, "token": None, "received": True}
    practice = services.store.practice(meta["practice_id"])
    if not practice or not services.practice.practice_approved(practice["id"]):
        raise HTTPException(404, {"code": "profile_not_found", "message": "This practice page isn’t available"})
    context = PracticeContext(user_id="public-form", practice=practice, member={}, role="sender",
                              owner_scope_id=None, actor_label="public:form")
    referral_input = IntakeReferralInput(
        source="manual", sender=update.sender, patient=update.patient, referral_type=update.referral_type,
        reason=update.reason, clinical_context=update.clinical_context, sender_priority=update.sender_priority,
    )
    detail = _run(lambda: services.intake.create(context, referral_input, source="public_form"))
    referral_id = detail["referral"]["id"]
    _, token = services.missing.links.issue(practice["id"], referral_id, "submission")
    _event(services, meta, "public_referral_submitted", {"referral_type": update.referral_type}, referral_id)
    return {"received": True, "token": token, "status_url": services.missing.links.url(token),
            "practice_name": practice["name"]}


# ------------------------------------------------------------------- sender


def _sender_errors(action):
    try:
        return action()
    except PilotError as error:
        if error.code in {"referral_not_found", "link_unavailable"}:
            raise HTTPException(404, {"code": "link_unavailable",
                                      "message": "This link is invalid or has expired. Contact the practice for a new one"}) from error
        raise HTTPException(error.status_code, {"code": error.code, "message": error.message}) from error


# Sender-link responses must not be cached by intermediaries, and the token-bearing page
# URL must not leak to other sites through the Referer header.
_SENDER_HEADERS = {"Cache-Control": "no-store, private", "Referrer-Policy": "no-referrer"}


def _sender_headers(response: Response) -> None:
    response.headers.update(_SENDER_HEADERS)


@router.get("/r/{token}")
def sender_status(token: str, request: Request, response: Response, services: Services) -> dict:
    _sender_headers(response)
    _limit(request, "sender_view")
    return _sender_errors(lambda: services.sender.view(token))


@router.post("/r/{token}/documents", status_code=201)
async def sender_upload(
    token: str, request: Request, response: Response, services: Services,
    content_type: Annotated[str, Header()] = "application/octet-stream",
    x_filename: Annotated[str | None, Header()] = None,
) -> dict:
    _sender_headers(response)
    _limit(request, "sender_upload")
    chunks, size = [], 0
    async for chunk in request.stream():
        size += len(chunk)
        if size > MAX_DOCUMENT_BYTES:
            raise HTTPException(413, {"code": "document_too_large", "message": "Files must be 15 MB or smaller"})
        chunks.append(chunk)
    return _sender_errors(lambda: services.sender.upload(
        token, content=b"".join(chunks), content_type=content_type,
        filename=unquote(x_filename) if x_filename else None))


@router.post("/r/{token}/response")
def sender_response(
    token: str, update: SenderResponseInput, request: Request, response: Response, services: Services,
) -> dict:
    _sender_headers(response)
    _limit(request, "sender_respond")
    return _sender_errors(lambda: services.sender.respond(
        token, update.message, [item.model_dump() for item in update.items]))

