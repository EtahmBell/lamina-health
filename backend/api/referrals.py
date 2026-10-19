from datetime import UTC, datetime

from fastapi import APIRouter, HTTPException

from backend.agents import PHYSICIAN_ACCESS_PROFILES
from backend.demo_identity import LUCY_AGENT_ID, PCP_NAME
from backend.demo_workspace import DemoWorkspace, MutableDemoWorkspace
from backend.models import (
    AccessProfile,
    AgentCorrection,
    AskPhysicianAgentRequest,
    ConsultationEncounter,
    CoordinationActor,
    CoordinationChatAnswer,
    CreateAgentCorrectionRequest,
    DraftHandoffRequest,
    EncounterIngestRequest,
    EncounterResult,
    HandoffResult,
    HandoffStatus,
    HandoffSummary,
    MarkHandoffViewedRequest,
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
    answer_coordination_question,
    authorize_coordination_chat,
    build_referral,
    draft_handoff,
    find_active_referral_for_pair,
    find_scheduling_options,
    ingest_consultation_encounter,
    most_recent_referral_for_pair,
    represented_agent_id,
    route_options_to_scheduling,
    run_preflight,
    send_handoff,
)
from backend.synthetic_data import ALL_PHYSICIANS
from backend.workflow import workflow_store

from .consult import load_patient

router = APIRouter(prefix="/api", tags=["referrals"])
_PHYSICIANS_BY_ID = {physician.id: physician for physician in ALL_PHYSICIANS}


def _referral_party_name(physician_id: str) -> str:
    """Either referral party's display name -- Lucy has no `_PHYSICIANS_BY_ID`
    entry (she is the demo PCP identity, not a directory specialist), so her
    canonical agent id is checked first."""
    if physician_id == LUCY_AGENT_ID:
        return PCP_NAME
    return _physician_display_name(physician_id)


def _physician_or_404(physician_id: str):
    physician = _PHYSICIANS_BY_ID.get(physician_id)
    if physician is None:
        raise HTTPException(status_code=404, detail="Receiving physician not found")
    return physician


def _physician_display_name(physician_id: str) -> str:
    return _physician_or_404(physician_id).name.replace(" (synthetic)", "")


@router.get("/physicians/{physician_id}/capacity", response_model=AccessProfile)
def get_physician_capacity(physician_id: str, _workspace_id: DemoWorkspace) -> AccessProfile:
    """Care-routing demo pass, Part R: a restrained capacity summary (visit
    vs. e-consult channels) for the specialist-side Incoming Requests
    experience -- reads the SAME structured access data the routing/match-
    details UI uses (Part B/K), never a second, independently-maintained
    source. 404 for any physician without a known capacity profile -- never
    a fabricated default."""
    _physician_or_404(physician_id)
    profile = PHYSICIAN_ACCESS_PROFILES.get(physician_id)
    if profile is None:
        raise HTTPException(status_code=404, detail="No capacity profile for this physician")
    return profile


def _load_referral(workspace_id: str, referral_id: int) -> Referral:
    referral = workflow_store.get_referral(workspace_id, referral_id)
    if referral is None:
        raise HTTPException(status_code=404, detail="Referral not found")
    return referral


