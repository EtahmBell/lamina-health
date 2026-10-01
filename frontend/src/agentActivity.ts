import type { ConsultationMessage, ConsultationRecord } from './api.ts'
import { JORDAN_ID, MARIA_ID, PCP_AGENT_ID, PCP_AGENT_NAME, cleanName, patientName } from './demoIdentity.ts'

/**
 * One canonical derivation of "my agent activity" from the structured consultation
 * events the backend already records. Home and My Agent → Activity both read this,
 * so interaction deep-linking has a single implementation.
 *
 * INTERACTION events carry the stable backend message id and deep-link to that exact
 * event inside the network consultation record. MILESTONE events open the consultation.
 */
export type AgentActivityEvent = {
  id: string
  kind: 'interaction' | 'milestone'
  title: string
  detail: string
  patientId: string
  patientLabel: string
  time: string
  order: number
  recordId: number
  eventId?: string
}

/** Backend sender names are already agent labels ("Dr. Iain Jung Agent"). */
export const agentDisplayName = (senderName: string) =>
  senderName.endsWith(' Agent') ? `${senderName.slice(0, -' Agent'.length)}'s Agent` : senderName

const recipientLabel = (messages: ConsultationMessage[], message: ConsultationMessage) => {
  if (message.recipient_agent_id === PCP_AGENT_ID) return PCP_AGENT_NAME
  if (message.recipient_agent_id === 'network') return 'the physician network'
  const reply = messages.find((item) => item.sender_agent_id === message.recipient_agent_id)
  return reply ? agentDisplayName(reply.sender_name) : 'a specialist agent'
}

const senderLabel = (message: ConsultationMessage) =>
  message.sender_agent_id === PCP_AGENT_ID ? PCP_AGENT_NAME : agentDisplayName(message.sender_name)

export function consultationActivity(record: ConsultationRecord): AgentActivityEvent[] {
  const messages = record.result.messages
  const patientLabel = patientName(record.patient_id)
  const physician = cleanName(record.result.recommended_physician.physician_name)
  const base = { patientId: record.patient_id, patientLabel, time: record.completed_at, recordId: record.id }
  const fitResponse = messages.find(
    (item) => item.message_type === 'fit_response' && item.sender_name.includes(physician),
  )
  const clarifications = messages.filter((item) => item.message_type === 'follow_up_question')
  return [
    {
      ...base,
      id: `${record.id}-resolved`,
      kind: 'milestone',
      order: 3,
      title: 'Consultation resolved',
      detail: `${record.result.recommended_physician.specialty} recommended${record.patient_id === MARIA_ID ? ' first' : ''}`,
    },
    ...clarifications.map((message) => ({
      ...base,
      id: `${record.id}-${message.id}`,
      kind: 'interaction' as const,
      order: 2,
      title: `${senderLabel(message)} → ${recipientLabel(messages, message)}`,
      detail: message.summary,
      eventId: message.id,
    })),
    {
      ...base,
      id: `${record.id}-consulted`,
      kind: 'interaction',
      order: 1,
      title: `${PCP_AGENT_NAME} → ${physician}'s Agent`,
      detail: `Requested specialty guidance for ${patientLabel}`,
      ...(fitResponse ? { eventId: fitResponse.id } : {}),
    },
  ]
}

export function agentActivity(records: ConsultationRecord[]): AgentActivityEvent[] {
  return records
    .flatMap(consultationActivity)
    .sort((a, b) => b.time.localeCompare(a.time) || b.order - a.order)
}

export const consultationPath = (recordId: number) => `/consultations/${recordId}`

/** Interaction rows target one structured event; milestones open the consultation. */
export const activityPath = (event: AgentActivityEvent) =>
  event.eventId
    ? `${consultationPath(event.recordId)}?event=${encodeURIComponent(event.eventId)}`
    : consultationPath(event.recordId)

export const eventDomId = (eventId: string) => `consult-event-${eventId}`

/** Case → existing calibration learning key. No second learning store is introduced. */
const CASE_LEARNING_KEYS: Record<string, string> = { [JORDAN_ID]: 'renal', [MARIA_ID]: 'anaemia' }

export const learningKeyForPatient = (patientId: string): string | null => CASE_LEARNING_KEYS[patientId] ?? null

export function calibrationPath(learningKey?: string | null, patientId?: string, recordId?: number) {
  const params = new URLSearchParams({ tab: 'calibration' })
  if (learningKey) params.set('learning', learningKey)
  if (learningKey && patientId) params.set('case', patientId)
  if (learningKey && recordId !== undefined) params.set('record', String(recordId))
  return `/agent?${params}`
}

export type SpecialtyCount = { specialty: string; count: number }

/**
 * Completed consultations grouped by the specialty each one resolved to.
 * Counting every participating agent instead would make each specialty equal,
 * because the same roster is consulted every time.
 */
export function specialtiesConsulted(records: ConsultationRecord[]): SpecialtyCount[] {
  const counts = new Map<string, number>()
  for (const record of records) {
    const specialty = record.result.recommended_physician.specialty
    counts.set(specialty, (counts.get(specialty) ?? 0) + 1)
  }
  return [...counts.entries()]
    .map(([specialty, count]) => ({ specialty, count }))
    .sort((a, b) => b.count - a.count || a.specialty.localeCompare(b.specialty))
}
