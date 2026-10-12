from fastapi import APIRouter, HTTPException

from backend.demo_workspace import MutableDemoWorkspace
from backend.models import Referral, ReferralCreateRequest
from backend.referrals import build_referral, run_preflight
from backend.synthetic_data import ALL_PHYSICIANS
from backend.workflow import workflow_store

from .consult import load_patient

router = APIRouter(prefix="/api", tags=["referrals"])
_PHYSICIANS_BY_ID = {physician.id: physician for physician in ALL_PHYSICIANS}


def _load_referral(workspace_id: str, referral_id: int) -> Referral:
    referral = workflow_store.get_referral(workspace_id, referral_id)
    if referral is None:
        raise HTTPException(status_code=404, detail="Referral not found")
    return referral


@router.post("/patients/{patient_id}/referrals", response_model=Referral)
def create_referral(
    patient_id: str, request: ReferralCreateRequest, workspace_id: MutableDemoWorkspace
) -> Referral:
    patient = load_patient(patient_id)
    receiving_physician = _PHYSICIANS_BY_ID.get(request.receiving_physician_id)
    if receiving_physician is None:
        raise HTTPException(status_code=404, detail="Receiving physician not found")
    referral = build_referral(patient, receiving_physician.id, receiving_physician.specialty)
    return workflow_store.create_referral(workspace_id, referral)


@router.get("/referrals/{referral_id}", response_model=Referral)
def get_referral(referral_id: int, workspace_id: MutableDemoWorkspace) -> Referral:
    return _load_referral(workspace_id, referral_id)


@router.post("/referrals/{referral_id}/preflight", response_model=Referral)
def run_referral_preflight(referral_id: int, workspace_id: MutableDemoWorkspace) -> Referral:
    referral = _load_referral(workspace_id, referral_id)
    patient = load_patient(referral.patient_id)
    updated = run_preflight(patient, referral)
    return workflow_store.update_referral(workspace_id, updated)
