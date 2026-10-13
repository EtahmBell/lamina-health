/** Lamina only wires a real, agent-consulted case for three patients (Jordan Lee,
 * Maria Santos, Tonjit Askarov) — see backend/synthetic_data/fixtures.py's consult
 * engine. The rest of this roster exists so the Patients page and Dashboard read
 * like an established practice with cases at every stage, not a sparse three-patient
 * demo. Their `stage`/`stageNote` are honest, static descriptions — never a
 * fabricated live consultation. */
export type PatientStage = 'new' | 'in_review' | 'referred' | 'workup' | 'followup' | 'closed'

export type DemoPatientSummary = {
  id: string
  name: string
  initials: string
  age: number
  location: string
  reason: string
  implemented: boolean
  recent: boolean
  stage: PatientStage
  stageNote: string
  /** Which physician's own patient panel this belongs to -- undefined means
   * Lucy's roster (the historical default, every existing entry below).
   * Chen's own pre-existing synthetic patients (closed-loop referral pass 2)
   * are tagged 'chen' so they render on his Patients page, never Lucy's. */
  owner?: 'chen'
}

export const DEMO_PATIENTS: DemoPatientSummary[] = [
  {
    id: 'patient-ckd-htn-001',
    name: 'Jordan Lee',
    initials: 'JL',
    age: 62,
    location: 'Oakland, CA',
    reason: 'Resistant hypertension with progressive renal dysfunction',
    implemented: true,
    recent: true,
    stage: 'new',
    stageNote: 'Real agent-consulted demo case.',
  },
  {
    id: 'patient-ida-002',
    name: 'Maria Santos',
    initials: 'MS',
    age: 54,
    location: 'Oakland, CA',
    reason: 'Persistent iron-deficiency anaemia despite oral iron',
    implemented: true,
    recent: true,
    stage: 'new',
    stageNote: 'Real agent-consulted demo case.',
  },
  {
    id: 'patient-t2dm-003',
    name: 'Tonjit Askarov',
    initials: 'TA',
    age: 52,
    location: 'Fremont, CA',
    reason: 'Worsening type 2 diabetes despite medication escalation',
    implemented: true,
    recent: true,
    stage: 'new',
    stageNote: 'Worsening glycemic control despite medication escalation.',
  },
  {
    id: 'patient-syncope-003',
    name: 'Marcus Chen',
    initials: 'MC',
    age: 71,
    location: 'Alameda, CA',
    reason: 'Recurrent unexplained syncope',
    implemented: false,
    recent: true,
    stage: 'new',
    stageNote: 'Intake complete; not yet sent to the network for consult.',
  },
  {
    id: 'patient-diabetes-004',
    name: 'Priya Shah',
    initials: 'PS',
    age: 55,
    location: 'Oakland, CA',
    reason: 'Uncontrolled diabetes with endocrine question',
    implemented: false,
    recent: false,
    stage: 'in_review',
    stageNote: "Your agent is reviewing the case before reaching out to the network.",
  },
  {
    id: 'patient-copd-005',
    name: 'Walter Osei',
    initials: 'WO',
    age: 68,
    location: 'Berkeley, CA',
    reason: 'Worsening COPD exacerbations despite inhaler therapy',
    implemented: false,
    recent: false,
    stage: 'referred',
    stageNote: 'Referred to pulmonology; appointment pending.',
  },
  {
    id: 'patient-thyroid-006',
    name: 'Dana Whitfield',
    initials: 'DW',
    age: 46,
    location: 'Oakland, CA',
    reason: 'Thyroid nodule found on routine imaging',
    implemented: false,
    recent: false,
    stage: 'workup',
    stageNote: 'Awaiting additional labs and imaging before the network is consulted.',
  },
  {
    id: 'patient-migraine-007',
    name: 'Esteban Ruiz',
    initials: 'ER',
    age: 33,
    location: 'San Leandro, CA',
    reason: 'Chronic migraine, considering neurology referral',
    implemented: false,
    recent: false,
    stage: 'workup',
    stageNote: 'Trialing a preventive regimen before deciding whether to refer out.',
  },
  {
    id: 'patient-osteo-008',
    name: 'Grace Lindqvist',
    initials: 'GL',
    age: 77,
    location: 'Alameda, CA',
    reason: 'Osteoporosis management after a fragility fracture',
    implemented: false,
    recent: false,
    stage: 'followup',
    stageNote: 'Stable on treatment; six-month follow-up scheduled.',
  },
  {
    id: 'patient-gerd-009',
    name: 'Noah Kessler',
    initials: 'NK',
    age: 41,
    location: 'Oakland, CA',
    reason: 'GERD symptoms, responded well to lifestyle changes and PPI',
    implemented: false,
    recent: false,
    stage: 'closed',
    stageNote: 'Symptoms resolved; no further specialty input needed at this time.',
  },
  {
    id: 'patient-afib-010',
    name: 'Helen Okafor',
    initials: 'HO',
    age: 74,
    location: 'Berkeley, CA',
    reason: 'New atrial fibrillation, anticoagulation and rate control established',
    implemented: false,
    recent: false,
    stage: 'closed',
    stageNote: 'Cardiology referral completed last quarter; case closed on this end.',
  },
  // Dr. Chen's pre-existing synthetic patient panel (closed-loop referral pass
  // 2) -- real, openable fixture patients (see backend/synthetic_data/fixtures.py),
  // never Lucy's roster. Tonjit is deliberately absent here: he only becomes
  // Chen's patient through the real referral-acceptance flow, never a static
  // entry (see CHEN_PATIENT_IDS below / Part E).
  {
    id: 'patient-chen-elena-001',
    name: 'Elena Martinez',
    initials: 'EM',
    age: 46,
    location: 'Oakland, CA',
    reason: 'Type 1 diabetes with recurrent nocturnal hypoglycemia',
    implemented: false,
    recent: true,
    stage: 'in_review',
    stageNote: 'Basal insulin dose under review to reduce overnight lows.',
    owner: 'chen',
  },
  {
    id: 'patient-chen-daniel-002',
    name: 'Daniel Cho',
    initials: 'DC',
    age: 61,
    location: 'Oakland, CA',
    reason: 'Type 2 diabetes after recent medication intensification',
    implemented: false,
    recent: true,
    stage: 'followup',
    stageNote: 'Follow-up visit scheduled to reassess response to semaglutide.',
    owner: 'chen',
  },
  {
    id: 'patient-chen-maya-003',
    name: 'Maya Thompson',
    initials: 'MT',
    age: 34,
    location: 'Berkeley, CA',
    reason: 'Thyroid nodule with indeterminate cytology',
    implemented: false,
    recent: true,
    stage: 'workup',
    stageNote: 'Repeat biopsy or diagnostic lobectomy under consideration.',
    owner: 'chen',
  },
  {
    id: 'patient-chen-robert-004',
    name: 'Robert Greene',
    initials: 'RG',
    age: 58,
    location: 'Oakland, CA',
    reason: 'Type 2 diabetes with persistent hyperglycemia and obesity',
    implemented: false,
    recent: true,
    stage: 'new',
    stageNote: 'Considering additional glucose-lowering therapy with weight-loss benefit.',
    owner: 'chen',
  },
  {
    id: 'patient-chen-aisha-005',
    name: 'Aisha Khan',
    initials: 'AK',
    age: 29,
    location: 'Oakland, CA',
    reason: 'Graves disease with treatment-response monitoring',
    implemented: false,
    recent: true,
    stage: 'new',
    stageNote: 'Symptoms improved on methimazole; monitoring treatment response.',
    owner: 'chen',
  },
  {
    id: 'patient-chen-peter-006',
    name: 'Peter Wallace',
    initials: 'PW',
    age: 67,
    location: 'San Francisco, CA',
    reason: 'Osteoporosis following fragility fracture',
    implemented: false,
    recent: false,
    stage: 'followup',
    stageNote: 'Follow-up DEXA scan planned to reassess bone density.',
    owner: 'chen',
  },
]

/** Chen's seeded patient-panel ids, derived (not hand-duplicated) so the
 * Tonjit-exclusion invariant is checkable in one place (Part E). */
export const CHEN_PATIENT_IDS = DEMO_PATIENTS.filter((patient) => patient.owner === 'chen').map((patient) => patient.id)
