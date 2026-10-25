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

from .consultation import MedicationChange, StrictModel
from .referral import Referral
from .referral_preference import StructuredReferralPreference


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
    medication_changes: list[MedicationChange] = Field(default_factory=list)
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
    medication_changes: list[MedicationChange] = Field(default_factory=list)
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


CorrectionScope = Literal["episode", "future", "both"]


class AgentCorrection(StrictModel):
    """A physician's explicit correction of their OWN agent's behavior
    (demo-consolidation pass, Part 23-31) -- durable, and deliberately
    separate from the immutable CoordinationEvent audit trail: the event
    stays "this is what the agent did"; this is the attached, later fact
    "the physician says this should change." Only the physician who owns
    `agent_id` may create one referencing their own agent (Part 28:
    enforced by the API layer, never by this model).

    Coordination oversight pass: a correction made from Agent coordination
    also records which structured item it annotates (`source_item_id`),
    what the agent originally represented, and its scope. `status` is
    `pending_training` for plain feedback (the older "Not quite" paths),
    `episode_annotation` for a this-coordination-only correction, and
    `confirmed` once a durable correction became a confirmed learning
    (`resulting_learning_id`, at representation version
    `resulting_representation_version`)."""

    id: int | None = None
    physician_id: str
    agent_id: str
    patient_id: str
    referral_id: int | None = None
    source_event_sequence: int | None = None
    source_item_id: str | None = None
    # Set when the correction was made from the Network consultation itself
    # (before or independent of any referral).
    consultation_record_id: int | None = None
    selected_text: str | None = None
    original_representation: str | None = None
    correction_text: str
    scope: CorrectionScope | None = None
    status: Literal["pending_training", "episode_annotation", "confirmed"] = "pending_training"
    resulting_learning_id: str | None = None
    resulting_representation_version: str | None = None
    created_at: str


class CreateAgentCorrectionRequest(StrictModel):
    physician_id: str
    referral_id: int | None = None
    source_event_sequence: int | None = None
    selected_text: str | None = None
    correction_text: str


# ---------------------------------------------------------------------------
# Agent coordination oversight pass: the structured coordination episode,
# projected for ONE viewing physician. Only permitted structured outputs
# appear here (requests, routing results, clarifications, requirements,
# provenance, acceptance, scheduling, handoff status) -- never evidence
# internals, prompts, model traces or free-form agent transcripts.
# ---------------------------------------------------------------------------
CoordinationStage = Literal["routing", "clarification", "workup", "acceptance", "scheduling", "handoff"]
# system_fact / patient_fact are immutable records; agent_representation and
# practice_representation are what a physician's own agent said or applied,
# and are the only kinds its owner can correct.
CoordinationContentKind = Literal["system_fact", "patient_fact", "agent_representation", "practice_representation"]


class CoordinationFact(StrictModel):
    text: str
    source: str


class CoordinationDetail(StrictModel):
    """One labelled part of an agent's structured representation (e.g. the
    referral question it framed) -- corrected together with the statement."""

    label: str
    text: str


class CoordinationItem(StrictModel):
    id: str
    stage: CoordinationStage
    title: str
    actor_kind: Literal["agent", "physician", "system", "network", "scheduling_workflow"]
    # The physician whose agent produced the item (or who acted), if any.
    actor_physician_id: str | None = None
    actor_name: str | None = None
    content_kind: CoordinationContentKind
    statement: str
    details: list[CoordinationDetail] = Field(default_factory=list)
    patient_facts: list[CoordinationFact] = Field(default_factory=list)
    occurred_at: str | None = None
    # Whether THIS viewer may correct it -- computed by
    # backend.referrals.coordination_episode.can_correct_item, and enforced
    # again by the correction endpoints.
    correctable: bool = False
    # The viewer's own corrections of this item (never another physician's).
    corrections: list[AgentCorrection] = Field(default_factory=list)


class CoordinationEpisode(StrictModel):
    referral_id: int
    patient_id: str
    viewer_physician_id: str
    viewer_role: Literal["referring", "receiving"]
    referring_physician_id: str
    receiving_physician_id: str
    items: list[CoordinationItem] = Field(default_factory=list)


class NetworkConsultationEpisode(StrictModel):
    """The Network consultation -- the referring agent's ONE outgoing case
    representation and every candidate agent's response -- projected for one
    viewer. Correction rights follow whose agent produced each item, never
    which physician was eventually selected."""

    consultation_record_id: int
    patient_id: str
    viewer_physician_id: str
    referring_physician_id: str
    items: list[CoordinationItem] = Field(default_factory=list)


class CoordinationCorrectionRequest(StrictModel):
    physician_id: str
    correction_text: str = Field(min_length=1, max_length=1000)
    # Omitted on interpret (Lamina proposes one, or asks); required on
    # confirm.
    scope: CorrectionScope | None = None


class CoordinationCorrectionProposal(StrictModel):
    """What confirming would do -- computed, never persisted (cancelling a
    proposal changes nothing)."""

    item_id: str
    original_representation: str
    correction_text: str
    # None when the scope can't be inferred confidently: the physician is
    # asked to choose.
    suggested_scope: CorrectionScope | None = None
    episode_effect: str
    # The durable change, when one is possible.
    future_available: bool
    future_effect: list[str] = Field(default_factory=list)
    future_unavailable_reason: str | None = None
    future_case_family: str | None = None
    future_preference: StructuredReferralPreference | None = None
