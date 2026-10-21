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
from backend.eval_harness import (
    EVAL_CASES_BY_PHYSICIAN,
    representation_snapshot_id,
    run_eval_case_repeated,
    run_eval_suite,
)
from backend.engagement import PERSONA_BY_PHYSICIAN_ID
from backend.models import PhysicianAgentEvalCase, PhysicianAgentEvalRun, PhysicianAgentEvalSuiteResult
from backend.synthetic_data import ALL_PHYSICIANS
from backend.workflow import workflow_store

_MAX_REPEAT = 10

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


@router.post("/physicians/{physician_id}/cases/{case_id}/run", response_model=list[PhysicianAgentEvalRun])
def run_eval_case_endpoint(
    physician_id: str, case_id: str, workspace_id: DemoWorkspace, times: int = 1
) -> list[PhysicianAgentEvalRun]:
    """Part F: per-case repeated-run inspection (e.g. "Run 5 times" for a
    model-dependent case) -- deliberately scoped to one case, never the
    whole suite, so this stays a small opt-in cost."""
    case = next((item for item in EVAL_CASES_BY_PHYSICIAN.get(physician_id, []) if item.id == case_id), None)
    if case is None:
        raise HTTPException(404, "No such evaluation case for this physician")
    bounded_times = max(1, min(times, _MAX_REPEAT))
    return run_eval_case_repeated(case, workflow_store, workspace_id, bounded_times)
