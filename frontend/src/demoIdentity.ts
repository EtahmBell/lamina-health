import { DEMO_PATIENTS } from './demoPatients.ts'

/** Stable synthetic demo identities shared by the workspace screens. */
export const JORDAN_ID = 'patient-ckd-htn-001'
export const MARIA_ID = 'patient-ida-002'
export const PCP_NAME = 'Dr. Lucy Saru'
export const PCP_AGENT_NAME = "Dr. Lucy Saru's Agent"
export const PCP_AGENT_ID = 'agent-pcp-lianne-cha'

/** The one controlled, workspace-isolated specialist demo persona (Pass 3A). */
export const SPECIALIST_NAME = 'Dr. Iain Jung'
export const SPECIALIST_AGENT_NAME = "Dr. Iain Jung's Agent"
export const SPECIALIST_SPECIALTY = 'Nephrology'
export const SPECIALIST_NPI = '9900000001'

export const cleanName = (name: string) => name.replace(' (synthetic)', '')
export const patientName = (id: string) => DEMO_PATIENTS.find((item) => item.id === id)?.name || id
export const patientInitials = (id: string) => DEMO_PATIENTS.find((item) => item.id === id)?.initials || '··'
