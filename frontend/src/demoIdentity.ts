import { DEMO_PATIENTS } from './demoPatients.ts'

/** Stable synthetic demo identities shared by the workspace screens. */
export const JORDAN_ID = 'patient-ckd-htn-001'
export const MARIA_ID = 'patient-ida-002'
export const PCP_NAME = 'Dr. Lucy Saruhashi'
export const PCP_AGENT_NAME = "Dr. Lucy Saruhashi's Agent"
export const PCP_AGENT_ID = 'agent-pcp-lianne-cha'

/** The one controlled, workspace-isolated specialist demo persona (Pass 3A). */
export const SPECIALIST_NAME = 'Dr. Iain Jung'
export const SPECIALIST_AGENT_NAME = "Dr. Iain Jung's Agent"
export const SPECIALIST_SPECIALTY = 'Nephrology'
export const SPECIALIST_NPI = '9900000001'

/** NPI → controlled engagement persona id, for the three physicians Pass 4A
 * built professional profiles for. Physicians outside this map simply have
 * no professional-profile link — never fabricated. */
export const ENGAGEMENT_PERSONA_BY_NPI: Record<string, 'iain' | 'onadeko' | 'sofia'> = {
  '9900000001': 'iain',
  '9900000002': 'onadeko',
  '9900000006': 'sofia',
}

export const cleanName = (name: string) => name.replace(' (synthetic)', '')
export const patientName = (id: string) => DEMO_PATIENTS.find((item) => item.id === id)?.name || id
export const patientInitials = (id: string) => DEMO_PATIENTS.find((item) => item.id === id)?.initials || '··'
