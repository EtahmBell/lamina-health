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
    label: str
    features: list[str]


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


class CareRoutingAssessment(StrictModel):
    """What kind of care this patient needs, BEFORE any physician is ranked
    (care-routing demo pass, Part A/B) -- specialty + modality + priority +
    whether in-person is actually needed, never a giant numeric score.
    Deterministic synthetic routing for this demo, never presented as an
    autonomously-validated clinical urgency determination."""

    specialty: str
    recommended_modality: CareModality
    suggested_priority: ReferralPriority
    in_person_need: InPersonNeed
    econsult_suitability: EconsultSuitability
    rationale: str


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
