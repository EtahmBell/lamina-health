"""Downstream closed-loop referral artifacts (closed-loop referral pass 3):
scheduling, the externally-ingested consultation encounter, and the
specialist-to-PCP handoff. Each is its own small, narrowly-scoped object
rather than a growing pile of fields bolted onto Referral (see Part AB) --
Referral only ever gains the minimal milestone statuses it genuinely needs
(`scheduled`, `consult_returned`); everything else lives here.
"""

from __future__ import annotations

from enum import StrEnum
from typing import Literal

from pydantic import Field

from .consultation import StrictModel
from .referral import Referral


class AppointmentSlot(StrictModel):
    """One structured, synthetic provider-availability slot -- never a bare
    frontend string. `slot_id` is stable across repeated availability checks
    (Part F: "operation is safe to rerun") so the same three options are
    always the same three options, not regenerated each time."""

    slot_id: str
    starts_at: str
    appointment_type: str
    duration_minutes: int
    location: str


class SchedulingStatus(StrEnum):
    OPTIONS_READY = "options_ready"
    SENT_TO_SCHEDULING = "sent_to_scheduling"
    SCHEDULED = "scheduled"


class SchedulingCoordination(StrictModel):
    """Conceptually one per referral (Part K) -- never overloads Referral
    with scheduling fields. `source` stays null until a slot is actually
    confirmed, at which point it is always `"synthetic_demo"` in this pass
    (Part M) -- a real future integration would set it to something else,
    e.g. a real scheduling system's own identifier."""

    referral_id: int
    status: SchedulingStatus
    options: list[AppointmentSlot] = Field(default_factory=list)
    selected_option: AppointmentSlot | None = None
    source: str | None = None
    routed_at: str | None = None
    confirmed_at: str | None = None
    created_at: str
    updated_at: str


class ConsultationEncounter(StrictModel):
    """The narrowest structured stand-in for "a clinical encounter arrived
    from the EHR/clinical record" (Part S) -- never created by a physician
    clicking a normal "Complete consultation" button (Part C). `source` is
    `"synthetic_demo"` for this pass; `"medplum"` is the documented future
    value once real EHR ingestion exists (Part AL) -- no integration is built
    now."""

    id: int | None = None
    referral_id: int
    patient_id: str
    physician_id: str
    specialty: str
    occurred_at: str
    source: Literal["synthetic_demo", "medplum"] = "synthetic_demo"
    status: Literal["completed"] = "completed"
    assessment: str
    key_findings: list[str] = Field(default_factory=list)
    plan: str
    follow_up: str
    created_at: str


class HandoffStatus(StrEnum):
    DRAFT = "draft"
    SENT = "sent"


class HandoffSummary(StrictModel):
    """The specialist-to-PCP handoff (Part X). `drafted_by_agent_id` records
    that the agent prepared the summary; `approved_by_physician_id` stays
    null until the physician explicitly sends it (Part AA) -- the draft is
    never visible to the referring side, and never self-approving.
    `viewed_by_referring_physician_at` (demo-consolidation pass, Part 8) is a
    workflow/UI timestamp only -- it records that the referring physician
    actually opened and loaded this handoff, never a claim that they
    formally attested to every recommendation in it."""

    id: int | None = None
    referral_id: int
    encounter_id: int
    patient_id: str
    from_physician_id: str
    to_physician_id: str
    drafted_by_agent_id: str
    assessment: str
    key_findings: list[str] = Field(default_factory=list)
    recommendations: str
    follow_up: str
    status: HandoffStatus
    approved_by_physician_id: str | None = None
    drafted_at: str
    sent_at: str | None = None
    viewed_by_referring_physician_at: str | None = None


class SchedulingOptionsRequest(StrictModel):
    receiving_physician_id: str


class RouteSchedulingRequest(StrictModel):
    receiving_physician_id: str


class EncounterIngestRequest(StrictModel):
    receiving_physician_id: str


class DraftHandoffRequest(StrictModel):
    receiving_physician_id: str


class SendHandoffRequest(StrictModel):
    receiving_physician_id: str


class MarkHandoffViewedRequest(StrictModel):
    referring_physician_id: str


class SchedulingOptionsResult(StrictModel):
    """A single round-trip result carrying both the updated referral
    (coordination_events) and the scheduling artifact itself -- avoids a
    second fetch after every scheduling action."""

    referral: Referral
    scheduling: SchedulingCoordination


class EncounterResult(StrictModel):
    referral: Referral
    encounter: ConsultationEncounter


class HandoffResult(StrictModel):
    referral: Referral
    handoff: HandoffSummary


class AskPhysicianAgentRequest(StrictModel):
    """Patient-scoped physician-agent-to-physician-agent coordination chat
    (demo-consolidation pass, Part 16-20) -- deliberately stateless/task-
    scoped server-side: nothing about this question or answer is persisted.
    Chat history, if the client wants multi-turn context while the page
    stays open, lives only in the requesting physician's own frontend
    session state -- never synced across physicians, never written to
    shared backend state, and never fed into the represented physician's
    permanent agent memory."""

    requesting_physician_id: str
    question: str


class CoordinationChatAnswer(StrictModel):
    answer: str
    based_on: list[str] = Field(default_factory=list)
    requires_physician_input: bool
    represented_agent_id: str
    created_at: str


class AgentCorrection(StrictModel):
    """A physician's explicit correction of their OWN agent's behavior
    (demo-consolidation pass, Part 23-31) -- durable, and deliberately
    separate from the immutable CoordinationEvent audit trail: the event
    stays "this is what the agent did"; this is the attached, later fact
    "the physician says this should change." `status` stays
    `pending_training` in this pass -- turning a correction into a
    confirmed physician-representation update is the next pass's NLP/quick-
    training flow, never this artifact alone (Part 30). Only the physician
    who owns `agent_id` may create one referencing their own agent (Part 28:
    enforced by the API layer, never by this model)."""

    id: int | None = None
    physician_id: str
    agent_id: str
    patient_id: str
    referral_id: int | None = None
    source_event_sequence: int | None = None
    selected_text: str | None = None
    correction_text: str
    status: Literal["pending_training"] = "pending_training"
    created_at: str


class CreateAgentCorrectionRequest(StrictModel):
    physician_id: str
    referral_id: int | None = None
    source_event_sequence: int | None = None
    selected_text: str | None = None
    correction_text: str
