from backend.models import HistoricalCase, LabObservation, PatientRecord, PhysicianProfile

PRIMARY_PATIENT_ID = "patient-ckd-htn-001"
MARIA_PATIENT_ID = "patient-ida-002"

PATIENTS = {
    PRIMARY_PATIENT_ID: PatientRecord(
        id=PRIMARY_PATIENT_ID,
        display_name="Jordan Lee (synthetic)",
        age=62,
        diagnoses=[
            "Resistant hypertension",
            "Type 2 diabetes mellitus",
            "Progressive chronic kidney disease",
        ],
        medications=["Lisinopril", "Amlodipine", "Chlorthalidone"],
        labs=[
            LabObservation(date="2025-01-12", test="creatinine", value=1.1, unit="mg/dL"),
            LabObservation(date="2025-05-16", test="creatinine", value=1.3, unit="mg/dL"),
            LabObservation(date="2026-01-09", test="creatinine", value=1.6, unit="mg/dL"),
            LabObservation(date="2026-08-21", test="creatinine", value=1.8, unit="mg/dL"),
            LabObservation(date="2025-01-12", test="eGFR", value=68, unit="mL/min/1.73m2"),
            LabObservation(date="2025-05-16", test="eGFR", value=59, unit="mL/min/1.73m2"),
            LabObservation(date="2026-01-09", test="eGFR", value=48, unit="mL/min/1.73m2"),
            LabObservation(date="2026-08-21", test="eGFR", value=41, unit="mL/min/1.73m2"),
        ],
        insurance="Lamina Demo PPO",
        location="Oakland, CA",
    ),
    MARIA_PATIENT_ID: PatientRecord(
        id=MARIA_PATIENT_ID,
        display_name="Maria Santos (synthetic)",
        age=54,
        diagnoses=["Persistent iron-deficiency anaemia", "Microcytic anaemia"],
        medications=["Ferrous sulfate (oral iron)"],
        labs=[
            LabObservation(date="2025-10-10", test="hemoglobin", value=10.8, unit="g/dL"),
            LabObservation(date="2026-03-13", test="hemoglobin", value=10.1, unit="g/dL"),
            LabObservation(date="2026-08-28", test="hemoglobin", value=9.5, unit="g/dL"),
            LabObservation(date="2026-08-28", test="ferritin", value=7, unit="ng/mL"),
            LabObservation(date="2026-08-28", test="serum_iron", value=28, unit="ug/dL"),
            LabObservation(date="2026-08-28", test="TIBC", value=410, unit="ug/dL"),
            LabObservation(date="2026-08-28", test="transferrin_saturation", value=7, unit="%"),
            LabObservation(date="2026-08-28", test="MCV", value=74, unit="fL"),
            LabObservation(date="2026-08-28", test="WBC", value=6.4, unit="10*3/uL"),
            LabObservation(date="2026-08-28", test="platelets", value=318, unit="10*3/uL"),
        ],
        clinical_notes=[
            "Fatigue with reduced exercise tolerance; no acute instability",
            "Persistent deficiency despite an adequate oral iron trial",
            "No documented prior upper or lower endoscopic evaluation",
            "No established bleeding source",
            "No known haematologic malignancy or additional cytopenias",
        ],
        insurance="Lamina Demo PPO",
        location="Oakland, CA",
    ),
}

