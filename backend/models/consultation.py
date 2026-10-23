from __future__ import annotations

from enum import StrEnum
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field


class StrictModel(BaseModel):
    model_config = ConfigDict(extra="forbid")


class ClinicalFit(StrEnum):
    STRONG = "strong"
    MODERATE = "moderate"
    POOR = "poor"


class EvidenceKind(StrEnum):
    PATIENT_FACT = "patient_fact"
    EXPLICIT_RULE = "explicit_physician_rule"
    PRACTICE_SIMILARITY = "historical_practice_similarity"
    OPERATIONAL = "operational"


class ConsultationMessageType(StrEnum):
    CONSULT_REQUEST = "consult_request"
    FIT_RESPONSE = "fit_response"
    FOLLOW_UP_QUESTION = "follow_up_question"
    FOLLOW_UP_ANSWER = "follow_up_answer"
    REFERRAL_REQUIREMENT = "referral_requirement"
    REDIRECT = "redirect"
    ACCESS_UPDATE = "access_update"
    SYNTHESIS = "synthesis"


class LabObservation(StrictModel):
    date: str
    test: Literal[
        "creatinine",
        "eGFR",
        "hemoglobin",
        "ferritin",
        "serum_iron",
        "TIBC",
        "transferrin_saturation",
        "MCV",
        "WBC",
        "platelets",
        "HbA1c",
        "fasting_glucose",
        "weight",
        "urine_albumin",
    ]
    value: float
    unit: str


MedicationAction = Literal["continue", "discontinue", "start"]


class MedicationChange(StrictModel):
    """One structured treatment-plan line item (Tonjit demo-story pass, Part
    H) -- deliberately narrow, never a real prescribing/dosing model. Exists
    so the patient's derived current-medication state and the handoff can
    both read the SAME structured fact, instead of either side (or the
    frontend) parsing the free-text `plan`/`recommendations` prose. Defined
    here (not in care_coordination.py, which imports StrictModel FROM this
    module) so both ConsultationEncounter/HandoffSummary and PatientRecord
    can share the one definition without a circular import."""

    medication: str
    action: MedicationAction
    medication_class: str | None = None


class MedicationChangeRecord(MedicationChange):
    """A MedicationChange with the provenance PatientRecord.recent_medication_
    changes needs once it's detached from the ConsultationEncounter that
    produced it -- which specialty/when, so the UI can say "Updated by
    Endocrinology" without a second round-trip to find out."""

    specialty: str
    occurred_at: str


class PatientRecord(StrictModel):
    id: str
    display_name: str
    synthetic: Literal[True] = True
    age: int = Field(ge=0, le=130)
    diagnoses: list[str]
    medications: list[str]
    labs: list[LabObservation]
    clinical_notes: list[str] = Field(default_factory=list)
    insurance: str
    location: str
    clinical_data_source: Literal["synthetic_fixture", "medplum_fhir"] = "synthetic_fixture"
    referral_question: str | None = None
    # Derived, request-time-only overlay (never part of the static fixture
    # itself -- see apply_medication_changes in referrals/service.py): which
    # of `medications` above changed because of a documented specialty-care
    # encounter, and which specialty/when. Empty for every patient with no
    # such encounter, exactly reproducing today's behavior.
    recent_medication_changes: list[MedicationChangeRecord] = Field(default_factory=list)


class ClinicalRepresentation(StrictModel):
    patient_id: str
    synthetic: Literal[True] = True
    case_family: Literal["ckd_hypertension", "iron_deficiency_anemia", "type_2_diabetes"]
    summary: str
    facts: list[str]
    signals: list[str]
    creatinine_trend: list[float]
    egfr_trend: list[float]
    resistant_hypertension: bool
    progressive_renal_dysfunction: bool
    ckd_stage: str
    hemoglobin_trend: list[float] = Field(default_factory=list)
    iron_studies: dict[str, float] = Field(default_factory=dict)
    persistent_iron_deficiency_anemia: bool = False
    microcytic_anemia: bool = False
    prior_endoscopy_documented: bool | None = None
    hba1c_trend: list[float] = Field(default_factory=list)
    fasting_glucose_trend: list[float] = Field(default_factory=list)
    weight_trend: list[float] = Field(default_factory=list)
    progressive_glycemic_control: bool = False
    renal_function_documented: bool = False


class HistoricalCase(StrictModel):
    """A privacy-preserving case PATTERN from a physician's practice history
    (routing consolidation pass, Part B/D) -- a structured description of a
    kind of case, never a prior patient. Carries no names, identifiers,
    dates, or counts; `modalities_used` records only how comparable cases
    were handled (visit and/or e-consult), when the fixture knows it."""

    label: str
    features: list[str]
    modalities_used: list[Literal["in_person", "econsult"]] = Field(default_factory=list)


