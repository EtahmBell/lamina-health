from fastapi import APIRouter, HTTPException

from backend.demo_workspace import DemoWorkspace, MutableDemoWorkspace
from backend.models import (
    ConsultationEncounter,
    DraftHandoffRequest,
    EncounterIngestRequest,
    EncounterResult,
    HandoffResult,
    HandoffStatus,
    HandoffSummary,
    Referral,
    ReferralAcceptRequest,
    ReferralCreateRequest,
    ReferralStatus,
    RouteSchedulingRequest,
    SchedulingCoordination,
    SchedulingOptionsRequest,
    SchedulingOptionsResult,
    SendHandoffRequest,
)
from backend.referrals import (
    accept_referral,
    build_referral,
    draft_handoff,
    find_scheduling_options,
    ingest_consultation_encounter,
    route_options_to_scheduling,
    run_preflight,
    send_handoff,
)
from backend.synthetic_data import ALL_PHYSICIANS
from backend.workflow import workflow_store

from .consult import load_patient

router = APIRouter(prefix="/api", tags=["referrals"])
_PHYSICIANS_BY_ID = {physician.id: physician for physician in ALL_PHYSICIANS}


def _physician_or_404(physician_id: str):
    physician = _PHYSICIANS_BY_ID.get(physician_id)
    if physician is None:
        raise HTTPException(status_code=404, detail="Receiving physician not found")
    return physician


def _physician_display_name(physician_id: str) -> str:
    return _physician_or_404(physician_id).name.replace(" (synthetic)", "")


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


# --------------------------------------------------------------------------
# Downstream coordination (closed-loop referral pass 3): scheduling, the
# externally-ingested consultation encounter, and the specialist-to-PCP
# handoff. Each has its own narrow read/write surface -- never crammed into
# the referral endpoints above.
# --------------------------------------------------------------------------


@router.post("/referrals/{referral_id}/scheduling/options", response_model=SchedulingOptionsResult)
def find_referral_scheduling_options(
    referral_id: int, request: SchedulingOptionsRequest, workspace_id: MutableDemoWorkspace
) -> SchedulingOptionsResult:
    referral = _load_referral(workspace_id, referral_id)
    if referral.receiving_physician_id != request.receiving_physician_id:
        raise HTTPException(status_code=403, detail="Only the receiving physician can find scheduling options")
    physician_name = _physician_display_name(request.receiving_physician_id)
    existing = workflow_store.get_scheduling(workspace_id, referral_id)
    try:
        scheduling = find_scheduling_options(referral, request.receiving_physician_id, physician_name, existing)
    except ValueError as error:
        raise HTTPException(status_code=409, detail=str(error)) from error
    updated_referral = workflow_store.update_referral(workspace_id, referral)
    if existing is None:
        scheduling = workflow_store.upsert_scheduling(workspace_id, referral.patient_id, scheduling)
    return SchedulingOptionsResult(referral=updated_referral, scheduling=scheduling)


@router.post("/referrals/{referral_id}/scheduling/route", response_model=SchedulingOptionsResult)
def route_referral_scheduling_options(
    referral_id: int, request: RouteSchedulingRequest, workspace_id: MutableDemoWorkspace
) -> SchedulingOptionsResult:
    referral = _load_referral(workspace_id, referral_id)
    if referral.receiving_physician_id != request.receiving_physician_id:
        raise HTTPException(status_code=403, detail="Only the receiving physician can route scheduling options")
    physician_name = _physician_display_name(request.receiving_physician_id)
    existing = workflow_store.get_scheduling(workspace_id, referral_id)
    if existing is None:
        raise HTTPException(status_code=404, detail="No scheduling options exist yet for this referral")
    try:
        routed = route_options_to_scheduling(referral, existing, request.receiving_physician_id, physician_name)
    except ValueError as error:
        raise HTTPException(status_code=409, detail=str(error)) from error
    updated_referral = workflow_store.update_referral(workspace_id, referral)
    routed = workflow_store.upsert_scheduling(workspace_id, referral.patient_id, routed)
    return SchedulingOptionsResult(referral=updated_referral, scheduling=routed)


@router.get("/referrals/{referral_id}/scheduling", response_model=SchedulingCoordination | None)
def get_referral_scheduling(referral_id: int, workspace_id: DemoWorkspace) -> SchedulingCoordination | None:
    return workflow_store.get_scheduling(workspace_id, referral_id)


