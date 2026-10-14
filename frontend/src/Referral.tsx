import { useEffect, useRef, useState } from 'react'
import { acceptReferral, createReferral, draftHandoff, findSchedulingOptions, getAgentOverview, getEncounter, getHandoff, getNetworkFeed, getPhysicianReferrals, getPracticeRepresentation, getScheduling, getTrainingHistory, ingestConsultationEncounter, routeSchedulingOptions, runReferralPreflight, sendHandoff, type AgentOverview, type AppointmentSlot, type ConsultationEncounter, type HandoffSummary, type NetworkFeed, type PacketItem, type PracticeRepresentation, type Referral, type ReferralStatus, type SchedulingCoordination, type TrainProjection } from './api.ts'
import { CHEN_AGENT_NAME, CHEN_ID, CHEN_NAME, CHEN_SPECIALTY, patientAgeLocation, patientInitials, patientName, PCP_NAME } from './demoIdentity.ts'
import { DEMO_PATIENTS, type PatientStage } from './demoPatients.ts'
import { AgentOverviewPanel, ChatTab, HomeAgentCard, NetworkFeedTab, NetworkHighlights, networkProfilePath, NetworkTabs, trainingPath, TrainTab, WorklistRows, type NetworkTab, type WorklistRowData } from './Engagement.tsx'
import { timeAwareGreeting } from './greeting.ts'
import { AgentAvatar, agentTone } from './AgentAvatar.tsx'
import { LaminaMark } from './LaminaMark.tsx'
import { ModalPortal } from './ModalPortal.tsx'
import { derivePhases, eventActorLabel, EVENT_TYPE_TITLES, formatSubmittedAt, lastName, PHASE_FADE_MS, PHASE_HOLD_MS, resolvedSummary, restorePhase, SUCCESS_WASH_HOLD_MS, type DisplayPhase } from './referralPhases.ts'

export { derivePhases } from './referralPhases.ts'
export type { DisplayPhase } from './referralPhases.ts'

type Navigate = (path: string) => void

const prefersReducedMotion = () => window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false

function PhaseContent({ phase, receivingPhysicianName, patientLabel, scheduling }: { phase: DisplayPhase; receivingPhysicianName: string; patientLabel: string; scheduling?: SchedulingCoordination | null }) {
  const who = lastName(receivingPhysicianName)
  switch (phase.kind) {
    case 'preparing':
      return <>
        <span className="status-label pulse"><span className="spark-icon lead" aria-hidden="true">✧</span>Preparing referral</span>
        <h3>Preparing the referral.</h3>
        <p>Your agent is assembling the clinical information Dr. {who} needs.</p>
      </>
    case 'checking':
      return <>
        <span className="status-label pulse"><span className="spark-icon lead" aria-hidden="true">✧</span>Checking requirements</span>
        <h3>Dr. {who}'s Agent is reviewing the referral.</h3>
        <p>Checking the packet against Dr. {who}'s referral requirements.</p>
      </>
    case 'missing':
      return <>
        <span className="status-label pulse"><span className="spark-icon lead" aria-hidden="true">✧</span>Resolving a missing item</span>
        <h3>Dr. {who}'s Agent requested {phase.requirementLabel.toLowerCase()}.</h3>
        <p>{PCP_NAME}'s Agent is checking the available record.</p>
      </>
    case 'found':
      return <>
        <span className="status-label pulse"><span className="spark-icon lead" aria-hidden="true">✧</span>Resolving a missing item</span>
        <h3><span aria-hidden="true">✓</span> Existing result found</h3>
        <p className="referral-found-value">{phase.value}</p>
        <p>{PCP_NAME}'s Agent added the existing result to the referral.</p>
      </>
    case 'ready':
      return <>
        <span className="status-label resolved"><span className="spark-icon lead" aria-hidden="true">✓</span>Ready for Dr. {who}'s review</span>
        <h3>The referral is ready.</h3>
        <p>{phase.resolvedCount > 0
          ? `Your agents resolved ${phase.resolvedCount} missing information requirement${phase.resolvedCount === 1 ? '' : 's'} without physician input.`
          : 'All required information was already included in the referral.'}</p>
        <small>Referral packet complete</small>
      </>
    case 'sent':
      // The durable rendering only -- the brief completion moment (Part 2-4)
      // is a separate full-card overlay drawn on top of this, never a second
      // competing claim inside the same text block.
      return <>
        <span className="status-label resolved"><span className="spark-icon lead" aria-hidden="true">✓</span>Sent</span>
        <h3>Awaiting Dr. {who}'s review</h3>
        <p>The completed referral packet has been sent to Dr. {who} for review.</p>
        <small className="referral-submission-meta">{resolvedSummary(phase.resolvedCount)}{phase.submittedAt ? ` · Submitted ${formatSubmittedAt(phase.submittedAt)}` : ''}</small>
      </>
    case 'accepted':
      // Durable PCP-side state once the receiving physician accepts (Part R)
      // -- a real physician action on the shared referral object, never a
      // replayed success animation on Lucy's side (Part S). Replaces
      // "Awaiting review" entirely; never shown alongside Start referral or
      // recommendation content.
      return <>
        <span className="status-label resolved"><span className="spark-icon lead" aria-hidden="true">✓</span>Accepted</span>
        <h3>Accepted by Dr. {who}</h3>
        <p>Dr. {who} accepted {patientLabel}'s referral and added them to their care.</p>
        <p className="referral-next-step-note">Next: Scheduling</p>
        {phase.acceptedAt && <small className="referral-submission-meta">Accepted {formatSubmittedAt(phase.acceptedAt)}</small>}
      </>
    case 'scheduled': {
      const slot = scheduling?.selected_option
      return <>
        <span className="status-label resolved"><span className="spark-icon lead" aria-hidden="true">✓</span>Scheduled</span>
        <h3>Appointment with Dr. {who}</h3>
        {slot && <p className="referral-found-value">{formatSubmittedAt(slot.starts_at)}</p>}
        <p>The referral was accepted and the consultation is scheduled.</p>
      </>
    }
    case 'handoff_received':
      return <>
        <span className="status-label resolved"><span className="spark-icon lead" aria-hidden="true">✓</span>Specialist follow-up received</span>
        <h3>Dr. {who} returned his consultation update.</h3>
        <p>Review the handoff for the full assessment and recommendations.</p>
        {phase.receivedAt && <small className="referral-submission-meta">Received {formatSubmittedAt(phase.receivedAt)}</small>}
      </>
    case 'unresolved':
      return <>
        <span className="status-label warning">Needs your input</span>
        <h3>Your agent could not resolve {phase.requirementLabels.length === 1 ? 'one referral requirement' : `${phase.requirementLabels.length} referral requirements`} automatically.</h3>
        <p>{phase.requirementLabels.length > 0 ? `${phase.requirementLabels.join(', ')} could not be located in the available record.` : 'A required item could not be located in the available record.'}</p>
      </>
  }
}

/**
 * The right-rail surface for a real referral -- rendered only once Referral
 * mode is already active (the parent RecommendationView decides discovery
 * vs. referral and does the hydration lookup). Two ways to enter:
 *
 * - `restoredReferral` provided (hydrated from a reload): jump straight to
 *   its real terminal state, synchronously, with no animation and no API
 *   calls -- restoring state is not the same event as creating it.
 * - `restoredReferral` null (the physician just clicked Start referral):
 *   run the real create+preflight calls immediately on mount, then reveal
 *   the resulting real phases over several seconds purely as frontend
 *   presentation pacing -- the backend call itself is never delayed (Part E/F/Y).
 */
