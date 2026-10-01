import type { AgentNetwork, AgentStatus } from './api.ts'

/** Why a physician is in the clinician's network. Never a statement about their agent. */
export type RelationshipSource = 'consulted' | 'added' | 'both'

export type NetworkRelationship = {
  npi: string
  name: string
  initials: string
  specialty: string
  location: string
  /** Separate concept from the relationship: the physician's own agent state. */
  status: AgentStatus | null
  source: RelationshipSource
  consultationCount: number
  /** Consultations this physician was the recommended destination for. Ordering only. */
  recommendedCount: number
  lastInteraction: string | null
  lastPatientName: string | null
  lastRecordId: number | null
  agentId: string | null
  /** False when a recorded relationship can no longer be resolved in the directory. */
  resolved: boolean
  /** Whether this physician is one of the agents drawn in the network visualization. */
  inGraph: boolean
}

export type SpecialtyGroup = { specialty: string; members: NetworkRelationship[] }

export const membershipLabel = (source: RelationshipSource) =>
  source === 'both' ? 'In your network · consulted through Lamina'
    : source === 'added' ? 'In your network'
      : 'Consulted through Lamina'

/** NPPES stores names upper-cased; render them the same way everywhere. */
export const physicianDisplayName = (value: string) => (value === value.toUpperCase()
  ? value.toLowerCase().replace(/(^|[\s'-])\p{L}/gu, (letter) => letter.toUpperCase())
  : value
).replace(/, Md/i, ', MD').replace(/, Do/i, ', DO')

export const physicianInitials = (name: string) => name
  .replace(/^Dr\.\s*/i, '')
  .split(/[\s,]+/)
  .filter(Boolean)
  .slice(0, 2)
  .map((part) => part[0].toUpperCase())
  .join('')

type Entry = NetworkRelationship & { added: string }

const recency = (member: Entry) => member.lastInteraction || member.added
const byRelationship = (a: Entry, b: Entry) =>
  b.recommendedCount - a.recommendedCount
  || recency(b).localeCompare(recency(a))
  || a.name.localeCompare(b.name)

/** Specialties the agent has actually routed patients to lead the list. */
const peakRecommended = (group: SpecialtyGroup) =>
  Math.max(...group.members.map((member) => member.recommendedCount))
const bySpecialty = (a: SpecialtyGroup, b: SpecialtyGroup) =>
  peakRecommended(b) - peakRecommended(a)
  || (b.members[0].lastInteraction || '').localeCompare(a.members[0].lastInteraction || '')
  || a.specialty.localeCompare(b.specialty)

/**
 * The clinician's network: physicians reached through a completed Lamina
 * consultation, physicians they recorded a relationship with, or both.
 * Grouped by the specialty actually recorded for each physician.
 */
export function networkRoster(network: AgentNetwork): SpecialtyGroup[] {
  const entries: Entry[] = []
  for (const node of network.nodes) {
    const consulted = Boolean(node.relationship)
    if (!consulted && !node.in_network) continue
    entries.push({
      npi: node.npi,
      name: node.name,
      initials: physicianInitials(node.name),
      specialty: node.specialty,
      location: node.location,
      status: node.status,
      source: consulted && node.in_network ? 'both' : consulted ? 'consulted' : 'added',
      consultationCount: node.relationship?.consultation_count ?? 0,
      recommendedCount: node.relationship?.recommended_count ?? 0,
      lastInteraction: node.relationship?.most_recent_interaction ?? null,
      lastPatientName: node.relationship?.last_patient_name ?? null,
      lastRecordId: node.relationship?.last_record_id ?? null,
      agentId: node.id,
      resolved: true,
      inGraph: true,
      added: node.added_at || '',
    })
  }
  for (const member of network.members) {
    const name = member.resolved ? physicianDisplayName(member.name) : member.name
    entries.push({
      npi: member.npi,
      name,
      initials: member.resolved ? physicianInitials(name) : '··',
      specialty: member.specialty,
      location: member.location,
      status: member.status,
      source: 'added',
      consultationCount: 0,
      recommendedCount: 0,
      lastInteraction: null,
      lastPatientName: null,
      lastRecordId: null,
      agentId: member.agent_id,
      resolved: member.resolved,
      inGraph: false,
      added: member.added_at,
    })
  }

  const groups = new Map<string, Entry[]>()
  for (const entry of entries) {
    const existing = groups.get(entry.specialty)
    if (existing) existing.push(entry)
    else groups.set(entry.specialty, [entry])
  }
  return [...groups.entries()]
    .map(([specialty, members]) => ({
      specialty,
      members: members.sort(byRelationship),
    }))
    .sort(bySpecialty)
}

export const rosterSize = (groups: SpecialtyGroup[]) =>
  groups.reduce((total, group) => total + group.members.length, 0)