@router.post("/patients/{patient_id}/referrals", response_model=Referral)
def create_referral(
    patient_id: str, request: ReferralCreateRequest, workspace_id: MutableDemoWorkspace
) -> Referral:
    """Demo-consolidation pass, Part 4/5: an accidental repeat "Start
    referral" for the same patient+receiving physician (e.g. browser back/
    forward landing on a stale Discovery view) must never create a second
    active row -- it idempotently returns the existing active episode
    instead. A legitimate new referral (a new specialty-care episode) is
    only ever created once the prior one for that exact pair has reached
    `consult_returned`, and carries `previous_referral_id` back to it."""
    patient = load_patient(patient_id)
    receiving_physician = _PHYSICIANS_BY_ID.get(request.receiving_physician_id)
    if receiving_physician is None:
        raise HTTPException(status_code=404, detail="Receiving physician not found")
    existing_for_patient = workflow_store.list_referrals(workspace_id, patient_id=patient_id)
    active_existing = find_active_referral_for_pair(existing_for_patient, receiving_physician.id)
    if active_existing is not None:
        return active_existing
    previous_episode = most_recent_referral_for_pair(existing_for_patient, receiving_physician.id)
    referral = build_referral(
        patient, receiving_physician.id, receiving_physician.specialty,
        priority=request.priority or "routine",
        modality=request.modality or "in_person",
        previous_referral_id=previous_episode.id if previous_episode else None,
    )
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
    actually named as this referral's receiving_physician_id may accept it.

    Acceptance also authorizes the automatic scheduling administration that
    follows (automation pass, Part E/F): finding valid availability and
    routing it into the scheduling workflow are purely administrative agent
    work, already authorized the instant the physician accepts, so they run
    immediately here rather than waiting on a second or third click. Both
    steps are idempotent (see find_scheduling_options/route_options_to_
    scheduling), so a rerun/retry of this same endpoint never duplicates
    options or events -- it just confirms the already-persisted state."""
    referral = _load_referral(workspace_id, referral_id)
    if referral.receiving_physician_id != request.receiving_physician_id:
        raise HTTPException(status_code=403, detail="Only the receiving physician can accept this referral")
    receiving_physician = _PHYSICIANS_BY_ID.get(request.receiving_physician_id)
    if receiving_physician is None:
        raise HTTPException(status_code=404, detail="Receiving physician not found")
    physician_name = receiving_physician.name.replace(" (synthetic)", "")
    try:
        updated = accept_referral(referral, receiving_physician.id, physician_name)
    except ValueError as error:
        raise HTTPException(status_code=409, detail=str(error)) from error
    existing_scheduling = workflow_store.get_scheduling(workspace_id, referral_id)
    try:
        scheduling = find_scheduling_options(updated, receiving_physician.id, physician_name, existing_scheduling)
        routed = route_options_to_scheduling(updated, scheduling, receiving_physician.id, physician_name)
    except ValueError:
        # Defensive only -- should not happen immediately after a fresh
        # acceptance; an unexpected scheduling error must never block the
        # acceptance itself from being saved.
        routed = existing_scheduling
    updated = workflow_store.update_referral(workspace_id, updated)
    if routed is not None and routed is not existing_scheduling:
        workflow_store.upsert_scheduling(workspace_id, updated.patient_id, routed)
    return updated


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
    the clinical record.

    Once the encounter is documented, Chen's Agent automatically drafts the
    PCP handoff from it (automation pass, Part I/K) -- the clinical source
    already exists and the agent is only summarizing already-documented
    information, so this is appropriate automation; only drafting (never
    sending) happens without a physician click. Runs only on first ingestion
    (`existing is None`), so a repeat ingest call never re-drafts."""
    referral = _load_referral(workspace_id, referral_id)
    if referral.receiving_physician_id != request.receiving_physician_id:
        raise HTTPException(status_code=403, detail="Only the receiving physician's encounter can be ingested")
    existing = workflow_store.get_encounter(workspace_id, referral_id)
    is_new_encounter = existing is None
    try:
        encounter = ingest_consultation_encounter(referral, request.receiving_physician_id, existing)
    except ValueError as error:
        raise HTTPException(status_code=409, detail=str(error)) from error
    if is_new_encounter:
        encounter = workflow_store.create_encounter(workspace_id, encounter)
        physician_name = _physician_display_name(request.receiving_physician_id)
        handoff = draft_handoff(referral, encounter, request.receiving_physician_id, physician_name, None)
        workflow_store.create_handoff(workspace_id, handoff)
    updated_referral = workflow_store.update_referral(workspace_id, referral)
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


@router.post("/referrals/{referral_id}/handoff/viewed", response_model=HandoffSummary)
def mark_referral_handoff_viewed(
    referral_id: int, request: MarkHandoffViewedRequest, workspace_id: MutableDemoWorkspace
) -> HandoffSummary:
    """Demo-consolidation pass, Part 8/9: a workflow/UI timestamp only -- it
    records that the referring physician actually opened and loaded the
    returned handoff, never a claim that they formally attested to every
    recommendation in it. Only ever set by the referring physician, only
    once the handoff is actually visible to them (status=sent); idempotent
    on an already-viewed handoff, so reopening it never resets the
    timestamp."""
    referral = _load_referral(workspace_id, referral_id)
    if referral.referring_physician_id != request.referring_physician_id:
        raise HTTPException(status_code=403, detail="Only the referring physician can mark this handoff viewed")
    handoff = workflow_store.get_handoff(workspace_id, referral_id)
    if handoff is None or handoff.status != HandoffStatus.SENT:
        raise HTTPException(status_code=409, detail="No sent handoff exists yet for this referral")
    if handoff.viewed_by_referring_physician_at is not None:
        return handoff
    viewed = handoff.model_copy(update={"viewed_by_referring_physician_at": datetime.now(UTC).isoformat()})
    return workflow_store.update_handoff(workspace_id, viewed)


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