export function ReferralCoordinationSurface({
  patientId, patientLabel, receivingPhysicianId, receivingPhysicianName, restoredReferral, onWashChange,
}: {
  patientId: string; patientLabel: string; receivingPhysicianId: string; receivingPhysicianName: string
  restoredReferral: Referral | null
  /** Mirrors justCompleted up to the parent, which owns the actual card
   * element -- the wash background lives there (see .handoff-wash), not on
   * this overlay, so its visible edge is the card's own border-box and can
   * never mismatch the card's radius (Part H). Never called for a restored/
   * hydrated referral. */
  onWashChange?: (active: boolean) => void
}) {
  const [status, setStatus] = useState<'running' | 'done' | 'error'>(restoredReferral ? 'done' : 'running')
  const [visiblePhase, setVisiblePhase] = useState<DisplayPhase | null>(restoredReferral ? restorePhase(restoredReferral) : null)
  const [fading, setFading] = useState(false)
  // justCompleted is true only during the brief live completion moment --
  // never on a restored/hydrated referral, never on error/unresolved paths.
  // It drives a centered text overlay (position: absolute over .best-fit-card),
  // not a change to the underlying phase content.
  const [justCompleted, setJustCompleted] = useState(false)
  const [referral, setReferral] = useState<Referral | null>(restoredReferral)
  const [coordinationOpen, setCoordinationOpen] = useState(false)
  const [packetOpen, setPacketOpen] = useState(false)
  // Scheduling/handoff detail lives in their own artifacts, never crammed
  // into the referral (Part AB) -- fetched separately once the referral
  // reaches the relevant milestone, never as part of the live phase-reveal
  // animation (Lucy never creates these herself; they only ever appear via
  // hydration/polling of Chen's own actions).
  const [scheduling, setScheduling] = useState<SchedulingCoordination | null>(null)
  const [handoff, setHandoff] = useState<HandoffSummary | null>(null)
  const [schedulingDetailsOpen, setSchedulingDetailsOpen] = useState(false)
  const [handoffOpen, setHandoffOpen] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const timers = useRef<number[]>([])
  const cancelled = useRef(false)

  useEffect(() => {
    if (!referral?.id) return
    let ignore = false
    if (referral.status === 'scheduled' || referral.status === 'consult_returned') {
      getScheduling(referral.id).then((value) => { if (!ignore) setScheduling(value) }).catch(() => {})
    }
    if (referral.status === 'consult_returned') {
      getHandoff(referral.id).then((value) => { if (!ignore) setHandoff(value) }).catch(() => {})
    }
    return () => { ignore = true }
  }, [referral?.id, referral?.status])

  const setWash = (active: boolean) => { setJustCompleted(active); onWashChange?.(active) }

  useEffect(() => () => {
    cancelled.current = true
    timers.current.forEach((id) => window.clearTimeout(id))
    onWashChange?.(false)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useEffect(() => {
    if (restoredReferral) return // already hydrated synchronously via initial state above
    void start()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const sleep = (ms: number) => new Promise<void>((resolve) => {
    const id = window.setTimeout(resolve, ms)
    timers.current.push(id)
  })

  /**
   * Double-rAF so the browser actually paints the new content at opacity 0
   * before we flip `fading` back off -- without this, React can batch the
   * content swap and the fade-back-in into the same commit, so the browser
   * never renders an intermediate opacity:0 frame to transition from, and
   * the new phase just snaps in instead of fading (the "jarring flash" bug).
   */
  const nextPaint = () => new Promise<void>((resolve) => {
    requestAnimationFrame(() => requestAnimationFrame(() => resolve()))
  })

  const crossfade = async (apply: () => void) => {
    if (cancelled.current) return
    if (!prefersReducedMotion()) {
      setFading(true)
      await sleep(PHASE_FADE_MS)
      if (cancelled.current) return
      apply()
      await nextPaint()
      if (cancelled.current) return
      setFading(false)
    } else {
      apply()
    }
  }

  const revealPhase = async (phase: DisplayPhase) => {
    await crossfade(() => setVisiblePhase(phase))
    if (cancelled.current) return
    await sleep(PHASE_HOLD_MS[phase.kind])
  }

  /**
   * The "sent" phase gets a stronger, three-moment reveal (Part 2-4):
   * 1. Crossfade out of the last coordination phase, and prepare the
   *    durable "Awaiting Dr. X's review" content underneath.
   * 2. Simultaneously bring up a full-card completion overlay ("Referral
   *    handoff complete") that visually covers everything -- its own CSS
   *    opacity transition, so it's a true takeover, not a status line.
   * 3. Hold, then fade the overlay away together with its background,
   *    revealing the durable content that was already prepared underneath.
   * Never stacks old-phase + overlay + durable content at once.
   */
  const revealSentPhase = async (phase: DisplayPhase & { kind: 'sent' }) => {
    await crossfade(() => { setVisiblePhase(phase); setWash(true) })
    if (cancelled.current) return
    await sleep(prefersReducedMotion() ? 500 : SUCCESS_WASH_HOLD_MS)
    if (cancelled.current) return
    setWash(false)
    await sleep(prefersReducedMotion() ? 0 : PHASE_FADE_MS)
    if (cancelled.current) return
    await sleep(PHASE_HOLD_MS.sent)
  }

  const start = async () => {
    setStatus('running'); setError(null); setVisiblePhase({ kind: 'preparing' })
    const minimumPreparingDisplay = sleep(PHASE_HOLD_MS.preparing)
    try {
      const created = await createReferral(patientId, receivingPhysicianId)
      const preflighted = await runReferralPreflight(created.id as number)
      await minimumPreparingDisplay
      if (cancelled.current) return
      setReferral(preflighted)
      for (const phase of derivePhases(preflighted).slice(1)) {
        if (phase.kind === 'sent') await revealSentPhase(phase)
        else await revealPhase(phase)
        if (cancelled.current) return
      }
      setStatus('done')
    } catch (startError) {
      if (cancelled.current) return
      setError(startError instanceof Error ? startError.message : 'Could not start the referral.')
      setStatus('error')
    }
  }

  if (status === 'error') {
    return <div className="referral-coordination-surface error-banner" role="alert">{error}</div>
  }
  if (!visiblePhase) return null
  const sentResolvedCount = visiblePhase.kind === 'sent' ? visiblePhase.resolvedCount : 0
  return <div className="referral-coordination-surface" role="status">
    <div className={`referral-phase ${fading ? 'phase-fading' : ''}`}>
      <PhaseContent phase={visiblePhase} receivingPhysicianName={receivingPhysicianName} patientLabel={patientLabel} scheduling={scheduling} />
    </div>
    {status === 'done' && referral && !justCompleted && <div className="referral-mode-links">
      <button type="button" className="text-button" onClick={() => setPacketOpen(true)}>View referral packet →</button>
      <button type="button" className="text-button" onClick={() => setCoordinationOpen(true)}>See agent coordination →</button>
      {scheduling?.status === 'scheduled' && <button type="button" className="text-button" onClick={() => setSchedulingDetailsOpen(true)}>View scheduling details →</button>}
      {handoff && <button type="button" className="text-button" onClick={() => setHandoffOpen(true)}>Review handoff →</button>}
    </div>}
    {/* Full-card completion takeover (Part 2-4): absolutely positioned over
     * the whole .best-fit-card.referral-card (which is position: relative),
     * so it covers the kicker/physician row/back-button too without any
     * layout jump, and is trivially centered via flex. Its own CSS opacity
     * transition drives the text fade -- no JS double-rAF needed here. The
     * translucent wash itself lives on the card element (.handoff-wash, set
     * by the parent via onWashChange), not here -- see Part H. */}
    <div className={`referral-handoff-overlay ${justCompleted ? 'visible' : ''}`} aria-hidden={!justCompleted} role={justCompleted ? 'status' : undefined}>
      <span className="referral-handoff-check" aria-hidden="true">✓</span>
      <h3>Referral handoff complete</h3>
      <p>Sent to {receivingPhysicianName}</p>
      {sentResolvedCount > 0 && <small>{resolvedSummary(sentResolvedCount)} automatically.</small>}
    </div>
    {coordinationOpen && referral && <AgentCoordinationModal
      referral={referral}
      receivingPhysicianName={receivingPhysicianName}
      onClose={() => setCoordinationOpen(false)}
    />}
    {packetOpen && referral && <ReferralPacketModal
      referral={referral}
      patientLabel={patientLabel}
      receivingPhysicianName={receivingPhysicianName}
      onClose={() => setPacketOpen(false)}
    />}
    {schedulingDetailsOpen && scheduling && <SchedulingDetailsModal
      scheduling={scheduling}
      receivingPhysicianName={receivingPhysicianName}
      onClose={() => setSchedulingDetailsOpen(false)}
    />}
    {handoffOpen && handoff && <HandoffModal
      handoff={handoff}
      patientLabel={patientLabel}
      receivingPhysicianName={receivingPhysicianName}
      onClose={() => setHandoffOpen(false)}
    />}
  </div>
}

/**
 * The detailed, scrollable audit trail behind "See agent coordination". Every
 * row is a rendering of a real backend CoordinationEvent -- structured
 * operational facts (what was checked, requested, found, attached), never
 * hidden model chain-of-thought (see Part I).
 */
export function AgentCoordinationModal({
  referral, receivingPhysicianName, patientLabel, onClose,
}: { referral: Referral; receivingPhysicianName: string; patientLabel?: string; onClose: () => void }) {
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => { if (event.key === 'Escape') onClose() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])
  const resolvedCount = referral.coordination_events.filter((event) => event.event_type === 'information_attached').length
  const needsPhysician = referral.coordination_events.some((event) => event.event_type === 'physician_action_required')
  const referringLabel = `${PCP_NAME}'s Agent`
  return <ModalPortal><div className="post-flow-overlay" role="presentation" onClick={(event) => { if (event.target === event.currentTarget) onClose() }}>
    <div className="post-flow-dialog coordination-dialog" role="dialog" aria-modal="true" aria-label="Agent coordination">
      <button className="text-button post-flow-close" onClick={onClose} aria-label="Close">×</button>
      <p className="eyebrow">Agent coordination</p>
      {patientLabel && <h2>{patientLabel}</h2>}
      <p className="coordination-subhead">Referral to {receivingPhysicianName} · {referral.specialty}</p>
      <div className="coordination-summary">
        <p>{resolvedCount > 0 ? `${resolvedCount} missing requirement${resolvedCount === 1 ? '' : 's'} resolved automatically` : 'No missing requirements'}</p>
        <p>{needsPhysician ? 'Physician action required' : 'No physician action required'}</p>
      </div>
      <div className="coordination-timeline">
        {referral.coordination_events.map((event) => <div className={`coordination-event actor-${event.actor ?? 'system'}`} key={event.sequence}>
          <span className="coordination-actor">{eventActorLabel(event, referringLabel, receivingPhysicianName)}</span>
          <strong>{EVENT_TYPE_TITLES[event.event_type] ?? event.event_type}</strong>
          <p>{event.summary}</p>
        </div>)}
      </div>
      <p className="coordination-footer">{referral.status === 'consult_returned' ? '✓ Specialist consultation handoff received' : referral.status === 'scheduled' ? '✓ Consultation scheduled' : referral.status === 'accepted' ? `✓ Referral accepted by ${receivingPhysicianName}` : referral.status === 'submitted' ? '✓ Referral sent to the receiving specialist' : referral.status === 'ready_for_review' ? '✓ Referral ready for review' : 'Referral not yet ready for review'}</p>
    </div>
  </div></ModalPortal>
}

/**
 * Generic, reusable PacketItem -> provenance line. Only items actually
 * attached during preflight get a provenance note -- items from initial
 * assembly simply don't have one. This is driven entirely by the real
 * PacketItemProvenance data (Part R); no requirement key or patient is ever
 * named here, so it works unchanged for any future referral/requirement.
 */
function packetItemProvenanceLine(item: PacketItem): string | null {
  if (item.provenance.attached_during !== 'preflight') return null
  return `Added during agent preflight · found by ${PCP_NAME}'s Agent in the patient's existing record.`
}

/**
 * "What exactly was sent to Dr. Chen?" -- a clinical handoff document, not a
 * developer inspector. Renders directly from the real persisted
 * ReferralPacket/PacketItem data; never a hardcoded per-patient summary.
 */
export function ReferralPacketModal({
  referral, patientLabel, receivingPhysicianName, onClose,
}: { referral: Referral; patientLabel: string; receivingPhysicianName: string; onClose: () => void }) {
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => { if (event.key === 'Escape') onClose() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])
  return <ModalPortal><div className="post-flow-overlay" role="presentation" onClick={(event) => { if (event.target === event.currentTarget) onClose() }}>
    <div className="post-flow-dialog packet-dialog" role="dialog" aria-modal="true" aria-label="Referral packet">
      <button className="text-button post-flow-close" onClick={onClose} aria-label="Close">×</button>
      <p className="eyebrow">Referral packet</p>
      <h2>{patientLabel}</h2>
      <p className="coordination-subhead">To {receivingPhysicianName} · {referral.specialty}</p>
      <p className="coordination-subhead">From {PCP_NAME}</p>
      <div className="packet-section">
        <h3>Referral question</h3>
        <p>{referral.referral_question}</p>
      </div>
      <div className="packet-section">
        <h3>Included information</h3>
        <div className="packet-items">
          {referral.packet.items.map((item) => <div className="packet-item" key={item.key}>
            <strong>{item.label}</strong>
            <p>{item.value}</p>
            {packetItemProvenanceLine(item) && <small className="packet-item-provenance">{packetItemProvenanceLine(item)}</small>}
          </div>)}
          {referral.packet.items.length === 0 && <p className="muted-note">No packet items recorded yet.</p>}
        </div>
      </div>
    </div>
  </div></ModalPortal>
}

/**
 * Appointment detail (Part Q) -- read-only, reused by both physicians. Keeps
 * it simple: no calendar, no date picker, just the real confirmed slot.
 */
export function SchedulingDetailsModal({
  scheduling, receivingPhysicianName, onClose,
}: { scheduling: SchedulingCoordination; receivingPhysicianName: string; onClose: () => void }) {
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => { if (event.key === 'Escape') onClose() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])
  const slot = scheduling.selected_option
  return <ModalPortal><div className="post-flow-overlay" role="presentation" onClick={(event) => { if (event.target === event.currentTarget) onClose() }}>
    <div className="post-flow-dialog packet-dialog" role="dialog" aria-modal="true" aria-label="Scheduling details">
      <button className="text-button post-flow-close" onClick={onClose} aria-label="Close">×</button>
      <p className="eyebrow">Scheduling details</p>
      {slot && <h2>{formatSubmittedAt(slot.starts_at)}</h2>}
      <p className="coordination-subhead">{receivingPhysicianName} · {CHEN_SPECIALTY}</p>
      <div className="packet-section"><h3>Appointment type</h3><p>{slot?.appointment_type ?? 'Not yet confirmed'}</p></div>
      <div className="packet-section"><h3>Location</h3><p>{slot?.location ?? '—'}</p></div>
      <div className="packet-section"><h3>Status</h3><p>{scheduling.status === 'scheduled' ? 'Confirmed' : scheduling.status.replaceAll('_', ' ')}</p></div>
      <div className="packet-section"><h3>Source</h3><small className="packet-item-provenance">Synthetic scheduling workflow</small></div>
    </div>
  </div></ModalPortal>
}

/**
 * The specialist-to-PCP handoff (Part Z/AE) -- the SAME persisted
 * HandoffSummary rendered for both physicians, never a separate Lucy copy.
 * `onSend` is only ever provided by Chen's own draft-review flow; Lucy's
 * read-only usage never passes it, since she can only ever receive an
 * already-sent handoff (see getHandoff's as_physician_id gating).
 */
export function HandoffModal({
  handoff, patientLabel, receivingPhysicianName, onClose, onSend,
}: {
  handoff: HandoffSummary; patientLabel: string; receivingPhysicianName: string
  onClose: () => void
  onSend?: () => Promise<void>
}) {
  const [sending, setSending] = useState(false)
  const [error, setError] = useState('')
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => { if (event.key === 'Escape' && !sending) onClose() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose, sending])
  const isDraft = handoff.status === 'draft'
  const handleSend = async () => {
    if (!onSend) return
    setSending(true); setError('')
    try {
      await onSend()
    } catch (sendError) {
      setError(sendError instanceof Error ? sendError.message : 'Could not send the handoff.')
      setSending(false)
    }
  }
  return <ModalPortal><div className="post-flow-overlay" role="presentation" onClick={(event) => { if (event.target === event.currentTarget && !sending) onClose() }}>
    <div className="post-flow-dialog packet-dialog" role="dialog" aria-modal="true" aria-label="Consultation handoff">
      <button className="text-button post-flow-close" onClick={onClose} aria-label="Close" disabled={sending}>×</button>
      <p className="eyebrow">Handoff to {PCP_NAME}</p>
      <h2>{patientLabel}</h2>
      <div className="request-review-parties">
        <div><span className="section-label">From</span><strong>{receivingPhysicianName}</strong><small>{CHEN_SPECIALTY}</small></div>
        <div><span className="section-label">To</span><strong>{PCP_NAME}</strong><small>Primary Care</small></div>
      </div>
      <div className="packet-section"><h3>Assessment</h3><p>{handoff.assessment}</p></div>
      <div className="packet-section"><h3>Key findings</h3><ul className="clinical-list">{handoff.key_findings.map((item) => <li key={item}>{item}</li>)}</ul></div>
      <div className="packet-section"><h3>Recommendations</h3><p>{handoff.recommendations}</p></div>
      <div className="packet-section"><h3>Follow-up</h3><p>{handoff.follow_up}</p></div>
      <hr className="handoff-divider" />
      <p className="handoff-provenance">Prepared by {receivingPhysicianName}'s Agent from the documented consultation.</p>
      {isDraft
        ? <p className="handoff-provenance">Requires {receivingPhysicianName}'s approval before sending.</p>
        : <p className="handoff-provenance">Approved and sent by {receivingPhysicianName}{handoff.sent_at ? ` · ${formatSubmittedAt(handoff.sent_at)}` : ''}</p>}
      {error && <p className="demo-reset-error" role="alert">{error}</p>}
      {isDraft && onSend && <div className="request-review-actions">
        <button className="button-primary" disabled={sending} onClick={handleSend}>{sending ? 'Sending…' : `Send to ${PCP_NAME} →`}</button>
      </div>}
    </div>
  </div></ModalPortal>
}

