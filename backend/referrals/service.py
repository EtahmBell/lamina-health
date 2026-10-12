"""Pure referral domain logic: build the initial referral, and run preflight.

Deliberately mirrors backend/agents/orchestrator.py's shape -- these functions
take/return plain domain objects and never touch persistence themselves. The
API layer (backend/api/referrals.py) is the only place that talks to
WorkflowStore, exactly like backend/api/consult.py does for consult_network().
"""

from __future__ import annotations

from datetime import UTC, datetime

from backend.clinical import build_patient_context
from backend.demo_identity import PCP_AGENT_ID
from backend.models import (
    AutonomyLevel,
    CoordinationActor,
    CoordinationEvent,
    CoordinationEventType,
    PatientRecord,
    Referral,
    ReferralStatus,
    RequirementStatus,
)

from .packet import assemble_initial_packet
from .requirements import evaluate_requirements, requirements_for
from .resolver import resolve_missing_requirement


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


def build_referral(
    patient: PatientRecord,
    receiving_physician_id: str,
    specialty: str,
    *,
    referring_physician_id: str = PCP_AGENT_ID,
    urgency: str = "Routine outpatient referral",
) -> Referral:
    """Create a new referral and assemble its initial packet. Does not persist."""
    context = build_patient_context(patient)
    referral_question = patient.referral_question or f"Please evaluate for {specialty.lower()} input."
    now = _now()
    referral = Referral(
        patient_id=patient.id,
        referring_physician_id=referring_physician_id,
        receiving_physician_id=receiving_physician_id,
        specialty=specialty,
        referral_question=referral_question,
        urgency=urgency,
        status=ReferralStatus.DRAFT,
        created_at=now,
        updated_at=now,
    )
    _append_event(
        referral,
        event_type=CoordinationEventType.REFERRAL_CREATED,
        actor=CoordinationActor.REFERRING_AGENT,
        autonomy=AutonomyLevel.AUTOMATIC,
        summary=f"Referral created for {patient.display_name.replace(' (synthetic)', '')} to {specialty}.",
        metadata={"receiving_physician_id": receiving_physician_id},
    )
    referral.packet = assemble_initial_packet(patient, context)
    referral.receiving_requirements = requirements_for(receiving_physician_id, context.case_family)
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


def run_preflight(patient: PatientRecord, referral: Referral) -> Referral:
    """Check receiving requirements against the packet, resolve any missing
    required item by searching the patient's existing chart, and advance the
    referral to ready_for_review once (and only once) every required field is
    satisfied. Safe to call repeatedly: already-satisfied items are never
    re-resolved or duplicated, and a referral already ready_for_review is
    returned unchanged."""
    if referral.status == ReferralStatus.READY_FOR_REVIEW:
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
        found = resolve_missing_requirement(patient, requirement)
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
    return referral
