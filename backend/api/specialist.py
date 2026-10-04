from __future__ import annotations

from typing import Annotated, Literal

from fastapi import APIRouter, Depends, HTTPException, Request
from pydantic import BaseModel, Field

from backend.demo_workspace import DemoWorkspace, MutableDemoWorkspace
from backend.specialist_projection import (
    project_specialist_case_detail,
    project_specialist_cases,
)
from backend.synthetic_data import PHYSICIANS, synthetic_agent_id
from backend.workflow import workflow_store

router = APIRouter(prefix="/api/workspace/specialist", tags=["specialist-workspace"])

CONTROLLED_SPECIALIST_NPI = "9900000001"
CONTROLLED_SPECIALIST_ID = "physician-jung"
CONTROLLED_SPECIALIST = next(
    profile for profile in PHYSICIANS if profile.id == CONTROLLED_SPECIALIST_ID
)


class SpecialistCalibrationUpdate(BaseModel):
    action: Literal["confirm", "edit", "reject"]
    statement: str | None = Field(default=None, max_length=500)


def controlled_specialist_perspective(request: Request) -> str:
    """Resolve server-owned demo perspective; never accept a client-selected NPI."""
    forbidden_query_keys = {"npi", "specialist_npi", "physician_npi"}
    if forbidden_query_keys.intersection(request.query_params.keys()) or any(
        header in request.headers for header in ("x-specialist-npi", "x-physician-npi")
    ):
        raise HTTPException(400, "Specialist perspective is server controlled")
    return CONTROLLED_SPECIALIST_NPI


ControlledSpecialist = Annotated[str, Depends(controlled_specialist_perspective)]


def _identity() -> dict:
    return {
        "npi": CONTROLLED_SPECIALIST_NPI,
        "physician_id": CONTROLLED_SPECIALIST_ID,
        "physician": "Dr. Iain Jung",
        "specialty": CONTROLLED_SPECIALIST.specialty,
        "location": CONTROLLED_SPECIALIST.location,
        "agent_id": synthetic_agent_id(CONTROLLED_SPECIALIST_ID),
        "agent_name": "Dr. Iain Jung's Agent",
        "synthetic": True,
        "status": "reserved",
        "perspective": "controlled_demo",
        "disclaimer": "Synthetic specialist demo · no PHI",
    }


def _cases(workspace_id: str, specialist_npi: str) -> list[dict]:
    return project_specialist_cases(
        workflow_store.history(workspace_id, limit=200),
        specialist_npi,
        workflow_store.specialist_reviews(workspace_id, specialist_npi),
    )


def _detail(workspace_id: str, specialist_npi: str, record_id: int) -> dict:
    record = workflow_store.consultation(workspace_id, record_id)
    if record is None:
        raise HTTPException(404, "Specialist case not found")
    detail = project_specialist_case_detail(
        record,
        specialist_npi,
        workflow_store.specialist_reviews(workspace_id, specialist_npi),
        workflow_store.specialist_calibrations(workspace_id, specialist_npi),
    )
    if detail is None:
        raise HTTPException(404, "Specialist case not found")
    return detail


@router.get("")
def specialist_workspace(
    workspace_id: DemoWorkspace, specialist_npi: ControlledSpecialist
) -> dict:
    cases = _cases(workspace_id, specialist_npi)
    return {
        "physician": _identity(),
        "recent_cases": cases[:5],
        "latest_case_activity": cases[0]["consulted_at"] if cases else None,
        "recommended_case_count": sum(case["was_recommended"] for case in cases),
        "unreviewed_case_count": sum(not case["reviewed"] for case in cases),
        "case_count": len(cases),
    }


@router.get("/cases")
def specialist_cases(
    workspace_id: DemoWorkspace, specialist_npi: ControlledSpecialist
) -> list[dict]:
    return _cases(workspace_id, specialist_npi)


@router.get("/cases/{record_id}")
def specialist_case(
    record_id: int, workspace_id: DemoWorkspace, specialist_npi: ControlledSpecialist
) -> dict:
    return _detail(workspace_id, specialist_npi, record_id)


@router.put("/cases/{record_id}/review")
def review_specialist_case(
    record_id: int,
    workspace_id: MutableDemoWorkspace,
    specialist_npi: ControlledSpecialist,
) -> dict:
    _detail(workspace_id, specialist_npi, record_id)
    return workflow_store.mark_specialist_case_reviewed(
        workspace_id, record_id, specialist_npi
    )


@router.put("/cases/{record_id}/calibrations/{learning_key}")
def update_specialist_calibration(
    record_id: int,
    learning_key: str,
    update: SpecialistCalibrationUpdate,
    workspace_id: MutableDemoWorkspace,
    specialist_npi: ControlledSpecialist,
) -> dict:
    detail = _detail(workspace_id, specialist_npi, record_id)
    proposal = detail["calibration"]
    if learning_key != proposal["key"]:
        raise HTTPException(404, "Specialist learning not found")
    statement = (update.statement or proposal["statement"]).strip()
    if update.action == "edit" and not update.statement:
        raise HTTPException(422, "Edited statement required")
    if not statement:
        raise HTTPException(422, "Statement cannot be empty")
    status = {
        "confirm": "confirmed",
        "edit": "suggested",
        "reject": "rejected",
    }[update.action]
    workflow_store.update_specialist_calibration(
        workspace_id,
        specialist_npi,
        record_id,
        learning_key,
        statement,
        status,
    )
    return _detail(workspace_id, specialist_npi, record_id)["calibration"]

