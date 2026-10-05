from __future__ import annotations

from typing import Annotated, Literal

from fastapi import APIRouter, Depends, HTTPException, Query, Request
from pydantic import BaseModel, Field

from backend.demo_workspace import DemoWorkspace, MutableDemoWorkspace
from backend.engagement import (
    EDITABLE_PERSONAS,
    PERSONAS,
    PROFILE_CATEGORIES,
    SYNTHETIC_FEED_FIXTURES,
    profile_update_draft,
    project_practice_representation,
    project_professional_profile,
    project_training_questions,
    proposed_learning_statement,
    question_by_id,
    related_personas,
)
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
        persona_id, workflow_store.profile_items(workspace_id, persona_id)
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
    )


def _require_update_type(update_type: str) -> None:
    if update_type not in UPDATE_TYPES:
        raise HTTPException(422, "Unsupported practice update type")


@router.get("/physician/profile")
def professional_profile(
    workspace_id: DemoWorkspace, persona_id: ControlledPersona
) -> dict:
    return _profile(workspace_id, persona_id)


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
def agent_representation(
    workspace_id: DemoWorkspace, persona_id: ControlledPersona
) -> dict:
    return _representation(workspace_id, persona_id)


@router.get("/physician/training")
def training_queue(workspace_id: DemoWorkspace, persona_id: ControlledPersona) -> dict:
    return {
        "physician": PERSONAS[persona_id],
        "questions": _questions(workspace_id, persona_id),
        "sessions": workflow_store.training_sessions(workspace_id, persona_id),
        "responses": workflow_store.training_responses(workspace_id, persona_id),
        "proposed_learnings": workflow_store.proposed_learnings(workspace_id, persona_id),
    }


@router.post("/physician/training/sessions", status_code=201)
def start_training_session(
    workspace_id: MutableDemoWorkspace, persona_id: ControlledPersona
) -> dict:
    session = workflow_store.start_training_session(workspace_id, persona_id)
    session["questions"] = [
        question
        for question in _questions(workspace_id, persona_id)
        if question["status"] == "unanswered"
    ]
    session["responses"] = []
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
    return workflow_store.save_training_response(
        workspace_id, persona_id, session_id, question_id, answer, update.skipped
    )


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


@router.get("/physician/updates")
def physician_updates(
    workspace_id: DemoWorkspace, persona_id: ControlledPersona
) -> list[dict]:
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
    profile = project_professional_profile(controlled_id, overlays)
    profile["items"] = [item for item in profile["items"] if item["shareable"]]
    profile["sections"] = {
        category: [item for item in items if item["shareable"]]
        for category, items in profile["sections"].items()
    }
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
        ],
        "disclaimer": "Controlled synthetic physician profile · no private calibration or patient data",
    }

