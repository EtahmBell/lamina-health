export type DemoPatientSummary = {
  id: string
  name: string
  initials: string
  age: number
  location: string
  reason: string
  status: 'Ready to consult' | 'Not yet consulted' | 'Consultation complete'
  implemented: boolean
  recent: boolean
}

export const DEMO_PATIENTS: DemoPatientSummary[] = [
  {
    id: 'patient-ckd-htn-001',
    name: 'Jordan Lee',
    initials: 'JL',
    age: 62,
    location: 'Oakland, CA',
    reason: 'Resistant hypertension with progressive renal dysfunction',
    status: 'Ready to consult',
    implemented: true,
    recent: true,
  },
  {
    id: 'patient-anemia-002',
    name: 'Amelia Rivera',
    initials: 'AR',
    age: 48,
    location: 'Berkeley, CA',
    reason: 'Persistent iron-deficiency anaemia',
    status: 'Not yet consulted',
    implemented: false,
    recent: true,
  },
  {
    id: 'patient-syncope-003',
    name: 'Marcus Chen',
    initials: 'MC',
    age: 71,
    location: 'Alameda, CA',
    reason: 'Recurrent unexplained syncope',
    status: 'Not yet consulted',
    implemented: false,
    recent: true,
  },
  {
    id: 'patient-diabetes-004',
    name: 'Priya Shah',
    initials: 'PS',
    age: 55,
    location: 'Oakland, CA',
    reason: 'Uncontrolled diabetes with endocrine question',
    status: 'Not yet consulted',
    implemented: false,
    recent: false,
  },
]
