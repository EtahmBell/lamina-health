"""Pure referral domain logic: build the initial referral, and run preflight.

Deliberately mirrors backend/agents/orchestrator.py's shape -- these functions
take/return plain domain objects and never touch persistence themselves. The
API layer (backend/api/referrals.py) is the only place that talks to
WorkflowStore, exactly like backend/api/consult.py does for consult_network().
"""

from __future__ import annotations

from datetime import UTC, datetime

from backend.clinical import build_patient_context
from backend.demo_identity import LUCY_AGENT_ID, PCP_NAME
from backend.models import (
    AutonomyLevel,
    CareModality,
    ConsultationEncounter,
    CoordinationActor,
    CoordinationEvent,
    CoordinationEventType,
    HandoffStatus,
    HandoffSummary,
    MedicationChange,
    MedicationChangeRecord,
    PatientRecord,
    Referral,
    ReferralPriority,
    ReferralRequirement,
    ReferralStatus,
    RequirementStatus,
    SchedulingCoordination,
    SchedulingStatus,
)
from backend.synthetic_data import synthetic_agent_id

from .packet import assemble_initial_packet
from .requirements import evaluate_requirements, requirements_for
from .resolver import resolve_missing_requirement
from .scheduling import open_slots, synthetic_chen_availability


def _now() -> str:
    return datetime.now(UTC).isoformat(timespec="seconds")


def _append_event(
    referral: Referral,
    *,
    event_type: CoordinationEventType,
    summary: str,
    actor: CoordinationActor | None = None,
    autonomy: AutonomyLevel | None = None,
    metadata: dict[str, str | int | bool] | None = None,
) -> None:
    sequence = referral.coordination_events[-1].sequence + 1 if referral.coordination_events else 1
    referral.coordination_events.append(
        CoordinationEvent(
            sequence=sequence,
            event_type=event_type,
            actor=actor,
            autonomy=autonomy,
            summary=summary,
            metadata=metadata or {},
            created_at=_now(),
        )
    )


_PRIORITY_URGENCY_TEXT: dict[ReferralPriority, str] = {
    "routine": "Routine outpatient referral",
    "soon": "Soon outpatient referral",
    "urgent": "Urgent outpatient referral",
}


def build_referral(
    patient: PatientRecord,
    receiving_physician_id: str,
    specialty: str,
    *,
    referring_physician_id: str = LUCY_AGENT_ID,
    priority: ReferralPriority = "routine",
    modality: CareModality = "in_person",
    previous_referral_id: int | None = None,
    requirement_override: list[ReferralRequirement] | None = None,
) -> Referral:
    """Create a new referral and assemble its initial packet. Does not persist.

    `previous_referral_id` (demo-consolidation pass, Part 5) links a
    legitimate later re-referral to the same physician back to the prior
    completed episode -- a referral IS a specialty-care episode, so this is
    the only lineage pointer needed; the API layer is responsible for only
    ever passing this when the prior episode actually reached a terminal
    state (see find_active_referral_for_pair's duplicate-guard counterpart).

    `priority` (care-routing demo pass, Part E) is whatever the referring
    physician explicitly confirmed/edited before creating this referral --
    never silently upgraded here. `urgency` (pre-existing, otherwise unused
    free text) is derived from it only for a readable referral_question
    companion string; readiness/packet assembly below never reads either.

    `requirement_override` (NLP referral-preference pass, Part J) is the
    receiving physician's own CONFIRMED persisted referral preference's
    required/helpful items for this case family, looked up by the caller
    (backend/api/referrals.py) -- never looked up here, keeping this
    function a pure function of its arguments."""
    context = build_patient_context(patient)
    referral_question = patient.referral_question or f"Please evaluate for {specialty.lower()} input."
    now = _now()
    referral = Referral(
        patient_id=patient.id,
        referring_physician_id=referring_physician_id,
        receiving_physician_id=receiving_physician_id,
        specialty=specialty,
        referral_question=referral_question,
        urgency=_PRIORITY_URGENCY_TEXT[priority],
        priority=priority,
        modality=modality,
        status=ReferralStatus.DRAFT,
        created_at=now,
        updated_at=now,
        previous_referral_id=previous_referral_id,
    )
    _append_event(
        referral,
        event_type=CoordinationEventType.REFERRAL_CREATED,
        actor=CoordinationActor.REFERRING_AGENT,
        autonomy=AutonomyLevel.AUTOMATIC,
        summary=f"Referral created for {patient.display_name.replace(' (synthetic)', '')} to {specialty}.",
        metadata={"receiving_physician_id": receiving_physician_id},
    )
    referral.packet = assemble_initial_packet(patient, context, referral.referring_physician_id)
    referral.receiving_requirements = requirements_for(
        receiving_physician_id, context.case_family, requirement_override
    )
    referral.status = ReferralStatus.ASSEMBLING
    _append_event(
        referral,
        event_type=CoordinationEventType.PACKET_ASSEMBLED,
        actor=CoordinationActor.REFERRING_AGENT,
        autonomy=AutonomyLevel.AUTOMATIC,
        summary=f"Initial referral packet assembled with {len(referral.packet.items)} item(s).",
        metadata={"item_count": len(referral.packet.items)},
    )
    return referral


