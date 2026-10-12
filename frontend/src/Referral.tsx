import { useEffect, useRef, useState } from 'react'
import { createReferral, runReferralPreflight, type Referral } from './api.ts'
import { PCP_NAME } from './demoIdentity.ts'
import { ModalPortal } from './ModalPortal.tsx'
import { derivePhases, eventActorLabel, EVENT_TYPE_TITLES, lastName, PHASE_FADE_MS, PHASE_HOLD_MS, type DisplayPhase } from './referralPhases.ts'

export { derivePhases } from './referralPhases.ts'
export type { DisplayPhase } from './referralPhases.ts'

const prefersReducedMotion = () => window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false

function PhaseContent({ phase, receivingPhysicianName }: { phase: DisplayPhase; receivingPhysicianName: string }) {
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
      return <>
        <span className="status-label resolved"><span className="spark-icon lead" aria-hidden="true">✓</span>Sent to Dr. {who}</span>
        <h3>Referral sent.</h3>
        <p>The completed referral packet has been sent to Dr. {who} for review.</p>
        <small>Awaiting specialist review</small>
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
 * The right-rail surface for a real referral. Executes the real backend
 * create+preflight calls immediately, then reveals the resulting real phases
 * over several seconds purely as frontend presentation pacing -- the backend
 * call itself is never delayed or slept (see Part E/F/Y).
 */
export function ReferralCoordinationSurface({
  patientId, patientLabel, receivingPhysicianId, receivingPhysicianName,
}: { patientId: string; patientLabel: string; receivingPhysicianId: string; receivingPhysicianName: string }) {
  const [status, setStatus] = useState<'idle' | 'running' | 'done' | 'error'>('idle')
  const [visiblePhase, setVisiblePhase] = useState<DisplayPhase | null>(null)
  const [fading, setFading] = useState(false)
  const [referral, setReferral] = useState<Referral | null>(null)
  const [coordinationOpen, setCoordinationOpen] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [toastVisible, setToastVisible] = useState(false)
  const timers = useRef<number[]>([])
  const cancelled = useRef(false)

  useEffect(() => () => {
    cancelled.current = true
    timers.current.forEach((id) => window.clearTimeout(id))
    timers.current = []
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

  const revealPhase = async (phase: DisplayPhase) => {
    if (cancelled.current) return
    if (!prefersReducedMotion()) {
      setFading(true)
      await sleep(PHASE_FADE_MS)
      if (cancelled.current) return
      setVisiblePhase(phase)
      await nextPaint()
      if (cancelled.current) return
      setFading(false)
    } else {
      setVisiblePhase(phase)
    }
    if (phase.kind === 'sent') setToastVisible(true)
    await sleep(PHASE_HOLD_MS[phase.kind])
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
        await revealPhase(phase)
        if (cancelled.current) return
      }
      setStatus('done')
    } catch (startError) {
      if (cancelled.current) return
      setError(startError instanceof Error ? startError.message : 'Could not start the referral.')
      setStatus('error')
    }
  }

  if (status === 'idle') {
    return <button className="button-primary" onClick={() => void start()}>Start referral <span>→</span></button>
  }
  if (status === 'error') {
    return <div className="referral-coordination-surface error-banner" role="alert">{error}</div>
  }
  if (!visiblePhase) return null
  return <div className="referral-coordination-surface" role="status">
    <div className={`referral-phase ${fading ? 'phase-fading' : ''}`}>
      <PhaseContent phase={visiblePhase} receivingPhysicianName={receivingPhysicianName} />
    </div>
    {status === 'done' && referral && <button type="button" className="text-button" onClick={() => setCoordinationOpen(true)}>See agent coordination →</button>}
    {coordinationOpen && referral && <AgentCoordinationModal
      referral={referral}
      receivingPhysicianName={receivingPhysicianName}
      onClose={() => setCoordinationOpen(false)}
    />}
    {toastVisible && <Toast
      title="Referral sent"
      message={`${patientLabel}'s referral was sent to Dr. ${lastName(receivingPhysicianName)}.`}
      onDismiss={() => setToastVisible(false)}
    />}
  </div>
}

const TOAST_VISIBLE_MS = 3200

/**
 * A brief, non-blocking confirmation -- not the durable state (the rail is).
 * Auto-dismisses; does not require interaction. The smallest reusable
 * implementation that didn't already exist elsewhere in Lamina.
 */
function Toast({ title, message, onDismiss }: { title: string; message: string; onDismiss: () => void }) {
  useEffect(() => {
    const id = window.setTimeout(onDismiss, TOAST_VISIBLE_MS)
    return () => window.clearTimeout(id)
  }, [onDismiss])
  return <div className="lamina-toast" role="status" aria-live="polite">
    <strong><span aria-hidden="true">✓</span> {title}</strong>
    <span>{message}</span>
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
