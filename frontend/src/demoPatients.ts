/** Lamina only wires a real, agent-consulted case for two patients (Jordan Lee,
 * Maria Santos) — see backend/synthetic_data/fixtures.py's consult engine. The
 * rest of this roster exists so the Patients page and Dashboard read like an
 * established practice with cases at every stage, not a sparse two-patient demo.
 * Their `stage`/`stageNote` are honest, static descriptions — never a fabricated
 * live consultation. */
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
]