# A referral is "done, repeatable" only once it reaches consult_returned
# (demo-consolidation pass, Part 4/5) -- every other status is still an
# active, non-repeatable specialty-care episode for that patient+receiving-
# physician pair. Deliberately the complement of _ACCEPTED_OR_LATER below
# rather than the same set: accepted/scheduled ARE still "active" here even
# though they're also "accepted or later" for other purposes.
_ACTIVE_NON_REPEATABLE_STATUSES = (
    ReferralStatus.DRAFT,
    ReferralStatus.ASSEMBLING,
    ReferralStatus.PREFLIGHT,
    ReferralStatus.RESOLVING,
    ReferralStatus.READY_FOR_REVIEW,
    ReferralStatus.SUBMITTED,
    ReferralStatus.ACCEPTED,
    ReferralStatus.SCHEDULED,
)


def find_active_referral_for_pair(
    existing_referrals_for_patient: list[Referral], receiving_physician_id: str
) -> Referral | None:
    """The backend duplicate-referral guard (Part 4) -- an accidental repeat
    "Start referral" click (e.g. after browser back/forward, or a stale
    frontend view) for the same patient+receiving-physician must never
    create a second active row. Returns the existing active episode so the
    caller can return it idempotently instead of creating a new one; returns
    None when there is no active episode for this pair (either none exists
    yet, or the prior one already reached consult_returned), which is
    exactly when a legitimate new referral -- a new episode -- may be
    created (Part 5)."""
    for referral in reversed(existing_referrals_for_patient):
        if referral.receiving_physician_id == receiving_physician_id and referral.status in _ACTIVE_NON_REPEATABLE_STATUSES:
            return referral
    return None


def most_recent_referral_for_pair(
    existing_referrals_for_patient: list[Referral], receiving_physician_id: str
) -> Referral | None:
    """The prior episode (if any) to link a legitimate new referral back to
    via `previous_referral_id` (Part 5) -- regardless of its status, since
    by the time this is consulted, find_active_referral_for_pair has
    already confirmed there is no ACTIVE one blocking a new episode."""
    for referral in reversed(existing_referrals_for_patient):
        if referral.receiving_physician_id == receiving_physician_id:
            return referral
    return None


