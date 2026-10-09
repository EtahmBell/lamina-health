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
  /** Completed consultations in which this physician was the canonical destination. */
  recommendedCount: number
  lastRecommendation: string | null
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

const isExplicit = (member: Entry) => member.source === 'added' || member.source === 'both'
const byRelationship = (a: Entry, b: Entry) =>
  Number(isExplicit(b)) - Number(isExplicit(a))
  || (b.lastRecommendation || '').localeCompare(a.lastRecommendation || '')
  || a.name.localeCompare(b.name)

const bySpecialty = (a: SpecialtyGroup, b: SpecialtyGroup) =>
  a.specialty.localeCompare(b.specialty)

function buildEntries(network: AgentNetwork): Entry[] {
  const entries: Entry[] = []
  for (const node of network.nodes) {
    const recommended = Boolean(node.relationship?.recommended_count)
    if (!recommended && !node.in_network) continue
    entries.push({
      npi: node.npi,
      name: node.name,
      initials: physicianInitials(node.name),
      specialty: node.specialty,
      location: node.location,
      status: node.status,
      source: recommended && node.in_network ? 'both' : recommended ? 'consulted' : 'added',
      consultationCount: node.relationship?.consultation_count ?? 0,
      recommendedCount: node.relationship?.recommended_count ?? 0,
      lastRecommendation: node.relationship?.most_recent_recommendation ?? null,
      lastPatientName: node.relationship?.last_recommendation_patient_name ?? null,
      lastRecordId: node.relationship?.last_recommendation_record_id ?? null,
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
      lastRecommendation: null,
      lastPatientName: null,
      lastRecordId: null,
      agentId: member.agent_id,
      resolved: member.resolved,
      inGraph: false,
      added: member.added_at,
    })
  }
  return entries
}

/**
 * The clinician's network: canonical recommendation destinations from completed
 * Lamina consultations, physicians they recorded a relationship with, or both.
 * Grouped by the specialty actually recorded for each physician.
 */
export function networkRoster(network: AgentNetwork): SpecialtyGroup[] {
  const entries = buildEntries(network)
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

/** A short, honest relationship line for the "most connected" ranked list — never
 * a fabricated interaction count. */
export const connectionLine = (member: NetworkRelationship): string =>
  member.consultationCount > 0
    ? `Consulted ${member.consultationCount} time${member.consultationCount === 1 ? '' : 's'}`
    : member.recommendedCount > 0
      ? 'Recent referral guidance'
      : 'In your network'

/**
 * The clinician's network ranked flat by connection strength (most recommended,
 * then most consulted, then explicitly-added, then most recently active, then
 * name) -- "Most connected in your network", never grouped by specialty. Real
 * derived counts only; a physician with zero interactions is never implied to
 * have any.
 */
export function rankedNetworkList(network: AgentNetwork): NetworkRelationship[] {
  const entries = buildEntries(network)
  return [...entries].sort((a, b) =>
    b.recommendedCount - a.recommendedCount
    || b.consultationCount - a.consultationCount
    || Number(isExplicit(b)) - Number(isExplicit(a))
    || (b.lastRecommendation || b.added || '').localeCompare(a.lastRecommendation || a.added || '')
    || a.name.localeCompare(b.name),
  )
}
