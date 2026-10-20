"""Physician-agent evaluation harness API (pre-NLP foundational pass).

Read-only / zero-side-effect by construction (Part N): every endpoint here
either lists static seed cases or runs backend.eval_harness.run_eval_suite,
which never writes to workflow_store. This is a developer/demo inspection
surface (Part S), never a new top-level product navigation item and never
patient-facing.
"""

from __future__ import annotations

from fastapi import APIRouter, HTTPException

from backend.demo_workspace import DemoWorkspace
from backend.eval_harness import EVAL_CASES_BY_PHYSICIAN, representation_snapshot_id, run_eval_suite
from backend.engagement import PERSONA_BY_PHYSICIAN_ID
from backend.models import PhysicianAgentEvalCase, PhysicianAgentEvalSuiteResult
from backend.synthetic_data import ALL_PHYSICIANS
from backend.workflow import workflow_store

router = APIRouter(prefix="/api/workspace/eval", tags=["physician-agent-evaluation"])

_PHYSICIANS_BY_ID = {profile.id: profile for profile in ALL_PHYSICIANS}


@router.get("/physicians")
def list_eval_physicians(workspace_id: DemoWorkspace) -> list[dict]:
    return [
        {
            "physician_id": physician_id,
            "name": _PHYSICIANS_BY_ID[physician_id].name.replace(" (synthetic)", ""),
            "specialty": _PHYSICIANS_BY_ID[physician_id].specialty,
            "case_count": len(cases),
            "representation_snapshot_id": representation_snapshot_id(
                workflow_store, workspace_id, PERSONA_BY_PHYSICIAN_ID.get(physician_id, physician_id)
            ),
        }
        for physician_id, cases in EVAL_CASES_BY_PHYSICIAN.items()
        if physician_id in _PHYSICIANS_BY_ID
    ]


@router.get("/physicians/{physician_id}/cases", response_model=list[PhysicianAgentEvalCase])
def list_eval_cases(physician_id: str) -> list[PhysicianAgentEvalCase]:
    if physician_id not in EVAL_CASES_BY_PHYSICIAN:
        raise HTTPException(404, "No evaluation cases seeded for this physician")
    return EVAL_CASES_BY_PHYSICIAN[physician_id]


@router.post("/physicians/{physician_id}/run", response_model=PhysicianAgentEvalSuiteResult)
def run_eval_physician_suite(physician_id: str, workspace_id: DemoWorkspace) -> PhysicianAgentEvalSuiteResult:
    if physician_id not in EVAL_CASES_BY_PHYSICIAN:
        raise HTTPException(404, "No evaluation cases seeded for this physician")
    return run_eval_suite(physician_id, workflow_store, workspace_id)