# --------------------------------------------------------------------------
# Physician-agent-to-physician-agent coordination chat (demo-consolidation
# pass, Part 16-21): a patient-scoped channel between the two physicians on
# an accepted referral. Deliberately stateless/task-scoped server-side --
# nothing here is persisted, so there is no shared thread, no GET endpoint,
# and no risk of one physician's questions leaking into the other's view
# (the bug this pass fixes). Each request is answered fresh from the real
# persisted referral/encounter/handoff/scheduling artifacts.
# --------------------------------------------------------------------------


def _other_referral_party(referral: Referral, physician_id: str) -> str:
    if physician_id == referral.referring_physician_id:
        return referral.receiving_physician_id
    if physician_id == referral.receiving_physician_id:
        return referral.referring_physician_id
    raise HTTPException(status_code=403, detail="Only the two physicians on this referral may use this channel")


@router.post("/referrals/{referral_id}/coordination-chat", response_model=CoordinationChatAnswer)
def ask_physician_agent(
    referral_id: int, request: AskPhysicianAgentRequest, workspace_id: MutableDemoWorkspace
) -> CoordinationChatAnswer:
    referral = _load_referral(workspace_id, referral_id)
    represented_physician_id = _other_referral_party(referral, request.requesting_physician_id)
    try:
        authorize_coordination_chat(referral, request.requesting_physician_id, represented_physician_id)
    except ValueError as error:
        raise HTTPException(status_code=403, detail=str(error)) from error
    scheduling = workflow_store.get_scheduling(workspace_id, referral_id)
    encounter = workflow_store.get_encounter(workspace_id, referral_id)
    handoff = workflow_store.get_handoff(workspace_id, referral_id)
    represented_name = _referral_party_name(represented_physician_id)
    answer, based_on, requires_physician_input = answer_coordination_question(
        referral, scheduling, encounter, handoff,
        request.requesting_physician_id, represented_physician_id, represented_name, request.question,
    )
    return CoordinationChatAnswer(
        answer=answer,
        based_on=based_on,
        requires_physician_input=requires_physician_input,
        represented_agent_id=represented_agent_id(represented_physician_id),
        created_at=datetime.now(UTC).isoformat(),
    )


# --------------------------------------------------------------------------
# Agent corrections (demo-consolidation pass, Part 23-31): a durable,
# physician-authored artifact, separate from the ephemeral chat above and
# never mutating the immutable CoordinationEvent audit trail. A physician
# may only correct an event generated by THEIR OWN agent (Part 28).
# --------------------------------------------------------------------------


def _correctable_event_owner(referral: Referral, sequence: int) -> str:
    """Which physician owns the agent that generated this coordination
    event -- only `referring_agent`/`receiving_agent` events are
    correctable at all (system/receiving_physician/scheduling_workflow
    events are not "an agent's" independent behavior)."""
    event = next((item for item in referral.coordination_events if item.sequence == sequence), None)
    if event is None:
        raise HTTPException(status_code=404, detail="Coordination event not found")
    if event.actor == CoordinationActor.REFERRING_AGENT:
        return referral.referring_physician_id
    if event.actor == CoordinationActor.RECEIVING_AGENT:
        return referral.receiving_physician_id
    raise HTTPException(status_code=403, detail="This event was not generated by a correctable agent")


@router.post("/patients/{patient_id}/corrections", response_model=AgentCorrection)
def create_agent_correction(
    patient_id: str, request: CreateAgentCorrectionRequest, workspace_id: MutableDemoWorkspace
) -> AgentCorrection:
    """Physicians train their own agents, never each other's (Part 28). When
    `referral_id`/`source_event_sequence` are given, ownership is verified
    against the real coordination event; a bare match-recommendation
    correction (no referral/event yet) is inherently self-correction, so no
    cross-physician check applies."""
    if request.referral_id is not None and request.source_event_sequence is not None:
        referral = _load_referral(workspace_id, request.referral_id)
        if referral.patient_id != patient_id:
            raise HTTPException(status_code=404, detail="Referral does not belong to this patient")
        owner = _correctable_event_owner(referral, request.source_event_sequence)
        if owner != request.physician_id:
            raise HTTPException(status_code=403, detail="A physician may only correct their own agent")
    correction = AgentCorrection(
        physician_id=request.physician_id,
        agent_id=represented_agent_id(request.physician_id),
        patient_id=patient_id,
        referral_id=request.referral_id,
        source_event_sequence=request.source_event_sequence,
        selected_text=request.selected_text,
        correction_text=request.correction_text,
        created_at=datetime.now(UTC).isoformat(),
    )
    return workflow_store.create_correction(workspace_id, patient_id, correction)


@router.get("/patients/{patient_id}/corrections", response_model=list[AgentCorrection])
def list_agent_corrections(patient_id: str, workspace_id: DemoWorkspace) -> list[AgentCorrection]:
    return workflow_store.list_corrections(workspace_id, patient_id)
