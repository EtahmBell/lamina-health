from backend.models import (
    ClinicalRepresentation,
    HistoricalCase,
    LabObservation,
    PatientRecord,
    PhysicianCaseRules,
    PhysicianProfile,
)

PRIMARY_PATIENT_ID = "patient-ckd-htn-001"
MARIA_PATIENT_ID = "patient-ida-002"
TONJIT_PATIENT_ID = "patient-t2dm-003"

# Dr. Chen's pre-existing synthetic patient panel (closed-loop referral pass
# 2) -- believable established endocrinology patients, lightweight by design
# (no referral_question, no elaborate case-family wiring): these patients
# already belong to Chen at the start of the demo, never arriving via the
# referral workflow. Tonjit is deliberately NOT included here -- he only
# becomes Chen's patient through the real accept_referral flow.
CHEN_ELENA_PATIENT_ID = "patient-chen-elena-001"
CHEN_DANIEL_PATIENT_ID = "patient-chen-daniel-002"
CHEN_MAYA_PATIENT_ID = "patient-chen-maya-003"
CHEN_ROBERT_PATIENT_ID = "patient-chen-robert-004"
CHEN_AISHA_PATIENT_ID = "patient-chen-aisha-005"
CHEN_PETER_PATIENT_ID = "patient-chen-peter-006"
CHEN_SEEDED_PATIENT_IDS = [
    CHEN_ELENA_PATIENT_ID,
    CHEN_DANIEL_PATIENT_ID,
    CHEN_MAYA_PATIENT_ID,
    CHEN_ROBERT_PATIENT_ID,
    CHEN_AISHA_PATIENT_ID,
    CHEN_PETER_PATIENT_ID,
]

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
    TONJIT_PATIENT_ID: PatientRecord(
        id=TONJIT_PATIENT_ID,
        display_name="Tonjit Askarov (synthetic)",
        age=52,
        diagnoses=["Type 2 diabetes mellitus"],
        medications=["Metformin", "Sitagliptin"],
        labs=[
            LabObservation(date="2025-03-10", test="HbA1c", value=7.1, unit="%"),
            LabObservation(date="2025-09-08", test="HbA1c", value=7.8, unit="%"),
            LabObservation(date="2026-03-16", test="HbA1c", value=8.7, unit="%"),
            LabObservation(date="2026-09-05", test="HbA1c", value=9.6, unit="%"),
            LabObservation(date="2025-03-10", test="fasting_glucose", value=128, unit="mg/dL"),
            LabObservation(date="2025-09-08", test="fasting_glucose", value=154, unit="mg/dL"),
            LabObservation(date="2026-03-16", test="fasting_glucose", value=183, unit="mg/dL"),
            LabObservation(date="2026-09-05", test="fasting_glucose", value=214, unit="mg/dL"),
            LabObservation(date="2026-09-05", test="weight", value=91, unit="kg"),
            LabObservation(date="2026-07-20", test="creatinine", value=0.9, unit="mg/dL"),
            LabObservation(date="2026-07-20", test="eGFR", value=97, unit="mL/min/1.73m2"),
            LabObservation(date="2026-07-20", test="urine_albumin", value=18, unit="mg/g"),
        ],
        clinical_notes=[
            "HbA1c has risen steadily over the past 18 months despite stepwise oral medication escalation.",
            "Metformin was established at diagnosis; sitagliptin was added in September 2025 after the first noted rise in HbA1c.",
            "Weight increased from approximately 84 kg to 91 kg over the same period.",
            "No prior endocrinology evaluation; management has been entirely primary-care based.",
            "Recent renal function and urine albumin are both within normal limits.",
        ],
        insurance="Lamina Demo PPO",
        location="Fremont, CA",
        referral_question=(
            "Persistent worsening type 2 diabetes despite medication escalation. Please "
            "evaluate for treatment intensification and additional management options."
        ),
    ),
    CHEN_ELENA_PATIENT_ID: PatientRecord(
        id=CHEN_ELENA_PATIENT_ID,
        display_name="Elena Martinez (synthetic)",
        age=46,
        diagnoses=["Type 1 diabetes mellitus", "Recurrent nocturnal hypoglycemia"],
        medications=["Insulin glargine", "Insulin lispro"],
        labs=[
            LabObservation(date="2026-04-02", test="HbA1c", value=7.4, unit="%"),
            LabObservation(date="2026-08-14", test="HbA1c", value=7.2, unit="%"),
        ],
        clinical_notes=[
            "Several nocturnal hypoglycemic episodes recorded via continuous glucose monitor over the past month.",
            "Basal insulin dose under review to reduce overnight lows.",
            "No recent hospitalization; episodes managed at home.",
        ],
        insurance="Lamina Demo PPO",
        location="Oakland, CA",
    ),
    CHEN_DANIEL_PATIENT_ID: PatientRecord(
        id=CHEN_DANIEL_PATIENT_ID,
        display_name="Daniel Cho (synthetic)",
        age=61,
        diagnoses=["Type 2 diabetes mellitus"],
        medications=["Metformin", "Semaglutide"],
        labs=[
            LabObservation(date="2026-05-20", test="HbA1c", value=8.3, unit="%"),
            LabObservation(date="2026-08-26", test="HbA1c", value=7.6, unit="%"),
        ],
        clinical_notes=[
            "Semaglutide added three months ago after insufficient control on metformin alone.",
            "Follow-up visit scheduled to reassess HbA1c response.",
            "Tolerating medication intensification well; no GI side effects reported.",
        ],
        insurance="Bay Demo HMO",
        location="Oakland, CA",
    ),
    CHEN_MAYA_PATIENT_ID: PatientRecord(
        id=CHEN_MAYA_PATIENT_ID,
        display_name="Maya Thompson (synthetic)",
        age=34,
        diagnoses=["Thyroid nodule, indeterminate cytology"],
        medications=[],
        labs=[],
        clinical_notes=[
            "Thyroid nodule identified on routine neck ultrasound.",
            "Fine-needle aspiration cytology returned indeterminate; repeat biopsy or diagnostic lobectomy under consideration.",
            "No compressive symptoms or voice change reported.",
        ],
        insurance="Lamina Demo PPO",
        location="Berkeley, CA",
    ),
    CHEN_ROBERT_PATIENT_ID: PatientRecord(
        id=CHEN_ROBERT_PATIENT_ID,
        display_name="Robert Greene (synthetic)",
        age=58,
        diagnoses=["Type 2 diabetes mellitus", "Obesity"],
        medications=["Metformin", "Insulin glargine"],
        labs=[
            LabObservation(date="2026-06-11", test="HbA1c", value=9.1, unit="%"),
            LabObservation(date="2026-08-29", test="weight", value=112, unit="kg"),
        ],
        clinical_notes=[
            "Persistent hyperglycemia despite basal insulin and metformin.",
            "Weight has remained stable despite dietary counseling.",
            "Considering additional glucose-lowering therapy with weight-loss benefit.",
        ],
        insurance="Lamina Demo PPO",
        location="Oakland, CA",
    ),
    CHEN_AISHA_PATIENT_ID: PatientRecord(
        id=CHEN_AISHA_PATIENT_ID,
        display_name="Aisha Khan (synthetic)",
        age=29,
        diagnoses=["Graves disease", "Hyperthyroidism"],
        medications=["Methimazole"],
        labs=[],
        clinical_notes=[
            "Started on methimazole for Graves disease four months ago.",
            "Symptoms of hyperthyroidism have improved; monitoring treatment response.",
            "No ophthalmologic involvement reported.",
        ],
        insurance="Bay Demo HMO",
        location="Oakland, CA",
    ),
    CHEN_PETER_PATIENT_ID: PatientRecord(
        id=CHEN_PETER_PATIENT_ID,
        display_name="Peter Wallace (synthetic)",
        age=67,
        diagnoses=["Osteoporosis", "History of fragility fracture"],
        medications=["Alendronate", "Vitamin D", "Calcium carbonate"],
        labs=[],
        clinical_notes=[
            "Sustained a distal radius fragility fracture one year ago.",
            "Started on oral bisphosphonate therapy following fracture.",
            "Follow-up DEXA scan planned to reassess bone density.",
        ],
        insurance="Lamina Demo PPO",
        location="San Francisco, CA",
    ),
}

