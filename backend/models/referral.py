from __future__ import annotations

from enum import StrEnum

from pydantic import Field

from .consultation import ReferralPriority, StrictModel


class ReferralStatus(StrEnum):
    DRAFT = "draft"
    ASSEMBLING = "assembling"
    PREFLIGHT = "preflight"
    RESOLVING = "resolving"
    READY_FOR_REVIEW = "ready_for_review"
    SUBMITTED = "submitted"
    ACCEPTED = "accepted"
    # Scheduling/encounter/handoff DETAIL deliberately lives in their own
    # small artifacts (SchedulingCoordination/ConsultationEncounter/
    # HandoffSummary), never crammed into Referral itself -- these two
    # statuses are only the minimal downstream milestones the referral
    # itself needs to carry (Part AB).
    SCHEDULED = "scheduled"
    CONSULT_RETURNED = "consult_returned"


class RequirementStatus(StrEnum):
    SATISFIED = "satisfied"
    MISSING_FROM_PACKET = "missing_from_packet"
    OPTIONAL_NOT_PRESENT = "optional_not_present"


class CoordinationEventType(StrEnum):
    REFERRAL_CREATED = "referral_created"
    PACKET_ASSEMBLED = "packet_assembled"
    PREFLIGHT_STARTED = "preflight_started"
    REQUIREMENT_CHECKED = "requirement_checked"
    INFORMATION_REQUESTED = "information_requested"
    RECORD_SEARCH_STARTED = "record_search_started"
    RECORD_FOUND = "record_found"
    RECORD_NOT_FOUND = "record_not_found"
    INFORMATION_ATTACHED = "information_attached"
    REQUIREMENT_RECHECKED = "requirement_rechecked"
    PREFLIGHT_COMPLETED = "preflight_completed"
    REFERRAL_READY = "referral_ready"
    PHYSICIAN_ACTION_REQUIRED = "physician_action_required"
    REFERRAL_SUBMITTED = "referral_submitted"
    REFERRAL_ACCEPTED = "referral_accepted"
    # Downstream coordination (closed-loop referral pass 3) -- see Part AG for
    # the actor distinctions these carry.
    SCHEDULING_OPTIONS_FOUND = "scheduling_options_found"
    SCHEDULING_OPTIONS_SENT = "scheduling_options_sent"
    APPOINTMENT_SCHEDULED = "appointment_scheduled"
    CONSULTATION_INGESTED = "consultation_ingested"
    HANDOFF_DRAFTED = "handoff_drafted"
    HANDOFF_SENT = "handoff_sent"


class CoordinationActor(StrEnum):
    REFERRING_AGENT = "referring_agent"
    RECEIVING_AGENT = "receiving_agent"
    SYSTEM = "system"
    # The one actor that is never an agent (see Part C) -- acceptance is an
    # explicit physician action, not something the receiving agent decides.
    RECEIVING_PHYSICIAN = "receiving_physician"
    # The synthetic stand-in for "patient/staff confirmed a time outside the
    # physician workflow" (Part M/N) -- never attributed to the receiving
    # physician or their agent, since neither one did the confirming.
    SCHEDULING_WORKFLOW = "scheduling_workflow"


class AutonomyLevel(StrEnum):
    """Whether an action required physician approval. Finding and attaching an
    existing chart result is AUTOMATIC; ordering a new one would not be -- see
    backend/referrals/resolver.py."""

    AUTOMATIC = "automatic"
    PHYSICIAN_REQUIRED = "physician_required"


class PacketItemProvenance(StrictModel):
    source: str
    attached_by: str
    attached_during: str
    observed_date: str | None = None


class PacketItem(StrictModel):
    key: str
    label: str
    value: str
    provenance: PacketItemProvenance


class ReferralPacket(StrictModel):
    items: list[PacketItem] = Field(default_factory=list)

    def item(self, key: str) -> PacketItem | None:
        return next((item for item in self.items if item.key == key), None)


class ReferralRequirement(StrictModel):
    key: str
    label: str
    required: bool
    freshness_days: int | None = None


class RequirementCheck(StrictModel):
    key: str
    label: str
    required: bool
    status: RequirementStatus


class CoordinationEvent(StrictModel):
    sequence: int = Field(ge=1)
    event_type: CoordinationEventType
    actor: CoordinationActor | None = None
    autonomy: AutonomyLevel | None = None
    summary: str
    metadata: dict[str, str | int | bool] = Field(default_factory=dict)
    created_at: str


class ReferralCreateRequest(StrictModel):
    receiving_physician_id: str
    # Care-routing demo pass, Part E: the physician-confirmable clinical
    # priority (suggested by the agent, editable before the referral is
    # created) -- `None` defers to build_referral's own "routine" default,
    # never silently upgraded by the backend.
    priority: ReferralPriority | None = None


class ReferralAcceptRequest(StrictModel):
    receiving_physician_id: str


class Referral(StrictModel):
    id: int | None = None
    patient_id: str
    referring_physician_id: str
    receiving_physician_id: str
    specialty: str
    referral_question: str
    urgency: str
    # Care-routing demo pass, Part E/F: the physician-confirmed structured
    # priority, kept deliberately separate from `urgency` (free-text, pre-
    # existing, otherwise unused) and from referral READINESS -- resolving a
    # missing requirement never changes this, and this never changes
    # readiness (Part F/U/V).
    priority: ReferralPriority = "routine"
    status: ReferralStatus
    created_at: str
    updated_at: str
    packet: ReferralPacket = Field(default_factory=ReferralPacket)
    receiving_requirements: list[ReferralRequirement] = Field(default_factory=list)
    requirement_results: list[RequirementCheck] = Field(default_factory=list)
    coordination_events: list[CoordinationEvent] = Field(default_factory=list)
    # A referral IS a specialty-care episode (demo-consolidation pass, Part
    # 5) -- a legitimate later re-referral to the same physician creates a
    # new row/new id rather than reusing or overwriting the completed one;
    # this is the only lineage pointer needed (no separate "episode" model),
    # since referral ids already naturally represent episodes. Null for a
    # patient's first referral to that physician.
    previous_referral_id: int | None = None