@router.post("/referrals/{referral_id}/encounter/ingest", response_model=EncounterResult)
def ingest_referral_encounter(
    referral_id: int, request: EncounterIngestRequest, workspace_id: MutableDemoWorkspace
) -> EncounterResult:
    """Demo-only control (Settings & Demo), never a normal Chen clinical
    button (Part C/R) -- simulates a real EHR/Medplum encounter arriving in
    the clinical record."""
    referral = _load_referral(workspace_id, referral_id)
    if referral.receiving_physician_id != request.receiving_physician_id:
        raise HTTPException(status_code=403, detail="Only the receiving physician's encounter can be ingested")
    existing = workflow_store.get_encounter(workspace_id, referral_id)
    try:
        encounter = ingest_consultation_encounter(referral, request.receiving_physician_id, existing)
    except ValueError as error:
        raise HTTPException(status_code=409, detail=str(error)) from error
    updated_referral = workflow_store.update_referral(workspace_id, referral)
    if existing is None:
        encounter = workflow_store.create_encounter(workspace_id, encounter)
    return EncounterResult(referral=updated_referral, encounter=encounter)


@router.get("/referrals/{referral_id}/encounter", response_model=ConsultationEncounter | None)
def get_referral_encounter(referral_id: int, workspace_id: DemoWorkspace) -> ConsultationEncounter | None:
    return workflow_store.get_encounter(workspace_id, referral_id)


@router.post("/referrals/{referral_id}/handoff/draft", response_model=HandoffResult)
def draft_referral_handoff(
    referral_id: int, request: DraftHandoffRequest, workspace_id: MutableDemoWorkspace
) -> HandoffResult:
    referral = _load_referral(workspace_id, referral_id)
    if referral.receiving_physician_id != request.receiving_physician_id:
        raise HTTPException(status_code=403, detail="Only the receiving physician's agent can draft this handoff")
    encounter = workflow_store.get_encounter(workspace_id, referral_id)
    if encounter is None:
        raise HTTPException(status_code=409, detail="No documented consultation encounter exists yet")
    physician_name = _physician_display_name(request.receiving_physician_id)
    existing = workflow_store.get_handoff(workspace_id, referral_id)
    try:
        handoff = draft_handoff(referral, encounter, request.receiving_physician_id, physician_name, existing)
    except ValueError as error:
        raise HTTPException(status_code=409, detail=str(error)) from error
    updated_referral = workflow_store.update_referral(workspace_id, referral)
    if existing is None:
        handoff = workflow_store.create_handoff(workspace_id, handoff)
    return HandoffResult(referral=updated_referral, handoff=handoff)


@router.get("/referrals/{referral_id}/handoff", response_model=HandoffSummary | None)
def get_referral_handoff(
    referral_id: int, workspace_id: DemoWorkspace, as_physician_id: str | None = None
) -> HandoffSummary | None:
    """The one access-gated read in this whole domain (Part AP): a draft
    handoff is only visible to the receiving physician who authored it --
    the referring side never sees it until it is actually sent. There is no
    real authentication in this demo, so `as_physician_id` is the explicit
    "acting as" identity, the same convention every write endpoint already
    uses for `receiving_physician_id`. Looks up the handoff first and only
    loads the referral when a draft actually needs gating, so this stays a
    safe `None` after a reset even though the referral row is also gone by
    then."""
    handoff = workflow_store.get_handoff(workspace_id, referral_id)
    if handoff is None:
        return None
    if handoff.status == HandoffStatus.SENT:
        return handoff
    referral = workflow_store.get_referral(workspace_id, referral_id)
    if referral is not None and as_physician_id == referral.receiving_physician_id:
        return handoff
    return None


@router.post("/referrals/{referral_id}/handoff/send", response_model=HandoffResult)
def send_referral_handoff(
    referral_id: int, request: SendHandoffRequest, workspace_id: MutableDemoWorkspace
) -> HandoffResult:
    referral = _load_referral(workspace_id, referral_id)
    if referral.receiving_physician_id != request.receiving_physician_id:
        raise HTTPException(status_code=403, detail="Only the receiving physician can send this handoff")
    existing = workflow_store.get_handoff(workspace_id, referral_id)
    if existing is None:
        raise HTTPException(status_code=404, detail="No handoff draft exists yet for this referral")
    physician_name = _physician_display_name(request.receiving_physician_id)
    try:
        sent = send_handoff(referral, existing, request.receiving_physician_id, physician_name)
    except ValueError as error:
        raise HTTPException(status_code=409, detail=str(error)) from error
    updated_referral = workflow_store.update_referral(workspace_id, referral)
    sent = workflow_store.update_handoff(workspace_id, sent)
    return HandoffResult(referral=updated_referral, handoff=sent)