/* ============================================================ RECEIVING SIDE
 * Everything below is Dr. Chen's (the receiving physician's) side of the
 * closed loop: Incoming requests triage, the Request Review modal, and the
 * Patients page that hosts them. Acceptance is the only functional decision
 * in this pass -- other receiving-side decisions are intentionally absent,
 * never shown as fake-functional buttons (Part N).
 */

const resolvedCountFor = (referral: Referral) =>
  referral.coordination_events.filter((event) => event.event_type === 'information_attached').length

/**
 * The compact "Incoming requests · N" control (Part E) -- hidden entirely
 * when there are zero submitted referrals, never a noisy empty card. Opens a
 * quick triage popover (Part F), not a navigation page.
 */
function IncomingRequestsControl({
  referrals, open, onToggle, onReview,
}: { referrals: Referral[]; open: boolean; onToggle: () => void; onReview: (referral: Referral) => void }) {
  const containerRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!open) return
    const onClick = (event: MouseEvent) => { if (containerRef.current && !containerRef.current.contains(event.target as Node)) onToggle() }
    const onKey = (event: KeyboardEvent) => { if (event.key === 'Escape') onToggle() }
    document.addEventListener('mousedown', onClick)
    document.addEventListener('keydown', onKey)
    return () => { document.removeEventListener('mousedown', onClick); document.removeEventListener('keydown', onKey) }
  }, [open, onToggle])
  return <div className="incoming-requests" ref={containerRef}>
    <button type="button" className="incoming-requests-toggle" onClick={onToggle} aria-haspopup="menu" aria-expanded={open}>
      Incoming requests <span>{referrals.length}</span>
    </button>
    {open && <div className="incoming-requests-popover" role="menu" aria-label="Incoming requests">
      {referrals.map((referral) => <div className="incoming-request-row" role="menuitem" key={referral.id}>
        <div className="incoming-request-main">
          <strong>{patientName(referral.patient_id)}</strong>
          <span>From {PCP_NAME}</span>
          <small>{referral.specialty} referral</small>
        </div>
        <p className="incoming-request-status"><span className="status-label resolved">Ready for review</span></p>
        <p className="incoming-request-resolved">{resolvedSummary(resolvedCountFor(referral))}</p>
        <button type="button" className="text-button" onClick={() => onReview(referral)}>Review <span>→</span></button>
      </div>)}
    </div>}
  </div>
}

