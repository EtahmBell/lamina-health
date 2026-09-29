import { DEMO_PATIENTS } from './demoPatients.ts'

/** Stable synthetic demo identities shared by the workspace screens. */
export const JORDAN_ID = 'patient-ckd-htn-001'
export const MARIA_ID = 'patient-ida-002'
export const PCP_NAME = 'Dr. Lucy Saru'
export const PCP_AGENT_NAME = "Dr. Lucy Saru's Agent"
export const PCP_AGENT_ID = 'agent-pcp-lianne-cha'

export const cleanName = (name: string) => name.replace(' (synthetic)', '')
export const patientName = (id: string) => DEMO_PATIENTS.find((item) => item.id === id)?.name || id
export const patientInitials = (id: string) => DEMO_PATIENTS.find((item) => item.id === id)?.initials || '··'
