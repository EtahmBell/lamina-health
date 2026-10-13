import { useEffect, useRef, useState } from 'react'
import { acceptReferral, createReferral, getAgentOverview, getPhysicianReferrals, getPracticeRepresentation, getTrainingHistory, runReferralPreflight, type AgentOverview, type PacketItem, type PracticeRepresentation, type Referral, type TrainProjection } from './api.ts'
import { CHEN_ID, CHEN_NAME, CHEN_SPECIALTY, patientAgeLocation, patientInitials, patientName, PCP_NAME } from './demoIdentity.ts'
import { AgentOverviewPanel, ChatTab, NetworkFeedTab, trainingPath, TrainTab } from './Engagement.tsx'
import { LaminaMark } from './LaminaMark.tsx'
import { ModalPortal } from './ModalPortal.tsx'
import { derivePhases, eventActorLabel, EVENT_TYPE_TITLES, formatSubmittedAt, lastName, PHASE_FADE_MS, PHASE_HOLD_MS, resolvedSummary, restorePhase, SUCCESS_WASH_HOLD_MS, type DisplayPhase } from './referralPhases.ts'

export { derivePhases } from './referralPhases.ts'
export type { DisplayPhase } from './referralPhases.ts'

type Navigate = (path: string) => void

const prefersReducedMotion = () => window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false

function PhaseContent({ phase, receivingPhysicianName, patientLabel }: { phase: DisplayPhase; receivingPhysicianName: string; patientLabel: string }) {
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
        {phase.acceptedAt && <small className="referral-submission-meta">Accepted {formatSubmittedAt(phase.acceptedAt)}</small>}
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
  const [error, setError] = useState<string | null>(null)
  const timers = useRef<number[]>([])
  const cancelled = useRef(false)

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
      <PhaseContent phase={visiblePhase} receivingPhysicianName={receivingPhysicianName} patientLabel={patientLabel} />
    </div>
    {status === 'done' && referral && !justCompleted && <div className="referral-mode-links">
      <button type="button" className="text-button" onClick={() => setPacketOpen(true)}>View referral packet →</button>
      <button type="button" className="text-button" onClick={() => setCoordinationOpen(true)}>See agent coordination →</button>
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
      <p className="coordination-footer">{referral.status === 'accepted' ? `✓ Referral accepted by ${receivingPhysicianName}` : referral.status === 'submitted' ? '✓ Referral sent to the receiving specialist' : referral.status === 'ready_for_review' ? '✓ Referral ready for review' : 'Referral not yet ready for review'}</p>
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

/**
 * Dr. Chen's Patients page (Part Q/P): before acceptance a referred patient
 * is only an incoming request, never listed here as a patient. The accepted
 * list is queried the same way the incoming popover is -- real persisted referrals
 * filtered by status, never a frontend fixture (Part W: "accepted patient"
 * simply means "a referral to me with status=accepted" -- no separate
 * relationship table needed).
 */
export function ChenPatientsPage({ navigate }: { navigate: Navigate }) {
  const [incoming, setIncoming] = useState<Referral[] | null>(null)
  const [accepted, setAccepted] = useState<Referral[] | null>(null)
  const [error, setError] = useState('')
  const [requestsOpen, setRequestsOpen] = useState(false)
  const [reviewing, setReviewing] = useState<Referral | null>(null)

  const load = () => Promise.all([
    getPhysicianReferrals(CHEN_ID, 'submitted'),
    getPhysicianReferrals(CHEN_ID, 'accepted'),
  ]).then(([submitted, acceptedReferrals]) => { setIncoming(submitted); setAccepted(acceptedReferrals) })
    .catch((loadError: Error) => setError(loadError.message))

  useEffect(() => { void load() }, [])

  const handleAccepted = (updated: Referral) => {
    setReviewing(null)
    setIncoming((current) => current?.filter((item) => item.id !== updated.id) ?? current)
    navigate(`/chen/patients/${updated.patient_id}`)
  }

  return <main className="page-shell selector-page">
    <header className="selector-header">
      <div><p className="eyebrow">Specialist patients</p><h1>Patients</h1><p>People accepted into your care.</p></div>
      {incoming && incoming.length > 0 && <IncomingRequestsControl
        referrals={incoming}
        open={requestsOpen}
        onToggle={() => setRequestsOpen((value) => !value)}
        onReview={(referral) => { setRequestsOpen(false); setReviewing(referral) }}
      />}
    </header>
    {error && <div className="error-banner" role="alert">{error}</div>}
    {accepted && accepted.length === 0 && <div className="empty-state specialist-empty">
      <LaminaMark />
      <h2>No patients yet</h2>
      <p>Patients appear here once you accept an incoming referral.</p>
    </div>}
    {accepted && accepted.length > 0 && <div className="lam-list patient-worklist">
      {accepted.map((referral) => <button key={referral.id} className="lam-row worklist-row" onClick={() => navigate(`/chen/patients/${referral.patient_id}`)}>
        <span className="lam-row-mark patient-row-avatar">{patientInitials(referral.patient_id)}</span>
        <span className="lam-row-main"><strong>{patientName(referral.patient_id)}</strong><small>{referral.specialty} · Accepted referral</small></span>
        <span className="lam-row-action">Open patient <b>→</b></span>
      </button>)}
    </div>}
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
  const agentName = `${CHEN_NAME}'s Agent`
  return <main className="page-shell agent-page">
    {error && <div className="error-banner" role="alert">{error}</div>}
    {!overview && !error && <p className="muted-note">Opening your agent…</p>}
    {overview && <>
      <section className="agent-hero"><div className="agent-hero-mark"><LaminaMark /></div><div>
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

export function ChenNetworkPage({ navigate }: { navigate: Navigate }) {
  return <main className="page-shell physician-directory-page">
    <header className="directory-hero"><div><p className="eyebrow">Physician-agent network</p><h1>Network</h1><p>Professional updates connected through your Lamina network.</p></div></header>
    <NetworkFeedTab personaId="chen" navigate={navigate} />
  </main>
}
