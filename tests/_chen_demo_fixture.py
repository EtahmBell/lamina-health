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