def run_preflight(patient: PatientRecord, referral: Referral) -> Referral:
    """Check receiving requirements against the packet, resolve any missing
    required item by searching the patient's existing chart, and advance the
    referral to ready_for_review -- and, since the physician already
    authorized this by clicking Start referral, immediately on to submitted
    -- once (and only once) every required field is satisfied. Safe to call
    repeatedly: already-satisfied items are never re-resolved or duplicated,
    and a referral already ready_for_review or submitted is returned
    unchanged."""
    if referral.status in (ReferralStatus.READY_FOR_REVIEW, ReferralStatus.SUBMITTED):
        return referral

    referral.status = ReferralStatus.PREFLIGHT
    _append_event(
        referral,
        event_type=CoordinationEventType.PREFLIGHT_STARTED,
        actor=CoordinationActor.RECEIVING_AGENT,
        autonomy=AutonomyLevel.AUTOMATIC,
        summary=f"{referral.specialty} preflight started against receiving requirements.",
    )

    checks = evaluate_requirements(referral.receiving_requirements, referral.packet)
    referral.requirement_results = checks
    for check in checks:
        _append_event(
            referral,
            event_type=CoordinationEventType.REQUIREMENT_CHECKED,
            actor=CoordinationActor.RECEIVING_AGENT,
            summary=f"{check.label}: {check.status.value}.",
            metadata={"requirement": check.key, "result": check.status.value},
        )

    missing_required = [
        check for check in checks if check.required and check.status == RequirementStatus.MISSING_FROM_PACKET
    ]
    if not missing_required:
        return _complete_preflight(referral)

    referral.status = ReferralStatus.RESOLVING
    requirements_by_key = {item.key: item for item in referral.receiving_requirements}
    for check in missing_required:
        requirement = requirements_by_key[check.key]
        _append_event(
            referral,
            event_type=CoordinationEventType.INFORMATION_REQUESTED,
            actor=CoordinationActor.RECEIVING_AGENT,
            summary=f"{referral.specialty} requires {requirement.label.lower()} before review and it is not included in the referral packet.",
            metadata={"requirement": requirement.key},
        )
        _append_event(
            referral,
            event_type=CoordinationEventType.RECORD_SEARCH_STARTED,
            actor=CoordinationActor.REFERRING_AGENT,
            autonomy=AutonomyLevel.AUTOMATIC,
            summary=f"Searching the patient record for {requirement.label.lower()}.",
            metadata={"requirement": requirement.key},
        )
        found = resolve_missing_requirement(patient, requirement, referral.referring_physician_id)
        if found is None:
            _append_event(
                referral,
                event_type=CoordinationEventType.RECORD_NOT_FOUND,
                actor=CoordinationActor.REFERRING_AGENT,
                summary=f"No qualifying {requirement.label.lower()} was found in the patient record.",
                metadata={"requirement": requirement.key},
            )
            continue
        _append_event(
            referral,
            event_type=CoordinationEventType.RECORD_FOUND,
            actor=CoordinationActor.REFERRING_AGENT,
            autonomy=AutonomyLevel.AUTOMATIC,
            summary=f"Found {requirement.label.lower()} in the patient record dated {found.provenance.observed_date}.",
            metadata={"requirement": requirement.key, "observed_date": found.provenance.observed_date or ""},
        )
        referral.packet.items.append(found)
        _append_event(
            referral,
            event_type=CoordinationEventType.INFORMATION_ATTACHED,
            actor=CoordinationActor.REFERRING_AGENT,
            autonomy=AutonomyLevel.AUTOMATIC,
            summary=f"Attached {requirement.label.lower()} to the referral packet.",
            metadata={"requirement": requirement.key},
        )

    rechecks = evaluate_requirements(referral.receiving_requirements, referral.packet)
    referral.requirement_results = rechecks
    for check in rechecks:
        _append_event(
            referral,
            event_type=CoordinationEventType.REQUIREMENT_RECHECKED,
            actor=CoordinationActor.RECEIVING_AGENT,
            summary=f"{check.label}: {check.status.value}.",
            metadata={"requirement": check.key, "result": check.status.value},
        )

    still_missing = [
        check for check in rechecks if check.required and check.status == RequirementStatus.MISSING_FROM_PACKET
    ]
    if still_missing:
        for check in still_missing:
            _append_event(
                referral,
                event_type=CoordinationEventType.PHYSICIAN_ACTION_REQUIRED,
                actor=CoordinationActor.SYSTEM,
                autonomy=AutonomyLevel.PHYSICIAN_REQUIRED,
                summary=f"{check.label} could not be located in the chart; physician action is required before this referral can be ready for review.",
                metadata={"requirement": check.key},
            )
        return referral

    return _complete_preflight(referral)


