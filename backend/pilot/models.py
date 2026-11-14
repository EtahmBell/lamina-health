"""Typed pilot domain records.

Intake referrals are deliberately NOT ``backend.models.Referral``: that model is the
synthetic PCP-outbound pipeline and requires a patient resolvable through
``ClinicalDataSource``. A real inbound referral can arrive for a patient Lamina has
never seen, so the patient here is only what the sender submitted.
"""

from __future__ import annotations

from enum import StrEnum
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field

from backend.models.referral import ReferralRequirement
from backend.models.referral_preference import StructuredReferralPreference


class _Strict(BaseModel):
    model_config = ConfigDict(extra="forbid")


# --------------------------------------------------------------------- practice

PracticeRole = Literal["physician", "staff"]


class PracticeInput(_Strict):
    name: str = Field(min_length=2, max_length=200)
    specialty: str | None = Field(default=None, max_length=200)
    website: str | None = Field(default=None, max_length=300)
    address: str | None = Field(default=None, max_length=400)
    phone: str | None = Field(default=None, max_length=40)
    contact_email: str | None = Field(default=None, max_length=200)


class InvitationInput(_Strict):
    role: Literal["staff"] = "staff"
    label: str | None = Field(default=None, max_length=200)


# --------------------------------------------------------------------- referrals

ReferralSource = Literal["manual", "upload", "public_form"]
Priority = Literal["routine", "soon", "urgent"]
Modality = Literal["in_person", "econsult", "either", "unspecified"]


class IntakeStatus(StrEnum):
    RECEIVED = "received"
    TRIAGED = "triaged"
    NEEDS_INFORMATION = "needs_information"
    READY_FOR_REVIEW = "ready_for_review"
    ACCEPTED = "accepted"
    REDIRECTED = "redirected"
    DECLINED = "declined"


TERMINAL_STATUSES = frozenset(
    {IntakeStatus.ACCEPTED, IntakeStatus.REDIRECTED, IntakeStatus.DECLINED}
)


class ReferralSender(_Strict):
    name: str = Field(min_length=1, max_length=200)
    practice: str | None = Field(default=None, max_length=200)
    contact: str | None = Field(default=None, max_length=200)
    npi: str | None = Field(default=None, pattern=r"^\d{10}$")
    # Reserved for the future network: a Lamina physician who sent this referral.
    lamina_physician_id: str | None = Field(default=None, max_length=100)


class IntakePatient(_Strict):
    """Only what the sender submitted. Never resolved against ClinicalDataSource."""

    name: str = Field(min_length=1, max_length=200)
    date_of_birth: str | None = Field(default=None, pattern=r"^\d{4}-\d{2}-\d{2}$")
    sex: str | None = Field(default=None, max_length=40)
    phone: str | None = Field(default=None, max_length=40)
    insurance: str | None = Field(default=None, max_length=200)
    external_id: str | None = Field(default=None, max_length=100)


class SubmittedItem(_Strict):
    """A structured fact supplied with the referral or later by the team.

    ``key`` matches a practice rule's requirement key. ``source`` records who
    provided it; the triage engine treats it as evidence only with a value.
    """

    key: str = Field(min_length=1, max_length=100)
    label: str | None = Field(default=None, max_length=200)
    value: str = Field(min_length=1, max_length=1000)
    observed_date: str | None = Field(default=None, pattern=r"^\d{4}-\d{2}-\d{2}$")
    source: Literal["sender_submitted", "staff_entered", "document_confirmed"] = (
        "staff_entered"
    )
    document_id: str | None = None
    page: int | None = None
    recorded_by: str | None = None
    recorded_at: str | None = None
    # A practice member who checked this value. Sender-entered values (status link, public
    # form) start unverified and never satisfy a requirement until someone verifies them.
    verified_by: str | None = None
    verified_at: str | None = None


def item_verified(item: SubmittedItem) -> bool:
    """Staff-entered and document-confirmed values are the team's own record. A
    sender-submitted value counts only once a practice member verified it -- or when a
    practice member recorded it themselves at intake (legacy rows: recorded_by user:)."""
    if item.source in {"staff_entered", "document_confirmed"} or item.verified_by:
        return True
    return item.source == "sender_submitted" and (item.recorded_by or "").startswith("user:")


class IntakeReferralInput(_Strict):
    source: Literal["manual", "upload"] = "manual"
    sender: ReferralSender
    patient: IntakePatient
    referral_type: str = Field(min_length=1, max_length=120)
    reason: str = Field(min_length=1, max_length=4000)
    clinical_context: str | None = Field(default=None, max_length=8000)
    sender_priority: Priority | None = None
    received_at: str | None = Field(
        default=None,
        description="When the practice actually received it (fax/email date). Defaults to now.",
    )
    submitted_items: list[SubmittedItem] = Field(default_factory=list, max_length=50)


class ReferralDocument(_Strict):
    id: str
    referral_id: str
    filename: str
    content_type: str
    size_bytes: int
    sha256: str
    uploaded_by: str
    uploaded_at: str
    extraction_status: Literal["extracted", "unsupported", "failed", "empty"]
    page_count: int | None = None


class IntakeReferral(_Strict):
    id: str
    practice_id: str
    source: ReferralSource
    status: IntakeStatus
    sender: ReferralSender
    # Receiver is the practice; kept explicit so referrals can later be
    # physician-to-physician without a schema change.
    receiver_practice_id: str
    patient: IntakePatient
    referral_type: str
    reason: str
    clinical_context: str | None = None
    sender_priority: Priority | None = None
    submitted_items: list[SubmittedItem] = Field(default_factory=list)
    received_at: str
    entered_at: str
    entered_by: str
    # The referral type exactly as it was submitted, kept when the team confirms a
    # different (canonical) practice type.
    submitted_referral_type: str | None = None
    current_recommendation_id: str | None = None
    review: dict | None = None
    escalated_at: str | None = None
    escalated_by: str | None = None
    escalation_note: str | None = None
    information_request: dict | None = None
    disposition: dict | None = None
    documents: list[ReferralDocument] = Field(default_factory=list)
    created_at: str
    updated_at: str


