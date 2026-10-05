from __future__ import annotations

import secrets
from typing import Annotated, Any, Literal

from fastapi import APIRouter, Depends, HTTPException, Query, Request
from pydantic import BaseModel, Field

from backend.demo_workspace import DemoWorkspace, MutableDemoWorkspace
from backend.engagement import (
    EDITABLE_PERSONAS,
    INITIALIZATION_QUESTIONS,
    INTEREST_TYPES,
    PERSONAS,
    PROFILE_CATEGORIES,
    SYNTHETIC_FEED_FIXTURES,
    generated_training_questions,
    next_branch_question,
    physician_interests,
    profile_update_draft,
    project_initialization,
    project_practice_representation,
    project_professional_profile,
    project_training_questions,
    proposed_learning_statement,
    question_by_id,
    related_personas,
    training_queue_summary,
)
from backend.professional_services import post_draft_service, profile_enrichment_service
from backend.workflow import workflow_store

router = APIRouter(prefix="/api/workspace", tags=["physician-engagement"])

UPDATE_TYPES = {
    "practice_focus",
    "referral_guidance",
    "availability",
    "publication",
    "research",
    "teaching",
    "location",
    "professional_update",
}
POST_TYPES = {
    "profile_update",
    "practice_update",
    "referral_guidance",
    "share_paper",
    "research_update",
    "teaching_update",
    "interesting_case",
    "availability",
    "professional_update",
    "other",
    *UPDATE_TYPES,
}


class ProfileItemUpdate(BaseModel):
    category: str = Field(min_length=1, max_length=40)
    title: str = Field(min_length=1, max_length=240)
    detail: str | None = Field(default=None, max_length=1000)
    shareable: bool = True


class TrainingResponseUpdate(BaseModel):
    answer: str | list[str] | None = None
    skipped: bool = False


class LearningUpdate(BaseModel):
    action: Literal["confirm", "edit", "reject"]
    statement: str | None = Field(default=None, max_length=500)


class PracticeUpdateInput(BaseModel):
    type: str = Field(min_length=1, max_length=40)
    title: str = Field(min_length=1, max_length=240)
    body: str = Field(min_length=1, max_length=2000)


class InterestInput(BaseModel):
    interest_type: str
    title: str = Field(min_length=1, max_length=240)
    detail: str | None = Field(default=None, max_length=1000)
    confirmed: bool = True
    shareable: bool = True


class TrainingSessionInput(BaseModel):
    mode: Literal["initialization", "daily", "extended"] = "daily"
    limit: int | None = Field(default=None, ge=1, le=25)


class CandidateReviewInput(BaseModel):
    action: Literal["confirm", "edit_confirm", "reject"]
    title: str | None = Field(default=None, max_length=240)
    detail: str | None = Field(default=None, max_length=1000)
    shareable: bool = True


class PostInput(BaseModel):
    type: str
    title: str = Field(min_length=1, max_length=240)
    body: str = Field(min_length=1, max_length=4000)
    case_origin: Literal["synthetic_demo", "real_patient"] | None = None


class PostDraftInput(BaseModel):
    type: str
    source_material: dict[str, Any]
    case_origin: Literal["synthetic_demo", "real_patient"] | None = None


def controlled_physician_perspective(
    request: Request, perspective: str = Query(default="lucy")
) -> str:
    if any(key in request.query_params for key in ("npi", "physician_npi")) or any(
        header in request.headers for header in ("x-physician-npi", "x-specialist-npi")
    ):
        raise HTTPException(400, "Physician perspective uses controlled demo personas")
    if perspective not in EDITABLE_PERSONAS:
        raise HTTPException(404, "Controlled demo physician not found")
    return perspective


ControlledPersona = Annotated[str, Depends(controlled_physician_perspective)]


def _profile(workspace_id: str, persona_id: str) -> dict:
    return project_professional_profile(
        persona_id,
        workflow_store.profile_items(workspace_id, persona_id),
        workflow_store.physician_interests(workspace_id, persona_id),
    )