/**
 * The focused clinical handoff surface (Part G-N): who, from whom, why, what
 * was sent, whether it satisfies Dr. Chen's own referral requirements, and
 * what the agents already resolved. Accept referral is the only functional
 * decision here -- never navigates to Patient Detail itself (the parent does
 * that after the brief success moment, see Part O).
 */
export function RequestReviewModal({
  referral, receivingPhysicianName, onAccepted, onClose,
}: { referral: Referral; receivingPhysicianName: string; onAccepted: (updated: Referral) => void; onClose: () => void }) {
  const [coordinationOpen, setCoordinationOpen] = useState(false)
  const [packetOpen, setPacketOpen] = useState(false)
  const [accepting, setAccepting] = useState(false)
  const [accepted, setAccepted] = useState(false)
  const [error, setError] = useState('')
  const cancelled = useRef(false)
  useEffect(() => () => { cancelled.current = true }, [])
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => { if (event.key === 'Escape' && !accepting && !coordinationOpen && !packetOpen) onClose() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose, accepting, coordinationOpen, packetOpen])

  const patientLabel = patientName(referral.patient_id)
  const ageLocation = patientAgeLocation(referral.patient_id)
  const resolvedCount = resolvedCountFor(referral)

  const accept = async () => {
    if (referral.id == null) return
    setAccepting(true); setError('')
    try {
      const updated = await acceptReferral(referral.id, referral.receiving_physician_id)
      if (cancelled.current) return
      setAccepted(true)
      await new Promise<void>((resolve) => window.setTimeout(resolve, prefersReducedMotion() ? 400 : 1400))
      if (cancelled.current) return
      onAccepted(updated)
    } catch (acceptError) {
      if (cancelled.current) return
      setError(acceptError instanceof Error ? acceptError.message : 'Could not accept this referral.')
      setAccepting(false)
    }
  }

  return <>
    <ModalPortal><div className="post-flow-overlay" role="presentation" onClick={(event) => { if (event.target === event.currentTarget && !accepting) onClose() }}>
      <div className="post-flow-dialog request-review-dialog" role="dialog" aria-modal="true" aria-label="Incoming referral">
        {!accepted && <button className="text-button post-flow-close" onClick={onClose} aria-label="Close" disabled={accepting}>×</button>}
        {accepted
          ? <div className="request-review-success" role="status">
            <span className="referral-handoff-check" aria-hidden="true">✓</span>
            <h2>Referral accepted</h2>
            <p>{patientLabel} has been added to your care.</p>
          </div>
          : <>
            <p className="eyebrow">Incoming referral</p>
            <h2>{patientLabel}</h2>
            {ageLocation && <p className="specialist-case-meta">{ageLocation}</p>}
            <div className="request-review-parties">
              <div><span className="section-label">From</span><strong>{PCP_NAME}</strong><small>Primary Care</small></div>
              <div><span className="section-label">To</span><strong>{receivingPhysicianName}</strong><small>{referral.specialty}</small></div>
            </div>
            <p className="request-review-status"><span className="status-label resolved">Ready for your review</span></p>

            <section className="packet-section">
              <h3>Referral question</h3>
              <p>{referral.referral_question}</p>
            </section>

            <section className="packet-section">
              <h3>Clinical snapshot</h3>
              <div className="packet-items">
                {referral.packet.items.map((item) => <div className="packet-item" key={item.key}>
                  <strong>{item.label}</strong>
                  <p>{item.value}</p>
                </div>)}
              </div>
            </section>

            <section className="packet-section">
              <h3>Referral readiness</h3>
              <div className="requirement-checklist">
                {referral.requirement_results.map((check) => {
                  const item = referral.packet.items.find((packetItem) => packetItem.key === check.key)
                  const provenance = item ? packetItemProvenanceLine(item) : null
                  return <div className={`requirement-check ${check.status}`} key={check.key}>
                    <span className="requirement-check-mark" aria-hidden="true">{check.status === 'satisfied' ? '✓' : check.status === 'optional_not_present' ? '○' : '✕'}</span>
                    <div>
                      <strong>{check.label}</strong>
                      {item ? <p>{item.value}</p> : <p className="muted-note">Not included in packet.</p>}
                      {provenance && <small className="packet-item-provenance">{provenance}</small>}
                    </div>
                  </div>
                })}
              </div>
            </section>

            <section className="packet-section agent-preflight-summary">
              <p className="section-label">Agent preflight complete</p>
              <p>{resolvedCount > 0
                ? `${resolvedCount} missing requirement${resolvedCount === 1 ? '' : 's'} resolved before this reached you.`
                : 'All required information was already included in the referral.'}</p>
              <p>No physician interruption was required.</p>
              <button type="button" className="text-button" onClick={() => setCoordinationOpen(true)}>See agent coordination <span>→</span></button>
            </section>

            <button type="button" className="text-button request-review-packet-link" onClick={() => setPacketOpen(true)}>View full referral packet <span>→</span></button>

            {error && <p className="demo-reset-error" role="alert">{error}</p>}
            <div className="request-review-actions">
              <button className="button-primary" disabled={accepting} onClick={accept}>{accepting ? 'Accepting…' : 'Accept referral'}</button>
            </div>
          </>}
      </div>
    </div></ModalPortal>
    {coordinationOpen && <AgentCoordinationModal referral={referral} receivingPhysicianName={receivingPhysicianName} patientLabel={patientLabel} onClose={() => setCoordinationOpen(false)} />}
    {packetOpen && <ReferralPacketModal referral={referral} patientLabel={patientLabel} receivingPhysicianName={receivingPhysicianName} onClose={() => setPacketOpen(false)} />}
  </>
}