class PhysicianProfile(StrictModel):
    id: str
    name: str
    synthetic: Literal[True] = True
    specialty: str
    subspecialty: str
    focus_areas: list[str]
    accepts_signals: list[str]
    explicit_rules: list[str]
    required_workup: list[str]
    historical_cases: list[HistoricalCase]
    insurance_networks: list[str]
    location: str
    availability_days: int


class PhysicianCaseRules(StrictModel):
    """A physician's referral representation for one case family. A physician
    may legitimately evaluate different case families differently (e.g. an
    endocrinologist sees diabetes referrals very differently from a CKD
    comorbidity mention) -- this is the ONE place that variation lives, so a
    physician id never has to carry two conflicting PhysicianProfile objects."""

    physician_id: str
    case_family: Literal["ckd_hypertension", "iron_deficiency_anemia", "type_2_diabetes"]
    accepts_signals: list[str]
    explicit_rules: list[str]
    required_workup: list[str]
    historical_cases: list[HistoricalCase]


class CandidateReason(StrictModel):
    physician_id: str
    reasons: list[str]


class Evidence(StrictModel):
    kind: EvidenceKind
    detail: str


class PhysicianEvaluation(StrictModel):
    physician_id: str
    physician_name: str
    specialty: str
    clinical_fit: ClinicalFit
    accepts_case: bool
    reason: str
    evidence: list[Evidence]
    required_workup: list[str]
    urgency: str
    availability: str
    insurance_status: str
    confidence: Literal["high", "medium", "low"]


ReferralPriority = Literal["routine", "soon", "urgent"]
CareModality = Literal["in_person", "econsult"]
EconsultSuitability = Literal["suitable", "possible_not_preferred", "not_suitable"]
InPersonNeed = Literal["preferred", "optional", "not_needed"]
CandidateFitLabel = Literal["strong", "moderate", "poor", "potential"]
EvidenceConfidence = Literal["high", "medium", "low", "unverified"]


class NetworkParticipation(StrEnum):
    """Evidence-confidence/connectivity, never a physician-quality tier (care-
    routing demo pass, Part J) -- deliberately NOT named "tier 1/2/3"."""

    INTEGRATED_NETWORK = "integrated_network"
    LAMINA_PHYSICIAN = "lamina_physician"
    EXTERNAL_DIRECTORY = "external_directory"


VisitViability = Literal["viable", "not_viable"]
# "conditional": clinically possible only if the receiving physician's own
# policy supports it for this presentation -- never decided by the patient
# need alone.
EconsultViability = Literal["viable", "conditional", "not_viable"]
ReceivingFit = Literal["strong", "moderate", "limited", "unknown"]
# How THIS physician handles e-consult for this kind of case. "unknown" is a
# genuine representation gap (never defaulted to acceptable); "not_offered"
# removes the e-consult route entirely.
EconsultPolicy = Literal["acceptable", "possible_not_preferred", "unknown", "not_offered"]
MatchEvidenceCategory = Literal[
    "specialty_scope",
    "similar_case_experience",
    "case_interest",
    "referral_preference",
    "modality_policy",
    "access_capacity",
    "continuity",
    "network_relationship",
]


class ModalityViability(StrictModel):
    """Which modalities are CLINICALLY viable for this patient (routing
    consolidation pass, Part B1/F) -- a patient-need fact only. Never reads
    any physician's preference; physician modality policy is applied later,
    in physician-case fit, and the final visit-vs-e-consult choice is made
    in route fit."""

    visit: VisitViability
    econsult: EconsultViability
    basis: str


class MatchEvidence(StrictModel):
    """One inspectable reason, tagged with where it came from (Part E) --
    structured evidence, never model scratchpad."""

    category: MatchEvidenceCategory
    summary: str
    source: str


class PhysicianCaseFit(StrictModel):
    """Physician-case fit, the second routing computation (Part B2): "for
    whom is this actually a good case?" Deliberately two-sided --
    `clinical_fit` is patient -> physician (specialty/scope), `receiving_fit`
    is physician -> patient (explicit practice rules, similar-case
    experience, confirmed interests/preferences). Access never enters
    either; a busy physician keeps the same fit (Part B3). No numeric
    value of any kind."""

    physician_id: str
    physician_name: str
    clinical_fit: Literal["strong", "moderate", "poor"]
    receiving_fit: ReceivingFit
    similar_case_patterns: list[str] = Field(default_factory=list)
    econsult_policy: EconsultPolicy = "unknown"
    evidence: list[MatchEvidence] = Field(default_factory=list)