# ----------------------------------------------------------------------- triage

Fit = Literal["strong", "possible", "outside_scope", "unknown"]
Readiness = Literal["ready", "missing_information", "unknown"]
NextStep = Literal[
    "request_information", "confirm_document_evidence", "physician_review", "consider_redirect",
    "review_sender_information", "confirm_referral_type",
]
# sender_reported: the referring office supplied a value that no one has verified yet. It is
# "received", not "satisfied", and never makes a referral ready on its own.
RequirementState = Literal[
    "satisfied", "proposed_from_document", "sender_reported", "missing", "optional_missing"
]


class RationaleSource(_Strict):
    kind: Literal[
        "practice_rule", "document", "submitted_item", "requirement_logic", "no_rule", "referral_type"
    ]
    rule_id: str | None = None
    rule_version: int | None = None
    document_id: str | None = None
    page: int | None = None
    quote: str | None = None
    item_key: str | None = None


class RationaleItem(_Strict):
    statement: str
    source: RationaleSource


class RequirementAssessment(_Strict):
    key: str
    label: str
    required: bool
    freshness_days: int | None = None
    state: RequirementState
    rule_id: str
    rule_version: int
    evidence: RationaleSource | None = None
    detail: str


class TriageRecommendation(_Strict):
    id: str
    referral_id: str
    practice_id: str
    fit: Fit
    readiness: Readiness
    requirements: list[RequirementAssessment] = Field(default_factory=list)
    missing_items: list[str] = Field(default_factory=list)
    suggested_priority: Priority
    suggested_modality: Modality
    requires_physician: bool
    next_step: NextStep
    rationale: list[RationaleItem]
    generator: Literal["deterministic", "deterministic+llm_extraction"]
    model_id: str | None = None
    rules_snapshot_id: str
    # How the submitted referral type was matched to a practice rule type (see rules.resolve_type).
    type_match: dict | None = None
    created_at: str


DecisionKind = Literal["accepted", "edited", "rejected"]
EDITABLE_TRIAGE_FIELDS = (
    "fit",
    "suggested_priority",
    "suggested_modality",
    "requires_physician",
    "next_step",
)


class RecommendationDecision(_Strict):
    id: str
    recommendation_id: str
    referral_id: str
    decision: DecisionKind
    changed_fields: dict[str, dict] = Field(default_factory=dict)
    reason: str | None = None
    actor: str
    actor_role: PracticeRole
    created_at: str


class TriageEditInput(_Strict):
    fit: Fit | None = None
    suggested_priority: Priority | None = None
    suggested_modality: Modality | None = None
    requires_physician: bool | None = None
    next_step: NextStep | None = None
    reason: str | None = Field(default=None, max_length=2000)


class ReasonInput(_Strict):
    reason: str | None = Field(default=None, max_length=2000)


class RequestInformationInput(_Strict):
    items: list[str] = Field(default_factory=list, max_length=20)
    note: str | None = Field(default=None, max_length=2000)


class RecordItemInput(_Strict):
    key: str = Field(min_length=1, max_length=100)
    value: str = Field(min_length=1, max_length=1000)
    observed_date: str | None = Field(default=None, pattern=r"^\d{4}-\d{2}-\d{2}$")
    document_id: str | None = None
    page: int | None = Field(default=None, ge=1)


class ReferralTypeInput(_Strict):
    referral_type: str = Field(min_length=1, max_length=120)


class VerifyItemInput(_Strict):
    note: str | None = Field(default=None, max_length=500)


class DispositionInput(_Strict):
    decision: Literal["accept", "redirect", "decline"]
    reason: str | None = Field(default=None, max_length=2000)
    redirect_to: str | None = Field(default=None, max_length=300)


# ------------------------------------------------------------------------ rules


class PracticeRuleContent(StructuredReferralPreference):
    """Practice rule content: the existing structured preference shape plus
    explicit urgency signals. Stored in physician_referral_preferences."""

    urgent_signals: list[str] = Field(default_factory=list)
    # Physician-controlled alternative names for this referral type ("Thyroid nodules",
    # "Thyroid mass"). Matching is exact after deterministic normalization only.
    aliases: list[str] = Field(default_factory=list)


OperationalStatus = Literal["inferred", "inferred_active", "confirmed", "superseded", "rejected"]


class PracticeRuleInput(_Strict):
    referral_type: str = Field(min_length=1, max_length=120)
    good_fit: list[str] = Field(default_factory=list, max_length=30)
    outside_scope: list[str] = Field(default_factory=list, max_length=30)
    required: list[ReferralRequirement] = Field(default_factory=list, max_length=30)
    helpful: list[ReferralRequirement] = Field(default_factory=list, max_length=30)
    urgent_signals: list[str] = Field(default_factory=list, max_length=30)
    aliases: list[str] = Field(default_factory=list, max_length=20)
    modality: Literal["in_person", "econsult", "either", "unspecified"] = "unspecified"
    note: str | None = Field(default=None, max_length=2000)
    publishable: bool = False


class PracticeRule(_Strict):
    id: str
    practice_id: str
    referral_type: str
    content: PracticeRuleContent
    source_text: str
    source: str
    scope: str
    operational_status: OperationalStatus
    physician_confirmed: bool
    confidence: float | None = None
    provenance: dict | None = None
    publishable: bool
    version: int
    supersedes_id: str | None = None
    created_at: str
    updated_at: str
    confirmed_at: str | None = None