/** Dr. Chen's own pre-existing synthetic patients (Part C/D), rendered with
 * the same shared WorklistRows component Lucy's Patients page uses -- only
 * the cosmetic stage copy differs, reframed for an established specialist
 * practice rather than Lucy's referral-intake funnel. Reuses the existing
 * `PatientStage` vocabulary already on each fixture (demoPatients.ts); no new
 * stage enum. "Follow-up scheduled" lands in Previous care, matching the same
 * priority convention Lucy's own PATIENT_STAGE_META already uses. */
const CHEN_PATIENT_STAGE_META: Record<PatientStage, { label: string; tone: string; nextStep: string; priority: number }> = {
  in_review: { label: 'Ready for review', tone: 'copper', nextStep: 'Review latest labs', priority: 0 },
  new: { label: 'Active', tone: 'slate', nextStep: 'Continue monitoring', priority: 1 },
  referred: { label: 'Active', tone: 'slate', nextStep: 'Continue monitoring', priority: 1 },
  workup: { label: 'Awaiting workup', tone: 'slate', nextStep: 'Order workup', priority: 2 },
  followup: { label: 'Follow-up scheduled', tone: 'quiet', nextStep: 'Confirm follow-up visit', priority: 5 },
  closed: { label: 'Previous care', tone: 'quiet', nextStep: 'View history', priority: 6 },
}
const CHEN_PREVIOUS_CARE_PRIORITY = CHEN_PATIENT_STAGE_META.followup.priority
const CHEN_SEEDED_PATIENTS = DEMO_PATIENTS.filter((patient) => patient.owner === 'chen')

/**
 * Appointment options (Part I/J): a focused list, not a calendar/date
 * picker. The quiet "how these are confirmed" note makes the product
 * boundary explicit without turning into marketing copy -- Lamina found the
 * times; a patient, outreach channel, or the scheduling team confirms one
 * (Part N: never claims Lamina contacted the patient).
 */
function SchedulingOptionsModal({
  scheduling, patientLabel, receivingPhysicianName, busy, error, onSend, onClose,
}: {
  scheduling: SchedulingCoordination; patientLabel: string; receivingPhysicianName: string
  busy: boolean; error: string; onSend: () => void; onClose: () => void
}) {
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => { if (event.key === 'Escape' && !busy) onClose() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose, busy])
  return <ModalPortal><div className="post-flow-overlay" role="presentation" onClick={(event) => { if (event.target === event.currentTarget && !busy) onClose() }}>
    <div className="post-flow-dialog packet-dialog" role="dialog" aria-modal="true" aria-label="Appointment options">
      <button className="text-button post-flow-close" onClick={onClose} aria-label="Close" disabled={busy}>×</button>
      <p className="eyebrow">Appointment options</p>
      <h2>{patientLabel}</h2>
      <p className="coordination-subhead">{receivingPhysicianName} · {CHEN_SPECIALTY}</p>
      <div className="packet-section">
        <h3>Available times</h3>
        <div className="packet-items">
          {scheduling.options.map((slot) => <div className="packet-item" key={slot.slot_id}>
            <strong>{formatSubmittedAt(slot.starts_at)}</strong>
            <p>{slot.appointment_type}</p>
          </div>)}
        </div>
      </div>
      <div className="packet-section scheduling-delivery-note">
        <h3>How these options can be confirmed</h3>
        <ul className="clinical-list">
          <li>Patients using Lamina could choose directly.</li>
          <li>Options could be sent through supported outreach channels.</li>
          <li>Or the scheduling team can contact the patient with already-valid times.</li>
        </ul>
      </div>
      {error && <p className="demo-reset-error" role="alert">{error}</p>}
      <div className="request-review-actions">
        <button className="button-primary" disabled={busy} onClick={onSend}>{busy ? 'Sending…' : 'Send options to scheduling →'}</button>
      </div>
    </div>
  </div></ModalPortal>
}

type ChenDownstreamBusy = 'checking' | 'routing' | 'drafting' | null

/**
 * Dr. Chen's right-rail surface for an ACCEPTED referral (Parts D-AC): the
 * downstream scheduling -> encounter -> handoff flow. Entirely state-driven
 * from the real persisted artifacts (never a replayed animation on
 * hydration) -- each click is a real backend call with a brief, calm loading
 * pulse (Part AS), never a backend sleep. Exactly one current-state card at
 * a time, same "right rail: current state / next action" convention as
 * Lucy's own ReferralCoordinationSurface.
 */
