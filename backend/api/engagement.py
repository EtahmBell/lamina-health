from __future__ import annotations

import logging
import re
import secrets
from datetime import UTC, datetime, timedelta
from typing import Annotated, Any, Literal

from fastapi import APIRouter, Depends, HTTPException, Query, Request
from pydantic import BaseModel, Field

from backend.agent_experience import (
    agent_test_cases,
    deterministic_agent_chat,
    deterministic_portrait,
    focused_training_question,
    persona_identity_summary,
    test_case_by_id,
)
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
    normalize_question,
    physician_interests,
    profile_update_draft,
    project_initialization,
    project_practice_representation,
    project_professional_profile,
    project_training_questions,
    question_by_id,
    related_personas,
    synthesize_branch_learning,
    training_queue_summary,
)
from backend.professional_services import (
    agent_chat_service,
    post_draft_service,
    profile_enrichment_service,
    training_branch_service,
)
from backend.specialist_projection import project_specialist_cases
from backend.workflow import workflow_store

router = APIRouter(prefix="/api/workspace", tags=["physician-engagement"])
logger = logging.getLogger(__name__)
NORMAL_TRAINING_TARGET = 10

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


class TrainingReviewCompleteInput(BaseModel):
    defer_pending: bool = False


class FocusedTrainingInput(BaseModel):
    seed_id: str = Field(min_length=1, max_length=120)
    answer_target: int = Field(default=10, ge=1, le=10)


class AgentChatInput(BaseModel):
    mode: Literal["practice_question", "synthetic_case"]
    message: str = Field(min_length=1, max_length=1000)
    controlled_test_case_id: str | None = Field(default=None, max_length=120)
    origin: Literal["practice", "synthetic_demo", "real_patient"] = "practice"


class AgentChatFeedbackInput(BaseModel):
    feedback: Literal["reflects", "not_quite"]


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


