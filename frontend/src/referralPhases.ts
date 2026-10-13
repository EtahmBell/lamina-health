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
  | { kind: 'sent'; resolvedCount: number; submittedAt: string | null }
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
    const resolvedCount = events.filter((event) => event.event_type === 'information_attached').length
    const submittedEvent = events.find((event) => event.event_type === 'referral_submitted')
    phases.push({ kind: 'sent', resolvedCount, submittedAt: submittedEvent?.created_at ?? null })
  }
  if (!hasReady && !hasSubmitted) {
    const requirementLabels = events
      .filter((event) => event.event_type === 'physician_action_required')
      .map((event) => labelFor(String(event.metadata.requirement ?? '')))
    phases.push({ kind: 'unresolved', requirementLabels })
  }
  return phases
}

/**
 * The durable display phase for a referral that already existed before this
 * page mounted (e.g. after a reload) -- the terminal state only, never the
 * animated progression. Any non-draft persisted status restores to Referral
 * mode (Part L): assembling/preflight are rare "reloaded mid-call" edge
 * cases with nothing to derive yet, so they restore to the static
 * `preparing` phase; resolving/ready_for_review/submitted restore to the
 * real derived terminal phase. `draft` cannot actually occur in persisted
 * data (a referral only reaches the store after advancing past it), so it's
 * the one case with nothing to restore.
 */
export function restorePhase(referral: Referral): DisplayPhase | null {
  if (referral.status === 'draft') return null
  if (referral.status === 'assembling' || referral.status === 'preflight') return { kind: 'preparing' }
  const phases = derivePhases(referral)
  return phases[phases.length - 1] ?? null
}

/** How long each phase stays on screen once revealed, in ms -- deliberately a
 * bit slower than a snappy UI transition so a viewer can actually read and
 * absorb each real step (Part 5 polish pass). Pure frontend presentation
 * pacing; the backend call itself is never delayed. */
export const PHASE_HOLD_MS: Record<DisplayPhase['kind'], number> = {
  preparing: 1500, checking: 1500, missing: 1800, found: 1800, ready: 900, sent: 400, unresolved: 600,
}

/** How long the full-card success wash holds before crossfading into the
 * durable "Awaiting review" state, in ms. A live Start-referral run only --
 * never replayed on page reload/restoration. */
export const SUCCESS_WASH_HOLD_MS = 1700

/** Crossfade duration between phases, in ms. */
export const PHASE_FADE_MS = 260

export function lastName(physicianName: string): string {
  return physicianName.split(' ').at(-1) ?? physicianName
}

/** "1 missing item resolved automatically" / "All required information was
 * already included" -- shared by the success wash and the durable sent card. */
export function resolvedSummary(resolvedCount: number): string {
  return resolvedCount > 0
    ? `${resolvedCount} missing item${resolvedCount === 1 ? '' : 's'} resolved automatically`
    : 'All required information was already included'
}

/** "Oct 12 · 12:49 PM" -- same compact timestamp convention App.tsx's own
 * eventTimestamp() already uses elsewhere in the app. */
export function formatSubmittedAt(value: string): string {
  return new Date(value).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }).replace(', ', ' · ')
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