PHYSICIANS = [
    PhysicianProfile(
        id="physician-jung",
        name="Dr. Iain Jung (synthetic)",
        specialty="Nephrology",
        subspecialty="Hypertension and cardiorenal medicine",
        focus_areas=[
            "CKD stage 3–4",
            "resistant hypertension",
            "proteinuria",
            "cardiorenal disease",
        ],
        accepts_signals=["ckd_stage_3", "progressive_renal_dysfunction", "resistant_hypertension"],
        explicit_rules=[
            "Prioritize progressive CKD with resistant hypertension for nephrology review."
        ],
        required_workup=[
            "Current basic metabolic panel (BMP)",
            "Urine protein/creatinine ratio (UPCR)",
        ],
        historical_cases=[
            HistoricalCase(
                label="Progressive diabetic CKD with difficult blood pressure control",
                features=[
                    "diabetes",
                    "ckd_stage_3",
                    "progressive_renal_dysfunction",
                    "resistant_hypertension",
                ],
            ),
            HistoricalCase(
                label="Proteinuric CKD referred for cardiorenal management",
                features=["proteinuria", "ckd_stage_3"],
            ),
        ],
        insurance_networks=["Lamina Demo PPO", "Bay Demo HMO"],
        location="Oakland, CA",
        availability_days=8,
    ),
    PhysicianProfile(
        id="physician-onadeko",
        name="Dr. Matthew Onadeko (synthetic)",
        specialty="Cardiology",
        subspecialty="Hypertension cardiology",
        focus_areas=["resistant hypertension", "secondary hypertension", "cardiovascular risk"],
        accepts_signals=["resistant_hypertension", "diabetes"],
        explicit_rules=[
            "When renal function is progressively declining, nephrology should evaluate first; hypertension cardiology can follow or co-manage."
        ],
        required_workup=["Home blood-pressure log", "Current ECG"],
        historical_cases=[
            HistoricalCase(
                label="Resistant hypertension despite multidrug therapy",
                features=["resistant_hypertension", "diabetes"],
            )
        ],
        insurance_networks=["Lamina Demo PPO"],
        location="San Francisco, CA",
        availability_days=42,
    ),
    PhysicianProfile(
        id="physician-patel",
        name="Dr. Celeste Bell (synthetic)",
        specialty="Cardiology",
        subspecialty="General cardiology",
        focus_areas=["hypertension", "ischemic heart disease", "cardiovascular risk"],
        accepts_signals=["resistant_hypertension", "diabetes"],
        explicit_rules=[
            "Accept resistant hypertension when a cardiac evaluation is specifically needed."
        ],
        required_workup=["Current ECG", "Home blood-pressure log"],
        historical_cases=[
            HistoricalCase(
                label="Hypertension with elevated cardiovascular risk",
                features=["resistant_hypertension", "diabetes"],
            )
        ],
        insurance_networks=["Lamina Demo PPO", "Bay Demo HMO"],
        location="Berkeley, CA",
        availability_days=24,
    ),
    PhysicianProfile(
        id="physician-rossi",
        name="Dr. Elena Rossi (synthetic)",
        specialty="Cardiac Electrophysiology",
        subspecialty="Arrhythmia management",
        focus_areas=["atrial fibrillation", "syncope", "device management"],
        accepts_signals=["arrhythmia", "syncope"],
        explicit_rules=[
            "Do not route isolated hypertension or CKD without an arrhythmia concern to electrophysiology."
        ],
        required_workup=["ECG documenting suspected rhythm disorder"],
        historical_cases=[
            HistoricalCase(label="Symptomatic atrial fibrillation", features=["arrhythmia"])
        ],
        insurance_networks=["Lamina Demo PPO"],
        location="San Francisco, CA",
        availability_days=18,
    ),
    PhysicianProfile(
        id="physician-chen",
        name="Dr. Noah Chen (synthetic)",
        specialty="Endocrinology",
        subspecialty="Diabetes",
        focus_areas=["complex diabetes", "metabolic disease"],
        accepts_signals=["diabetes"],
        explicit_rules=[
            "Diabetes alone does not make endocrinology the lead service for progressive CKD."
        ],
        required_workup=["Current HbA1c"],
        historical_cases=[
            HistoricalCase(label="Complex diabetes medication management", features=["diabetes"])
        ],
        insurance_networks=["Bay Demo HMO"],
        location="Oakland, CA",
        availability_days=15,
    ),
]