def _questions(workspace_id: str, persona_id: str) -> list[dict]:
    return project_training_questions(
        persona_id, workflow_store.training_responses(workspace_id, persona_id)
    )


def _existing_learnings(workspace_id: str, persona_id: str) -> list[dict]:
    if persona_id == "lucy":
        return workflow_store.preferences(workspace_id)
    npi = PERSONAS[persona_id]["npi"]
    return workflow_store.specialist_calibrations(workspace_id, npi)


def _representation(workspace_id: str, persona_id: str) -> dict:
    return project_practice_representation(
        persona_id,
        _questions(workspace_id, persona_id),
        workflow_store.proposed_learnings(workspace_id, persona_id),
        _profile(workspace_id, persona_id),
        _existing_learnings(workspace_id, persona_id),
        physician_interests(
            persona_id, workflow_store.physician_interests(workspace_id, persona_id)
        ),
    )


def _require_update_type(update_type: str) -> None:
    if update_type not in UPDATE_TYPES:
        raise HTTPException(422, "Unsupported practice update type")


@router.get("/physician/profile")
def professional_profile(workspace_id: DemoWorkspace, persona_id: ControlledPersona) -> dict:
    return _profile(workspace_id, persona_id)


@router.get("/physician/interests")
def get_physician_interests(
    workspace_id: DemoWorkspace, persona_id: ControlledPersona
) -> list[dict]:
    return physician_interests(
        persona_id, workflow_store.physician_interests(workspace_id, persona_id)
    )


@router.post("/physician/interests", status_code=201)
def create_physician_interest(
    update: InterestInput,
    workspace_id: MutableDemoWorkspace,
    persona_id: ControlledPersona,
) -> dict:
    if update.interest_type not in INTEREST_TYPES:
        raise HTTPException(422, "Unsupported physician interest type")
    return workflow_store.upsert_physician_interest(
        workspace_id,
        persona_id,
        f"interest-{secrets.token_hex(8)}",
        update.interest_type,
        " ".join(update.title.split()),
        " ".join(update.detail.split()) if update.detail else None,
        update.confirmed,
        update.shareable,
    )


@router.put("/physician/interests/{interest_id}")
def update_physician_interest(
    interest_id: str,
    update: InterestInput,
    workspace_id: MutableDemoWorkspace,
    persona_id: ControlledPersona,
) -> dict:
    if update.interest_type not in INTEREST_TYPES:
        raise HTTPException(422, "Unsupported physician interest type")
    return workflow_store.upsert_physician_interest(
        workspace_id,
        persona_id,
        interest_id,
        update.interest_type,
        " ".join(update.title.split()),
        " ".join(update.detail.split()) if update.detail else None,
        update.confirmed,
        update.shareable,
    )


@router.get("/physician/initialization")
def physician_initialization(workspace_id: DemoWorkspace, persona_id: ControlledPersona) -> dict:
    profile = _profile(workspace_id, persona_id)
    questions = _questions(workspace_id, persona_id)
    return project_initialization(profile, profile["interests"], questions)


@router.put("/physician/profile/items/{item_id}")
def update_profile_item(
    item_id: str,
    update: ProfileItemUpdate,
    workspace_id: MutableDemoWorkspace,
    persona_id: ControlledPersona,
) -> dict:
    if update.category not in PROFILE_CATEGORIES:
        raise HTTPException(422, "Unsupported professional profile category")
    title = " ".join(update.title.split())
    if not title:
        raise HTTPException(422, "Profile item title cannot be empty")
    profile_item = workflow_store.upsert_profile_item(
        workspace_id,
        persona_id,
        item_id,
        update.category,
        title,
        " ".join(update.detail.split()) if update.detail else None,
        update.shareable,
    )
    draft = profile_update_draft(profile_item)
    draft_update = workflow_store.create_practice_update(
        workspace_id,
        persona_id,
        draft["type"],
        draft["title"],
        draft["body"],
        "agent_drafted_from_profile_change",
        agent_drafted=True,
    )
    return {"profile_item": profile_item, "draft_update": draft_update}


