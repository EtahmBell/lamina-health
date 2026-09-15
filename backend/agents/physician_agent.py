from backend.models import (
    ClinicalFit,
    ClinicalRepresentation,
    Evidence,
    EvidenceKind,
    PatientRecord,
    PhysicianEvaluation,
    PhysicianProfile,
)
from backend.physicians import similar_cases


def _insurance_status(patient: PatientRecord, profile: PhysicianProfile) -> str:
    if patient.insurance in profile.insurance_networks:
        return f"In network for {patient.insurance} (synthetic demo data)"
    return f"Out-of-network or unknown for {patient.insurance} (synthetic demo data)"


def evaluate_physician(
    patient: PatientRecord,
    context: ClinicalRepresentation,
    profile: PhysicianProfile,
) -> PhysicianEvaluation:
    evidence = [Evidence(kind=EvidenceKind.PATIENT_FACT, detail=fact) for fact in context.facts]
    matches = similar_cases(context, profile)
    for case, overlap in matches:
        evidence.append(
            Evidence(
                kind=EvidenceKind.PRACTICE_SIMILARITY,
                detail=f"Synthetic case mix includes {case.label}; overlapping signals: {', '.join(overlap)}. This is a fit signal, not a quality measure.",
            )
        )
    evidence.append(
        Evidence(
            kind=EvidenceKind.OPERATIONAL,
            detail=f"Approximate next availability: {profile.availability_days} days; {_insurance_status(patient, profile)}",
        )
    )

    if profile.id == "physician-alvarez":
        evidence.insert(
            0, Evidence(kind=EvidenceKind.EXPLICIT_RULE, detail=profile.explicit_rules[0])
        )
        fit, accepts, confidence = ClinicalFit.STRONG, True, "high"
        reason = (
            "Persistent unexplained iron-deficiency anaemia without prior GI source evaluation "
            "fits this gastroenterology practice."
        )
        urgency = "Routine outpatient source evaluation"
    elif profile.id == "physician-brooks":
        evidence.insert(
            0, Evidence(kind=EvidenceKind.EXPLICIT_RULE, detail=profile.explicit_rules[0])
        )
        fit, accepts, confidence = ClinicalFit.MODERATE, True, "high"
        reason = (
            "Haematology is appropriate for refractory deficiency or IV iron, but GI source "
            "evaluation should occur first because no prior endoscopy is documented."
        )
        urgency = "Appropriate later or alongside GI if replacement needs escalate"
    elif profile.id == "physician-wu":
        evidence.insert(
            0, Evidence(kind=EvidenceKind.EXPLICIT_RULE, detail=profile.explicit_rules[0])
        )
        fit, accepts, confidence = ClinicalFit.MODERATE, True, "high"
        reason = (
            "General gastroenterology is an appropriate source-evaluation option with a longer "
            "synthetic access interval."
        )
        urgency = "Routine outpatient source evaluation"
    elif profile.id == "physician-kim":
        evidence.insert(
            0, Evidence(kind=EvidenceKind.EXPLICIT_RULE, detail=profile.explicit_rules[0])
        )
        fit, accepts, confidence = ClinicalFit.POOR, False, "medium"
        reason = (
            "Primary care has already established persistent iron deficiency; internal medicine "
            "can coordinate but is not the next specialty destination."
        )
        urgency = "Continue primary-care coordination"
    elif profile.id == "physician-reed":
        evidence.insert(
            0, Evidence(kind=EvidenceKind.EXPLICIT_RULE, detail=profile.explicit_rules[0])
        )
        fit, accepts, confidence = ClinicalFit.POOR, False, "high"
        reason = (
            "No colorectal lesion or surgical indication is established; diagnostic GI source "
            "evaluation should occur before surgical referral."
        )
        urgency = "Not indicated from supplied facts"
    elif profile.id == "physician-jung":
        fit, accepts, confidence = ClinicalFit.STRONG, True, "high"
        reason = "Progressive stage 3b CKD is the dominant trajectory, and resistant hypertension is within this nephrology practice footprint."
        urgency = "Expedited outpatient evaluation"
    elif profile.id == "physician-onadeko":
        evidence.insert(
            0, Evidence(kind=EvidenceKind.EXPLICIT_RULE, detail=profile.explicit_rules[0])
        )
        fit, accepts, confidence = ClinicalFit.MODERATE, True, "high"
        reason = "The hypertension phenotype fits, but the physician's explicit rule places nephrology first because renal function is progressively declining."
        urgency = "Routine after or alongside nephrology"
    elif profile.id == "physician-patel":
        evidence.insert(
            0, Evidence(kind=EvidenceKind.EXPLICIT_RULE, detail=profile.explicit_rules[0])
        )
        fit, accepts, confidence = ClinicalFit.MODERATE, True, "medium"
        reason = "General cardiology can assess resistant hypertension and cardiovascular risk, but it does not best explain the renal trajectory."
        urgency = "Routine"
    elif profile.id == "physician-rossi":
        evidence.insert(
            0, Evidence(kind=EvidenceKind.EXPLICIT_RULE, detail=profile.explicit_rules[0])
        )
        fit, accepts, confidence = ClinicalFit.POOR, False, "high"
        reason = "No arrhythmia, syncope, or device concern is present; cardiology taxonomy alone is not a fit signal for electrophysiology."
        urgency = "Not indicated from supplied facts"
    else:
        evidence.insert(
            0, Evidence(kind=EvidenceKind.EXPLICIT_RULE, detail=profile.explicit_rules[0])
        )
        fit, accepts, confidence = ClinicalFit.POOR, False, "high"
        reason = "Diabetes is relevant, but the immediate referral question is progressive CKD with resistant hypertension rather than complex glycemic management."
        urgency = "Not the lead referral"

    if profile.id == "physician-jung":
        evidence.insert(
            0, Evidence(kind=EvidenceKind.EXPLICIT_RULE, detail=profile.explicit_rules[0])
        )
    return PhysicianEvaluation(
        physician_id=profile.id,
        physician_name=profile.name,
        specialty=profile.specialty,
        clinical_fit=fit,
        accepts_case=accepts,
        reason=reason,
        evidence=evidence,
        required_workup=profile.required_workup,
        urgency=urgency,
        availability=f"Approximately {profile.availability_days} days",
        insurance_status=_insurance_status(patient, profile),
        confidence=confidence,
    )