def _complete_preflight(referral: Referral) -> Referral:
    referral.status = ReferralStatus.READY_FOR_REVIEW
    _append_event(
        referral,
        event_type=CoordinationEventType.PREFLIGHT_COMPLETED,
        actor=CoordinationActor.SYSTEM,
        summary="Preflight completed; all required fields are satisfied.",
    )
    _append_event(
        referral,
        event_type=CoordinationEventType.REFERRAL_READY,
        actor=CoordinationActor.SYSTEM,
        summary="Referral is ready for specialist review.",
    )
    # The physician already authorized this handoff by clicking Start referral
    # (see Part C) -- reaching ready_for_review is not a second decision point,
    # so submission happens automatically rather than waiting on another click.
    return submit_referral(referral)


def submit_referral(referral: Referral) -> Referral:
    """Hand a completed referral packet off to the receiving physician's
    workflow. Only a referral that has reached ready_for_review can be
    submitted; calling this on an already-submitted referral is a safe
    no-op (idempotent), and calling it on anything else (draft, resolving,
    etc.) is a programming error, not a recoverable user state."""
    if referral.status == ReferralStatus.SUBMITTED:
        return referral
    if referral.status != ReferralStatus.READY_FOR_REVIEW:
        raise ValueError(
            f"Cannot submit a referral in status {referral.status.value!r}; "
            "it must first reach ready_for_review."
        )
    referral.status = ReferralStatus.SUBMITTED
    metadata: dict[str, str | int | bool] = {
        "receiving_physician_id": referral.receiving_physician_id,
        "specialty": referral.specialty,
    }
    if referral.id is not None:
        metadata["referral_id"] = referral.id
    _append_event(
        referral,
        event_type=CoordinationEventType.REFERRAL_SUBMITTED,
        actor=CoordinationActor.SYSTEM,
        autonomy=AutonomyLevel.AUTOMATIC,
        summary=f"Completed referral packet sent for {referral.specialty} review.",
        metadata=metadata,
    )
    return referral


_ACCEPTED_OR_LATER = (
    ReferralStatus.ACCEPTED,
    ReferralStatus.SCHEDULED,
    ReferralStatus.CONSULT_RETURNED,
)


def accept_referral(
    referral: Referral, receiving_physician_id: str, receiving_physician_name: str
) -> Referral:
    """The one receiving-side transition in this pass: a submitted referral
    becomes accepted only through an explicit, named physician action -- the
    receiving agent prepares and checks the packet (see run_preflight), but
    it never decides to accept the patient itself (see Part B/C). Idempotent
    on anything already accepted OR further along the automated downstream
    pipeline (scheduled/consult_returned) -- acceptance now automatically
    authorizes that pipeline (see accept_referral_endpoint), so a repeat
    call/rerun must never re-raise just because the referral has since moved
    on, and must never append a second referral_accepted event."""
    if referral.receiving_physician_id != receiving_physician_id:
        raise ValueError(
            f"{receiving_physician_id!r} is not the receiving physician for this referral."
        )
    if referral.status in _ACCEPTED_OR_LATER:
        return referral
    if referral.status != ReferralStatus.SUBMITTED:
        raise ValueError(
            f"Cannot accept a referral in status {referral.status.value!r}; "
            "it must first be submitted."
        )
    referral.status = ReferralStatus.ACCEPTED
    metadata: dict[str, str | int | bool] = {"receiving_physician_id": receiving_physician_id}
    if referral.id is not None:
        metadata["referral_id"] = referral.id
    _append_event(
        referral,
        event_type=CoordinationEventType.REFERRAL_ACCEPTED,
        actor=CoordinationActor.RECEIVING_PHYSICIAN,
        autonomy=AutonomyLevel.PHYSICIAN_REQUIRED,
        summary=f"{receiving_physician_name} accepted the referral and added the patient to their care.",
        metadata=metadata,
    )
    return referral


# --------------------------------------------------------------------------
# Downstream coordination (closed-loop referral pass 3): scheduling, the
# externally-ingested consultation encounter, and the specialist-to-PCP
# handoff. Each stage is its own narrow artifact (Part AB) -- Referral only
# ever gains the minimal milestone statuses (`scheduled`, `consult_returned`)
# it genuinely needs; everything else is read from the artifact itself.
# --------------------------------------------------------------------------