class CareRoutingAssessment(StrictModel):
    """PATIENT NEED -- what care this patient needs, BEFORE any physician is
    ranked (care-routing demo pass, Part A/B; routing consolidation pass,
    Part B1). Specialty, clinician-confirmable priority, and which
    modalities are clinically viable (`modality_viability`) are patient
    facts. `recommended_modality`/`in_person_need`/`econsult_suitability`
    are a display summary of the ROUTE-FIT outcome (see
    backend/agents/care_routing.py) -- kept for the existing UI, never an
    input to physician fit. Deterministic synthetic routing for this demo,
    never presented as an autonomously-validated clinical urgency
    determination: `suggested_priority` is protocol-grounded and stays a
    suggestion until the referring clinician confirms it."""

    specialty: str
    recommended_modality: CareModality
    suggested_priority: ReferralPriority
    in_person_need: InPersonNeed
    econsult_suitability: EconsultSuitability
    rationale: str
    modality_viability: ModalityViability | None = None
    priority_basis: str | None = None
    referral_question: str | None = None
    hard_constraints: list[str] = Field(default_factory=list)


class AccessProfile(StrictModel):
    """Modality-specific expected access (care-routing demo pass, Part B/K) --
    in-person and e-consult are separate capacity channels, one shared
    structured source, never one derived from the other. `econsult_available
    = None` means policy is genuinely unknown (Part P) -- never defaulted to
    True."""

    in_person_wait_days: int | None = None
    in_person_wait_label: str
    econsult_available: bool | None = None
    econsult_response_days: int | None = None
    econsult_response_label: str | None = None
    access_confidence: EvidenceConfidence


class CandidateRoute(StrictModel):
    """physician + modality + expected access = ROUTE (care-routing demo
    pass, Part A). The same physician may appear more than once (e.g. Dr.
    Chen in-person AND Dr. Chen e-consult) -- each is its own route, with its
    own `recommended` flag; `fit_label` never changes between a physician's
    own routes (Part V: access must never mutate fit). `rationale` is `None`
    for a lower-information external-directory candidate (Part I) -- never a
    fabricated agent-derived explanation."""

    physician_id: str
    physician_name: str
    specialty: str
    modality: CareModality
    fit_label: CandidateFitLabel
    evidence_confidence: EvidenceConfidence
    network_participation: NetworkParticipation
    access: AccessProfile
    recommended: bool
    rationale: str | None = None
    # Routing consolidation pass, Part B3/E: route-level evidence (modality
    # policy, access/capacity, network relationship) -- physician-case fit
    # evidence lives on ConsultationResult.physician_fits, never duplicated
    # here. `within_access_target` is whether this route's modality-specific
    # access meets the clinician-confirmed priority's window.
    route_evidence: list[MatchEvidence] = Field(default_factory=list)
    within_access_target: bool | None = None


class ConsultationRequest(StrictModel):
    pcp_guidance: str | None = Field(default=None, max_length=500)


class ConsultationMessage(StrictModel):
    id: str
    consultation_id: str
    sequence: int = Field(ge=1)
    sender_agent_id: str
    sender_name: str
    sender_role: str
    recipient_agent_id: str
    message_type: ConsultationMessageType
    summary: str
    evidence: list[Evidence]
    related_patient_facts: list[str]
    metadata: dict[str, str | int | bool] = Field(default_factory=dict)


class ConsultationResult(StrictModel):
    consultation_id: str
    patient_id: str
    patient_facts_used: list[str]
    candidates: list[CandidateReason]
    patient_context: ClinicalRepresentation
    messages: list[ConsultationMessage]
    recommended_physician: PhysicianEvaluation
    why: str
    before_referral: list[str]
    availability: str
    insurance: str
    alternatives: list[PhysicianEvaluation]
    consultation: list[PhysicianEvaluation]
    disclaimer: str
    # Care-routing demo pass, Part B/X: purely additive -- every existing
    # field above is untouched, so a patient/case with no routing data
    # (care_routing=None, candidate_routes=[]) renders exactly as before
    # this pass. Populated only for the Tonjit/diabetes demo case for now.
    care_routing: CareRoutingAssessment | None = None
    candidate_routes: list[CandidateRoute] = Field(default_factory=list)
    # Routing consolidation pass, Part B2: physician-case fit per routed
    # physician, kept separate from both the patient need and the routes.
    physician_fits: list[PhysicianCaseFit] = Field(default_factory=list)