export function ChenDownstreamCard({ referral, patientLabel }: { referral: Referral; patientLabel: string }) {
  const [scheduling, setScheduling] = useState<SchedulingCoordination | null | undefined>(undefined)
  const [encounter, setEncounter] = useState<ConsultationEncounter | null | undefined>(undefined)
  const [handoff, setHandoff] = useState<HandoffSummary | null | undefined>(undefined)
  const [busy, setBusy] = useState<ChenDownstreamBusy>(null)
  const [optionsOpen, setOptionsOpen] = useState(false)
  const [schedulingDetailsOpen, setSchedulingDetailsOpen] = useState(false)
  const [handoffOpen, setHandoffOpen] = useState(false)
  const [coordinationOpen, setCoordinationOpen] = useState(false)
  const [liveReferral, setLiveReferral] = useState(referral)
  const [error, setError] = useState('')
  const cancelled = useRef(false)

  useEffect(() => () => { cancelled.current = true }, [])

  useEffect(() => {
    if (!referral.id) return
    let ignore = false
    Promise.all([
      getScheduling(referral.id),
      getEncounter(referral.id),
      getHandoff(referral.id, CHEN_ID),
    ]).then(([s, e, h]) => { if (!ignore) { setScheduling(s); setEncounter(e); setHandoff(h) } }).catch(() => {})
    return () => { ignore = true }
  }, [referral.id])

  const sleep = (ms: number) => new Promise<void>((resolve) => window.setTimeout(resolve, prefersReducedMotion() ? 0 : ms))

  const findOptions = async () => {
    if (!referral.id) return
    setBusy('checking'); setError('')
    try {
      const [result] = await Promise.all([findSchedulingOptions(referral.id, CHEN_ID), sleep(3000)])
      if (cancelled.current) return
      setLiveReferral(result.referral)
      setScheduling(result.scheduling)
    } catch (findError) {
      if (!cancelled.current) setError(findError instanceof Error ? findError.message : 'Could not find appointment options.')
    } finally {
      if (!cancelled.current) setBusy(null)
    }
  }

  const sendToScheduling = async () => {
    if (!referral.id) return
    setBusy('routing'); setError('')
    try {
      const [result] = await Promise.all([routeSchedulingOptions(referral.id, CHEN_ID), sleep(1800)])
      if (cancelled.current) return
      setLiveReferral(result.referral)
      setScheduling(result.scheduling)
      setOptionsOpen(false)
    } catch (routeError) {
      if (!cancelled.current) setError(routeError instanceof Error ? routeError.message : 'Could not send options to scheduling.')
    } finally {
      if (!cancelled.current) setBusy(null)
    }
  }

  const draftTheHandoff = async () => {
    if (!referral.id) return
    setBusy('drafting'); setError('')
    try {
      const [result] = await Promise.all([draftHandoff(referral.id, CHEN_ID), sleep(2500)])
      if (cancelled.current) return
      setLiveReferral(result.referral)
      setHandoff(result.handoff)
    } catch (draftError) {
      if (!cancelled.current) setError(draftError instanceof Error ? draftError.message : 'Could not draft the handoff.')
    } finally {
      if (!cancelled.current) setBusy(null)
    }
  }

  const sendTheHandoff = async () => {
    if (!referral.id) return
    const result = await sendHandoff(referral.id, CHEN_ID)
    setLiveReferral(result.referral)
    setHandoff(result.handoff)
  }

  if (scheduling === undefined || encounter === undefined || handoff === undefined) {
    return <div className="next-step-card idle"><p className="muted-note">Opening referral…</p></div>
  }

  if (busy === 'checking') return <div className="next-step-card consulting">
    <span className="status-label pulse"><span className="spark-icon lead" aria-hidden="true">✧</span>Checking availability</span>
    <h3>Looking for appointment options.</h3>
    <p>Your agent is looking for eligible new-patient Endocrinology appointments.</p>
  </div>

  if (busy === 'routing') return <div className="next-step-card consulting">
    <span className="status-label pulse"><span className="spark-icon lead" aria-hidden="true">✧</span>Routing to scheduling</span>
    <h3>Sending options to the scheduling workflow.</h3>
  </div>

  if (busy === 'drafting') return <div className="next-step-card consulting">
    <span className="status-label pulse"><span className="spark-icon lead" aria-hidden="true">✧</span>Preparing handoff</span>
    <h3>Preparing handoff.</h3>
    <p>Your agent is summarizing the documented consultation for Dr. Saruhashi.</p>
  </div>

  const links = <div className="referral-mode-links">
    <button type="button" className="text-button" onClick={() => setCoordinationOpen(true)}>View referral history →</button>
  </div>

  if (handoff && handoff.status === 'sent') return <>
    <div className="next-step-card ready">
      <span className="status-label resolved"><span className="spark-icon lead" aria-hidden="true">✓</span>Handoff sent</span>
      <h3>Dr. Saruhashi received the specialist update.</h3>
      {handoff.sent_at && <small className="referral-submission-meta">Sent {formatSubmittedAt(handoff.sent_at)}</small>}
      <div className="referral-mode-links">
        <button type="button" className="text-button" onClick={() => setHandoffOpen(true)}>View handoff →</button>
        <button type="button" className="text-button" onClick={() => setCoordinationOpen(true)}>View referral history →</button>
      </div>
    </div>
    {handoffOpen && <HandoffModal handoff={handoff} patientLabel={patientLabel} receivingPhysicianName={CHEN_NAME} onClose={() => setHandoffOpen(false)} />}
    {coordinationOpen && <AgentCoordinationModal referral={liveReferral} receivingPhysicianName={CHEN_NAME} patientLabel={patientLabel} onClose={() => setCoordinationOpen(false)} />}
  </>

  if (handoff && handoff.status === 'draft') return <>
    <div className="next-step-card ready">
      <span className="status-label resolved"><span className="spark-icon lead" aria-hidden="true">✓</span>Draft ready</span>
      <h3>A handoff draft is ready for your review.</h3>
      <button type="button" className="button-primary" onClick={() => setHandoffOpen(true)}>Review handoff →</button>
      {links}
    </div>
    {handoffOpen && <HandoffModal handoff={handoff} patientLabel={patientLabel} receivingPhysicianName={CHEN_NAME} onClose={() => setHandoffOpen(false)} onSend={sendTheHandoff} />}
    {coordinationOpen && <AgentCoordinationModal referral={liveReferral} receivingPhysicianName={CHEN_NAME} patientLabel={patientLabel} onClose={() => setCoordinationOpen(false)} />}
  </>

  if (encounter) return <>
    <div className="next-step-card ready">
      <span className="status-label resolved"><span className="spark-icon lead" aria-hidden="true">✓</span>Consultation documented</span>
      <h3>{patientLabel}'s {encounter.specialty} visit is available in the record.</h3>
      <p>Your agent can prepare a concise update for Dr. Saruhashi from the documented consultation.</p>
      {error && <p className="demo-reset-error" role="alert">{error}</p>}
      <button type="button" className="button-primary" onClick={draftTheHandoff}>Draft handoff →</button>
      {links}
    </div>
    {coordinationOpen && <AgentCoordinationModal referral={liveReferral} receivingPhysicianName={CHEN_NAME} patientLabel={patientLabel} onClose={() => setCoordinationOpen(false)} />}
  </>

  if (scheduling && scheduling.status === 'scheduled') {
    const slot = scheduling.selected_option
    return <>
      <div className="next-step-card ready">
        <span className="status-label resolved"><span className="spark-icon lead" aria-hidden="true">✓</span>Scheduled</span>
        <h3>Consultation scheduled</h3>
        {slot && <p className="referral-found-value">{formatSubmittedAt(slot.starts_at)}</p>}
        <p>{CHEN_NAME} · {CHEN_SPECIALTY}</p>
        <p>The appointment has been confirmed.</p>
        <div className="referral-mode-links">
          <button type="button" className="text-button" onClick={() => setSchedulingDetailsOpen(true)}>View scheduling details →</button>
          <button type="button" className="text-button" onClick={() => setCoordinationOpen(true)}>View referral history →</button>
        </div>
      </div>
      {schedulingDetailsOpen && <SchedulingDetailsModal scheduling={scheduling} receivingPhysicianName={CHEN_NAME} onClose={() => setSchedulingDetailsOpen(false)} />}
      {coordinationOpen && <AgentCoordinationModal referral={liveReferral} receivingPhysicianName={CHEN_NAME} patientLabel={patientLabel} onClose={() => setCoordinationOpen(false)} />}
    </>
  }

  if (scheduling && scheduling.status === 'options_ready') return <>
    <div className="next-step-card ready">
      <span className="status-label resolved"><span className="spark-icon lead" aria-hidden="true">✓</span>{scheduling.options.length} appointment options found</span>
      <h3>Your agent found valid new-patient times in your schedule.</h3>
      <button type="button" className="button-primary" onClick={() => setOptionsOpen(true)}>View options →</button>
      {links}
    </div>
    {optionsOpen && <SchedulingOptionsModal scheduling={scheduling} patientLabel={patientLabel} receivingPhysicianName={CHEN_NAME} busy={false} error={error} onSend={sendToScheduling} onClose={() => setOptionsOpen(false)} />}
    {coordinationOpen && <AgentCoordinationModal referral={liveReferral} receivingPhysicianName={CHEN_NAME} patientLabel={patientLabel} onClose={() => setCoordinationOpen(false)} />}
  </>

  return <>
    <div className="next-step-card idle">
      <span className="status-label resolved"><span className="spark-icon lead" aria-hidden="true">✓</span>Accepted</span>
      <h3>Referred by {PCP_NAME}.</h3>
      <p className="section-label">Referral question</p>
      <p>{referral.referral_question}</p>
      <p className="referral-next-step-note">Find appointment options</p>
      {error && <p className="demo-reset-error" role="alert">{error}</p>}
      <button type="button" className="consult-button" onClick={findOptions}>Find appointment options <span className="spark-icon" aria-hidden="true">✧</span></button>
      <p className="bottom-note">Your agent can check {CHEN_NAME}'s available new-patient {CHEN_SPECIALTY} slots.</p>
    </div>
    {coordinationOpen && <AgentCoordinationModal referral={liveReferral} receivingPhysicianName={CHEN_NAME} patientLabel={patientLabel} onClose={() => setCoordinationOpen(false)} />}
  </>
}