@router.get("/physician/agent-representation")
def agent_representation(workspace_id: DemoWorkspace, persona_id: ControlledPersona) -> dict:
    return _representation(workspace_id, persona_id)


@router.get("/physician/training")
def training_queue(workspace_id: DemoWorkspace, persona_id: ControlledPersona) -> dict:
    responses = workflow_store.training_responses(workspace_id, persona_id)
    questions = project_training_questions(persona_id, responses)
    return {
        "physician": PERSONAS[persona_id],
        "questions": questions,
        "queue_summary": training_queue_summary(questions, responses),
        "sessions": workflow_store.training_sessions(workspace_id, persona_id),
        "responses": workflow_store.training_responses(workspace_id, persona_id),
        "proposed_learnings": workflow_store.proposed_learnings(workspace_id, persona_id),
    }


@router.post("/physician/training/sessions", status_code=201)
def start_training_session(
    workspace_id: MutableDemoWorkspace,
    persona_id: ControlledPersona,
    update: TrainingSessionInput | None = None,
) -> dict:
    update = update or TrainingSessionInput()
    default_limit = 15 if update.mode == "initialization" else 5
    if update.mode == "extended":
        default_limit = 25
    question_limit = min(update.limit or default_limit, 25)
    session = workflow_store.start_training_session(
        workspace_id, persona_id, update.mode, question_limit
    )
    unanswered = [
        question
        for question in _questions(workspace_id, persona_id)
        if question["status"] == "unanswered"
    ]
    if update.mode == "initialization":
        answered_ids = {
            item["question_id"]
            for item in workflow_store.training_responses(workspace_id, persona_id)
        }
        unanswered = [
            question_by_id(persona_id, item["id"])
            for item in INITIALIZATION_QUESTIONS[persona_id]
            if item["id"] not in answered_ids
        ] + unanswered
        unanswered = [item for item in unanswered if item is not None]
        unanswered.sort(
            key=lambda item: (
                item.get("source_type") != "initialization",
                -item["priority"],
                item["id"],
            )
        )
    else:
        unanswered.sort(key=lambda item: (-item["priority"], item["id"]))
    if update.mode == "extended" and len(unanswered) < question_limit:
        known_ids = {
            item["question_id"]
            for item in workflow_store.training_responses(workspace_id, persona_id)
        } | {item["id"] for item in unanswered}
        for generated in generated_training_questions(persona_id):
            if generated["id"] in known_ids:
                continue
            unanswered.append(question_by_id(persona_id, generated["id"]))
            if len(unanswered) >= question_limit:
                break
    session["questions"] = unanswered[:question_limit]
    for question in session["questions"]:
        workflow_store.assign_training_question(
            workspace_id, persona_id, session["id"], question, question["priority"]
        )
    session["responses"] = []
    return session


@router.get("/physician/training/sessions/{session_id}")
def resume_training_session(
    session_id: int, workspace_id: DemoWorkspace, persona_id: ControlledPersona
) -> dict:
    session = workflow_store.training_session(workspace_id, persona_id, session_id)
    if not session:
        raise HTTPException(404, "Training session not found")
    assigned = workflow_store.training_session_questions(workspace_id, persona_id, session_id)
    session["questions"] = [
        question
        for item in assigned
        if (question := question_by_id(persona_id, item["question_id"])) is not None
    ]
    session["responses"] = workflow_store.training_responses(workspace_id, persona_id, session_id)
    return session