# ONE canonical physician identity for Dr. Noah Chen, shared by every patient pool
# he appears in (Jordan's and Tonjit's). His stable professional footprint lives
# here; what differs per case family (diabetes vs. CKD/hypertension) lives in
# PHYSICIAN_CASE_RULES below, never in a second competing PhysicianProfile object.
PHYSICIAN_CHEN = PhysicianProfile(
    id="physician-chen",
    name="Dr. Noah Chen (synthetic)",
    specialty="Endocrinology",
    subspecialty="Diabetes",
    focus_areas=["complex diabetes", "type 2 diabetes", "treatment intensification", "metabolic disease"],
    accepts_signals=["type_2_diabetes", "progressive_glycemic_control"],
    explicit_rules=[
        "Accept progressive type 2 diabetes with worsening HbA1c despite primary-care medication escalation."
    ],
    required_workup=["Current HbA1c", "Home glucose log"],
    # Privacy-preserving practice-history PATTERNS (routing consolidation
    # pass, Part D) -- structured kinds of cases from his synthetic case mix,
    # never prior patients, and deliberately without counts.
    historical_cases=[
        HistoricalCase(
            label="Progressive type 2 diabetes despite oral medication escalation",
            features=["type_2_diabetes", "progressive_glycemic_control"],
            modalities_used=["in_person"],
        ),
        HistoricalCase(
            label="Treatment intensification after inadequate glycemic control on multiple agents",
            features=["type_2_diabetes", "progressive_glycemic_control"],
            modalities_used=["in_person"],
        ),
        HistoricalCase(
            label="Focused diabetes medication-management questions with complete recent workup",
            features=["type_2_diabetes", "focused_medication_question"],
            modalities_used=["econsult"],
        ),
    ],
    insurance_networks=["Lamina Demo PPO", "Bay Demo HMO"],
    location="Oakland, CA",
    # Demo hardening pass, Part K: matches his visit access profile (~10 days).
    availability_days=10,
)

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
    PHYSICIAN_CHEN,
]

