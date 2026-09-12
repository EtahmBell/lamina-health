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


class LabObservation(StrictModel):
    date: str
    test: Literal["creatinine", "eGFR"]
    value: float
    unit: str


class PatientRecord(StrictModel):
    id: str
    display_name: str
    synthetic: Literal[True] = True
    age: int = Field(ge=0, le=130)
    diagnoses: list[str]
    medications: list[str]
    labs: list[LabObservation]
    insurance: str
    location: str


class ClinicalRepresentation(StrictModel):
    patient_id: str
    synthetic: Literal[True] = True
    summary: str
    facts: list[str]
    signals: list[str]
    creatinine_trend: list[float]
    egfr_trend: list[float]
    resistant_hypertension: bool
    progressive_renal_dysfunction: bool
    ckd_stage: str


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


class ConsultationRequest(StrictModel):
    pcp_guidance: str | None = Field(default=None, max_length=500)


class ConsultationResult(StrictModel):
    consultation_id: str
    patient_id: str
    patient_facts_used: list[str]
    candidates: list[CandidateReason]
    recommended_physician: PhysicianEvaluation
    why: str
    before_referral: list[str]
    availability: str
    insurance: str
    alternatives: list[PhysicianEvaluation]
    consultation: list[PhysicianEvaluation]
    disclaimer: str

