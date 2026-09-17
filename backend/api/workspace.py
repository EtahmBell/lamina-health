from __future__ import annotations

from typing import Literal

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field

from backend.network_projection import project_agent_network
from backend.provider_network import provider_network
from backend.synthetic_data import PATIENTS
from backend.workflow import workflow_store

router = APIRouter(prefix="/api/workspace", tags=["clinician-workspace"])

AGENT_ID = "agent-pcp-lianne-cha"
LEARNINGS = {
    "renal": "Progressive CKD with resistant hypertension usually leads to nephrology first.",
    "anaemia": "Persistent iron deficiency without GI source evaluation usually leads to gastroenterology first.",
}
CALIBRATIONS = {
    "renal": {
        "question": "When would you send resistant hypertension to nephrology instead of cardiology?",
        "answer": "When renal function is progressively declining, nephrology evaluates first; hypertension cardiology can follow or co-manage.",
        "based_on": ["Current synthetic consultation rule", "Jordan Lee consultation facts"],
    },
    "anaemia": {
        "question": "What kind of anaemia case would you send to GI before haematology?",
        "answer": "Persistent iron deficiency without documented source evaluation goes to gastroenterology first. Haematology remains relevant if deficiency persists or IV iron is needed.",
        "based_on": ["Current synthetic consultation rule", "Maria Santos consultation facts"],
    },
}


class PreferenceUpdate(BaseModel):
    action: Literal["confirm", "edit", "reject"]
    statement: str | None = Field(default=None, max_length=240)


@router.get("/agent")
def my_agent() -> dict:
    saved = {item["key"]: item for item in workflow_store.preferences()}
    return {
        "id": AGENT_ID, "physician": "Dr. Lianne Cha", "specialty": "Primary Care",
        "status": "active", "synthetic": True, "location": "Oakland, CA (synthetic demo)",
        "known": [
            {"label": "Specialty", "value": "Primary Care", "source": "Configured synthetic demo profile"},
            {"label": "Practice location", "value": "Oakland, CA", "source": "Configured synthetic demo profile"},
            {"label": "Clinical focus", "value": "Specialty-care coordination", "source": "Configured synthetic demo profile"},
            {"label": "Referral pathways", "value": "Nephrology for progressive CKD; GI source evaluation before haematology for persistent iron deficiency", "source": "Current synthetic consultation rules · not physician-confirmed"},
            *[{"label": "Confirmed preference", "value": item["statement"], "source": item["provenance"]}
              for item in saved.values() if item["status"] == "confirmed"],
        ],
        "access": [
            {"label": "Public physician identity", "detail": "NPPES directory only; not proof of participation"},
            {"label": "Physician-defined preferences", "detail": "Local demo preferences enabled"},
            {"label": "Patient clinical context", "detail": "Bounded synthetic Medplum/FHIR or offline fixture context during consult"},
            {"label": "Consultation history", "detail": "Completed Lamina demo consultations"},
            {"label": "Scheduling", "detail": "Not connected"},
            {"label": "Insurance", "detail": "Synthetic demo data only"},
        ],
        "learnings": [
            saved.get(key) or {"key": key, "statement": statement,
                               "provenance": "Suggested from synthetic consultation rules · not confirmed",
                               "status": "suggested", "updated_at": None}
            for key, statement in LEARNINGS.items()
        ],
        "calibrations": CALIBRATIONS,
    }


@router.put("/agent/learnings/{key}")
def update_learning(key: str, update: PreferenceUpdate) -> dict:
    if key not in LEARNINGS:
        raise HTTPException(404, "Unknown demo learning")
    saved = {item["key"]: item for item in workflow_store.preferences()}
    statement = (update.statement or saved.get(key, {}).get("statement") or LEARNINGS[key]).strip()
    if update.action == "edit" and not update.statement:
        raise HTTPException(422, "Edited statement required")
    if not statement:
        raise HTTPException(422, "Statement cannot be empty")
    return workflow_store.update_preference(
        key, statement, "confirmed" if update.action == "confirm" else (
            "rejected" if update.action == "reject" else "suggested"
        )
    )


@router.get("/activity")
def patient_activity() -> list[dict]:
    return workflow_store.activity(list(PATIENTS))


@router.get("/network")
def agent_network() -> dict:
    return project_agent_network(workflow_store.history(limit=200), provider_network)


@router.get("/consultations")
def consultation_history() -> list[dict]:
    return workflow_store.history()


@router.get("/consultations/{record_id}")
def saved_consultation(record_id: int) -> dict:
    record = workflow_store.consultation(record_id)
    if record is None:
        raise HTTPException(404, "Consultation record not found")
    return record