def find_scheduling_options(
    referral: Referral,
    receiving_physician_id: str,
    receiving_physician_name: str,
    existing: SchedulingCoordination | None,
    booked_slot_ids: frozenset[str] = frozenset(),
) -> SchedulingCoordination:
    """Legitimate agent work (Part F): check Dr. Chen's known synthetic
    availability and return valid new-patient slots. Safe to call repeatedly
    -- an already-persisted SchedulingCoordination is returned unchanged
    (and no duplicate event is appended), never regenerated with different
    slots on a second click. `booked_slot_ids` are slots already held by
    other patients: they are never offered, whatever this referral's
    priority (Part L) -- with nothing open, this raises so the caller
    escalates instead of displacing anyone."""
    if referral.receiving_physician_id != receiving_physician_id:
        raise ValueError(
            f"{receiving_physician_id!r} is not the receiving physician for this referral."
        )
    if existing is not None:
        return existing
    if referral.status != ReferralStatus.ACCEPTED:
        raise ValueError(
            f"Cannot find scheduling options for a referral in status {referral.status.value!r}; "
            "it must first be accepted."
        )
    slots = open_slots(synthetic_chen_availability(), booked_slot_ids)
    if not slots:
        raise ValueError(
            "No open appointment slot; escalate to an alternative route or clinic scheduling. "
            "No booked appointment is displaced."
        )
    now = _now()
    _append_event(
        referral,
        event_type=CoordinationEventType.SCHEDULING_OPTIONS_FOUND,
        actor=CoordinationActor.RECEIVING_AGENT,
        autonomy=AutonomyLevel.AUTOMATIC,
        summary=f"{receiving_physician_name}'s Agent found {len(slots)} valid new-patient appointment option(s).",
        metadata={"referral_id": referral.id or 0, "option_count": len(slots)},
    )
    return SchedulingCoordination(
        referral_id=referral.id or 0,
        status=SchedulingStatus.OPTIONS_READY,
        options=slots,
        created_at=now,
        updated_at=now,
    )


def route_options_to_scheduling(
    referral: Referral,
    coordination: SchedulingCoordination,
    receiving_physician_id: str,
    receiving_physician_name: str,
) -> SchedulingCoordination:
    """Administrative agent-workflow work (automation pass, Part E/F/L) --
    routing valid options into the scheduling workflow is purely
    administrative, already authorized the moment Dr. Chen accepted the
    referral, so it is never a second physician decision/click (contrast
    with `send_handoff`, which IS a real decision gate). Actor is the
    receiving agent/workflow, never the physician. For this synthetic demo
    only (Part M), routing also triggers `confirm_synthetic_appointment`
    immediately afterward -- the one place this demo simulates "the
    scheduling workflow/patient confirmed a time" without claiming Lamina
    contacted anyone (Part N)."""
    if referral.receiving_physician_id != receiving_physician_id:
        raise ValueError(
            f"{receiving_physician_id!r} is not the receiving physician for this referral."
        )
    if coordination.status in (SchedulingStatus.SENT_TO_SCHEDULING, SchedulingStatus.SCHEDULED):
        return coordination
    if coordination.status != SchedulingStatus.OPTIONS_READY:
        raise ValueError(f"Cannot route scheduling options in status {coordination.status.value!r}.")
    routed = coordination.model_copy(
        update={
            "status": SchedulingStatus.SENT_TO_SCHEDULING,
            "routed_at": _now(),
            "updated_at": _now(),
        }
    )
    _append_event(
        referral,
        event_type=CoordinationEventType.SCHEDULING_OPTIONS_SENT,
        actor=CoordinationActor.RECEIVING_AGENT,
        autonomy=AutonomyLevel.AUTOMATIC,
        summary=f"{receiving_physician_name}'s Agent routed the available appointment options to the practice scheduling workflow.",
        metadata={"referral_id": referral.id or 0},
    )
    return confirm_synthetic_appointment(referral, routed)