def _question(workspace_id: str, persona_id: str, question_id: str) -> dict | None:
    return question_by_id(persona_id, question_id) or workflow_store.generated_training_question(
        workspace_id, persona_id, question_id
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
    sessions = workflow_store.training_sessions(workspace_id, persona_id)
    first_training_completed = any(
        item["mode"] == "initialization"
        and item["status"] == "completed"
        and item["lifecycle_state"] != "abandoned"
        for item in sessions
    )
    state = workflow_store.initialization_state(workspace_id, persona_id)
    if state is None and first_training_completed and profile["interests"]:
        state = workflow_store.mark_initialized(workspace_id, persona_id)
    return project_initialization(
        profile,
        profile["interests"],
        questions,
        state,
        first_training_completed,
    )


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


def _materialize_training_session(
    workspace_id: str, persona_id: str, session: dict
) -> dict:
    session_responses = workflow_store.training_responses(
        workspace_id, persona_id, session["id"]
    )
    answered_ids = {item["question_id"] for item in session_responses}
    assigned = workflow_store.training_session_questions(
        workspace_id, persona_id, session["id"]
    )
    assigned_ids = {item["question_id"] for item in assigned}
    remaining_budget = max(0, session["answer_target"] - len(session_responses))
    selected = [
        question
        for item in assigned
        if item["question_id"] not in answered_ids
        and (question := _question(workspace_id, persona_id, item["question_id"])) is not None
    ][:remaining_budget]
    selected_ids = {item["id"] for item in selected}

    deferred = [
        item
        for item in workflow_store.deferred_training_questions(workspace_id, persona_id)
        if item["id"] not in selected_ids and item["id"] not in answered_ids
    ]
    for question in deferred:
        if len(selected) >= remaining_budget:
            break
        selected.append(question)
        selected_ids.add(question["id"])

    responses = workflow_store.training_responses(workspace_id, persona_id)
    unanswered = [
        question
        for question in _questions(workspace_id, persona_id)
        if question["status"] == "unanswered"
        and question["id"] not in selected_ids
        and question["id"] not in assigned_ids
    ]
    if session["mode"] == "initialization":
        globally_answered_ids = {item["question_id"] for item in responses}
        initialization = [
            question_by_id(persona_id, item["id"])
            for item in INITIALIZATION_QUESTIONS[persona_id]
            if item["id"] not in globally_answered_ids
            and item["id"] not in assigned_ids
            and item["id"] not in selected_ids
        ]
        unanswered = [item for item in initialization if item is not None] + unanswered
        unanswered.sort(
            key=lambda item: (
                item.get("source_type") != "initialization",
                -item["priority"],
                item["id"],
            )
        )
    else:
        unanswered.sort(key=lambda item: (-item["priority"], item["id"]))

    needed = remaining_budget - len(selected)
    if session["mode"] in {"initialization", "daily", "extended"} and len(unanswered) < needed:
        known_ids = answered_ids | assigned_ids | selected_ids | {
            item["question_id"] for item in responses
        } | {item["id"] for item in unanswered}
        for generated in generated_training_questions(persona_id):
            if generated["id"] in known_ids:
                continue
            question = question_by_id(persona_id, generated["id"])
            if question is not None:
                unanswered.append(question)
                known_ids.add(question["id"])
            if len(unanswered) >= needed:
                break
    selected.extend(unanswered[: max(0, remaining_budget - len(selected))])

    for question in selected:
        if question["id"] not in assigned_ids:
            workflow_store.assign_training_question(
                workspace_id,
                persona_id,
                session["id"],
                question,
                1000 if question.get("deferred_id") is not None else question["priority"],
            )
        if question.get("deferred_id") is not None:
            workflow_store.consume_deferred_training_question(
                workspace_id,
                persona_id,
                question["deferred_id"],
                session["id"],
            )
    materialized = [
        question
        for item in workflow_store.training_session_questions(
            workspace_id, persona_id, session["id"]
        )
        if (question := _question(workspace_id, persona_id, item["question_id"])) is not None
    ]
    return {**session, "questions": materialized, "responses": session_responses}


def _recover_active_training_session(
    workspace_id: str, persona_id: str
) -> dict | None:
    sessions = workflow_store.training_sessions(workspace_id, persona_id)
    active = [
        item
        for item in sessions
        if item["status"] == "active" and item["lifecycle_state"] == "active"
    ]
    if not active:
        return None
    response_counts = {
        item["id"]: len(
            workflow_store.training_responses(workspace_id, persona_id, item["id"])
        )
        for item in active
    }
    progressed = [item for item in active if response_counts[item["id"]] > 0]
    canonical = (progressed or active)[0]
    for duplicate in active:
        if duplicate["id"] == canonical["id"]:
            continue
        workflow_store.abandon_training_session(workspace_id, persona_id, duplicate["id"])
        logger.info(
            "training_session_recovered persona=%s session=%s reason=duplicate_active answers_preserved=%s",
            persona_id,
            duplicate["id"],
            response_counts[duplicate["id"]],
        )
    if (
        response_counts[canonical["id"]] == 0
        and canonical["mode"] != "focused"
        and canonical["answer_target"] != NORMAL_TRAINING_TARGET
    ):
        canonical = workflow_store.normalize_unstarted_training_session(
            workspace_id,
            persona_id,
            canonical["id"],
            NORMAL_TRAINING_TARGET,
        ) or canonical
        logger.info(
            "training_session_recovered persona=%s session=%s reason=legacy_unstarted target=%s",
            persona_id,
            canonical["id"],
            NORMAL_TRAINING_TARGET,
        )
    if response_counts[canonical["id"]] >= canonical["answer_target"]:
        _complete_training_questions(workspace_id, persona_id, canonical["id"])
        logger.info(
            "training_session_recovered persona=%s session=%s reason=target_already_reached",
            persona_id,
            canonical["id"],
        )
        return None
    materialized = _materialize_training_session(workspace_id, persona_id, canonical)
    if response_counts[canonical["id"]] == 0 and not materialized["questions"]:
        workflow_store.abandon_training_session(workspace_id, persona_id, canonical["id"])
        logger.info(
            "training_session_recovered persona=%s session=%s reason=empty_unstarted",
            persona_id,
            canonical["id"],
        )
        return None
    response_ids = {item["question_id"] for item in materialized["responses"]}
    if response_ids and not any(
        item["id"] not in response_ids for item in materialized["questions"]
    ):
        _complete_training_questions(workspace_id, persona_id, canonical["id"])
        logger.info(
            "training_session_recovered persona=%s session=%s reason=no_remaining_questions",
            persona_id,
            canonical["id"],
        )
        return None
    return materialized


def _training_projection(workspace_id: str, persona_id: str) -> dict:
    responses = workflow_store.training_responses(workspace_id, persona_id)
    active = _recover_active_training_session(workspace_id, persona_id)
    sessions = workflow_store.training_sessions(workspace_id, persona_id)
    history = workflow_store.training_history(workspace_id, persona_id)
    pending_learnings = [
        item
        for item in workflow_store.proposed_learnings(workspace_id, persona_id)
        if item["source_type"] == "training_response"
        and item.get("review_action") is None
    ]
    pending_by_session: dict[int, list[dict]] = {}
    for item in pending_learnings:
        if not item["source_reference"].startswith("session:"):
            continue
        pending_by_session.setdefault(int(item["source_reference"].split(":", 2)[1]), []).append(
            item
        )
    review_session = next(
        (
            item
            for item in sessions
            if item["lifecycle_state"] == "questions_complete"
            and item["id"] in pending_by_session
        ),
        None,
    )
    queue = training_queue_summary(_questions(workspace_id, persona_id), responses)
    initialization = physician_initialization(workspace_id, persona_id)
    answered_count = len(active.get("responses", [])) if active else 0
    if not initialization["initialized"]:
        state, action = "initialization_needed", "continue_setup"
    elif active:
        state, action = (
            ("active_unstarted", "start_training")
            if answered_count == 0
            else ("active_in_progress", "resume_training")
        )
    elif review_session:
        state, action = "review_pending", "review_training"
    elif queue["available_total"] > 0:
        state, action = "ready", "start_training"
    else:
        state, action = "caught_up", "none"
    return {
        "state": state,
        "action": action,
        "active_session_id": active["id"] if active else None,
        "review_session_id": review_session["id"] if review_session else None,
        "answered_count": answered_count,
        "answer_target": active["answer_target"] if active else None,
        "review_pending": bool(pending_learnings),
        "initialization_required": not initialization["initialized"],
        "initialized": initialization["initialized"],
        "training_status": "active" if active else "ready",
        "current_session": active,
        "questions_answered_total": sum(not item["skipped"] for item in responses),
        "sessions_completed": sum(
            item["status"] == "completed" and item["lifecycle_state"] != "abandoned"
            for item in sessions
        ),
        "last_trained_at": max(
            (item["answered_at"] for item in responses), default=None
        ),
        "more_training_available": queue["available_total"] > 0,
        "available_total": queue["available_total"],
        "recent_training_history": history[:10],
        "deferred_branch_count": len(
            workflow_store.deferred_training_questions(workspace_id, persona_id)
        ),
        "pending_training_review_count": len(pending_learnings),
    }


@router.get("/physician/training/history")
def training_history(workspace_id: DemoWorkspace, persona_id: ControlledPersona) -> dict:
    return _training_projection(workspace_id, persona_id)


@router.get("/physician/agent-overview")
def agent_overview(workspace_id: DemoWorkspace, persona_id: ControlledPersona) -> dict:
    profile = _profile(workspace_id, persona_id)
    representation = _representation(workspace_id, persona_id)
    training = _training_projection(workspace_id, persona_id)
    initialization = physician_initialization(workspace_id, persona_id)
    confirmed = representation["sections"]["confirmed_learnings"]
    portrait, portrait_facts = deterministic_portrait(persona_id, confirmed)
    records = workflow_store.history(workspace_id, limit=200)
    if persona_id == "iain":
        network_cases_count = len(
            project_specialist_cases(
                records,
                PERSONAS[persona_id]["npi"],
                workflow_store.specialist_reviews(
                    workspace_id, PERSONAS[persona_id]["npi"]
                ),
            )
        )
    else:
        network_cases_count = len(records)
    published_updates = workflow_store.practice_updates(
        workspace_id, persona_id, "published"
    )
    network_physicians = workflow_store.network_members(workspace_id)
    stats = {
        "questions_answered_total": training["questions_answered_total"],
        "training_sessions_completed": training["sessions_completed"],
        "confirmed_practice_learnings": len(confirmed),
        "case_interests_count": sum(
            item["interest_type"] == "case_interest" and item["confirmed"]
            for item in profile["interests"]
        ),
        "network_cases_count": network_cases_count,
        "last_trained_at": training["last_trained_at"],
        "published_updates_count": len(published_updates),
        "network_physicians_count": len(network_physicians),
    }
    return {
        "physician": PERSONAS[persona_id],
        "specialty": PERSONAS[persona_id]["specialty"],
        "location": PERSONAS[persona_id]["location"],
        "portrait": portrait,
        "portrait_confirmed_facts": portrait_facts,
        "stats": stats,
        "initialization": initialization,
        "training": training,
        "last_trained_at": training["last_trained_at"],
        "more_training_available": training["more_training_available"],
        "next_action": training["action"],
        "ranking_effect": "none",
    }


@router.get("/physician/agent-test-cases")
def get_agent_test_cases(
    workspace_id: DemoWorkspace, persona_id: ControlledPersona
) -> list[dict]:
    del workspace_id
    return agent_test_cases(persona_id)


@router.post("/physician/agent-chat", status_code=201)
def chat_with_agent(
    update: AgentChatInput,
    workspace_id: MutableDemoWorkspace,
    persona_id: ControlledPersona,
) -> dict:
    if update.origin == "real_patient":
        raise HTTPException(422, "Real-patient chat is disabled in the public synthetic demo")
    if re.search(
        r"\b(?:mrn|medical record number|ssn|date of birth|dob)\b",
        update.message.casefold(),
    ):
        raise HTTPException(422, "Patient identifiers are not allowed in agent chat")
    test_case = None
    if update.mode == "synthetic_case":
        if update.origin != "synthetic_demo" or not update.controlled_test_case_id:
            raise HTTPException(422, "Synthetic-case chat requires a controlled test case")
        test_case = test_case_by_id(persona_id, update.controlled_test_case_id)
        if test_case is None:
            raise HTTPException(404, "Controlled synthetic test case not found")
    representation = _representation(workspace_id, persona_id)
    fallback = deterministic_agent_chat(
        persona_id,
        update.mode,
        update.message,
        representation,
        test_case,
    )
    allowed_references = {
        "practice:explicit_rules",
        "practice:preferred_workup",
        "practice:clinical_focus",
        "practice:explicit_rules:renal-routing",
        "practice:explicit_rules:anaemia-routing",
        *[
            f"interest:{item['id']}"
            for item in representation["sections"].get("interests", [])
        ],
        *[
            f"learning:{item['id']}"
            for item in representation["sections"].get("confirmed_learnings", [])
        ],
    }
    if test_case:
        allowed_references.add(f"test_case:{test_case['id']}")
    payload = {
        "physician": persona_identity_summary(persona_id),
        "mode": update.mode,
        "message": update.message,
        "confirmed_representation": representation["sections"],
        "controlled_synthetic_test_case": (
            {key: value for key, value in test_case.items() if key != "correction_prompt"}
            if test_case
            else None
        ),
        "allowed_references": sorted(allowed_references),
        "safety_boundary": "Practice representation and controlled synthetic scenarios only; no real PHI.",
    }
    result, provider = agent_chat_service.respond(payload, fallback)
    response_id = f"chat-{secrets.token_hex(12)}"
    saved = workflow_store.save_agent_chat_response(
        workspace_id,
        persona_id,
        response_id,
        update.mode,
        test_case["id"] if test_case else None,
        update.model_dump(),
        result,
        provider,
    )
    return {
        **saved,
        "mode": update.mode,
        "controlled_test_case_id": test_case["id"] if test_case else None,
        "synthetic_only": True,
    }


@router.post("/physician/agent-chat/{response_id}/feedback")
def submit_agent_chat_feedback(
    response_id: str,
    update: AgentChatFeedbackInput,
    workspace_id: MutableDemoWorkspace,
    persona_id: ControlledPersona,
) -> dict:
    chat_response = workflow_store.agent_chat_response(
        workspace_id, persona_id, response_id
    )
    if not chat_response:
        raise HTTPException(404, "Agent chat response not found")
    workflow_store.set_agent_chat_feedback(
        workspace_id, persona_id, response_id, update.feedback
    )
    seed = None
    if update.feedback == "not_quite":
        question = focused_training_question(persona_id, chat_response)
        seed_id = f"seed-{secrets.token_hex(10)}"
        seed = workflow_store.create_focused_training_seed(
            workspace_id,
            persona_id,
            seed_id,
            response_id,
            question,
        )
    return {
        "response_id": response_id,
        "feedback": update.feedback,
        "focused_training_seed": seed,
    }


@router.post("/physician/training/sessions", status_code=201)
def start_training_session(
    workspace_id: MutableDemoWorkspace,
    persona_id: ControlledPersona,
    update: TrainingSessionInput | None = None,
) -> dict:
    update = update or TrainingSessionInput()
    existing = _recover_active_training_session(workspace_id, persona_id)
    if existing is not None:
        return existing
    question_limit = NORMAL_TRAINING_TARGET
    session = workflow_store.start_training_session(
        workspace_id, persona_id, update.mode, question_limit
    )
    materialized = _materialize_training_session(workspace_id, persona_id, session)
    if not materialized["questions"]:
        abandoned = workflow_store.abandon_training_session(
            workspace_id, persona_id, session["id"]
        )
        return {**(abandoned or session), "questions": [], "responses": []}
    return materialized


@router.post("/physician/training/focused", status_code=201)
def start_focused_training(
    update: FocusedTrainingInput,
    workspace_id: MutableDemoWorkspace,
    persona_id: ControlledPersona,
) -> dict:
    if _recover_active_training_session(workspace_id, persona_id) is not None:
        raise HTTPException(409, "Complete the current training session before starting focused training")
    seed = workflow_store.focused_training_seed(
        workspace_id, persona_id, update.seed_id
    )
    if not seed or seed["status"] != "pending":
        raise HTTPException(404, "Pending focused training seed not found")
    session = workflow_store.start_training_session(
        workspace_id,
        persona_id,
        "focused",
        update.answer_target,
        focused_seed_id=update.seed_id,
    )
    if session.get("focused_seed_id") != update.seed_id:
        raise HTTPException(409, "Another training session is already active")
    question = workflow_store.save_generated_training_question(
        workspace_id,
        persona_id,
        session["id"],
        seed["question"],
        "agent_chat_feedback",
    )
    workflow_store.assign_training_question(
        workspace_id, persona_id, session["id"], question, 100
    )
    workflow_store.start_focused_training_seed(
        workspace_id, persona_id, update.seed_id, session["id"]
    )
    return {**session, "questions": [question], "responses": []}


@router.get("/physician/training/sessions/{session_id}")
def resume_training_session(
    session_id: int, workspace_id: DemoWorkspace, persona_id: ControlledPersona
) -> dict:
    session = workflow_store.training_session(workspace_id, persona_id, session_id)
    if not session:
        raise HTTPException(404, "Training session not found")
    if session["status"] == "active":
        recovered = _recover_active_training_session(workspace_id, persona_id)
        if recovered is None or recovered["id"] != session_id:
            raise HTTPException(409, "This training session is no longer active")
        return recovered
    assigned = workflow_store.training_session_questions(workspace_id, persona_id, session_id)
    session["questions"] = [
        question
        for item in assigned
        if (question := _question(workspace_id, persona_id, item["question_id"])) is not None
    ]
    session["responses"] = workflow_store.training_responses(workspace_id, persona_id, session_id)
    return session


def _complete_training_questions(
    workspace_id: str, persona_id: str, session_id: int
) -> dict:
    session = workflow_store.training_session(workspace_id, persona_id, session_id)
    if not session:
        raise HTTPException(404, "Training session not found")
    responses = workflow_store.training_responses(workspace_id, persona_id, session_id)
    assigned = workflow_store.training_session_questions(workspace_id, persona_id, session_id)
    assignment_by_id = {item["question_id"]: item for item in assigned}
    branches: dict[str, list[tuple[dict, dict]]] = {}
    for response in responses:
        if response["skipped"] or response["answer"] is None:
            continue
        question = _question(workspace_id, persona_id, response["question_id"])
        if question is None:
            continue
        root_id = assignment_by_id.get(response["question_id"], {}).get(
            "root_question_id", question.get("root_question_id", question["id"])
        )
        branches.setdefault(root_id, []).append((question, response))
    for root_id, branch in branches.items():
        workflow_store.create_proposed_learning(
            workspace_id,
            persona_id,
            "training_response",
            f"session:{session_id}:root:{root_id}",
            synthesize_branch_learning(root_id, branch),
        )
    completed = workflow_store.complete_training_session(
        workspace_id, persona_id, session_id
    )
    if session["mode"] == "initialization" and _profile(workspace_id, persona_id)[
        "interests"
    ]:
        workflow_store.mark_initialized(workspace_id, persona_id)
    proposed = [
        item
        for item in workflow_store.proposed_learnings(workspace_id, persona_id)
        if item["source_reference"].startswith(f"session:{session_id}:")
    ]
    pending_deferred = workflow_store.deferred_training_questions(
        workspace_id, persona_id
    )
    summary = {
        "answered_count": sum(not item["skipped"] for item in responses),
        "target_count": session["answer_target"],
        "proposed_learning_count": len(proposed),
        "unresolved_question_count": sum(
            item["source_session_id"] == session_id for item in pending_deferred
        ),
        "pending_review_count": sum(item.get("review_action") is None for item in proposed),
        "more_training_available": training_queue_summary(
            _questions(workspace_id, persona_id),
            workflow_store.training_responses(workspace_id, persona_id),
        )["available_total"]
        > 0,
    }
    return {
        **completed,
        "responses": responses,
        "proposed_learnings": proposed,
        "completion_summary": summary,
    }


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
    question = _question(workspace_id, persona_id, question_id)
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
    response_count = len(
        workflow_store.training_responses(workspace_id, persona_id, session_id)
    )
    target_reached = response_count >= session["answer_target"]
    focused_resolved = bool(
        session["mode"] == "focused"
        and (update.skipped or answer != "Depends")
    )
    next_question = None
    deferred_question = None
    if not update.skipped and isinstance(answer, str):
        next_question = next_branch_question(persona_id, question_id, answer, assigned_ids)
        if next_question is None and answer == "Depends":
            source_reference = question.get("source_reference")
            answered_prompts = [
                item["prompt"]
                for assignment in assigned
                if (item := _question(workspace_id, persona_id, assignment["question_id"]))
                is not None
            ]
            context = {
                "persona_id": persona_id,
                "physician": PERSONAS[persona_id],
                "parent": question,
                "parent_question": question["prompt"],
                "physician_answer": "Depends",
                "branch_depth": question.get("branch_depth", 0),
                "branch_path": question.get("branch_path", []),
                "dimension": question.get("dimension_being_narrowed", "diagnosis_phenotype"),
                "question_objective": question.get(
                    "question_objective", "Locate a bounded practice-fit boundary."
                ),
                "source_references": [source_reference] if source_reference else [],
                "answered_questions": answered_prompts,
                "confirmed_practice_representation": _representation(workspace_id, persona_id)[
                    "sections"
                ],
                "data_boundary": "Synthetic professional/practice context only; no real PHI.",
            }
            generated, provider = training_branch_service.generate(context, assigned_ids)
            if generated is not None:
                if provider == "responses_api":
                    depth = int(question.get("branch_depth", 0)) + 1
                    generated = normalize_question(
                        {
                            "id": f"{persona_id}-branch-ai-{secrets.token_hex(8)}",
                            "physician_persona": persona_id,
                            "root_question_id": question.get("root_question_id", question["id"]),
                            "parent_question_id": question["id"],
                            "branch_depth": depth,
                            "branch_path": [
                                *question.get("branch_path", []),
                                f"{question['id']}:Depends",
                            ],
                            "branch_condition": "Depends",
                            "source_type": generated["source_type"],
                            "source_reference": source_reference,
                            "prompt": generated["question"],
                            "question_type": generated["question_type"],
                            "answer_options": generated["answer_options"],
                            "why_this_matters": generated["why_this_matters"],
                            "dimension_being_narrowed": generated["dimension_being_narrowed"],
                            "terminal_candidate": generated["terminal_candidate"],
                            "source_references": generated["source_references"],
                            "proposed_boundary_rationale": generated["proposed_boundary_rationale"],
                            "terminal": generated["terminal_candidate"],
                            "synthetic": True,
                        }
                    )
                next_question = workflow_store.save_generated_training_question(
                    workspace_id, persona_id, session_id, generated, provider
                )
        if next_question is not None:
            if target_reached:
                provider = next_question.get("generation_provider", "curated_branch")
                deferred_question = workflow_store.defer_training_question(
                    workspace_id,
                    persona_id,
                    session_id,
                    next_question,
                    provider,
                )
                next_question = None
            else:
                workflow_store.assign_training_question(
                    workspace_id,
                    persona_id,
                    session_id,
                    next_question,
                    next_question["priority"],
                )
    questions_complete = target_reached or focused_resolved
    completion = (
        _complete_training_questions(workspace_id, persona_id, session_id)
        if questions_complete
        else None
    )
    return {
        **response,
        "next_question": next_question,
        "answered_count": response_count,
        "answer_target": session["answer_target"],
        "questions_complete": questions_complete,
        "deferred_branch": deferred_question,
        "completion_summary": completion["completion_summary"] if completion else None,
    }


@router.post("/physician/training/sessions/{session_id}/finish")
def finish_training_session(
    session_id: int,
    workspace_id: MutableDemoWorkspace,
    persona_id: ControlledPersona,
) -> dict:
    return _complete_training_questions(workspace_id, persona_id, session_id)


@router.post("/physician/training/reset")
def reset_training(workspace_id: MutableDemoWorkspace, persona_id: ControlledPersona) -> dict:
    """Reset only training-derived state for repeat controlled-demo testing."""
    deleted = workflow_store.reset_training(workspace_id, persona_id)
    questions = _questions(workspace_id, persona_id)
    responses = workflow_store.training_responses(workspace_id, persona_id)
    return {
        "persona_id": persona_id,
        "deleted": deleted,
        "queue_summary": training_queue_summary(questions, responses),
        "questions": questions,
        "proposed_learnings": workflow_store.proposed_learnings(workspace_id, persona_id),
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
        workspace_id, persona_id, learning_id, statement, status, update.action
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
    session = None
    source_reference = current["source_reference"]
    if source_reference.startswith("session:"):
        session_id = int(source_reference.split(":", 2)[1])
        session_learnings = [
            item
            for item in workflow_store.proposed_learnings(workspace_id, persona_id)
            if item["source_reference"].startswith(f"session:{session_id}:")
        ]
        if session_learnings and all(
            item.get("review_action") is not None for item in session_learnings
        ):
            session = workflow_store.complete_training_review(
                workspace_id, persona_id, session_id
            )
    return {"learning": learning, "draft_update": draft_update, "session": session}


@router.post("/physician/training/sessions/{session_id}/review/complete")
def complete_training_review(
    session_id: int,
    update: TrainingReviewCompleteInput,
    workspace_id: MutableDemoWorkspace,
    persona_id: ControlledPersona,
) -> dict:
    session = workflow_store.training_session(workspace_id, persona_id, session_id)
    if not session or session["status"] != "completed":
        raise HTTPException(404, "Completed training session not found")
    pending = [
        item
        for item in workflow_store.proposed_learnings(workspace_id, persona_id)
        if item["source_reference"].startswith(f"session:{session_id}:")
        and item.get("review_action") is None
    ]
    if pending and not update.defer_pending:
        raise HTTPException(409, "Pending learnings must be reviewed or explicitly deferred")
    completed = workflow_store.complete_training_review(
        workspace_id, persona_id, session_id, deferred=bool(pending)
    )
    return {**completed, "pending_review_count": len(pending)}


@router.post("/physician/profile/enrich", status_code=201)
def enrich_physician_profile(
    workspace_id: MutableDemoWorkspace, persona_id: ControlledPersona
) -> dict:
    latest = workflow_store.latest_enrichment(workspace_id, persona_id)
    if (
        latest["status"] == "complete"
        and latest["provider"] == "responses_api"
        and datetime.fromisoformat(latest["updated_at"])
        >= datetime.now(UTC) - timedelta(minutes=30)
    ):
        return {**latest, "cached": True}
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
                    "relationship_basis": _relationship_bases(
                        author, persona_id, records, members
                    ),
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
                    "relationship_basis": _relationship_bases(author, persona_id, records, members),
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