MARIA_PHYSICIANS = [
    PhysicianProfile(
        id="physician-alvarez",
        name="Dr. Sofia Alvarez (synthetic)",
        specialty="Gastroenterology",
        subspecialty="Occult gastrointestinal blood loss",
        focus_areas=["iron-deficiency anaemia", "occult GI blood loss", "diagnostic endoscopy"],
        accepts_signals=["iron_deficiency_anemia", "no_prior_endoscopy", "oral_iron_failure"],
        explicit_rules=[
            "Accept persistent iron-deficiency anaemia without prior GI source evaluation."
        ],
        required_workup=["Recent complete blood count (CBC)", "Ferritin", "Iron studies"],
        historical_cases=[
            HistoricalCase(
                label="Persistent iron deficiency without prior endoscopic evaluation",
                features=["iron_deficiency_anemia", "no_prior_endoscopy", "oral_iron_failure"],
            )
        ],
        insurance_networks=["Lamina Demo PPO"],
        location="Oakland, CA",
        availability_days=12,
    ),
    PhysicianProfile(
        id="physician-brooks",
        name="Dr. Naomi Brooks (synthetic)",
        specialty="Haematology",
        subspecialty="Anaemia and iron disorders",
        focus_areas=["refractory iron deficiency", "complex anaemia", "intravenous iron"],
        accepts_signals=["iron_deficiency_anemia", "oral_iron_failure"],
        explicit_rules=[
            (
                "For isolated iron deficiency without source evaluation, gastroenterology "
                "should generally evaluate first; haematology can follow for persistent "
                "anaemia or IV iron."
            )
        ],
        required_workup=["Recent complete blood count (CBC)", "Ferritin", "Iron studies"],
        historical_cases=[
            HistoricalCase(
                label="Refractory iron deficiency requiring parenteral replacement",
                features=["iron_deficiency_anemia", "oral_iron_failure"],
            )
        ],
        insurance_networks=["Lamina Demo PPO"],
        location="Berkeley, CA",
        availability_days=8,
    ),
    PhysicianProfile(
        id="physician-wu",
        name="Dr. Claire Wu (synthetic)",
        specialty="Gastroenterology",
        subspecialty="General gastroenterology",
        focus_areas=["iron-deficiency anaemia", "endoscopic source evaluation"],
        accepts_signals=["iron_deficiency_anemia", "no_prior_endoscopy"],
        explicit_rules=["Accept stable iron-deficiency anaemia after current iron studies."],
        required_workup=["Recent complete blood count (CBC)", "Iron studies"],
        historical_cases=[
            HistoricalCase(
                label="Outpatient evaluation of unexplained iron deficiency",
                features=["iron_deficiency_anemia", "no_prior_endoscopy"],
            )
        ],
        insurance_networks=["Lamina Demo PPO"],
        location="San Francisco, CA",
        availability_days=25,
    ),
    PhysicianProfile(
        id="physician-kim",
        name="Dr. Daniel Kim (synthetic)",
        specialty="Internal Medicine",
        subspecialty="Complex diagnostic medicine",
        focus_areas=["initial anaemia workup", "care coordination"],
        accepts_signals=["iron_deficiency_anemia"],
        explicit_rules=["Complete initial laboratory workup, then route to the source specialty."],
        required_workup=["Recent complete blood count (CBC)"],
        historical_cases=[],
        insurance_networks=["Lamina Demo PPO"],
        location="Oakland, CA",
        availability_days=14,
    ),
    PhysicianProfile(
        id="physician-reed",
        name="Dr. Maya Reed (synthetic)",
        specialty="Colorectal Surgery",
        subspecialty="Colorectal disease",
        focus_areas=["colorectal lesions", "operative management"],
        accepts_signals=["identified_colorectal_lesion"],
        explicit_rules=[
            "Do not route unexplained iron deficiency to surgery before diagnostic source evaluation."
        ],
        required_workup=["Completed diagnostic evaluation identifying a surgical lesion"],
        historical_cases=[],
        insurance_networks=["Lamina Demo PPO"],
        location="Oakland, CA",
        availability_days=16,
    ),
]

DEMO_NETWORK_PHYSICIANS = [
    PhysicianProfile(
        id="physician-cha",
        name="Dr. Lianne Cha (synthetic)",
        specialty="Primary Care",
        subspecialty="Primary care and specialty-care coordination",
        focus_areas=["primary care", "specialty-care coordination"],
        accepts_signals=[],
        explicit_rules=[],
        required_workup=[],
        historical_cases=[],
        insurance_networks=["Lamina Demo PPO"],
        location="Oakland, CA",
        availability_days=21,
    ),
]

ALL_PHYSICIANS = [*PHYSICIANS, *MARIA_PHYSICIANS, *DEMO_NETWORK_PHYSICIANS]
PHYSICIANS_BY_PATIENT = {
    PRIMARY_PATIENT_ID: PHYSICIANS,
    MARIA_PATIENT_ID: MARIA_PHYSICIANS,
}