def confirm_synthetic_appointment(
    referral: Referral, coordination: SchedulingCoordination
) -> SchedulingCoordination:
    """The synthetic demo's own stand-in for real patient/staff confirmation
    (Part M) -- never Dr. Chen's Agent, never the receiving physician.
    Always selects one of the REAL options already returned by
    `find_scheduling_options`, never a fabricated fourth time."""
    if coordination.status == SchedulingStatus.SCHEDULED:
        return coordination
    if coordination.status != SchedulingStatus.SENT_TO_SCHEDULING:
        raise ValueError(f"Cannot confirm an appointment in status {coordination.status.value!r}.")
    selected = coordination.options[0]
    confirmed = coordination.model_copy(
        update={
            "status": SchedulingStatus.SCHEDULED,
            "selected_option": selected,
            "source": "synthetic_demo",
            "confirmed_at": _now(),
            "updated_at": _now(),
        }
    )
    _append_event(
        referral,
        event_type=CoordinationEventType.APPOINTMENT_SCHEDULED,
        actor=CoordinationActor.SCHEDULING_WORKFLOW,
        autonomy=AutonomyLevel.AUTOMATIC,
        summary=f"Synthetic scheduling workflow confirmed the {selected.appointment_type.lower()} for {selected.starts_at}.",
        metadata={"referral_id": referral.id or 0, "slot_id": selected.slot_id, "source": "synthetic_demo"},
    )
    referral.status = ReferralStatus.SCHEDULED
    return confirmed


def ingest_consultation_encounter(
    referral: Referral,
    receiving_physician_id: str,
    existing: ConsultationEncounter | None,
) -> ConsultationEncounter:
    """Demo-only stand-in for a real EHR/Medplum encounter arriving in the
    clinical record (Part C/S) -- deliberately never exposed as a normal
    Chen "Complete consultation" button; see the `/encounter/ingest` demo
    control. Idempotent: duplicate ingestion returns the existing encounter
    unchanged, never a second one."""
    if existing is not None:
        return existing
    if referral.receiving_physician_id != receiving_physician_id:
        raise ValueError(
            f"{receiving_physician_id!r} is not the receiving physician for this referral."
        )
    if referral.status != ReferralStatus.SCHEDULED:
        raise ValueError(
            f"Cannot ingest a consultation encounter for a referral in status {referral.status.value!r}; "
            "the appointment must first be scheduled."
        )
    now = _now()
    encounter = ConsultationEncounter(
        referral_id=referral.id or 0,
        patient_id=referral.patient_id,
        physician_id=receiving_physician_id,
        specialty=referral.specialty,
        occurred_at=now,
        source="synthetic_demo",
        status="completed",
        assessment="Type 2 diabetes with persistent poor glycemic control despite current therapy.",
        key_findings=["HbA1c 9.6%"],
        plan=(
            "Continue metformin. Discontinue sitagliptin. Start semaglutide (GLP-1 receptor "
            "agonist). Closer glucose monitoring."
        ),
        # Tonjit demo-story pass, Part D/H: the same structured facts the
        # prose `plan` above describes in words -- this is what the patient's
        # derived current-medication state and the handoff actually read,
        # never a parse of that prose.
        medication_changes=[
            MedicationChange(medication="Metformin", action="continue"),
            MedicationChange(medication="Sitagliptin", action="discontinue"),
            MedicationChange(
                medication="Semaglutide", action="start", medication_class="GLP-1 receptor agonist"
            ),
        ],
        follow_up="Closer glucose monitoring. Endocrinology follow-up in approximately 3 months.",
        created_at=now,
    )
    _append_event(
        referral,
        event_type=CoordinationEventType.CONSULTATION_INGESTED,
        actor=CoordinationActor.SYSTEM,
        autonomy=AutonomyLevel.AUTOMATIC,
        summary=f"A {referral.specialty.lower()} consultation encounter became available from the clinical record.",
        metadata={"referral_id": referral.id or 0, "source": "synthetic_demo"},
    )
    return encounter


