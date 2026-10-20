"""Builds a throwaway, in-memory PatientRecord from a SyntheticCaseContext.

Never persisted, never touching the real PATIENTS fixture dict or any live
demo workflow state (Part D/N of the eval-harness pass). Feeds directly
into the SAME backend.clinical.build_patient_context() the product itself
uses, so every downstream deterministic function this harness calls runs
the real production logic against it -- never a parallel evaluation-only
reimplementation (Part M).
"""

from __future__ import annotations

from backend.models import LabObservation, PatientRecord, SyntheticCaseContext

_EARLIER = "2025-12-01"
_RECENT = "2026-06-01"


def build_synthetic_patient(case_id: str, context: SyntheticCaseContext) -> PatientRecord:
    labs: list[LabObservation] = []
    for index, value in enumerate(context.hba1c_trend):
        labs.append(LabObservation(date=_EARLIER if index == 0 else _RECENT, test="HbA1c", value=value, unit="%"))
    for index, value in enumerate(context.fasting_glucose_trend):
        labs.append(
            LabObservation(date=_EARLIER if index == 0 else _RECENT, test="fasting_glucose", value=value, unit="mg/dL")
        )
    if context.recent_creatinine is not None:
        labs.append(LabObservation(date=_RECENT, test="creatinine", value=context.recent_creatinine, unit="mg/dL"))
    if context.recent_egfr is not None:
        labs.append(LabObservation(date=_RECENT, test="eGFR", value=context.recent_egfr, unit="mL/min/1.73m2"))
    return PatientRecord(
        id=f"synthetic-eval-{case_id}",
        display_name="Synthetic evaluation patient (not a real person)",
        age=context.age,
        diagnoses=context.diagnoses,
        medications=context.current_medications,
        labs=labs,
        clinical_notes=[],
        insurance="Lamina Demo PPO",
        location="Synthetic evaluation harness",
        referral_question=context.clinical_question,
    )