@router.put("/physician/training/sessions/{session_id}/responses/{question_id}")
def answer_training_question(
    session_id: int,
    question_id: str,
    update: TrainingResponseUpdate,
    workspace_id: MutableDemoWorkspace,
    persona_id: ControlledPersona,
) -> dict:
    session = workflow_store.training_session(workspace_id, persona_id, session_id)
    if not session or session["status"] != "active":
        raise HTTPException(404, "Active training session not found")
    question = question_by_id(persona_id, question_id)
    if not question:
        raise HTTPException(404, "Training question not found")
    assigned = workflow_store.training_session_questions(workspace_id, persona_id, session_id)
    assigned_ids = {item["question_id"] for item in assigned}
    if question_id not in assigned_ids:
        raise HTTPException(404, "Question is not assigned to this session")
    if update.skipped:
        answer = None
    else:
        answer = update.answer
        if answer is None:
            raise HTTPException(422, "Answer or skip is required")
        if question["question_type"] == "multi_select":
            if not isinstance(answer, list) or not answer:
                raise HTTPException(422, "Select at least one answer")
            if any(option not in question["answer_options"] for option in answer):
                raise HTTPException(422, "Unsupported answer option")
        elif question["question_type"] != "short_text":
            if not isinstance(answer, str) or answer not in question["answer_options"]:
                raise HTTPException(422, "Unsupported answer option")
        elif not isinstance(answer, str) or not answer.strip():
            raise HTTPException(422, "Answer cannot be empty")
    response = workflow_store.save_training_response(
        workspace_id, persona_id, session_id, question_id, answer, update.skipped
    )
    next_question = None
    if not update.skipped and isinstance(answer, str):
        next_question = next_branch_question(persona_id, question_id, answer, assigned_ids)
        if next_question is not None:
            workflow_store.assign_training_question(
                workspace_id,
                persona_id,
                session_id,
                next_question,
                next_question["priority"],
            )
    return {**response, "next_question": next_question}


@router.post("/physician/training/sessions/{session_id}/finish")
def finish_training_session(
    session_id: int,
    workspace_id: MutableDemoWorkspace,
    persona_id: ControlledPersona,
) -> dict:
    session = workflow_store.training_session(workspace_id, persona_id, session_id)
    if not session:
        raise HTTPException(404, "Training session not found")
    responses = workflow_store.training_responses(workspace_id, persona_id, session_id)
    for response in responses:
        if response["skipped"] or response["answer"] is None:
            continue
        workflow_store.create_proposed_learning(
            workspace_id,
            persona_id,
            "training_response",
            f"session:{session_id}:question:{response['question_id']}",
            proposed_learning_statement(response["question_id"], response["answer"]),
        )
    completed = workflow_store.complete_training_session(
        workspace_id, persona_id, session_id
    )
    return {
        **completed,
        "responses": responses,
        "proposed_learnings": [
            item
            for item in workflow_store.proposed_learnings(workspace_id, persona_id)
            if item["source_reference"].startswith(f"session:{session_id}:")
        ],
    }


@router.put("/physician/training/learnings/{learning_id}")
def update_training_learning(
    learning_id: int,
    update: LearningUpdate,
    workspace_id: MutableDemoWorkspace,
    persona_id: ControlledPersona,
) -> dict:
    current = next(
        (
            item
            for item in workflow_store.proposed_learnings(workspace_id, persona_id)
            if item["id"] == learning_id
        ),
        None,
    )
    if not current:
        raise HTTPException(404, "Proposed learning not found")
    if update.action == "edit" and not update.statement:
        raise HTTPException(422, "Edited statement required")
    statement = " ".join((update.statement or current["statement"]).split())
    if not statement:
        raise HTTPException(422, "Statement cannot be empty")
    status = {
        "confirm": "confirmed",
        "edit": "suggested",
        "reject": "rejected",
    }[update.action]
    learning = workflow_store.update_proposed_learning(
        workspace_id, persona_id, learning_id, statement, status
    )
    draft_update = None
    if status == "confirmed":
        draft_update = workflow_store.create_practice_update(
            workspace_id,
            persona_id,
            "referral_guidance",
            "Practice representation update",
            statement,
            "agent_drafted_from_confirmed_learning",
            agent_drafted=True,
        )
    return {"learning": learning, "draft_update": draft_update}


@router.post("/physician/profile/enrich", status_code=201)
def enrich_physician_profile(
    workspace_id: MutableDemoWorkspace, persona_id: ControlledPersona
) -> dict:
    provider, candidates, message = profile_enrichment_service.candidates(persona_id)
    job = workflow_store.create_enrichment_job(workspace_id, persona_id, provider)
    return workflow_store.complete_enrichment_job(
        workspace_id, persona_id, job["id"], candidates, message
    )


