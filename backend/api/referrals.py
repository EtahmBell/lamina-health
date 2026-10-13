from fastapi import APIRouter, HTTPException

from backend.demo_workspace import DemoWorkspace, MutableDemoWorkspace
from backend.models import Referral, ReferralAcceptRequest, ReferralCreateRequest, ReferralStatus
from backend.referrals import accept_referral, build_referral, run_preflight
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


@router.get("/patients/{patient_id}/referrals/active", response_model=Referral | None)
def get_active_referral(patient_id: str, workspace_id: DemoWorkspace) -> Referral | None:
    """The patient-level hydration lookup: "does this patient already have a
    referral in flight (or completed)?" so Patient Detail can restore the
    real persisted state after a reload instead of reverting to the
    recommendation/Start-referral state. Returns the most recently created
    referral for this patient, or null if none exists -- never a 404, since
    "no referral yet" is the normal state for every patient."""
    referrals = workflow_store.list_referrals(workspace_id, patient_id=patient_id)
    return referrals[-1] if referrals else None


@router.post("/referrals/{referral_id}/preflight", response_model=Referral)
def run_referral_preflight(referral_id: int, workspace_id: MutableDemoWorkspace) -> Referral:
    referral = _load_referral(workspace_id, referral_id)
    patient = load_patient(referral.patient_id)
    updated = run_preflight(patient, referral)
    return workflow_store.update_referral(workspace_id, updated)


@router.post("/referrals/{referral_id}/accept", response_model=Referral)
def accept_referral_endpoint(
    referral_id: int, request: ReferralAcceptRequest, workspace_id: MutableDemoWorkspace
) -> Referral:
    """A real physician action (Part D/O) -- never implied by preflight
    completing or by the referral merely being submitted. Only the physician
    actually named as this referral's receiving_physician_id may accept it."""
    referral = _load_referral(workspace_id, referral_id)
    if referral.receiving_physician_id != request.receiving_physician_id:
        raise HTTPException(status_code=403, detail="Only the receiving physician can accept this referral")
    receiving_physician = _PHYSICIANS_BY_ID.get(request.receiving_physician_id)
    if receiving_physician is None:
        raise HTTPException(status_code=404, detail="Receiving physician not found")
    try:
        updated = accept_referral(
            referral, receiving_physician.id, receiving_physician.name.replace(" (synthetic)", "")
        )
    except ValueError as error:
        raise HTTPException(status_code=409, detail=str(error)) from error
    return workflow_store.update_referral(workspace_id, updated)


@router.get("/physicians/{physician_id}/referrals", response_model=list[Referral])
def list_physician_referrals(
    physician_id: str, workspace_id: DemoWorkspace, status: ReferralStatus | None = None
) -> list[Referral]:
    """The receiving-physician query (Part V): ?status=submitted drives
    Incoming requests, ?status=accepted drives the physician's accepted
    patient list -- both are the same persisted referrals, filtered
    differently, never a separate frontend fixture."""
    return workflow_store.list_referrals(
        workspace_id,
        receiving_physician_id=physician_id,
        status=status.value if status else None,
    )
