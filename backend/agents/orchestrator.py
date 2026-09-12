from backend.clinical import build_patient_context, generate_candidates
from backend.models import (
    ClinicalFit,
    ConsultationResult,
    PatientRecord,
    PhysicianProfile,
)

from .physician_agent import evaluate_physician

FIT_ORDER = {ClinicalFit.STRONG: 0, ClinicalFit.MODERATE: 1, ClinicalFit.POOR: 2}


def consult_network(
    patient: PatientRecord,
    physicians: list[PhysicianProfile],
    pcp_guidance: str | None = None,
) -> ConsultationResult:
    context = build_patient_context(patient)
    candidates = generate_candidates(context, physicians, pcp_guidance)
    evaluations = [evaluate_physician(patient, context, profile) for profile in physicians]
    profiles_by_id = {profile.id: profile for profile in physicians}
    ranked = sorted(
        evaluations,
        key=lambda item: (
            FIT_ORDER[item.clinical_fit],
            not item.accepts_case,
            "hypertension" not in profiles_by_id[item.physician_id].subspecialty.casefold(),
            profiles_by_id[item.physician_id].availability_days,
            item.physician_name,
        ),
    )
    recommended = ranked[0]
    alternatives = [item for item in ranked[1:] if item.accepts_case][:2]
    return ConsultationResult(
        consultation_id=f"consult-{patient.id}-v1",
        patient_id=patient.id,
        patient_facts_used=context.facts,
        candidates=candidates,
        recommended_physician=recommended,
        why=(
            "The renal trajectory changes the referral priority: explicit nephrology and "
            "hypertension-cardiology rules both support nephrology first. Historical case "
            "similarity and access information reinforce, but do not determine, that choice."
        ),
        before_referral=recommended.required_workup,
        availability=recommended.availability,
        insurance=recommended.insurance_status,
        alternatives=alternatives,
        consultation=evaluations,
        disclaimer="Synthetic demonstration only. This record supports referral orchestration and is not medical advice or a quality ranking.",
    )