def apply_medication_changes(
    base_medications: list[str], encounters: list[ConsultationEncounter]
) -> tuple[list[str], list[MedicationChangeRecord]]:
    """Derive the patient's CURRENT medication list from their static base
    regimen plus every documented encounter's structured medication_changes,
    applied in chronological order (Tonjit demo-story pass, Part F/G/H) --
    the base fixture itself is never mutated; this is a pure, request-time
    derivation. `start` adds a medication if not already present, `discontinue`
    removes it if present, `continue` is a no-op on the list (it only exists
    so the full regimen can be documented/surfaced with provenance). Also
    returns a flat, chronological provenance log for `PatientRecord.
    recent_medication_changes` -- every change, from every encounter, so a
    patient with more than one documented encounter in the future still gets
    a complete history, not just the latest one."""
    current = list(base_medications)
    changes: list[MedicationChangeRecord] = []
    for encounter in encounters:
        for change in encounter.medication_changes:
            if change.action == "start" and change.medication not in current:
                current.append(change.medication)
            elif change.action == "discontinue" and change.medication in current:
                current.remove(change.medication)
            changes.append(
                MedicationChangeRecord(
                    medication=change.medication,
                    action=change.action,
                    medication_class=change.medication_class,
                    specialty=encounter.specialty,
                    occurred_at=encounter.occurred_at,
                )
            )
    return current, changes


def draft_handoff(
    referral: Referral,
    encounter: ConsultationEncounter,
    receiving_physician_id: str,
    receiving_physician_name: str,
    existing: HandoffSummary | None,
) -> HandoffSummary:
    """Chen's Agent drafts a PCP handoff from the documented encounter (Part
    W) -- deterministic from structured encounter data in this pass, never a
    live model call (a future Responses-API-based synthesis layer could
    replace this function's body without touching callers). Remains
    `status=draft` until the physician explicitly sends it (Part AA)."""
    if existing is not None:
        return existing
    if referral.receiving_physician_id != receiving_physician_id:
        raise ValueError(
            f"{receiving_physician_id!r} is not the receiving physician for this referral."
        )
    if encounter.referral_id != referral.id:
        raise ValueError("Encounter does not belong to this referral.")
    now = _now()
    handoff = HandoffSummary(
        referral_id=referral.id or 0,
        encounter_id=encounter.id or 0,
        patient_id=referral.patient_id,
        from_physician_id=receiving_physician_id,
        to_physician_id=referral.referring_physician_id,
        drafted_by_agent_id=synthetic_agent_id(receiving_physician_id),
        assessment=encounter.assessment,
        key_findings=encounter.key_findings,
        recommendations=encounter.plan,
        medication_changes=encounter.medication_changes,
        follow_up=encounter.follow_up,
        status=HandoffStatus.DRAFT,
        drafted_at=now,
    )
    _append_event(
        referral,
        event_type=CoordinationEventType.HANDOFF_DRAFTED,
        actor=CoordinationActor.RECEIVING_AGENT,
        autonomy=AutonomyLevel.AUTOMATIC,
        summary=f"{receiving_physician_name}'s Agent drafted a consultation handoff for {PCP_NAME} from the documented encounter.",
        metadata={"referral_id": referral.id or 0, "encounter_id": encounter.id or 0},
    )
    return handoff


def send_handoff(
    referral: Referral,
    handoff: HandoffSummary,
    receiving_physician_id: str,
    receiving_physician_name: str,
) -> HandoffSummary:
    """The one human approval gate in this whole downstream flow (Part AA):
    Dr. Chen -- never his agent -- explicitly approves and sends. Idempotent
    on an already-sent handoff; advances the referral to its final
    `consult_returned` milestone."""
    if referral.receiving_physician_id != receiving_physician_id:
        raise ValueError(
            f"{receiving_physician_id!r} is not the receiving physician for this referral."
        )
    if handoff.status == HandoffStatus.SENT:
        return handoff
    if handoff.status != HandoffStatus.DRAFT:
        raise ValueError(f"Cannot send a handoff in status {handoff.status.value!r}.")
    sent = handoff.model_copy(
        update={
            "status": HandoffStatus.SENT,
            "approved_by_physician_id": receiving_physician_id,
            "sent_at": _now(),
        }
    )
    _append_event(
        referral,
        event_type=CoordinationEventType.HANDOFF_SENT,
        actor=CoordinationActor.RECEIVING_PHYSICIAN,
        autonomy=AutonomyLevel.PHYSICIAN_REQUIRED,
        summary=f"{receiving_physician_name} approved and sent the consultation handoff to {PCP_NAME}.",
        metadata={"referral_id": referral.id or 0, "handoff_id": handoff.id or 0},
    )
    referral.status = ReferralStatus.CONSULT_RETURNED
    return sent
