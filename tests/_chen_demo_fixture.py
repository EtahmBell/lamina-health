"""Shared test helper (demo-coherence causality fix): reproduces exactly
what Dr. Chen's real NLP teaching step does -- interpret, then confirm --
for tests that need his baseline diabetes referral preference to already
be confirmed before exercising some other behavior. Deliberately NOT a
product-level shortcut: see backend.referral_preferences.
ensure_seed_preferences' docstring for why the old auto-migration that used
to do this implicitly was removed. Any test that wants Chen's baseline
confirmed should call this explicitly, the same way a physician actually
would.
"""

from __future__ import annotations

from backend.referral_preferences import CHEN_SEED_CASE_FAMILY, deterministic_interpret
from backend.representation import representation_snapshot_id
from backend.synthetic_data import PHYSICIAN_CHEN
from backend.workflow import WorkflowStore

CHEN_ID = PHYSICIAN_CHEN.id

CHEN_DEMO_SOURCE_TEXT = (
    "For diabetes referrals, I usually need a recent A1c, current diabetes medications, "
    "and recent kidney function. Glucose logs or CGM are useful when available, but aren't "
    "required. I commonly see patients whose diabetes remains poorly controlled despite "
    "treatment escalation."
)


def teach_and_confirm_chen_baseline(workflow_store: WorkflowStore, workspace_id: str) -> dict:
    """Runs CHEN_DEMO_SOURCE_TEXT through the same deterministic fallback
    interpreter the real NLP flow uses, then confirms the result -- exactly
    the causal sequence the product itself requires (interpret -> review ->
    confirm), never a direct database shortcut that skips it."""
    structured = deterministic_interpret(CHEN_DEMO_SOURCE_TEXT, CHEN_SEED_CASE_FAMILY)
    created = workflow_store.create_referral_preference(
        workspace_id, CHEN_ID, CHEN_SEED_CASE_FAMILY, CHEN_DEMO_SOURCE_TEXT,
        structured.model_dump_json(), "physician_authored_nlp",
    )
    workflow_store.confirm_referral_preference(workspace_id, created["id"], None)
    snapshot_id = representation_snapshot_id(workflow_store, workspace_id, "chen")
    workflow_store.set_referral_preference_snapshot(workspace_id, created["id"], snapshot_id)
    return workflow_store.referral_preference(workspace_id, created["id"])


def document_chen_consultation(workflow_store: WorkflowStore, workspace_id: str, referral_id: int = 900) -> None:
    """Demo hardening pass, Part B: the authoritative "recent work" event
    for the e-consult clarification -- a completed Endocrinology encounter
    Dr. Chen documented for Tonjit. Mirrors what the synthetic encounter
    simulation persists; cleared by the Tonjit demo reset like any other
    Tonjit encounter."""
    from backend.models import ConsultationEncounter
    from backend.synthetic_data import TONJIT_PATIENT_ID

    workflow_store.create_encounter(workspace_id, ConsultationEncounter(
        referral_id=referral_id,
        patient_id=TONJIT_PATIENT_ID,
        physician_id=CHEN_ID,
        specialty="Endocrinology",
        occurred_at="2026-10-20T10:00:00",
        assessment="Synthetic assessment.",
        plan="Synthetic plan.",
        follow_up="Synthetic follow-up.",
        created_at="2026-10-20T10:00:00",
    ))