@router.get("/physician/profile/enrichment")
def physician_profile_enrichment(
    workspace_id: DemoWorkspace, persona_id: ControlledPersona
) -> dict:
    return workflow_store.latest_enrichment(workspace_id, persona_id)


@router.put("/physician/profile/enrichment/{candidate_id}")
def review_physician_profile_candidate(
    candidate_id: str,
    update: CandidateReviewInput,
    workspace_id: MutableDemoWorkspace,
    persona_id: ControlledPersona,
) -> dict:
    status = {
        "confirm": "confirmed",
        "edit_confirm": "edited",
        "reject": "rejected",
    }[update.action]
    if update.action == "edit_confirm" and not update.title:
        raise HTTPException(422, "Edited candidate title is required")
    candidate = workflow_store.review_profile_candidate(
        workspace_id,
        persona_id,
        candidate_id,
        status,
        " ".join(update.title.split()) if update.title else None,
        " ".join(update.detail.split()) if update.detail else None,
    )
    if not candidate:
        raise HTTPException(404, "Profile candidate not found")
    profile_item = None
    if status in {"confirmed", "edited"}:
        profile_item = workflow_store.upsert_profile_item(
            workspace_id,
            persona_id,
            f"enrichment-{candidate_id}",
            candidate["category"],
            candidate["proposed_title"],
            candidate["proposed_detail"],
            update.shareable,
            "confirmed_public_candidate",
        )
    return {"candidate": candidate, "profile_item": profile_item}


def _validate_post_type(post_type: str) -> None:
    if post_type not in POST_TYPES:
        raise HTTPException(422, "Unsupported professional post type")


def _validate_case_origin(post_type: str, case_origin: str | None) -> None:
    if post_type == "interesting_case" and case_origin != "synthetic_demo":
        raise HTTPException(
            422,
            "Public-demo case posts require explicitly synthetic content; "
            "real-patient posting is disabled",
        )


@router.get("/physician/posts")
def physician_posts(workspace_id: DemoWorkspace, persona_id: ControlledPersona) -> list[dict]:
    return workflow_store.practice_updates(workspace_id, persona_id)


@router.post("/physician/posts", status_code=201)
def create_physician_post(
    update: PostInput,
    workspace_id: MutableDemoWorkspace,
    persona_id: ControlledPersona,
) -> dict:
    _validate_post_type(update.type)
    _validate_case_origin(update.type, update.case_origin)
    post = workflow_store.create_practice_update(
        workspace_id,
        persona_id,
        update.type,
        update.title.strip(),
        update.body.strip(),
        "physician_entered",
        source_input={"case_origin": update.case_origin},
        synthetic_case=update.type == "interesting_case",
        case_safety_label=(
            "Clinical case reflection · Synthetic/demo case"
            if update.type == "interesting_case"
            else None
        ),
    )
    if update.type == "referral_guidance":
        workflow_store.create_proposed_learning(
            workspace_id,
            persona_id,
            "professional_post",
            f"post:{post['id']}",
            update.body.strip(),
        )
    return post


@router.post("/physician/posts/draft", status_code=201)
def draft_physician_post(
    update: PostDraftInput,
    workspace_id: MutableDemoWorkspace,
    persona_id: ControlledPersona,
) -> dict:
    _validate_post_type(update.type)
    _validate_case_origin(update.type, update.case_origin)
    draft = post_draft_service.draft(persona_id, update.type, update.source_material)
    post = workflow_store.create_practice_update(
        workspace_id,
        persona_id,
        update.type,
        draft["title"],
        draft["body"],
        f"agent_drafted:{draft['provider']}",
        agent_drafted=True,
        source_input=update.source_material,
        synthetic_case=update.type == "interesting_case",
        case_safety_label=(
            "Clinical case reflection · Synthetic/demo case"
            if update.type == "interesting_case"
            else None
        ),
    )
    return {"post": post, "draft_provider": draft["provider"]}


