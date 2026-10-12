import type { CoordinationEvent, Referral } from './api.ts'

/**
 * One real referral's coordination events, turned into an ordered set of
 * display phases. Every phase is derived from events that actually occurred
 * -- a phase that has no supporting event is simply never produced, so the
 * player can never show something that didn't happen (see Part F/Q).
 */
export type DisplayPhase =
  | { kind: 'preparing' }
  | { kind: 'checking' }
  | { kind: 'missing'; requirementLabel: string }
  | { kind: 'found'; requirementLabel: string; value: string; observedDate: string | null }
  | { kind: 'ready'; resolvedCount: number }
  | { kind: 'sent' }
  | { kind: 'unresolved'; requirementLabels: string[] }

/**
 * Phases are derived from which events actually exist in the log, not from
 * the referral's final `status` alone -- by the time a successful referral
 * is inspected, auto-submission has usually already advanced `status` past
 * `ready_for_review` straight to `submitted` (see Part C), so `referral_ready`
 * and `referral_submitted` are two separate phases in sequence, not a status
 * branch.
 */
export function derivePhases(referral: Referral): DisplayPhase[] {
  const phases: DisplayPhase[] = [{ kind: 'preparing' }]
  const events = referral.coordination_events
  if (events.some((event) => event.event_type === 'preflight_started')) phases.push({ kind: 'checking' })

  const labelFor = (key: string) => referral.receiving_requirements.find((item) => item.key === key)?.label ?? key
  for (const requested of events.filter((event) => event.event_type === 'information_requested')) {
    const key = String(requested.metadata.requirement ?? '')
    phases.push({ kind: 'missing', requirementLabel: labelFor(key) })
    const found = events.find((event) => event.event_type === 'record_found' && event.metadata.requirement === key)
    const item = referral.packet.items.find((packetItem) => packetItem.key === key)
    if (found && item) {
      phases.push({ kind: 'found', requirementLabel: labelFor(key), value: item.value, observedDate: item.provenance.observed_date })
    }
  }

  const hasReady = events.some((event) => event.event_type === 'referral_ready')
  const hasSubmitted = events.some((event) => event.event_type === 'referral_submitted')
  if (hasReady) {
    const resolvedCount = events.filter((event) => event.event_type === 'information_attached').length
    phases.push({ kind: 'ready', resolvedCount })
  }
  if (hasSubmitted) {
    phases.push({ kind: 'sent' })
  }
  if (!hasReady && !hasSubmitted) {
    const requirementLabels = events
      .filter((event) => event.event_type === 'physician_action_required')
      .map((event) => labelFor(String(event.metadata.requirement ?? '')))
    phases.push({ kind: 'unresolved', requirementLabels })
  }
  return phases
}

/** How long each phase stays on screen once revealed, in ms -- deliberately a
 * bit slower than a snappy UI transition so a viewer can actually read and
 * absorb each real step (Part 5 polish pass). Pure frontend presentation
 * pacing; the backend call itself is never delayed. */
export const PHASE_HOLD_MS: Record<DisplayPhase['kind'], number> = {
  preparing: 1500, checking: 1500, missing: 1800, found: 1800, ready: 900, sent: 600, unresolved: 600,
}

/** Crossfade duration between phases, in ms. */
export const PHASE_FADE_MS = 260

export function lastName(physicianName: string): string {
  return physicianName.split(' ').at(-1) ?? physicianName
}

export const EVENT_TYPE_TITLES: Record<string, string> = {
  referral_created: 'Referral created',
  packet_assembled: 'Referral packet assembled',
  preflight_started: 'Preflight started',
  requirement_checked: 'Checked referral requirements',
  information_requested: 'Requested missing information',
  record_search_started: "Searched the patient's available record",
  record_found: 'Found a matching record',
  record_not_found: 'No matching record found',
  information_attached: 'Attached information to the packet',
  requirement_rechecked: 'Rechecked referral requirements',
  preflight_completed: 'Preflight completed',
  referral_ready: 'Referral ready for review',
  physician_action_required: 'Physician action required',
  referral_submitted: 'Referral sent',
}

export function eventActorLabel(event: CoordinationEvent, referringLabel: string, receivingPhysicianName: string): string {
  if (event.actor === 'receiving_agent') return `${receivingPhysicianName}'s Agent`
  if (event.actor === 'referring_agent') return referringLabel
  return 'Lamina'
}
