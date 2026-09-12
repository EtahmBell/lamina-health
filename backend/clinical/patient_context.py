from backend.models import ClinicalRepresentation, PatientRecord


def build_patient_context(patient: PatientRecord) -> ClinicalRepresentation:
    creatinine = [lab.value for lab in patient.labs if lab.test == "creatinine"]
    egfr = [lab.value for lab in patient.labs if lab.test == "eGFR"]
    medication_names = {item.casefold() for item in patient.medications}
    antihypertensive_classes_present = sum(
        name in medication_names for name in ("lisinopril", "amlodipine", "chlorthalidone")
    )
    resistant = "resistant hypertension" in {d.casefold() for d in patient.diagnoses} and antihypertensive_classes_present >= 3
    progressive = len(creatinine) >= 2 and len(egfr) >= 2 and creatinine[-1] > creatinine[0] and egfr[-1] < egfr[0]
    ckd_stage = "stage 3b" if egfr and 30 <= egfr[-1] < 45 else "not determined"
    facts = [
        f"Age {patient.age}",
        "Resistant hypertension despite lisinopril, amlodipine, and chlorthalidone",
        f"Creatinine rose from {creatinine[0]:.1f} to {creatinine[-1]:.1f} mg/dL",
        f"eGFR declined from {egfr[0]:.0f} to {egfr[-1]:.0f} mL/min/1.73m²",
        "Type 2 diabetes mellitus",
        f"Current renal function is consistent with CKD {ckd_stage}",
    ]
    signals = ["resistant_hypertension", "diabetes"]
    if progressive:
        signals.append("progressive_renal_dysfunction")
    if ckd_stage.startswith("stage 3"):
        signals.append("ckd_stage_3")
    return ClinicalRepresentation(
        patient_id=patient.id,
        summary=(
            f"{patient.age}-year-old with resistant hypertension on three agents, diabetes, "
            f"and progressive {ckd_stage} chronic kidney disease."
        ),
        facts=facts,
        signals=signals,
        creatinine_trend=creatinine,
        egfr_trend=egfr,
        resistant_hypertension=resistant,
        progressive_renal_dysfunction=progressive,
        ckd_stage=ckd_stage,
    )