@router.put("/physician/posts/{post_id}")
def edit_physician_post(
    post_id: int,
    update: PostInput,
    workspace_id: MutableDemoWorkspace,
    persona_id: ControlledPersona,
) -> dict:
    _validate_post_type(update.type)
    _validate_case_origin(update.type, update.case_origin)
    saved = workflow_store.edit_practice_update(
        workspace_id,
        persona_id,
        post_id,
        update.type,
        update.title,
        update.body,
        {"case_origin": update.case_origin},
        update.type == "interesting_case",
        (
            "Clinical case reflection · Synthetic/demo case"
            if update.type == "interesting_case"
            else None
        ),
    )
    if not saved:
        raise HTTPException(404, "Editable draft post not found")
    return saved


@router.put("/physician/posts/{post_id}/publish")
def publish_physician_post(
    post_id: int,
    workspace_id: MutableDemoWorkspace,
    persona_id: ControlledPersona,
) -> dict:
    current = workflow_store.practice_update(workspace_id, persona_id, post_id)
    if not current or current["status"] != "draft":
        raise HTTPException(404, "Publishable draft post not found")
    return workflow_store.set_practice_update_status(workspace_id, persona_id, post_id, "published")


@router.put("/physician/posts/{post_id}/dismiss")
def dismiss_physician_post(
    post_id: int,
    workspace_id: MutableDemoWorkspace,
    persona_id: ControlledPersona,
) -> dict:
    current = workflow_store.practice_update(workspace_id, persona_id, post_id)
    if not current or current["status"] == "archived":
        raise HTTPException(404, "Active professional post not found")
    return workflow_store.set_practice_update_status(workspace_id, persona_id, post_id, "archived")


@router.get("/physician/updates")
def physician_updates(workspace_id: DemoWorkspace, persona_id: ControlledPersona) -> list[dict]:
    return workflow_store.practice_updates(workspace_id, persona_id)


@router.post("/physician/updates", status_code=201)
def create_physician_update(
    update: PracticeUpdateInput,
    workspace_id: MutableDemoWorkspace,
    persona_id: ControlledPersona,
) -> dict:
    _require_update_type(update.type)
    if not update.title.strip() or not update.body.strip():
        raise HTTPException(422, "Practice update title and body cannot be empty")
    return workflow_store.create_practice_update(
        workspace_id,
        persona_id,
        update.type,
        update.title.strip(),
        update.body.strip(),
        "physician_entered",
    )


@router.put("/physician/updates/{update_id}")
def edit_physician_update(
    update_id: int,
    update: PracticeUpdateInput,
    workspace_id: MutableDemoWorkspace,
    persona_id: ControlledPersona,
) -> dict:
    _require_update_type(update.type)
    if not update.title.strip() or not update.body.strip():
        raise HTTPException(422, "Practice update title and body cannot be empty")
    saved = workflow_store.edit_practice_update(
        workspace_id,
        persona_id,
        update_id,
        update.type,
        update.title.strip(),
        update.body.strip(),
    )
    if not saved:
        raise HTTPException(404, "Editable draft update not found")
    return saved


@router.put("/physician/updates/{update_id}/publish")
def publish_physician_update(
    update_id: int,
    workspace_id: MutableDemoWorkspace,
    persona_id: ControlledPersona,
) -> dict:
    current = workflow_store.practice_update(workspace_id, persona_id, update_id)
    if not current or current["status"] != "draft":
        raise HTTPException(404, "Publishable draft update not found")
    return workflow_store.set_practice_update_status(
        workspace_id, persona_id, update_id, "published"
    )


@router.put("/physician/updates/{update_id}/dismiss")
def dismiss_physician_update(
    update_id: int,
    workspace_id: MutableDemoWorkspace,
    persona_id: ControlledPersona,
) -> dict:
    current = workflow_store.practice_update(workspace_id, persona_id, update_id)
    if not current or current["status"] == "archived":
        raise HTTPException(404, "Active practice update not found")
    return workflow_store.set_practice_update_status(
        workspace_id, persona_id, update_id, "archived"
    )