/**
 * Dr. Chen's Patients page (Part F): his own pre-existing synthetic patient
 * panel, grouped exactly like Lucy's (active vs. previous care, searchable),
 * plus accepted referrals merged in at the top. Before acceptance a referred
 * patient is only an incoming request, never listed here as a patient. Both
 * lists are queried the same way the incoming popover is -- real persisted
 * referrals filtered by status, never a frontend fixture (Part W: "accepted
 * patient" simply means "a referral to me with status=accepted" -- no
 * separate relationship table needed). A referred patient is NEVER part of
 * the static seeded roster above (Part E) -- only `accepted` ever adds one.
 */
/** Everything past acceptance is still "in Chen's active care" for this pass
 * (Part 2 fix) -- scheduling/encounter/handoff progress must never make a
 * referred patient disappear from his patient list. There is no archival/
 * completed state yet; when one is introduced later, it narrows this set,
 * it does not reintroduce the bug by excluding 'scheduled'/'consult_returned'
 * again. */
const CHEN_ACTIVE_REFERRAL_STATUSES: ReferralStatus[] = ['accepted', 'scheduled', 'consult_returned']
const CHEN_ACCEPTED_ROW_LABEL: Partial<Record<ReferralStatus, string>> = {
  accepted: 'Accepted referral', scheduled: 'Consultation scheduled', consult_returned: 'Handoff sent',
}

export function ChenPatientsPage({ navigate }: { navigate: Navigate }) {
  const [query, setQuery] = useState('')
  const [incoming, setIncoming] = useState<Referral[] | null>(null)
  const [accepted, setAccepted] = useState<Referral[] | null>(null)
  const [error, setError] = useState('')
  const [requestsOpen, setRequestsOpen] = useState(false)
  const [reviewing, setReviewing] = useState<Referral | null>(null)

  /** A real backend query for "every referral in my care, however far along
   * it is" -- never a single fixed status (Part 2 fix: ?status=accepted
   * alone silently dropped a referral the moment it progressed past
   * acceptance). Filtering down to the known active-care statuses, rather
   * than just "not submitted," is deliberate: a future terminal/archival
   * status is excluded by default instead of leaking in silently. */
  const load = () => Promise.all([
    getPhysicianReferrals(CHEN_ID, 'submitted'),
    getPhysicianReferrals(CHEN_ID),
  ]).then(([submitted, all]) => {
    setIncoming(submitted)
    setAccepted(all.filter((referral) => CHEN_ACTIVE_REFERRAL_STATUSES.includes(referral.status)))
  }).catch((loadError: Error) => setError(loadError.message))

  useEffect(() => { void load() }, [])

  const handleAccepted = (updated: Referral) => {
    setReviewing(null)
    setIncoming((current) => current?.filter((item) => item.id !== updated.id) ?? current)
    navigate(`/chen/patients/${updated.patient_id}`)
  }

  const visibleSeeded = CHEN_SEEDED_PATIENTS.filter((patient) => `${patient.name} ${patient.reason}`.toLowerCase().includes(query.toLowerCase()))
  const seededRows: WorklistRowData[] = visibleSeeded.map((patient) => {
    const meta = CHEN_PATIENT_STAGE_META[patient.stage]
    return { patient, label: meta.label, tone: meta.tone, nextStep: meta.nextStep, priority: meta.priority, updated: null }
  })
  const acceptedRows: WorklistRowData[] = (accepted ?? [])
    .map((referral): WorklistRowData | null => {
      const patient = DEMO_PATIENTS.find((item) => item.id === referral.patient_id)
      if (!patient || `${patient.name} ${patient.reason}`.toLowerCase().includes(query.toLowerCase()) === false) return null
      return { patient, label: CHEN_ACCEPTED_ROW_LABEL[referral.status] ?? 'Accepted referral', tone: 'copper', nextStep: 'Open patient', priority: -1, updated: null }
    })
    .filter((row): row is WorklistRowData => row !== null)
  const rows = [...acceptedRows, ...seededRows].sort((a, b) => a.priority - b.priority)
  const active = rows.filter((row) => row.priority < CHEN_PREVIOUS_CARE_PRIORITY)
  const previous = rows.filter((row) => row.priority >= CHEN_PREVIOUS_CARE_PRIORITY)

  return <main className="page-shell selector-page">
    <header className="selector-header">
      <div><p className="eyebrow">Specialist patients</p><h1>Patients</h1><p>People in your active care.</p></div>
      {incoming && incoming.length > 0 && <IncomingRequestsControl
        referrals={incoming}
        open={requestsOpen}
        onToggle={() => setRequestsOpen((value) => !value)}
        onReview={(referral) => { setRequestsOpen(false); setReviewing(referral) }}
      />}
    </header>
    <label className="patient-search"><svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="11" cy="11" r="6" /><path d="m16 16 4 4" /></svg><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search patients or clinical problem…" aria-label="Search patients" /></label>
    {error && <div className="error-banner" role="alert">{error}</div>}
    {active.length > 0 && <section className="patient-worklist-section">
      <div className="home-section-heading"><h2>Active patients</h2><span>{active.length}</span></div>
      <WorklistRows rows={active} navigate={navigate} basePath="/chen/patients" />
    </section>}
    {previous.length > 0 && <section className="patient-worklist-section">
      <div className="home-section-heading"><h2>Previous care</h2><span>{previous.length}</span></div>
      <WorklistRows rows={previous} navigate={navigate} basePath="/chen/patients" />
    </section>}
    {rows.length === 0 && <div className="empty-state specialist-empty">
      <LaminaMark />
      <h2>No patients found</h2>
      <p>Try a different name or clinical problem.</p>
    </div>}
    {reviewing && <RequestReviewModal referral={reviewing} receivingPhysicianName={CHEN_NAME} onAccepted={handleAccepted} onClose={() => setReviewing(null)} />}
  </main>
}

/**
 * Dr. Chen's Dashboard (Part B): the same general Dashboard architecture as
 * Lucy's own HomePage -- greeting, agent banner, patients-with-next-steps,
 * incoming-request awareness, recent activity, recent network -- populated
 * with his own real data, never a special "endocrinologist dashboard."
 * Incoming requests reuse the exact same submitted-referral data (and the
 * same RequestReviewModal) as Patients -> Incoming requests, never a
 * duplicate referral fixture (Part B1).
 */
export function ChenHomePage({ navigate }: { navigate: Navigate }) {
  const [incoming, setIncoming] = useState<Referral[] | null>(null)
  const [overview, setOverview] = useState<AgentOverview | null>(null)
  const [feed, setFeed] = useState<NetworkFeed | null>(null)
  const [reviewing, setReviewing] = useState<Referral | null>(null)
  const [error, setError] = useState('')

  useEffect(() => {
    getPhysicianReferrals(CHEN_ID, 'submitted').then(setIncoming).catch((err: Error) => setError(err.message))
    getAgentOverview('chen').then(setOverview).catch(() => {})
    getNetworkFeed('chen').then(setFeed).catch(() => {})
  }, [])

  const handleAccepted = (updated: Referral) => {
    setReviewing(null)
    setIncoming((current) => current?.filter((item) => item.id !== updated.id) ?? current)
    navigate(`/chen/patients/${updated.patient_id}`)
  }

  const greetingName = `Dr. ${CHEN_NAME.split(' ').at(-1)}`
  const topPatients: WorklistRowData[] = CHEN_SEEDED_PATIENTS
    .map((patient): WorklistRowData => {
      const meta = CHEN_PATIENT_STAGE_META[patient.stage]
      return { patient, label: meta.label, tone: meta.tone, nextStep: meta.nextStep, priority: meta.priority, updated: null }
    })
    .sort((a, b) => a.priority - b.priority)
    .slice(0, 3)
  const situationSummary = incoming && incoming.length > 0
    ? `${incoming.length} incoming referral${incoming.length === 1 ? '' : 's'} ${incoming.length === 1 ? 'needs' : 'need'} your review.`
    : null

  return <main className="page-shell home-page dashboard-page">
    <header className="dashboard-greeting"><p className="eyebrow">Dashboard</p><h1>{timeAwareGreeting(greetingName)}</h1>{situationSummary && <p className="dashboard-situation">{situationSummary}</p>}</header>
    {error && <div className="error-banner" role="alert">Recent workspace activity is temporarily unavailable. Patient records remain accessible.</div>}
    <HomeAgentCard overview={overview} navigate={navigate} trainPath={trainingPath('chen')} viewAgentPath="/chen/agent?tab=overview" personaId="chen" />
    {incoming && incoming.length > 0 && <section className="dashboard-needs-you">
      <div className="home-section-heading"><div><h2>Incoming requests</h2></div><span>{incoming.length}</span></div>
      <div className="lam-list needs-attention">
        {incoming.map((referral) => <button key={referral.id} className="lam-row" onClick={() => setReviewing(referral)}>
          <span className="lam-row-mark patient-row-avatar">{patientInitials(referral.patient_id)}</span>
          <span className="lam-row-main">
            <strong>{patientName(referral.patient_id)}</strong>
            <span>Incoming referral ready for review</span>
            <small>{resolvedSummary(resolvedCountFor(referral))}</small>
          </span>
          <span className="lam-row-action">Review <b>→</b></span>
        </button>)}
      </div>
    </section>}
    {topPatients.length > 0 && <section className="patient-worklist-section">
      <div className="home-section-heading"><div><h2>Patients</h2></div><button className="text-button" onClick={() => navigate('/chen/patients')}>View all patients →</button></div>
      <WorklistRows rows={topPatients} navigate={navigate} basePath="/chen/patients" />
    </section>}
    <div className="dashboard-bottom-row">
      <section className="home-activity"><div className="home-section-heading"><div><h2>Recent activity</h2></div></div><p className="home-empty">No agent activity yet.</p></section>
      <NetworkHighlights feed={feed} navigate={navigate} perspective="chen" />
    </div>
    {reviewing && <RequestReviewModal referral={reviewing} receivingPhysicianName={CHEN_NAME} onAccepted={handleAccepted} onClose={() => setReviewing(null)} />}
  </main>
}