MARIA_PHYSICIANS = [
    PhysicianProfile(
        id="physician-sanchez",
        name="Dr. Tiffany Sanchez (synthetic)",
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
        availability_days=9,
    ),
    PhysicianProfile(
        id="physician-alvarez",
        name="Dr. Sofia Alvarez (synthetic)",
        specialty="Gastroenterology",
        subspecialty="General gastroenterology",
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

TONJIT_PHYSICIANS = [
    PHYSICIAN_CHEN,
    PhysicianProfile(
        id="physician-okonkwo",
        name="Dr. Adaeze Okonkwo (synthetic)",
        specialty="Endocrinology",
        subspecialty="General endocrinology",
        focus_areas=["type 2 diabetes", "metabolic disease"],
        accepts_signals=["type_2_diabetes", "progressive_glycemic_control"],
        explicit_rules=[
            "Accept progressive type 2 diabetes needing treatment intensification."
        ],
        required_workup=["Current HbA1c", "Home glucose log"],
        historical_cases=[
            HistoricalCase(
                label="Type 2 diabetes requiring treatment intensification",
                features=["type_2_diabetes", "progressive_glycemic_control"],
            )
        ],
        insurance_networks=["Lamina Demo PPO"],
        location="San Francisco, CA",
        availability_days=30,
    ),
    PhysicianProfile(
        id="physician-torres",
        name="Dr. Marcus Torres (synthetic)",
        specialty="Internal Medicine",
        subspecialty="Complex diagnostic medicine",
        focus_areas=["initial diabetes management", "care coordination"],
        accepts_signals=["type_2_diabetes"],
        explicit_rules=[
            "Complete initial medication titration in primary care before internal medicine consultation."
        ],
        required_workup=["Current HbA1c"],
        historical_cases=[],
        insurance_networks=["Lamina Demo PPO"],
        location="Oakland, CA",
        availability_days=12,
    ),
]

# Case-family-specific referral rules. A physician may legitimately evaluate
# different case families differently (Dr. Chen rejects a CKD/hypertension lead
# referral but accepts a progressive type 2 diabetes one) -- that variation lives
# here, keyed by (physician_id, case_family), rather than as two competing
# PhysicianProfile objects sharing one id. Physicians who only ever see one case
# family (everyone else, for now) have no entry here and simply fall back to
# their own PhysicianProfile fields -- see resolve_case_rules() below.
PHYSICIAN_CASE_RULES: list[PhysicianCaseRules] = [
    PhysicianCaseRules(
        physician_id="physician-chen",
        case_family="ckd_hypertension",
        accepts_signals=["diabetes"],
        explicit_rules=[
            "Diabetes alone does not make endocrinology the lead service for progressive CKD."
        ],
        required_workup=["Current HbA1c"],
        historical_cases=[
            HistoricalCase(label="Complex diabetes medication management", features=["diabetes"])
        ],
    ),
    # Demo-coherence causality fix: a ("physician-chen", "type_2_diabetes")
    # override used to live here too, but it only ever duplicated
    # PHYSICIAN_CHEN's own profile fields -- identical to what
    # resolve_case_rules()'s own generic fallback branch below already
    # produces. Removing it is a no-op for every existing caller (verified:
    # same accepts_signals/explicit_rules/required_workup/historical_cases
    # either way) and avoids presenting it as a second, distinct fixture
    # source for this case family now that Dr. Chen has his own confirmed-
    # preference system (backend/referral_preferences.py) -- see
    # requirements_for()'s _SUPERSEDED_BY_CONFIRMED_PREFERENCE guard for the
    # other half of this fix.
]
PHYSICIAN_CASE_RULES_BY_KEY: dict[tuple[str, str], PhysicianCaseRules] = {
    (rule.physician_id, rule.case_family): rule for rule in PHYSICIAN_CASE_RULES
}


def resolve_case_rules(
    profile: PhysicianProfile,
    context: ClinicalRepresentation,
    confirmed_preference: PhysicianCaseRules | None = None,
) -> PhysicianCaseRules:
    """The referral representation a physician applies for one patient's case
    family. `confirmed_preference` (NLP referral-preference pass, Part J), when
    supplied, takes priority over the static fixture -- the physician's own
    CONFIRMED persisted referral preference for this case family, never a
    draft/rejected one. Stays a pure function: the caller (see
    backend/referral_preferences.py) is responsible for looking up that
    confirmed preference from storage. Falls back to the physician's own
    general PhysicianProfile fields when neither a confirmed preference nor a
    case-specific fixture override exists, so physicians who only ever see one
    case family (nearly everyone, today) are completely unaffected."""
    if confirmed_preference is not None:
        return confirmed_preference
    override = PHYSICIAN_CASE_RULES_BY_KEY.get((profile.id, context.case_family))
    if override is not None:
        return override
    return PhysicianCaseRules(
        physician_id=profile.id,
        case_family=context.case_family,
        accepts_signals=profile.accepts_signals,
        explicit_rules=profile.explicit_rules,
        required_workup=profile.required_workup,
        historical_cases=profile.historical_cases,
    )


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


def _network_only(physician_id: str, name: str, specialty: str, subspecialty: str, location: str, availability_days: int) -> PhysicianProfile:
    """A controlled directory-only physician: visible in Network/Colleagues, never a
    consult-network candidate (not listed in PHYSICIANS_BY_PATIENT). Mirrors the
    physician-cha pattern above."""
    return PhysicianProfile(
        id=physician_id,
        name=f"{name} (synthetic)",
        specialty=specialty,
        subspecialty=subspecialty,
        focus_areas=[],
        accepts_signals=[],
        explicit_rules=[],
        required_workup=[],
        historical_cases=[],
        insurance_networks=["Lamina Demo PPO"],
        location=location,
        availability_days=availability_days,
    )


# Broadens the controlled synthetic network beyond the handful of consult-engine
# participants, so Network/Colleagues reads as a real professional population rather
# than an empty shell around five case-linked names.
EXPANDED_NETWORK_PHYSICIANS = [
    _network_only("physician-islam", "Dr. Noah Islam", "Pulmonology", "General pulmonology", "Oakland, CA", 11),
    _network_only("physician-muhammad", "Dr. Ahmed Muhammad", "Orthopedic Surgery", "Sports medicine", "San Francisco, CA", 19),
    _network_only("physician-guechtouli", "Dr. Hamidou Guechtouli", "Infectious Disease", "General infectious disease", "Oakland, CA", 14),
    _network_only("physician-mithel", "Dr. Chris Mithel", "Dermatology", "Medical dermatology", "Berkeley, CA", 23),
    _network_only("physician-daniels", "Dr. Connor Daniels", "Urology", "General urology", "San Francisco, CA", 17),
    _network_only("physician-miller", "Dr. Josh Miller", "Rheumatology", "Inflammatory arthritis", "Oakland, CA", 26),
    _network_only("physician-da-fieno-m", "Dr. Mattia Da Fieno", "Neurology", "General neurology", "Berkeley, CA", 20),
    _network_only("physician-da-fieno-l", "Dr. Lorenzo Da Fieno", "General Surgery", "Elective general surgery", "San Francisco, CA", 28),
    _network_only("physician-murtuza-lanier", "Dr. Carson Murtuza-Lanier", "Psychiatry", "Adult outpatient psychiatry", "Oakland, CA", 9),
    _network_only("physician-nakajima", "Dr. Dan Nakajima", "Pulmonology", "Sleep medicine", "San Francisco, CA", 15),
    _network_only("physician-ramanathan", "Dr. Maya Ramanathan", "Endocrinology", "Thyroid and metabolic disease", "Oakland, CA", 18),
    _network_only("physician-park", "Dr. Nina Park", "Obstetrics & Gynecology", "General OB/GYN", "Berkeley, CA", 13),
    _network_only("physician-desai", "Dr. Priya Desai", "Rheumatology", "Connective tissue disease", "San Francisco, CA", 22),
    _network_only("physician-chen-emily", "Dr. Emily Chen", "Dermatology", "Procedural dermatology", "Oakland, CA", 16),
    _network_only("physician-rahman", "Dr. Amina Rahman", "Pulmonology", "Asthma and COPD", "Berkeley, CA", 10),
    _network_only("physician-rosen", "Dr. Natalie Rosen", "Hematology/Oncology", "Benign hematology", "San Francisco, CA", 24),
]

ALL_PHYSICIANS = [
    *PHYSICIANS,
    *MARIA_PHYSICIANS,
    # PHYSICIAN_CHEN is already included via PHYSICIANS -- excluded here by
    # identity (not just id) since TONJIT_PHYSICIANS reuses that same canonical object.
    *[p for p in TONJIT_PHYSICIANS if p is not PHYSICIAN_CHEN],
    *DEMO_NETWORK_PHYSICIANS,
    *EXPANDED_NETWORK_PHYSICIANS,
]
PHYSICIANS_BY_PATIENT = {
    PRIMARY_PATIENT_ID: PHYSICIANS,
    MARIA_PATIENT_ID: MARIA_PHYSICIANS,
    TONJIT_PATIENT_ID: TONJIT_PHYSICIANS,
}
