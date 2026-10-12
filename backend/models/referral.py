from __future__ import annotations

from enum import StrEnum

from pydantic import Field

from .consultation import StrictModel


class ReferralStatus(StrEnum):
    DRAFT = "draft"
    ASSEMBLING = "assembling"
    PREFLIGHT = "preflight"
    RESOLVING = "resolving"
    READY_FOR_REVIEW = "ready_for_review"


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


class CoordinationActor(StrEnum):
    REFERRING_AGENT = "referring_agent"
    RECEIVING_AGENT = "receiving_agent"
    SYSTEM = "system"


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


class Referral(StrictModel):
    id: int | None = None
    patient_id: str
    referring_physician_id: str
    receiving_physician_id: str
    specialty: str
    referral_question: str
    urgency: str
    status: ReferralStatus
    created_at: str
    updated_at: str
    packet: ReferralPacket = Field(default_factory=ReferralPacket)
    receiving_requirements: list[ReferralRequirement] = Field(default_factory=list)
    requirement_results: list[RequirementCheck] = Field(default_factory=list)
    coordination_events: list[CoordinationEvent] = Field(default_factory=list)
