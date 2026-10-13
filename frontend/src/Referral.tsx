import { useEffect, useRef, useState } from 'react'
import { createReferral, runReferralPreflight, type PacketItem, type Referral } from './api.ts'
import { PCP_NAME } from './demoIdentity.ts'
import { ModalPortal } from './ModalPortal.tsx'
import { derivePhases, eventActorLabel, EVENT_TYPE_TITLES, formatSubmittedAt, lastName, PHASE_FADE_MS, PHASE_HOLD_MS, resolvedSummary, restorePhase, SUCCESS_WASH_HOLD_MS, type DisplayPhase } from './referralPhases.ts'

export { derivePhases } from './referralPhases.ts'
export type { DisplayPhase } from './referralPhases.ts'

const prefersReducedMotion = () => window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false

function PhaseContent({ phase, receivingPhysicianName, justCompleted }: { phase: DisplayPhase; receivingPhysicianName: string; justCompleted?: boolean }) {
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
      // Two renderings of the same real "submitted" phase data: a brief
      // full-card completion moment (see the success-wash treatment on the
      // outer card), then a crossfade into the durable "awaiting review"
      // copy. Never two different claims -- just two moments in hierarchy.
      if (justCompleted) {
        return <>
          <span className="status-label resolved"><span className="spark-icon lead" aria-hidden="true">✓</span>Referral sent</span>
          <p className="referral-wash-line">The completed packet was sent to Dr. {who}.</p>
          <p className="referral-wash-line">{resolvedSummary(phase.resolvedCount)}.</p>
        </>
      }
      return <>
        <span className="status-label resolved"><span className="spark-icon lead" aria-hidden="true">✓</span>Sent</span>
        <h3>Awaiting Dr. {who}'s review</h3>
        <p>The completed referral packet has been sent to Dr. {who} for review.</p>
        <small className="referral-submission-meta">{resolvedSummary(phase.resolvedCount)}{phase.submittedAt ? ` · Submitted ${formatSubmittedAt(phase.submittedAt)}` : ''}</small>
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
  patientId, patientLabel, receivingPhysicianId, receivingPhysicianName, restoredReferral, onSuccessWashChange,
}: {
  patientId: string; patientLabel: string; receivingPhysicianId: string; receivingPhysicianName: string
  restoredReferral: Referral | null
  /** Lets the parent card apply a full-card success-wash background while the
   * completion moment plays -- never fired on restoration, only on a live
   * Start-referral run (see Part D). */
  onSuccessWashChange?: (active: boolean) => void
}) {
  const [status, setStatus] = useState<'running' | 'done' | 'error'>(restoredReferral ? 'done' : 'running')
  const [visiblePhase, setVisiblePhase] = useState<DisplayPhase | null>(restoredReferral ? restorePhase(restoredReferral) : null)
  const [fading, setFading] = useState(false)
  const [justCompleted, setJustCompleted] = useState(false)
  const [referral, setReferral] = useState<Referral | null>(restoredReferral)
  const [coordinationOpen, setCoordinationOpen] = useState(false)
  const [packetOpen, setPacketOpen] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const timers = useRef<number[]>([])
  const cancelled = useRef(false)

  useEffect(() => () => {
    cancelled.current = true
    timers.current.forEach((id) => window.clearTimeout(id))
    onSuccessWashChange?.(false)
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
   * The "sent" phase gets a stronger, two-moment reveal (Part D): first a
   * brief full-card success wash ("Referral sent" / what was resolved),
   * held long enough to register as a real completion event, then a
   * crossfade into the durable "Awaiting Dr. X's review" card. Both moments
   * render the exact same real phase data -- only the copy hierarchy and the
   * outer card's background differ.
   */
  const revealSentPhase = async (phase: DisplayPhase & { kind: 'sent' }) => {
    await crossfade(() => { setVisiblePhase(phase); setJustCompleted(true); onSuccessWashChange?.(true) })
    if (cancelled.current) return
    await sleep(prefersReducedMotion() ? 500 : SUCCESS_WASH_HOLD_MS)
    if (cancelled.current) return
    await crossfade(() => { setJustCompleted(false); onSuccessWashChange?.(false) })
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
  return <div className="referral-coordination-surface" role="status">
    <div className={`referral-phase ${fading ? 'phase-fading' : ''}`}>
      <PhaseContent phase={visiblePhase} receivingPhysicianName={receivingPhysicianName} justCompleted={justCompleted} />
    </div>
    {status === 'done' && referral && !justCompleted && <div className="referral-mode-links">
      <button type="button" className="text-button" onClick={() => setPacketOpen(true)}>View referral packet →</button>
      <button type="button" className="text-button" onClick={() => setCoordinationOpen(true)}>See agent coordination →</button>
    </div>}
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
      <p className="coordination-footer">{referral.status === 'submitted' ? '✓ Referral sent to the receiving specialist' : referral.status === 'ready_for_review' ? '✓ Referral ready for review' : 'Referral not yet ready for review'}</p>
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
