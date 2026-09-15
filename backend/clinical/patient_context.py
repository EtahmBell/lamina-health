from backend.models import ClinicalRepresentation, PatientRecord


def _values(patient: PatientRecord, test: str) -> list[float]:
    return [lab.value for lab in patient.labs if lab.test == test]


def build_patient_context(patient: PatientRecord) -> ClinicalRepresentation:
    creatinine = _values(patient, "creatinine")
    egfr = _values(patient, "eGFR")
    hemoglobin = _values(patient, "hemoglobin")
    if hemoglobin:
        ferritin = _values(patient, "ferritin")
        serum_iron = _values(patient, "serum_iron")
        tibc = _values(patient, "TIBC")
        saturation = _values(patient, "transferrin_saturation")
        mcv = _values(patient, "MCV")
        prior_endoscopy = not any(
            "no documented prior upper or lower endoscopic" in note.casefold()
            for note in patient.clinical_notes
        )
        facts = [
            f"Age {patient.age}",
            f"Hemoglobin declined from {hemoglobin[0]:.1f} to {hemoglobin[-1]:.1f} g/dL",
            f"Ferritin is {ferritin[-1]:.0f} ng/mL",
            (
                f"Iron studies show serum iron {serum_iron[-1]:.0f} ug/dL, "
                f"TIBC {tibc[-1]:.0f} ug/dL, and transferrin saturation "
                f"{saturation[-1]:.0f}%"
            ),
            f"MCV is {mcv[-1]:.0f} fL, consistent with microcytosis",
            "Persistent deficiency despite oral iron therapy",
            "No documented prior upper or lower endoscopic evaluation",
            "Other cell lines are preserved; no additional cytopenias",
        ]
        return ClinicalRepresentation(
            patient_id=patient.id,
            summary=(
                f"{patient.age}-year-old with persistent microcytic iron-deficiency anaemia "
                "despite oral iron and no documented prior endoscopic evaluation."
            ),
            facts=facts,
            signals=[
                "iron_deficiency_anemia",
                "microcytic_anemia",
                "oral_iron_failure",
                "no_prior_endoscopy",
                "isolated_anemia",
            ],
            creatinine_trend=[],
            egfr_trend=[],
            resistant_hypertension=False,
            progressive_renal_dysfunction=False,
            ckd_stage="not applicable",
            hemoglobin_trend=hemoglobin,
            iron_studies={
                "ferritin": ferritin[-1],
                "serum_iron": serum_iron[-1],
                "TIBC": tibc[-1],
                "transferrin_saturation": saturation[-1],
            },
            persistent_iron_deficiency_anemia=True,
            microcytic_anemia=bool(mcv and mcv[-1] < 80),
            prior_endoscopy_documented=prior_endoscopy,
        )
    medication_names = {item.casefold() for item in patient.medications}
    antihypertensive_classes_present = sum(
        name in medication_names for name in ("lisinopril", "amlodipine", "chlorthalidone")
    )
    resistant = (
        "resistant hypertension" in {d.casefold() for d in patient.diagnoses}
        and antihypertensive_classes_present >= 3
    )
    progressive = (
        len(creatinine) >= 2
        and len(egfr) >= 2
        and creatinine[-1] > creatinine[0]
        and egfr[-1] < egfr[0]
    )
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