def _relationship_bases(
    author: str, perspective: str, records: list[dict], members: list[dict]
) -> list[str]:
    bases: list[str] = []
    npi = PERSONAS[author]["npi"]
    if npi and any(member["npi"] == npi for member in members):
        bases.append("explicit_network_member")
    if author in related_personas(perspective, records, []):
        bases.append("canonical_agent_interaction")
    return bases


@router.get("/network/feed")
def network_feed(
    workspace_id: DemoWorkspace, persona_id: ControlledPersona
) -> dict:
    records = workflow_store.history(workspace_id, limit=200)
    members = workflow_store.network_members(workspace_id)
    eligible = related_personas(persona_id, records, members)
    items: list[dict] = []
    for fixture in SYNTHETIC_FEED_FIXTURES:
        author = fixture["physician_persona"]
        if author in eligible:
            items.append(
                {
                    **fixture,
                    "physician": PERSONAS[author],
                    "relationship_basis": _relationship_bases(author, persona_id, records, members),
                }
            )
    for update in workflow_store.practice_updates(workspace_id, status="published"):
        if not update["physician_approved"]:
            continue
        author = update["persona_id"]
        if author in eligible:
            items.append(
                {
                    **update,
                    "id": f"workspace-{update['id']}",
                    "physician_persona": author,
                    "physician": PERSONAS[author],
                    "relationship_basis": _relationship_bases(
                        author, persona_id, records, members
                    ),
                    "synthetic": True,
                }
            )
    items.sort(key=lambda item: item["published_at"] or "", reverse=True)
    return {
        "items": items,
        "relationship_sources": [
            "explicit_network_members",
            "canonical_physician_agent_interactions",
        ],
        "ranking": "chronological_only",
        "disclaimer": "Synthetic professional network updates only · no PHI",
    }


@router.get("/network/physicians/{controlled_id}/profile")
def network_physician_profile(controlled_id: str, workspace_id: DemoWorkspace) -> dict:
    if controlled_id not in PERSONAS:
        raise HTTPException(404, "Controlled synthetic physician not found")
    overlays = (
        workflow_store.profile_items(workspace_id, controlled_id)
        if controlled_id in EDITABLE_PERSONAS
        else []
    )
    interest_overlays = (
        workflow_store.physician_interests(workspace_id, controlled_id)
        if controlled_id in EDITABLE_PERSONAS
        else []
    )
    profile = project_professional_profile(controlled_id, overlays, interest_overlays)
    profile["items"] = [item for item in profile["items"] if item["shareable"]]
    profile["sections"] = {
        category: [item for item in items if item["shareable"]]
        for category, items in profile["sections"].items()
    }
    profile["interests"] = [
        item for item in profile["interests"] if item["confirmed"] and item["shareable"]
    ]
    completed = sorted({item["category"] for item in profile["items"]})
    profile["completeness"] = {
        "completed_section_count": len(completed),
        "total_section_count": len(PROFILE_CATEGORIES),
        "incomplete_sections": [
            category for category in PROFILE_CATEGORIES if category not in completed
        ],
        "meaning": "Shareable professional profile completeness only; not physician quality or referral rank.",
    }
    questions = (
        _questions(workspace_id, controlled_id)
        if controlled_id in EDITABLE_PERSONAS
        else []
    )
    learnings = (
        workflow_store.proposed_learnings(workspace_id, controlled_id)
        if controlled_id in EDITABLE_PERSONAS
        else []
    )
    representation = project_practice_representation(
        controlled_id, questions, learnings, profile
    )
    return {
        "physician": PERSONAS[controlled_id],
        "professional_profile": profile,
        "practice_representation": representation["sections"],
        "published_updates": [
            item
            for item in [
                *SYNTHETIC_FEED_FIXTURES,
                *workflow_store.practice_updates(workspace_id, controlled_id, "published"),
            ]
            if item.get("physician_persona", item.get("persona_id")) == controlled_id
            and item.get("physician_approved", True)
        ],
        "disclaimer": "Controlled synthetic physician profile · no private calibration or patient data",
    }
