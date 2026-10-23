"""Natural-language physician referral preferences: interpret -> review ->
confirm/edit/reject (Part B/F/G/H/I). A DRAFT is never operational -- only
GET endpoints here (and the confirmed_* helpers in
backend.referral_preferences used by the rest of the product) ever read a
CONFIRMED preference."""

from __future__ import annotations

from fastapi import APIRouter, HTTPException

from backend.demo_workspace import DemoWorkspace, MutableDemoWorkspace
from backend.engagement import EDITABLE_PERSONAS, PERSONAS
from backend.models import (
    PhysicianReferralPreference,
    ReferralPreferenceEditRequest,
    ReferralPreferenceInterpretRequest,
    StructuredReferralPreference,
)
from backend.referral_preferences import (
    ensure_seed_preferences,
    merge_modality_clarification,
    referral_preference_interpretation_service,
)
from backend.representation import representation_snapshot_id
from backend.workflow import workflow_store

router = APIRouter(
    prefix="/api/workspace/physician/{persona_id}/referral-preferences",
    tags=["physician-referral-preferences"],
)


def _physician_id(persona_id: str) -> str:
    if persona_id not in EDITABLE_PERSONAS or PERSONAS.get(persona_id, {}).get("physician_id") is None:
        raise HTTPException(status_code=404, detail="This physician does not receive referrals")
    return PERSONAS[persona_id]["physician_id"]


def _as_model(row: dict) -> PhysicianReferralPreference:
    return PhysicianReferralPreference(
        id=row["id"],
        physician_id=row["physician_id"],
        case_family=row["case_family"],
        source_text=row["source_text"],
        structured_rules=_structured(row),
        status=row["status"],
        source=row["source"],
        created_at=row["created_at"],
        updated_at=row["updated_at"],
        confirmed_at=row["confirmed_at"],
        supersedes_id=row.get("supersedes_id"),
        representation_snapshot_id_at_confirmation=row.get(
            "representation_snapshot_id_at_confirmation"
        ),
    )


def _structured(row: dict) -> StructuredReferralPreference:
    return StructuredReferralPreference.model_validate_json(row["structured_rules_json"])


@router.get("", response_model=list[PhysicianReferralPreference])
def list_preferences(persona_id: str, workspace_id: DemoWorkspace) -> list[PhysicianReferralPreference]:
    physician_id = _physician_id(persona_id)
    ensure_seed_preferences(workflow_store, workspace_id)
    return [_as_model(row) for row in workflow_store.list_referral_preferences(workspace_id, physician_id)]


@router.post("/interpret", response_model=PhysicianReferralPreference)
def interpret_preference(
    persona_id: str, request: ReferralPreferenceInterpretRequest, workspace_id: MutableDemoWorkspace
) -> PhysicianReferralPreference:
    """Interpretation NEVER makes anything operational (Part C/F/W) -- this
    always creates a DRAFT row, regardless of how the model/fallback
    resolved the text."""
    physician_id = _physician_id(persona_id)
    specialty = PERSONAS[persona_id]["specialty"]
    case_family, structured, _provider = referral_preference_interpretation_service.interpret(
        request.source_text, specialty, request.case_family
    )
    if request.clarifies == "modality":
        structured = merge_modality_clarification(
            workflow_store.confirmed_referral_preference(workspace_id, physician_id, case_family), structured
        )
    created = workflow_store.create_referral_preference(
        workspace_id,
        physician_id,
        case_family,
        source_text=request.source_text,
        structured_rules_json=structured.model_dump_json(),
        source="physician_authored_nlp",
    )
    return _as_model(created)


@router.patch("/{preference_id}", response_model=PhysicianReferralPreference)
def edit_preference(
    persona_id: str, preference_id: str, request: ReferralPreferenceEditRequest, workspace_id: MutableDemoWorkspace
) -> PhysicianReferralPreference:
    """Structured editing (Part G) -- only while still a draft; a
    confirmed/rejected/superseded preference is immutable history."""
    physician_id = _physician_id(persona_id)
    existing = workflow_store.referral_preference(workspace_id, preference_id)
    if existing is None or existing["physician_id"] != physician_id:
        raise HTTPException(status_code=404, detail="Referral preference not found")
    updated = workflow_store.update_referral_preference_rules(
        workspace_id, preference_id, request.structured_rules.model_dump_json()
    )
    if updated is None:
        raise HTTPException(status_code=409, detail="Only a draft preference can be edited")
    return _as_model(updated)


@router.post("/{preference_id}/confirm", response_model=PhysicianReferralPreference)
def confirm_preference(persona_id: str, preference_id: str, workspace_id: MutableDemoWorkspace) -> PhysicianReferralPreference:
    """The ONLY action that makes a preference operational (Part H) --
    supersedes any prior confirmed preference for the same case family and
    records the representation snapshot id this confirmation produced
    (Part O)."""
    physician_id = _physician_id(persona_id)
    existing = workflow_store.referral_preference(workspace_id, preference_id)
    if existing is None or existing["physician_id"] != physician_id:
        raise HTTPException(status_code=404, detail="Referral preference not found")
    confirmed = workflow_store.confirm_referral_preference(workspace_id, preference_id, None)
    if confirmed is None:
        raise HTTPException(status_code=409, detail="Only a draft preference can be confirmed")
    snapshot_id = representation_snapshot_id(workflow_store, workspace_id, persona_id)
    workflow_store.set_referral_preference_snapshot(workspace_id, preference_id, snapshot_id)
    return _as_model(workflow_store.referral_preference(workspace_id, preference_id))


@router.post("/{preference_id}/reject", response_model=PhysicianReferralPreference)
def reject_preference(persona_id: str, preference_id: str, workspace_id: MutableDemoWorkspace) -> PhysicianReferralPreference:
    physician_id = _physician_id(persona_id)
    existing = workflow_store.referral_preference(workspace_id, preference_id)
    if existing is None or existing["physician_id"] != physician_id:
        raise HTTPException(status_code=404, detail="Referral preference not found")
    rejected = workflow_store.reject_referral_preference(workspace_id, preference_id)
    if rejected is None:
        raise HTTPException(status_code=409, detail="Only a draft preference can be rejected")
    return _as_model(rejected)