/* ===================================================================== Part B/D
 * Dr. Chen's Profile reuses ProfessionalProfilePage directly (wired up at the
 * route level in App.tsx) -- no special Chen-only profile page exists. The
 * two small pages below exist only because that SHARED profile page links out
 * to "View how my agent represents me" and (via the public-preview page) "View
 * network posts" -- both reuse existing generic shared components
 * (AgentOverviewPanel/TrainTab/ChatTab/NetworkFeedTab), exactly like Lucy's
 * and Iain's own agent/network pages, never a parallel implementation.
 */

const CHEN_AGENT_TABS = ['overview', 'train', 'test'] as const
type ChenAgentTab = typeof CHEN_AGENT_TABS[number]
const resolveChenAgentTab = (value: string | null): ChenAgentTab =>
  value && (CHEN_AGENT_TABS as readonly string[]).includes(value) ? (value as ChenAgentTab) : 'overview'

export function ChenAgentPage({ navigate, params }: { navigate: Navigate; params?: URLSearchParams }) {
  const tabParam = params?.get('tab') ?? null
  const [representation, setRepresentation] = useState<PracticeRepresentation | null>(null)
  const [overview, setOverview] = useState<AgentOverview | null>(null)
  const [trainProjection, setTrainProjection] = useState<TrainProjection | null>(null)
  const [tab, setTab] = useState<ChenAgentTab>(() => resolveChenAgentTab(tabParam))
  const [error, setError] = useState('')
  useEffect(() => {
    getPracticeRepresentation('chen').then(setRepresentation).catch(() => {})
    getAgentOverview('chen').then(setOverview).catch((err: Error) => setError(err.message))
    getTrainingHistory('chen').then(setTrainProjection).catch(() => {})
  }, [])
  useEffect(() => { setTab(resolveChenAgentTab(tabParam)) }, [tabParam])
  const selectTab = (next: ChenAgentTab) => { setTab(next); window.history.replaceState({}, '', `/chen/agent?tab=${next}`) }
  const agentName = CHEN_AGENT_NAME
  return <main className="page-shell agent-page">
    {error && <div className="error-banner" role="alert">{error}</div>}
    {!overview && !error && <p className="muted-note">Opening your agent…</p>}
    {overview && <>
      <section className="agent-hero"><div className="agent-hero-mark"><AgentAvatar tone={agentTone('chen')} /></div><div>
        <p className="eyebrow">Your physician agent</p>
        <h1>{agentName}</h1>
        <p>{CHEN_SPECIALTY} · Represents your practice to referring physician agents.</p>
      </div></section>
      <nav className="agent-tabs" aria-label="My Agent sections">{CHEN_AGENT_TABS.map((item) => <button key={item} className={tab === item ? 'active' : ''} aria-current={tab === item ? 'page' : undefined} onClick={() => selectTab(item)}>{item[0].toUpperCase() + item.slice(1)}</button>)}</nav>
      {tab === 'overview' && <AgentOverviewPanel overview={overview} representation={representation} navigate={navigate} trainPath={trainingPath('chen')} personaId="chen" />}
      {tab === 'train' && <TrainTab trainProjection={trainProjection} navigate={navigate} trainPath={trainingPath('chen')} />}
      {tab === 'test' && <ChatTab personaId="chen" agentName={agentName} navigate={navigate} trainPath={trainingPath('chen')} />}
    </>}
  </main>
}

/** Mirrors SpecialistMyNetworkTab's exact shape (Specialist.tsx), generalized
 * to Chen's perspective -- "Colleagues" (Part J): physicians explicitly added
 * to his network, or whose agents have interacted with his, deduped by id. */
function ChenMyNetworkTab({ navigate }: { navigate: Navigate }) {
  const [feed, setFeed] = useState<NetworkFeed | null>(null)
  const [error, setError] = useState('')
  useEffect(() => { getNetworkFeed('chen').then(setFeed).catch((err: Error) => setError(err.message)) }, [])
  const physicians = feed ? [...new Map(feed.items.map((item) => [item.physician.id, item.physician])).values()] : []
  return <div className="my-network-tab">
    <p className="network-intro">Physicians relevant to your practice — explicitly added to your network, or whose agents have interacted with yours.</p>
    {error && <div className="error-banner" role="alert">{error}</div>}
    {!feed && !error && <p className="muted-note">Loading network…</p>}
    {feed && physicians.length === 0 && <div className="empty-state history-empty"><LaminaMark /><h2>No relevant physicians yet</h2><p>Physicians appear here once your agent participates in a network interaction, or once a professional connection is added.</p></div>}
    {physicians.length > 0 && <div className="lam-list">{physicians.map((physician) => <button className="lam-row" key={physician.id} onClick={() => navigate(networkProfilePath('chen', physician.id))}>
      <span className="lam-row-mark patient-row-avatar">{physician.name.replace('Dr. ', '').split(/\s+/).map((part) => part[0]).slice(0, 2).join('')}</span>
      <span className="lam-row-main"><strong>{physician.name}</strong><span>{physician.specialty}</span><small>{physician.location}</small></span>
      <span className="lam-row-action">View professional profile <b>→</b></span>
    </button>)}</div>}
  </div>
}

/** Dr. Chen's Network page (Part J): the same Colleagues/Feed tab structure
 * as Lucy's and Iain's own Network pages -- reused, not a unique Chen
 * network. Routes resolve back into Chen's own perspective (networkProfilePath
 * 'chen'), never Lucy's or Iain's. */
export function ChenNetworkPage({ navigate, params }: { navigate: Navigate; params?: URLSearchParams }) {
  const tabParam = params?.get('tab') ?? null
  const [tab, setTab] = useState<NetworkTab>(tabParam === 'my-network' ? 'my-network' : 'feed')
  useEffect(() => { setTab(tabParam === 'my-network' ? 'my-network' : 'feed') }, [tabParam])
  const selectTab = (next: NetworkTab) => { setTab(next); window.history.replaceState({}, '', next === 'my-network' ? '/chen/network?tab=my-network' : '/chen/network') }
  return <main className="page-shell physician-directory-page">
    <header className="directory-hero"><div><p className="eyebrow">Physician-agent network</p><h1>Network</h1><p>The physicians, practices, and professional updates connected through your Lamina network.</p></div></header>
    <NetworkTabs tab={tab} onSelect={selectTab} />
    {tab === 'my-network' ? <ChenMyNetworkTab navigate={navigate} /> : <NetworkFeedTab personaId="chen" navigate={navigate} />}
  </main>
}
