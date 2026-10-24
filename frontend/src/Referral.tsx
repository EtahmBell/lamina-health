import { useEffect, useRef, useState } from 'react'
import { acceptReferral, askPhysicianAgent, createAgentCorrection, createReferral, getAgentOverview, getEncounter, getHandoff, getNetworkFeed, getPhysicianCapacity, getPhysicianReferrals, getPracticeRepresentation, getScheduling, getTrainingHistory, markHandoffViewed, runReferralPreflight, sendHandoff, type AccessProfile, type AgentOverview, type AppointmentSlot, type CareModality, type ConsultationEncounter, type CoordinationEvent, type HandoffSummary, type NetworkFeed, type PacketItem, type PracticeRepresentation, type Referral, type ReferralPriority, type ReferralStatus, type SchedulingCoordination, type TrainProjection } from './api.ts'
import { CHEN_AGENT_NAME, CHEN_ID, CHEN_NAME, CHEN_SPECIALTY, patientAgeLocation, patientInitials, patientName, PCP_NAME, TONJIT_ID } from './demoIdentity.ts'
import { DEMO_PATIENTS, type PatientStage } from './demoPatients.ts'
import { AgentOverviewPanel, ChatTab, HomeAgentCard, NetworkHighlights, trainingPath, TrainTab, WorklistRows, type WorklistRowData } from './Engagement.tsx'
import { timeAwareGreeting } from './greeting.ts'
import { AgentAvatar, agentTone } from './AgentAvatar.tsx'
import { LaminaMark } from './LaminaMark.tsx'
import { physicianInitials } from './networkRoster.ts'
import { ModalPortal } from './ModalPortal.tsx'
import { acceptedReferralStep, attentionOrder, CHEN_SEEDED_NEXT_STEPS, handledByAgentOrStaff, referralReviewStep, topAttention, type NextStepItem } from './specialistWorklist.ts'
import { derivePhases, eventActorLabel, EVENT_TYPE_TITLES, formatSubmittedAt, lastName, PHASE_FADE_MS, PHASE_HOLD_MS, resolvedSummary, restorePhase, SUCCESS_WASH_HOLD_MS, type DisplayPhase } from './referralPhases.ts'

export { derivePhases } from './referralPhases.ts'
export type { DisplayPhase } from './referralPhases.ts'

type Navigate = (path: string) => void

const prefersReducedMotion = () => window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false

/** Care-routing demo pass, Part E/F/Q: the one shared label for the
 * structured priority, Routine/Soon/Urgent -- never a numeric score (Part
 * W), reused wherever priority is shown (Lucy's editor, the referral-mode
 * surface, Chen's Incoming Requests). */
export const priorityLabel = (priority: ReferralPriority) => priority === 'urgent' ? 'Urgent' : priority === 'soon' ? 'Soon' : 'Routine'

/** Routing/triage UX pass, Part E: ONE shared chip treatment for priority
 * everywhere it appears -- never plain bold text in one place and a pill
 * elsewhere. Read-only display chip; `PriorityChipRow` below is the only
 * editable form. */
export function PriorityChip({ priority }: { priority: ReferralPriority }) {
  return <span className={`priority-chip priority-chip-display priority-${priority}`}>{priorityLabel(priority)}</span>
}

/** Routing/triage UX pass, Part C: priority is ALWAYS shown as this
 * directly-editable chip row -- there is no separate "Edit" affordance or
 * edit-mode toggle. */
export function PriorityChipRow({ priority, onChange }: { priority: ReferralPriority; onChange: (value: ReferralPriority) => void }) {
  return <div className="priority-chip-row">{(['routine', 'soon', 'urgent'] as const).map((value) => <button
    key={value} type="button"
    className={`priority-chip ${priority === value ? 'selected' : ''}`}
    onClick={() => onChange(value)}
  >{priorityLabel(value)}</button>)}</div>
}

/** Follow-up pass, Part P/Q: a restrained, one-shot success animation --
 * the circular ring strokes in, then the checkmark strokes in inside it,
 * total ~540ms. Pure CSS keyframes driven entirely by mount (no JS timers,
 * no state), so it plays exactly once whenever this element is actually
 * mounted and never replays on an ordinary rerender. The one real
 * precondition -- that it only ever MOUNTS on a genuine live acceptance,
 * never on hydration of an already-accepted referral -- is the caller's
 * responsibility (see RequestReviewModal: this only renders inside the
 * `accepted` branch, which is local, mount-once state that a restored/
 * hydrated referral never sets). Respects prefers-reduced-motion by
 * showing the completed check-circle immediately (see CSS). Backend
 * acceptance itself already happened before this ever renders -- the
 * animation is presentation only. */
function CheckCircleAnimation() {
  return <svg className="check-circle-animation" viewBox="0 0 64 64" width="52" height="52" aria-hidden="true">
    <circle className="check-circle-ring" cx="32" cy="32" r="27" fill="none" strokeWidth="3" />
    <path className="check-circle-mark" d="M20 33 L28 41 L44 23" fill="none" strokeWidth="3.5" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
}

function PhaseContent({ phase, receivingPhysicianName, patientLabel, scheduling, modality = 'in_person' }: { phase: DisplayPhase; receivingPhysicianName: string; patientLabel: string; scheduling?: SchedulingCoordination | null; modality?: CareModality }) {
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
        <p className="referral-next-step-note">Next: {modality === 'econsult' ? 'E-consult' : 'Scheduling'}</p>
        {phase.acceptedAt && <small className="referral-submission-meta">Accepted {formatSubmittedAt(phase.acceptedAt)}</small>}
      </>
    case 'scheduled': {
      // Routing/triage UX polish pass, Part 3A: an e-consult route has no
      // visit slot to show -- the backend's scheduling pipeline still runs
      // unconditionally behind the scenes (Part AC: no full e-consult
      // workflow), but presenting its synthetic appointment TIME for an
      // e-consult would contradict the modality the physician actually
      // selected, so this branch never reads `scheduling` at all.
      if (modality === 'econsult') return <>
        <span className="status-label resolved"><span className="spark-icon lead" aria-hidden="true">✓</span>E-consult sent</span>
        <h3>E-consult request sent to Dr. {who}</h3>
        <p>The referral was accepted and an e-consult request was sent for asynchronous review.</p>
      </>
      const slot = scheduling?.selected_option
      return <>
        <span className="status-label resolved"><span className="spark-icon lead" aria-hidden="true">✓</span>Scheduled</span>
        <h3>Appointment with Dr. {who}</h3>
        {slot && <p className="referral-found-value">{formatSubmittedAt(slot.starts_at)}</p>}
        <p>The referral was accepted and the consultation is scheduled.</p>
      </>
    }
    case 'handoff_received':
      // Green, not mineral-blue (ongoing-coordination pass, Part C) -- the
      // only phase that represents the referral loop successfully
      // RETURNING information, reusing the shared .status-label.success
      // token already established elsewhere (Lucy's worklist badges), never
      // a new color invented for this one card.
      return <>
        <span className="status-label success"><span className="spark-icon lead" aria-hidden="true">✓</span>Specialist follow-up received</span>
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
/** Demo hardening pass, Part J: one in-flight create per patient +
 * receiving physician. A second mount (React StrictMode re-runs mount
 * effects in development) or a fast double click shares the SAME request
 * instead of sending another. The backend's atomic get-or-create remains
 * the authoritative guard; this just avoids the redundant request. */
const referralCreationsInFlight = new Map<string, Promise<Referral>>()

export function createReferralOnce(patientId: string, receivingPhysicianId: string, priority?: ReferralPriority, modality?: CareModality): Promise<Referral> {
  const key = `${patientId}::${receivingPhysicianId}`
  const pending = referralCreationsInFlight.get(key)
  if (pending) return pending
  const request = createReferral(patientId, receivingPhysicianId, priority, modality)
    .finally(() => referralCreationsInFlight.delete(key))
  referralCreationsInFlight.set(key, request)
  return request
}

export function ReferralCoordinationSurface({
  patientId, patientLabel, receivingPhysicianId, receivingPhysicianName, restoredReferral, onWashChange, onReferralChange, onReviewedChange, priority, modality, onViewReceivingProfile,
}: {
  patientId: string; patientLabel: string; receivingPhysicianId: string; receivingPhysicianName: string
  restoredReferral: Referral | null
  /** Physician UX consistency pass, Part G: opens the receiving physician's
   * PUBLIC network profile (the same route/page used everywhere else) --
   * never their private My Agent, never the agent chat. Omitted when the
   * physician has no Lamina profile. */
  onViewReceivingProfile?: () => void
  /** Care-routing demo pass, Part E: the physician-confirmed priority at the
   * moment "Start referral" is clicked -- read once here (a brand-new
   * referral is only ever created once, in the mount effect below), never
   * re-read afterward. Omitted entirely for a restored referral, which
   * already carries its own real persisted `priority`. */
  priority?: ReferralPriority
  /** Routing/triage UX polish pass, Part 3A: which care route the physician
   * actually selected at the moment "Start referral" is clicked -- same
   * "read once, never re-read" shape as `priority` above. Omitted for a
   * restored referral, which already carries its own real `modality`. */
  modality?: CareModality
  /** Mirrors justCompleted up to the parent, which owns the actual card
   * element -- the wash background lives there (see .handoff-wash), not on
   * this overlay, so its visible edge is the card's own border-box and can
   * never mismatch the card's radius (Part H). Never called for a restored/
   * hydrated referral. */
  onWashChange?: (active: boolean) => void
  /** Root-cause fix for the duplicate-referral navigation bug (demo-
   * consolidation pass, Part 3): the parent's own `activeReferral` was only
   * ever populated by the one-time mount hydration lookup, so a referral
   * created LIVE within this same session (no reload) never propagated back
   * up -- "Back to match options" then showed a stale Discovery view with
   * no record of the referral that very session just created, allowing
   * "Start referral" to be clicked again. Called with the real referral the
   * moment it exists, so the parent is never out of sync with what this
   * component itself already knows. */
  onReferralChange?: (referral: Referral) => void
  /** Once Lucy has reviewed the returned handoff, the episode recedes and
   * the parent switches to rendering a generic current-care-state card
   * instead of "Referral to Dr. X" (demo-consolidation pass, Part 7-10) --
   * that framing lives one level up (RecommendationView owns the kicker/
   * physician-row), so this component reports the real `reviewed` fact
   * rather than deciding it unilaterally. Mirrors onReferralChange's same
   * "never let the parent go stale" shape. */
  onReviewedChange?: (reviewed: boolean) => void
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
  // `undefined` means "a handoff should exist but hasn't loaded yet" --
  // distinct from `null` ("no handoff, and none is expected"). A restored
  // consult_returned referral always has a real handoff; starting this at
  // `undefined` lets the render gate below show a neutral loading state
  // instead of flashing the ACTIVE "Referral to Dr. X" structure first and
  // then snapping to the generic/collapsed state once the fetch resolves
  // (bug-fix pass, Part Q -- the reload-flash bug).
  const [handoff, setHandoff] = useState<HandoffSummary | null | undefined>(
    restoredReferral?.status === 'consult_returned' ? undefined : null
  )
  const [schedulingDetailsOpen, setSchedulingDetailsOpen] = useState(false)
  const [handoffOpen, setHandoffOpen] = useState(false)
  // Collapsed by default (Part 10) -- the physician explicitly expands it.
  const [episodeOpen, setEpisodeOpen] = useState(false)
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

  // Keeps the parent informed of the real `reviewed` fact (never decided
  // unilaterally) -- but deliberately withheld while the handoff modal is
  // still open: the parent's "reviewed" vs "active" branches are
  // structurally different trees (generic card vs. "Referral to Dr. X"),
  // so flipping mid-render would remount this very component and silently
  // close the modal out from under the physician still reading it. Reports
  // once she actually closes it, by which point the remount is invisible.
  // Also withheld while `handoff === undefined` (bug-fix pass, Part Q) --
  // on a restored consult_returned referral the real handoff hasn't loaded
  // yet, so reporting a premature `false` here would briefly flash the
  // parent into its "Referral to Dr. X" framing before snapping to the
  // generic state once the fetch resolves. Silence until the real answer
  // is known, exactly like this component's own render gate below.
  useEffect(() => {
    if (handoffOpen || handoff === undefined) return
    onReviewedChange?.(Boolean(handoff?.viewed_by_referring_physician_at))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [handoff?.viewed_by_referring_physician_at, handoffOpen])

  const setWash = (active: boolean) => { setJustCompleted(active); onWashChange?.(active) }

  /**
   * Marks the handoff viewed the moment it is opened (demo-consolidation
   * pass, Part 8) -- by this point `handoff` is already the real, fully-
   * loaded object (never a placeholder), so "opens and loads" has already
   * happened; this is a best-effort background call that never blocks or
   * delays the modal itself from opening. A no-op once already viewed.
   */
  const openHandoff = () => {
    setHandoffOpen(true)
    if (!handoff || !referral?.id || handoff.viewed_by_referring_physician_at) return
    markHandoffViewed(referral.id, referral.referring_physician_id).then((viewed) => {
      if (!cancelled.current) setHandoff(viewed)
    }).catch(() => {})
  }

  useEffect(() => {
    // A StrictMode remount reuses this ref after the simulated unmount's
    // cleanup -- reset it so the remounted surface isn't treated as gone.
    cancelled.current = false
    return () => {
      cancelled.current = true
      timers.current.forEach((id) => window.clearTimeout(id))
      onWashChange?.(false)
    }
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
      const created = await createReferralOnce(patientId, receivingPhysicianId, priority, modality)
      const preflighted = await runReferralPreflight(created.id as number)
      await minimumPreparingDisplay
      if (cancelled.current) return
      setReferral(preflighted)
      onReferralChange?.(preflighted)
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
  // Mirrors the onReviewedChange withholding above (bug-fix pass, Part Q):
  // the real handoff hasn't loaded yet for a restored consult_returned
  // referral, so render neither the active nor the collapsed structure --
  // just a neutral placeholder -- until it has.
  if (handoff === undefined) {
    return <div className="referral-coordination-surface" role="status"><div className="next-step-card idle"><p className="muted-note">Opening referral…</p></div></div>
  }
  const sentResolvedCount = visiblePhase.kind === 'sent' ? visiblePhase.resolvedCount : 0
  const reviewed = Boolean(handoff?.viewed_by_referring_physician_at)
  const modals = <>
    {coordinationOpen && referral && <AgentCoordinationModal
      referral={referral}
      receivingPhysicianName={receivingPhysicianName}
      viewerPhysicianId={referral.referring_physician_id}
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
  </>

  // Once Lucy has reviewed the returned handoff, the episode recedes into a
  // compact, collapsed-by-default history section (demo-consolidation pass,
  // Part 7C/10/32) -- the "Referral to Dr. X" framing itself lives one
  // level up and has already stopped rendering (see onReviewedChange), so
  // this returns ONLY the collapsed episode, never the live phase content.
  //
  // Root-cause fix (bug-fix pass, Part D-G/O/P): `reviewed` flips true the
  // instant the background `markHandoffViewed` call resolves -- which
  // happens WHILE the modal is still open (openHandoff fires it immediately
  // on open, not on close). Without `!handoffOpen` here, this branch (a
  // structurally different tree from the "active" branch below) would swap
  // out from under the open HandoffModal mid-read, remounting it and
  // reading as a glitchy phase/flash. `!handoffOpen` is the single
  // authoritative gate: the same fact `onReviewedChange` already withholds
  // on above, now applied consistently to this component's OWN branch
  // choice too, so the background stays completely stable until she
  // actually closes the modal, and the transition happens exactly once.
  if (status === 'done' && referral && !justCompleted && reviewed && !handoffOpen) {
    return <>
      <div className="specialty-episode-section">
        <p className="section-label">Recent specialty care</p>
        <details className="specialty-episode" open={episodeOpen} onToggle={(event) => setEpisodeOpen(event.currentTarget.open)}>
          <summary className="specialty-episode-summary">
            {/* Part F/G/I: one flex row, every item centered on the same
             * axis. The avatar/name open the physician's profile and cancel
             * the summary's own toggle (preventDefault on the click also
             * covers Enter/Space, which dispatch a click on the button), so
             * profile and episode expansion never trigger each other. */}
            <span className="specialty-episode-identity">
              {onViewReceivingProfile
                ? <button type="button" className="specialty-episode-avatar directory-avatar" tabIndex={-1} aria-hidden="true" onClick={(event) => { event.preventDefault(); event.stopPropagation(); onViewReceivingProfile() }}>{physicianInitials(receivingPhysicianName)}</button>
                : <span className="specialty-episode-avatar directory-avatar" aria-hidden="true">{physicianInitials(receivingPhysicianName)}</span>}
              <span className="specialty-episode-title">{referral.specialty} with {onViewReceivingProfile
                ? <button type="button" className="specialty-episode-physician" aria-label={`View ${receivingPhysicianName}'s profile`} onClick={(event) => { event.preventDefault(); event.stopPropagation(); onViewReceivingProfile() }}>{receivingPhysicianName}</button>
                : receivingPhysicianName}</span>
            </span>
            <span className="status-label success">✓ Consultation complete</span>
            <span className="specialty-episode-chevron" aria-hidden="true">{episodeOpen ? '−' : '+'}</span>
          </summary>
          <div className="specialty-episode-detail">
            {handoff?.sent_at && <p className="muted-note">Sent {formatSubmittedAt(handoff.sent_at)}</p>}
            <div className="referral-artifact-links">
              <button type="button" className="text-button" onClick={openHandoff}>View handoff →</button>
              <button type="button" className="text-button" onClick={() => setPacketOpen(true)}>View referral packet →</button>
              <button type="button" className="text-button" onClick={() => setCoordinationOpen(true)}>See agent coordination →</button>
              {scheduling?.status === 'scheduled' && <button type="button" className="text-button" onClick={() => setSchedulingDetailsOpen(true)}>View scheduling details →</button>}
            </div>
            <CoordinationChatCard
              referral={referral}
              patientLabel={patientLabel}
              requestingPhysicianId={referral.referring_physician_id}
              representedPhysicianId={referral.receiving_physician_id}
              representedPhysicianName={receivingPhysicianName}
              representedTone="copper"
              suggestedPrompts={lucySuggestedPrompts(patientLabel, receivingPhysicianName, referral.specialty)}
            />
          </div>
        </details>
      </div>
      {modals}
    </>
  }

  return <>
    <div className="referral-coordination-surface" role="status">
      <div className={`referral-phase ${fading ? 'phase-fading' : ''}`}>
        <PhaseContent phase={visiblePhase} receivingPhysicianName={receivingPhysicianName} patientLabel={patientLabel} scheduling={scheduling} modality={referral?.modality ?? modality} />
      </div>
      {/* Care-routing demo pass, Part F: clinical priority and referral
       * readiness are deliberately shown as two separate labeled values,
       * never combined into one status -- readiness still drives the phase
       * content above on its own; a missing requirement never makes this
       * "Routine", and resolving one never touches priority either. */}
      {referral && <p className="referral-priority-line"><span className="section-label">Clinical priority</span> <PriorityChip priority={referral.priority} /></p>}
      {/* The current-state card stays focused on NOW (demo-consolidation
       * pass, Part 1): a single primary action for whatever the CURRENT phase
       * actually calls for. The historical artifact links live in their own
       * quiet, always-visible section below -- never a generic "Referral
       * details" modal (removed, Part 2): that added an unnecessary click and
       * broken-feeling back/forward navigation. Direct access, no detour. */}
      {status === 'done' && referral && !justCompleted && handoff && <div className="referral-mode-links">
        <button type="button" className="button-primary" onClick={openHandoff}>Review handoff →</button>
      </div>}
      {status === 'done' && referral && !justCompleted && <div className="referral-artifact-links">
        <p className="section-label">Referral details</p>
        <button type="button" className="text-button" onClick={() => setPacketOpen(true)}>View referral packet →</button>
        <button type="button" className="text-button" onClick={() => setCoordinationOpen(true)}>See agent coordination →</button>
        {scheduling?.status === 'scheduled' && <button type="button" className="text-button" onClick={() => setSchedulingDetailsOpen(true)}>View scheduling details →</button>}
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
    </div>
    {/* Active-episode chat is rendered by the PARENT, as a true sibling card
     * of the "Referral to Dr. X" card -- not here (bug-fix pass, Part C).
     * Rendering it inside this component's own returned fragment, even as a
     * JSX sibling of .referral-coordination-surface, still ends up nested
     * inside whatever single bordered wrapper the parent puts around this
     * component's entire output (App.tsx's .best-fit-card.referral-card).
     * The parent has everything it needs to gate this itself (activeReferral
     * + ACCEPTED_OR_LATER_STATUSES, reported via onReferralChange) without
     * duplicating this component's internal state. Once reviewed, chat moves
     * inside the collapsed episode above instead (Part 32) -- never both at
     * once. */}
    {modals}
  </>
}

/**
 * The detailed, scrollable audit trail behind "See agent coordination". Every
 * row is a rendering of a real backend CoordinationEvent -- structured
 * operational facts (what was checked, requested, found, attached), never
 * hidden model chain-of-thought (see Part I).
 */
/**
 * Which physician's agent actually produced this event, if any -- mirrors
 * the backend's own `_correctable_event_owner` (Part 23-28). System events
 * (preflight_completed, referral_ready, ...) are never correctable: no
 * single physician's agent authored them.
 */
function correctableEventOwner(referral: Referral, event: CoordinationEvent): string | null {
  if (event.actor === 'referring_agent') return referral.referring_physician_id
  if (event.actor === 'receiving_agent') return referral.receiving_physician_id
  return null
}

/**
 * A quiet, physician-owned correction mechanic (demo-consolidation pass,
 * Part 23-28): a physician may correct only THEIR OWN agent's events here
 * (Lucy corrects Lucy's agent, Chen corrects Chen's agent, never cross-
 * physician -- enforced again server-side regardless). Saved as a
 * pending_training AgentCorrection, a separate attached artifact -- the
 * original CoordinationEvent audit trail is never mutated. This is
 * intentionally the simple, quiet fallback ("Correct this" per event)
 * rather than a bespoke text-selection popover; an active browser text
 * selection inside the event is still opportunistically captured as
 * `selected_text` when present.
 */
export function AgentCoordinationModal({
  referral, receivingPhysicianName, patientLabel, viewerPhysicianId, onClose,
}: { referral: Referral; receivingPhysicianName: string; patientLabel?: string; viewerPhysicianId: string; onClose: () => void }) {
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => { if (event.key === 'Escape') onClose() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])
  const resolvedCount = referral.coordination_events.filter((event) => event.event_type === 'information_attached').length
  const needsPhysician = referral.coordination_events.some((event) => event.event_type === 'physician_action_required')
  const referringLabel = `${PCP_NAME}'s Agent`

  const [correctingSequence, setCorrectingSequence] = useState<number | null>(null)
  const [correctionSelectedText, setCorrectionSelectedText] = useState('')
  const [correctionText, setCorrectionText] = useState('')
  const [savingCorrection, setSavingCorrection] = useState(false)
  const [correctedSequences, setCorrectedSequences] = useState<Set<number>>(new Set())

  const openCorrection = (sequence: number) => {
    setCorrectionSelectedText(window.getSelection()?.toString().trim() ?? '')
    setCorrectionText('')
    setCorrectingSequence(sequence)
  }
  const saveCorrection = async () => {
    if (correctingSequence == null || !correctionText.trim()) return
    setSavingCorrection(true)
    try {
      await createAgentCorrection(referral.patient_id, viewerPhysicianId, correctionText.trim(), {
        referralId: referral.id ?? undefined,
        sourceEventSequence: correctingSequence,
        selectedText: correctionSelectedText || undefined,
      })
      setCorrectedSequences((previous) => new Set(previous).add(correctingSequence))
      setCorrectingSequence(null)
    } finally {
      setSavingCorrection(false)
    }
  }

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
        {referral.coordination_events.map((event) => {
          const owner = correctableEventOwner(referral, event)
          const correctable = owner != null && owner === viewerPhysicianId
          const corrected = correctedSequences.has(event.sequence)
          return <div className={`coordination-event actor-${event.actor ?? 'system'}`} key={event.sequence}>
            <span className="coordination-actor">{eventActorLabel(event, referringLabel, receivingPhysicianName)}</span>
            <strong>{EVENT_TYPE_TITLES[event.event_type] ?? event.event_type}</strong>
            <p>{event.summary}</p>
            {correctable && corrected && <p className="coordination-correction-saved">✓ Saved for your agent to review. Nothing was changed automatically.</p>}
            {correctable && !corrected && correctingSequence !== event.sequence && <button type="button" className="coordination-correct-trigger" onClick={() => openCorrection(event.sequence)}>Correct this</button>}
            {correctingSequence === event.sequence && <div className="coordination-correction-form">
              <p className="section-label">What should your agent have done or said instead?</p>
              {correctionSelectedText && <p className="coordination-correction-selected">“{correctionSelectedText}”</p>}
              <textarea
                className="feedback-reason-text"
                value={correctionText}
                onChange={(textEvent) => setCorrectionText(textEvent.target.value)}
                autoFocus
              />
              <div className="feedback-reason-actions">
                <button type="button" className="text-button" onClick={() => setCorrectingSequence(null)}>Cancel</button>
                <button type="button" className="button-secondary" disabled={savingCorrection || !correctionText.trim()} onClick={() => void saveCorrection()}>{savingCorrection ? 'Saving…' : 'Save correction'}</button>
              </div>
            </div>}
          </div>
        })}
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
  const cancelledRef = useRef(false)
  useEffect(() => () => { cancelledRef.current = true }, [])
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => { if (event.key === 'Escape' && !sending) onClose() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose, sending])
  const isDraft = handoff.status === 'draft'
  /**
   * `sending` also gates every close path below (X/backdrop/Escape), so a
   * physician can't dismiss the modal mid-request and lose track of whether
   * it went through. It must still clear once the request SETTLES, success
   * or failure -- leaving it stuck `true` after a successful send (a
   * previous bug: only the catch branch reset it) permanently locks the
   * modal closed, since the Send button itself simply disappears once
   * `isDraft` flips to false and no longer offers any way to notice.
   *
   * On a SUCCESSFUL send (demo-consolidation pass, Part 15), the modal also
   * closes itself automatically -- the parent's `onSend` already persisted
   * the sent HandoffSummary and updated its own local state (so the durable
   * "Handoff sent" card is already correct underneath by the time this
   * closes); a FAILED send never closes, leaving the error and the Send
   * button in place to retry.
   */
  const handleSend = async () => {
    if (!onSend) return
    setSending(true); setError('')
    try {
      await onSend()
      if (!cancelledRef.current) onClose()
    } catch (sendError) {
      if (!cancelledRef.current) setError(sendError instanceof Error ? sendError.message : 'Could not send the handoff.')
    } finally {
      if (!cancelledRef.current) setSending(false)
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

/** Lucy's suggested prompts when asking the receiving specialist's agent
 * (ongoing-coordination pass, Part L) -- parameterized by the real patient/
 * physician/specialty rather than hardcoding a single demo patient's name,
 * so the same component works for any future referred patient. Using one
 * never removes it from the list (Part L: "not a checklist"). */
export function lucySuggestedPrompts(patientLabel: string, receivingPhysicianName: string, specialty: string): string[] {
  return [
    `What follow-up did ${receivingPhysicianName} recommend?`,
    `When should ${patientLabel} return to ${specialty}?`,
    `Is there anything else ${receivingPhysicianName} needs from primary care?`,
    `What did the ${specialty} consultation change?`,
    `What should I know before ${patientLabel}'s next follow-up?`,
  ]
}

/** Dr. Chen's suggested prompts when asking the referring physician's agent. */
export function chenSuggestedPrompts(patientLabel: string, referringPhysicianName: string): string[] {
  return [
    'What treatment was tried before referral?',
    `What was ${patientLabel}'s recent clinical trajectory?`,
    'Are there newer primary-care labs available?',
    `What is ${referringPhysicianName} currently managing?`,
    'What was the original referral concern?',
  ]
}

type LocalChatMessage = { id: string; role: 'physician' | 'agent'; content: string; basedOn: string[]; requiresPhysicianInput: boolean }

/**
 * Patient-scoped physician-agent-to-physician-agent coordination chat
 * (demo-consolidation pass, Part 16-21) -- a single shared component for
 * both directions, distinguished only by which physician id is
 * "requesting" vs "represented". Deliberately EPHEMERAL: `messages` is
 * plain component state, never fetched from or written to the backend --
 * the two physicians' interactions are entirely separate and private (Part
 * 16), nothing persists across reload/navigation (Part 17/20), and nothing
 * is stored in localStorage/sessionStorage either. Reuses the existing
 * ChatTab visual language (.chat-thread/.chat-message/.chat-agent-label/
 * .chat-composer) rather than a parallel chat framework (Part O), now in a
 * bounded, scrollable viewport (Part 19) so the rail never grows
 * indefinitely.
 */
export function CoordinationChatCard({
  referral, patientLabel, requestingPhysicianId, representedPhysicianId, representedPhysicianName, representedTone, suggestedPrompts,
}: {
  referral: Referral; patientLabel: string
  requestingPhysicianId: string; representedPhysicianId: string; representedPhysicianName: string
  representedTone: 'blue' | 'copper'; suggestedPrompts: string[]
}) {
  const [messages, setMessages] = useState<LocalChatMessage[]>([])
  const [input, setInput] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [promptsOpen, setPromptsOpen] = useState(false)
  const cancelled = useRef(false)
  const threadRef = useRef<HTMLDivElement>(null)

  // Reset on (re)mount: StrictMode mounts, cleans up, and remounts in dev.
  useEffect(() => { cancelled.current = false; return () => { cancelled.current = true } }, [])

  useEffect(() => {
    if (threadRef.current) threadRef.current.scrollTop = threadRef.current.scrollHeight
  }, [messages, busy])

  const send = async (question: string) => {
    const trimmed = question.trim()
    if (!trimmed || busy || !referral.id) return
    setBusy(true); setError(''); setInput('')
    setMessages((prev) => [...prev, { id: crypto.randomUUID(), role: 'physician', content: trimmed, basedOn: [], requiresPhysicianInput: false }])
    try {
      const result = await askPhysicianAgent(referral.id, requestingPhysicianId, trimmed)
      if (cancelled.current) return
      setMessages((prev) => [...prev, {
        id: crypto.randomUUID(), role: 'agent', content: result.answer,
        basedOn: result.based_on, requiresPhysicianInput: result.requires_physician_input,
      }])
    } catch (sendError) {
      if (!cancelled.current) setError(sendError instanceof Error ? sendError.message : 'Could not reach the agent.')
    } finally {
      if (!cancelled.current) setBusy(false)
    }
  }

  return <section className="coordination-chat-card patient-top-card" aria-label={`Ask ${representedPhysicianName}'s Agent`}>
    <p className="eyebrow">Ask {representedPhysicianName}'s Agent</p>
    {messages.length === 0 && <p className="panel-intro">Ask about {patientLabel}'s referral, consultation, or follow-up.</p>}
    {messages.length > 0 && <div className="chat-thread" role="log" aria-live="polite" ref={threadRef}>
      {messages.map((message) => message.role === 'physician'
        ? <p className="chat-message physician" key={message.id}>{message.content}</p>
        : <div className="chat-message agent" key={message.id}>
          <span className="chat-agent-label"><AgentAvatar tone={representedTone} /> {representedPhysicianName}'s Agent</span>
          <p>{message.content}</p>
          {message.requiresPhysicianInput && <p className="chat-uncertainty">This requires {representedPhysicianName}'s input directly.</p>}
          {message.basedOn.length > 0 && <p className="chat-grounding">Based on: {message.basedOn.join(', ')}</p>}
        </div>)}
      {busy && <div className="chat-message agent typing"><span className="chat-agent-label"><AgentAvatar tone={representedTone} /> {representedPhysicianName}'s Agent</span><p className="chat-typing-dots" aria-label={`${representedPhysicianName}'s Agent is answering`}><span /><span /><span /></p></div>}
    </div>}
    {error && <p className="demo-reset-error" role="alert">{error}</p>}
    <form className="chat-composer" onSubmit={(event) => { event.preventDefault(); void send(input) }}>
      <label htmlFor={`coordination-chat-input-${referral.id}`} className="sr-only">Ask {representedPhysicianName}'s Agent</label>
      <input id={`coordination-chat-input-${referral.id}`} value={input} onChange={(event) => setInput(event.target.value)} placeholder="Ask a question…" disabled={busy} />
      <button className="button-primary" type="submit" disabled={busy || !input.trim()}>Send</button>
    </form>
    <details className="network-optional coordination-chat-prompts" open={promptsOpen} onToggle={(event) => setPromptsOpen(event.currentTarget.open)}>
      <summary className="optional-guidance-label">Suggested prompts ▾</summary>
      <div className="chat-starter-prompts">{suggestedPrompts.map((prompt) => <button key={prompt} type="button" className="chat-starter-prompt" disabled={busy} onClick={() => void send(prompt)}>{prompt}</button>)}</div>
    </details>
  </section>
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

/** Routing consolidation pass, Part I: one row in a specialist's
 * "Patients with next steps" -- a new referral to review is just that
 * patient's current next step, shown with its clinician-defined priority
 * and modality, never in a separate "Needs your review" section. */
function NextStepRows({ items, onOpen }: { items: NextStepItem[]; onOpen: (item: NextStepItem) => void }) {
  return <div className="lam-list patient-worklist next-step-worklist">{items.map((item) => <button key={item.id} className="lam-row next-step-row" onClick={() => onOpen(item)}>
    <span className="lam-row-mark patient-row-avatar">{patientInitials(item.patientId)}</span>
    <span className="lam-row-main">
      <strong>{patientName(item.patientId)}</strong>
      <small className="next-step-meta"><PriorityChip priority={item.priority} /><span className="incoming-request-modality">· {item.modality === 'econsult' ? 'E-consult' : 'Visit'}</span></small>
      <span className="next-step-detail">{item.detail}</span>
    </span>
    <span className="lam-row-action">{item.action} <b>→</b></span>
  </button>)}</div>
}

/** Every next step for Dr. Chen's patients, from real referral state plus
 * his established synthetic panel -- the single source his Dashboard
 * worklist reads. */
function chenNextSteps(
  incoming: Referral[] | null, accepted: Referral[] | null,
  careState: Map<number, { encounter: ConsultationEncounter | null; handoff: HandoffSummary | null }>,
  now: Date,
): NextStepItem[] {
  const referralSteps = (accepted ?? []).map((referral) => {
    const state = (referral.id != null && careState.get(referral.id)) || { encounter: null, handoff: null }
    return acceptedReferralStep(referral, {
      encounterDocumented: Boolean(state.encounter),
      handoffStatus: state.handoff?.status ?? null,
      handoffDraftedAt: state.handoff?.drafted_at ?? null,
    }, now)
  }).filter((item): item is NextStepItem => item !== null)
  return [...(incoming ?? []).map((referral) => referralReviewStep(referral, now, PCP_NAME)), ...referralSteps, ...CHEN_SEEDED_NEXT_STEPS]
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
  const [capacity, setCapacity] = useState<AccessProfile | null>(null)
  const cancelled = useRef(false)
  // Reset on (re)mount: StrictMode mounts, cleans up, and remounts in dev.
  useEffect(() => { cancelled.current = false; return () => { cancelled.current = true } }, [])
  // Routing/triage UX pass, Part T: makes visible that Lamina already
  // triaged this request before Chen ever opens it -- never a numeric
  // acuity score, just the same structured facts the routing UI uses
  // elsewhere. Best-effort/silent if no capacity profile exists.
  useEffect(() => { getPhysicianCapacity(referral.receiving_physician_id).then(setCapacity).catch(() => {}) }, [referral.receiving_physician_id])
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
            <CheckCircleAnimation />
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
            {/* UX polish pass, Part 7A: the redundant resolved-status badge
             * is gone -- this whole modal already IS the review, and the
             * badge only restated that. Part 7B/C/D: the old triage-summary
             * section's blue-boxed treatment is gone too (it read as too
             * heavy for how often it's seen) -- renamed "Routing summary"
             * and presented as calm, cleanly-aligned structured facts, not
             * a filled card. */}
            <section className="routing-summary">
              <p className="section-label">Routing summary</p>
              <p className="recommended-handling-line"><PriorityChip priority={referral.priority} /><span className="incoming-request-modality">· {referral.modality === 'econsult' ? 'E-consult' : 'In-person visit'}</span></p>
              {capacity && <p className="recommended-handling-fact"><span className="section-label">Expected access</span> <strong>{(referral.modality === 'econsult' ? capacity.econsult_response_label : capacity.in_person_wait_label)?.replace('Approximately ', '~')}</strong></p>}
              <p className="recommended-handling-fact"><span className="section-label">Referral packet</span> <strong>Complete</strong></p>
              {resolvedCount > 0 && <p className="muted-note">{resolvedSummary(resolvedCount)}</p>}
            </section>

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
    {coordinationOpen && <AgentCoordinationModal referral={referral} receivingPhysicianName={receivingPhysicianName} patientLabel={patientLabel} viewerPhysicianId={referral.receiving_physician_id} onClose={() => setCoordinationOpen(false)} />}
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

/** Set right before navigating away from a just-accepted referral (Part G),
 * read and immediately cleared on the very next mount of ChenDownstreamCard
 * for that same patient -- a pure "this session caused it" presentation
 * signal, never persisted business state (Part N: a plain reload finds it
 * already gone, so the intro sequence never replays). */
const CHEN_JUST_ACCEPTED_KEY = 'lamina:chen:just-accepted-referral'

export function markReferralJustAccepted(patientId: string) {
  try { window.sessionStorage.setItem(CHEN_JUST_ACCEPTED_KEY, patientId) } catch { /* ignore */ }
}

/** The same established one-shot-per-session presentation pattern as
 * markReferralJustAccepted/consumeJustAcceptedFlag above, reused for Lucy's
 * post-consult medication-change highlight (demo-story pass, Part J-M) --
 * keyed by encounter id so a later, different documented encounter would
 * highlight again. Lives here (not in App.tsx) because this file already
 * owns the one place sessionStorage is used for ephemeral presentation
 * state; App.tsx itself must never read/write browser storage directly
 * (membership and every other real workspace fact stays canonical backend
 * state -- see the network-membership invariant this mirrors). Returns
 * `true` exactly once per encounter id per session. */
export function consumeMedicationHighlightFlag(encounterId: number): boolean {
  const key = `lamina:lucy:medication-highlight:${encounterId}`
  try {
    if (window.sessionStorage.getItem(key)) return false
    window.sessionStorage.setItem(key, '1')
    return true
  } catch {
    return false
  }
}

function consumeJustAcceptedFlag(patientId: string): boolean {
  try {
    const stored = window.sessionStorage.getItem(CHEN_JUST_ACCEPTED_KEY)
    if (stored !== patientId) return false
    window.sessionStorage.removeItem(CHEN_JUST_ACCEPTED_KEY)
    return true
  } catch {
    return false
  }
}

type ChenIntroPhase = 'accepted' | 'checking' | 'routing' | null

/**
 * Dr. Chen's right-rail surface for an ACCEPTED referral (automation pass,
 * Parts E-L): entirely state-driven from the real persisted artifacts,
 * never a replayed animation on hydration. Acceptance itself already
 * authorizes everything through scheduling (Part E/F) -- the backend
 * executes that chain synchronously inside /accept, so there is no manual
 * "Find appointment options"/"Send to scheduling" step left here; the only
 * remaining physician decision downstream of acceptance is reviewing and
 * explicitly sending the (auto-drafted) clinical handoff (Part J/M). The
 * brief "accepted -> checking -> routing -> scheduled" intro (Part G) is
 * pure frontend presentation pacing played once, only in the same session
 * that just performed the accept action (see consumeJustAcceptedFlag) --
 * never replayed on reload, and skipped entirely under reduced motion.
 */
export function ChenDownstreamCard({ referral, patientLabel }: { referral: Referral; patientLabel: string }) {
  const [scheduling, setScheduling] = useState<SchedulingCoordination | null | undefined>(undefined)
  const [encounter, setEncounter] = useState<ConsultationEncounter | null | undefined>(undefined)
  const [handoff, setHandoff] = useState<HandoffSummary | null | undefined>(undefined)
  const [schedulingDetailsOpen, setSchedulingDetailsOpen] = useState(false)
  const [handoffOpen, setHandoffOpen] = useState(false)
  const [coordinationOpen, setCoordinationOpen] = useState(false)
  const [liveReferral, setLiveReferral] = useState(referral)
  const [introPhase, setIntroPhase] = useState<ChenIntroPhase>(null)
  const [justAccepted] = useState(() => consumeJustAcceptedFlag(referral.patient_id))
  const [capacity, setCapacity] = useState<AccessProfile | null>(null)
  const cancelled = useRef(false)

  // Reset on (re)mount: StrictMode mounts, cleans up, and remounts in dev.
  useEffect(() => { cancelled.current = false; return () => { cancelled.current = true } }, [])
  // Routing/triage UX pass, Part U/V: the "finding an appointment" intro
  // phases below surface the SAME expected-access fact the routing UI uses
  // elsewhere -- triage already decided priority/modality/access band;
  // scheduling only ever resolves the exact slot, never recalculates
  // priority (Part W). Best-effort/silent if no capacity profile exists.
  useEffect(() => { getPhysicianCapacity(referral.receiving_physician_id).then(setCapacity).catch(() => {}) }, [referral.receiving_physician_id])

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

  const sleep = (ms: number) => new Promise<void>((resolve) => window.setTimeout(resolve, ms))

  // Live-session-only presentation (Part G/N): once the real (already
  // backend-complete) data has loaded, briefly narrate the administrative
  // steps that already happened before landing on the durable state below.
  // Never runs on a restored/hydrated view, and never under reduced motion.
  useEffect(() => {
    if (!justAccepted || scheduling === undefined || prefersReducedMotion()) return
    let active = true
    const play = async () => {
      setIntroPhase('accepted'); await sleep(1100)
      if (!active || cancelled.current) return
      setIntroPhase('checking'); await sleep(1700)
      if (!active || cancelled.current) return
      setIntroPhase('routing'); await sleep(1300)
      if (!active || cancelled.current) return
      setIntroPhase(null)
    }
    void play()
    return () => { active = false }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [justAccepted, scheduling === undefined])

  const sendTheHandoff = async () => {
    if (!referral.id) return
    const result = await sendHandoff(referral.id, CHEN_ID)
    setLiveReferral(result.referral)
    setHandoff(result.handoff)
  }

  if (scheduling === undefined || encounter === undefined || handoff === undefined) {
    return <div className="next-step-card idle"><p className="muted-note">Opening referral…</p></div>
  }

  if (introPhase === 'accepted') return <div className="next-step-card ready">
    <span className="status-label resolved"><span className="spark-icon lead" aria-hidden="true">✓</span>Referral accepted</span>
    <h3>You accepted {patientLabel}'s referral.</h3>
  </div>

  // UX polish pass, Part 3A: an e-consult route has no visit to find -- the
  // intro narrates preparing a response instead, and reads the
  // e-consult-specific access fact rather than the in-person one.
  const accessLabel = (referral.modality === 'econsult' ? capacity?.econsult_response_label : capacity?.in_person_wait_label)?.replace('Approximately ', '~')
  if (introPhase === 'checking') return <div className="next-step-card consulting">
    <span className="status-label pulse"><span className="spark-icon lead" aria-hidden="true">✧</span>{referral.modality === 'econsult' ? 'Preparing e-consult response' : 'Finding an appointment'}</span>
    <h3>{referral.modality === 'econsult' ? 'Preparing an e-consult response.' : `Looking for the earliest appropriate ${CHEN_SPECIALTY} visit.`}</h3>
    <p className="recommended-handling-line"><PriorityChip priority={referral.priority} />{accessLabel && <span className="incoming-request-modality">· Expected within {accessLabel}</span>}</p>
  </div>

  if (introPhase === 'routing') return <div className="next-step-card consulting">
    <span className="status-label pulse"><span className="spark-icon lead" aria-hidden="true">✧</span>{referral.modality === 'econsult' ? 'Preparing e-consult response' : 'Finding an appointment'}</span>
    <h3>{referral.modality === 'econsult' ? 'Confirming the e-consult request.' : 'Confirming the visit with the scheduling workflow.'}</h3>
    <p className="recommended-handling-line"><PriorityChip priority={referral.priority} />{accessLabel && <span className="incoming-request-modality">· Expected within {accessLabel}</span>}</p>
  </div>

  const links = <div className="referral-mode-links">
    <button type="button" className="text-button" onClick={() => setCoordinationOpen(true)}>View referral history →</button>
  </div>

  // Symmetric cross-physician chat (Part H/S) -- available from acceptance
  // through every downstream state (Part R), computed once and appended to
  // every settled durable-state branch below.
  const chatCard = referral.id && <CoordinationChatCard
    referral={referral}
    patientLabel={patientLabel}
    requestingPhysicianId={referral.receiving_physician_id}
    representedPhysicianId={referral.referring_physician_id}
    representedPhysicianName={PCP_NAME}
    representedTone="blue"
    suggestedPrompts={chenSuggestedPrompts(patientLabel, PCP_NAME)}
  />

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
    {chatCard}
    {handoffOpen && <HandoffModal handoff={handoff} patientLabel={patientLabel} receivingPhysicianName={CHEN_NAME} onClose={() => setHandoffOpen(false)} />}
    {coordinationOpen && <AgentCoordinationModal referral={liveReferral} receivingPhysicianName={CHEN_NAME} patientLabel={patientLabel} viewerPhysicianId={liveReferral.receiving_physician_id} onClose={() => setCoordinationOpen(false)} />}
  </>

  // Handoff drafting is itself automatic once a documented encounter exists
  // (Part I/K) -- the clinical source already exists and the agent is only
  // summarizing it, so there is no "Draft handoff" click here; the one
  // remaining physician decision is reviewing and explicitly sending it
  // (Part J/M), via HandoffModal's onSend.
  if (handoff && handoff.status === 'draft') return <>
    <div className="next-step-card ready">
      <span className="status-label resolved"><span className="spark-icon lead" aria-hidden="true">✓</span>Handoff ready for review</span>
      <h3>Your agent prepared an update for Dr. Saruhashi from the documented consultation.</h3>
      <button type="button" className="button-primary" onClick={() => setHandoffOpen(true)}>Review &amp; send →</button>
      {links}
    </div>
    {chatCard}
    {handoffOpen && <HandoffModal handoff={handoff} patientLabel={patientLabel} receivingPhysicianName={CHEN_NAME} onClose={() => setHandoffOpen(false)} onSend={sendTheHandoff} />}
    {coordinationOpen && <AgentCoordinationModal referral={liveReferral} receivingPhysicianName={CHEN_NAME} patientLabel={patientLabel} viewerPhysicianId={liveReferral.receiving_physician_id} onClose={() => setCoordinationOpen(false)} />}
  </>

  // Documented-but-not-yet-drafted is a defensive fallback only (Part I/K
  // auto-drafts inside the same backend call that ingests the encounter) --
  // never a manual "Draft handoff" button; informational text, no action.
  if (encounter && !handoff) return <>
    <div className="next-step-card ready">
      <span className="status-label resolved"><span className="spark-icon lead" aria-hidden="true">✓</span>Consultation documented</span>
      <h3>{patientLabel}'s {encounter.specialty} visit is available in the record.</h3>
      <p>Your agent is preparing an update for Dr. Saruhashi.</p>
      {links}
    </div>
    {chatCard}
    {coordinationOpen && <AgentCoordinationModal referral={liveReferral} receivingPhysicianName={CHEN_NAME} patientLabel={patientLabel} viewerPhysicianId={liveReferral.receiving_physician_id} onClose={() => setCoordinationOpen(false)} />}
  </>

  if (scheduling && scheduling.status === 'scheduled') {
    // UX polish pass, Part 3A: the backend's scheduling pipeline still runs
    // unconditionally behind an e-consult acceptance too (Part AC: no full
    // e-consult workflow this pass), but its synthetic appointment TIME
    // describes a visit slot that was never actually requested here -- this
    // branch never surfaces it, showing the e-consult-coherent facts
    // (priority, expected response) instead.
    if (referral.modality === 'econsult') return <>
      <div className="next-step-card ready">
        <span className="status-label resolved"><span className="spark-icon lead" aria-hidden="true">✓</span>E-consult sent</span>
        <h3>E-consult request sent</h3>
        <p>{CHEN_NAME} will respond asynchronously.</p>
        <p className="recommended-handling-line"><PriorityChip priority={referral.priority} />{capacity?.econsult_response_label && <span className="incoming-request-modality">· Expected within {capacity.econsult_response_label.replace('Approximately ', '~')}</span>}</p>
        <div className="referral-mode-links">
          <button type="button" className="text-button" onClick={() => setCoordinationOpen(true)}>View referral history →</button>
        </div>
      </div>
      {chatCard}
      {coordinationOpen && <AgentCoordinationModal referral={liveReferral} receivingPhysicianName={CHEN_NAME} patientLabel={patientLabel} viewerPhysicianId={liveReferral.receiving_physician_id} onClose={() => setCoordinationOpen(false)} />}
    </>
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
      {chatCard}
      {schedulingDetailsOpen && <SchedulingDetailsModal scheduling={scheduling} receivingPhysicianName={CHEN_NAME} onClose={() => setSchedulingDetailsOpen(false)} />}
      {coordinationOpen && <AgentCoordinationModal referral={liveReferral} receivingPhysicianName={CHEN_NAME} patientLabel={patientLabel} viewerPhysicianId={liveReferral.receiving_physician_id} onClose={() => setCoordinationOpen(false)} />}
    </>
  }

  // Everything past this point is a defensive fallback only -- under normal
  // operation, acceptance's automatic chain (Part E/F) always reaches
  // `scheduled` synchronously, so scheduling is never actually observed
  // sitting at options_ready/sent_to_scheduling, or null, once Chen views
  // this page. Informational only, never a manual trigger button.
  return <>
    <div className="next-step-card idle">
      <span className="status-label resolved"><span className="spark-icon lead" aria-hidden="true">✓</span>Accepted</span>
      <h3>Referred by {PCP_NAME}.</h3>
      <p className="section-label">Referral question</p>
      <p>{referral.referral_question}</p>
      <p>Scheduling administration is in progress.</p>
    </div>
    {chatCard}
    {coordinationOpen && <AgentCoordinationModal referral={liveReferral} receivingPhysicianName={CHEN_NAME} patientLabel={patientLabel} viewerPhysicianId={liveReferral.receiving_physician_id} onClose={() => setCoordinationOpen(false)} />}
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
export const ACCEPTED_OR_LATER_STATUSES: ReferralStatus[] = ['accepted', 'scheduled', 'consult_returned']

/** The patient's real CARE STATE drives the badge (ongoing-coordination
 * pass, Part A) -- a handoff is a communication artifact describing that
 * care, never a replacement for it, so its existence only ever changes the
 * row ACTION ("Review handoff"/"View handoff"), never the badge label once
 * a documented encounter exists. Derived from the real persisted artifacts
 * (Referral/ConsultationEncounter/HandoffSummary), never special-cased by
 * patient id -- works identically for any future referred patient. */
export function chenPatientRowStatus(
  referral: Referral, encounter: ConsultationEncounter | null, handoff: HandoffSummary | null,
): { label: string; nextStep: string } {
  if (encounter) {
    if (handoff?.status === 'sent') return { label: 'Consultation complete', nextStep: 'View handoff' }
    if (handoff?.status === 'draft') return { label: 'Consultation complete', nextStep: 'Review handoff' }
    return { label: 'Consultation complete', nextStep: 'Open patient' }
  }
  if (referral.status === 'scheduled' || referral.status === 'consult_returned') return { label: 'Scheduled', nextStep: 'Open patient' }
  return { label: 'Referral accepted', nextStep: 'Open patient' }
}

export function ChenPatientsPage({ navigate, params }: { navigate: Navigate; params?: URLSearchParams }) {
  const [query, setQuery] = useState('')
  const [incoming, setIncoming] = useState<Referral[] | null>(null)
  const [accepted, setAccepted] = useState<Referral[] | null>(null)
  const [careState, setCareState] = useState<Map<number, { encounter: ConsultationEncounter | null; handoff: HandoffSummary | null }>>(new Map())
  const [error, setError] = useState('')
  const [reviewing, setReviewing] = useState<Referral | null>(null)
  // Routing/triage UX polish pass, Part 5C: a purely presentational,
  // briefly-applied highlight for whichever patients the Dashboard's
  // "Recent activity" auto-routing item pointed at -- never changes which
  // patients are shown, sorted, or how long they stay (demo-friendly, not a
  // persisted notification).
  const [highlighted, setHighlighted] = useState<Set<string>>(new Set())
  useEffect(() => {
    const ids = (params?.get('highlight') ?? '').split(',').filter(Boolean)
    if (ids.length === 0) return
    setHighlighted(new Set(ids))
    const timer = window.setTimeout(() => setHighlighted(new Set()), 2600)
    return () => window.clearTimeout(timer)
  }, [params])

  /** A real backend query for "every referral in my care, however far along
   * it is" -- never a single fixed status (Part 2 fix: ?status=accepted
   * alone silently dropped a referral the moment it progressed past
   * acceptance). Filtering down to the known active-care statuses, rather
   * than just "not submitted," is deliberate: a future terminal/archival
   * status is excluded by default instead of leaking in silently. Each
   * accepted-or-later referral also gets its real encounter/handoff fetched
   * (Part A) -- the badge is never derived from referral.status alone. */
  const load = () => Promise.all([
    getPhysicianReferrals(CHEN_ID, 'submitted'),
    getPhysicianReferrals(CHEN_ID),
  ]).then(async ([submitted, all]) => {
    setIncoming(submitted)
    const activeReferrals = all.filter((referral) => ACCEPTED_OR_LATER_STATUSES.includes(referral.status))
    setAccepted(activeReferrals)
    const entries = await Promise.all(activeReferrals.map(async (referral) => {
      if (!referral.id) return null
      const [encounter, handoff] = await Promise.all([getEncounter(referral.id), getHandoff(referral.id, CHEN_ID)])
      return [referral.id, { encounter, handoff }] as const
    }))
    setCareState(new Map(entries.filter((entry): entry is readonly [number, { encounter: ConsultationEncounter | null; handoff: HandoffSummary | null }] => entry !== null)))
  }).catch((loadError: Error) => setError(loadError.message))

  useEffect(() => { void load() }, [])

  const handleAccepted = (updated: Referral) => {
    setReviewing(null)
    setIncoming((current) => current?.filter((item) => item.id !== updated.id) ?? current)
    markReferralJustAccepted(updated.patient_id)
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
      const state = (referral.id && careState.get(referral.id)) || { encounter: null, handoff: null }
      const { label, nextStep } = chenPatientRowStatus(referral, state.encounter, state.handoff)
      return { patient, label, tone: 'copper', nextStep, priority: -1, updated: null }
    })
    .filter((row): row is WorklistRowData => row !== null)
  // Routing consolidation pass, Part I: an incoming referral is simply that
  // patient's current next step -- a row in the same list, opening the
  // review in place, never a separate "Needs your review" control.
  const incomingRows: WorklistRowData[] = (incoming ?? [])
    .map((referral): WorklistRowData | null => {
      const patient = DEMO_PATIENTS.find((item) => item.id === referral.patient_id)
      if (!patient || `${patient.name} ${patient.reason}`.toLowerCase().includes(query.toLowerCase()) === false) return null
      return { patient, label: 'New referral', tone: 'copper', nextStep: 'Review referral', priority: -3, updated: null, onOpen: () => setReviewing(referral) }
    })
    .filter((row): row is WorklistRowData => row !== null)
  const rows = [...incomingRows, ...acceptedRows, ...seededRows].sort((a, b) => a.priority - b.priority)
  const active = rows.filter((row) => row.priority < CHEN_PREVIOUS_CARE_PRIORITY)
  const previous = rows.filter((row) => row.priority >= CHEN_PREVIOUS_CARE_PRIORITY)

  return <main className="page-shell selector-page">
    <header className="selector-header">
      <div><p className="eyebrow">Specialist patients</p><h1>Patients</h1><p>People in your active care, including new referrals awaiting your review.</p></div>
    </header>
    <label className="patient-search"><svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="11" cy="11" r="6" /><path d="m16 16 4 4" /></svg><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search patients or clinical problem…" aria-label="Search patients" /></label>
    {error && <div className="error-banner" role="alert">{error}</div>}
    {active.length > 0 && <section className="patient-worklist-section">
      <div className="home-section-heading"><h2>Active patients</h2><span>{active.length}</span></div>
      <WorklistRows rows={active} navigate={navigate} basePath="/chen/patients" highlightIds={highlighted} />
    </section>}
    {previous.length > 0 && <section className="patient-worklist-section">
      <div className="home-section-heading"><h2>Previous care</h2><span>{previous.length}</span></div>
      <WorklistRows rows={previous} navigate={navigate} basePath="/chen/patients" highlightIds={highlighted} />
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
 *
 * Bug-fix pass (demo-story pass, Part A/B/C): the Dashboard's "Patients"
 * worklist used to be built ONLY from the static seeded roster
 * (CHEN_SEEDED_PATIENTS) -- it had no idea an accepted referral existed at
 * all, so a patient with a documented consultation and a draft handoff
 * still awaiting review (one of the most important outstanding actions in
 * the whole demo) never appeared here, even though the full Patients page
 * already modeled this correctly via chenPatientRowStatus/careState. This
 * now merges in every accepted-or-later referral the exact same way
 * ChenPatientsPage does, and ranks a pending "Review handoff" above
 * everything else -- but once it's sent, that referral-derived row returns
 * to ordinary priority and can fall off the top-3 Dashboard slice just like
 * any other patient (Part C: Dashboard presence is driven by outstanding
 * action/relevance, never a permanent-residency guarantee).
 */
/**
 * Routing/triage UX pass, Part X/Y (polish pass, Part 5D): two restrained,
 * read-only capacity cards -- the two real capacity LANES, visits and
 * e-consults. Urgent review was removed as a third card (polish pass, Part
 * 5D) -- it read as an equal-weight third queue rather than the exceptional
 * physician-review escalation path it actually is; that distinction now
 * lives only in copy elsewhere (Needs your review), not as its own capacity
 * tile. Reuses the exact same structured AccessProfile the routing/match-
 * details UI already reads (Part B/K) -- no second, independently-
 * maintained source. Currently only meaningful for Chen; renders nothing if
 * no capacity profile exists. No shadows, no KPI/metric-dashboard styling.
 */
function ChenCapacityCards() {
  const [capacity, setCapacity] = useState<AccessProfile | null>(null)
  useEffect(() => { getPhysicianCapacity(CHEN_ID).then(setCapacity).catch(() => {}) }, [])
  if (!capacity) return null
  return <section className="care-capacity-cards">
    <p className="section-label">Care capacity</p>
    <div className="care-capacity-grid">
      <div className="care-capacity-card">
        <p className="care-capacity-card-label">Visits</p>
        <p className="care-capacity-card-value">Next appropriate opening</p>
        <p className="care-capacity-card-detail">{capacity.in_person_wait_label.replace('Approximately ', '~')}</p>
      </div>
      <div className="care-capacity-card">
        <p className="care-capacity-card-label">E-consults</p>
        <p className="care-capacity-card-value">Typical response</p>
        <p className="care-capacity-card-detail">{capacity.econsult_available ? (capacity.econsult_response_label ?? 'Available').replace('Approximately ', '~') : 'Not enabled'}</p>
      </div>
    </div>
  </section>
}

/** Routing/triage UX pass, Part Z (polish pass, Part 5A/B): the three
 * synthetic auto-routed requests that used to be their own standalone
 * "Recent routing activity" block are now a single item inside the
 * Dashboard's ordinary Recent activity feed instead -- a dedicated
 * dashboard-middle surface overstated how much was happening; folding it
 * into Recent activity says the same thing ("routine demand moves in the
 * background without Chen's manual sorting") at the right visual weight.
 * Because cross-agent coordination detail is never exposed to the other
 * physician (the Witness-style boundary this demo already keeps for agent
 * chat), clicking through does something useful but partial: it opens
 * Patients and briefly highlights the affected patients, rather than
 * opening a detail view of the coordination itself. Deliberately
 * static/synthetic (no backing workflow for these three requests is
 * needed, Part Z). */
export const CHEN_AUTO_ROUTED_PATIENT_IDS = ['patient-chen-robert-004', 'patient-chen-aisha-005', 'patient-chen-maya-003']

export function ChenHomePage({ navigate }: { navigate: Navigate }) {
  const [incoming, setIncoming] = useState<Referral[] | null>(null)
  const [accepted, setAccepted] = useState<Referral[] | null>(null)
  const [careState, setCareState] = useState<Map<number, { encounter: ConsultationEncounter | null; handoff: HandoffSummary | null }>>(new Map())
  const [overview, setOverview] = useState<AgentOverview | null>(null)
  const [feed, setFeed] = useState<NetworkFeed | null>(null)
  const [reviewing, setReviewing] = useState<Referral | null>(null)
  const [error, setError] = useState('')

  useEffect(() => {
    Promise.all([
      getPhysicianReferrals(CHEN_ID, 'submitted'),
      getPhysicianReferrals(CHEN_ID),
    ]).then(async ([submitted, all]) => {
      setIncoming(submitted)
      const activeReferrals = all.filter((referral) => ACCEPTED_OR_LATER_STATUSES.includes(referral.status))
      setAccepted(activeReferrals)
      const entries = await Promise.all(activeReferrals.map(async (referral) => {
        if (!referral.id) return null
        const [encounter, handoff] = await Promise.all([getEncounter(referral.id), getHandoff(referral.id, CHEN_ID)])
        return [referral.id, { encounter, handoff }] as const
      }))
      setCareState(new Map(entries.filter((entry): entry is readonly [number, { encounter: ConsultationEncounter | null; handoff: HandoffSummary | null }] => entry !== null)))
    }).catch((err: Error) => setError(err.message))
    getAgentOverview('chen').then(setOverview).catch(() => {})
    getNetworkFeed('chen').then(setFeed).catch(() => {})
  }, [])

  const handleAccepted = (updated: Referral) => {
    setReviewing(null)
    setIncoming((current) => current?.filter((item) => item.id !== updated.id) ?? current)
    markReferralJustAccepted(updated.patient_id)
    navigate(`/chen/patients/${updated.patient_id}`)
  }

  const greetingName = `Dr. ${CHEN_NAME.split(' ').at(-1)}`
  /** Routing consolidation pass, Part I-M: ONE "Patients with next steps"
   * worklist. The top three are the next steps most deserving Dr. Chen's
   * attention now (specialistWorklist.ts: physician judgment required,
   * readiness, time remaining to a modality-specific service target, then
   * clinician-defined priority) -- not newest-first, not static priority
   * alone. Agent/staff-resolvable steps never take a top slot. */
  const steps = incoming === null ? [] : chenNextSteps(incoming, accepted, careState, new Date())
  const topSteps = topAttention(steps)
  const physicianSteps = attentionOrder(steps)
  const agentHandledCount = handledByAgentOrStaff(steps).length
  const situationSummary = physicianSteps.length > 0
    ? `${physicianSteps.length} patient${physicianSteps.length === 1 ? ' has a next step' : 's have next steps'} that need${physicianSteps.length === 1 ? 's' : ''} you.`
    : null
  const openStep = (item: NextStepItem) => {
    const referral = item.kind === 'review_referral' ? incoming?.find((candidate) => candidate.id === item.referralId) : undefined
    if (referral) setReviewing(referral)
    else navigate(`/chen/patients/${item.patientId}`)
  }

  return <main className="page-shell home-page dashboard-page">
    <header className="dashboard-greeting"><p className="eyebrow">Dashboard</p><h1>{timeAwareGreeting(greetingName)}</h1>{situationSummary && <p className="dashboard-situation">{situationSummary}</p>}</header>
    {error && <div className="error-banner" role="alert">Recent workspace activity is temporarily unavailable. Patient records remain accessible.</div>}
    <HomeAgentCard overview={overview} navigate={navigate} trainPath={trainingPath('chen')} viewAgentPath="/chen/agent?tab=overview" />
    {topSteps.length > 0 && <section className="patient-worklist-section">
      <div className="home-section-heading"><div><h2>Patients with next steps</h2><p className="dashboard-watchlist-sub">Ordered by clinical timing and service targets.</p></div><button className="text-button" onClick={() => navigate('/chen/patients')}>View all patients →</button></div>
      <NextStepRows items={topSteps} onOpen={openStep} />
      {agentHandledCount > 0 && <p className="next-step-agent-note">{agentHandledCount} administrative step{agentHandledCount === 1 ? ' is' : 's are'} being handled by your agent and staff.</p>}
    </section>}
    <ChenCapacityCards />
    <div className="dashboard-bottom-row">
      {/* Follow-up pass, Part L-Q: TWO separate activity entries, never
       * conflated -- Lucy/Chen agent coordination around Tonjit's referral
       * is its own real event; the synthetic auto-routed-demand summary is
       * a different, unrelated kind of event (Part 5B/C from the prior
       * pass: one entry among Chen's real agent activity, at ordinary
       * weight, not its own standalone dashboard-middle block). Order is
       * the Tonjit coordination first (most recent for this demo), then
       * the auto-routing summary (Part O). */}
      <section className="home-activity">
        <div className="home-section-heading"><div><h2>Recent activity</h2></div></div>
        <div className="activity-stream">
          {/* Witness-architecture boundary (Part M/Q): this must never open
           * the ephemeral cross-agent chat/task transcript -- it may only
           * navigate to an already-authorized, real destination (Tonjit's
           * own patient record, which Chen is independently allowed to
           * open), never reveal the private coordination context itself. */}
          <button
            key="saruhashi-coordination"
            className="activity-row interaction"
            onClick={() => navigate(`/chen/patients/${TONJIT_ID}`)}
          >
            <span className="activity-marker interaction" />
            <span>
              <em className="activity-kind agent-event-label">Agent</em>
              <strong>Your agent coordinated with Dr. Saruhashi's agent</strong>
              <small>{patientName(TONJIT_ID)} · Endocrinology referral</small>
            </span>
            <b>View patient →</b>
          </button>
          <button
            key="auto-routing"
            className="activity-row interaction"
            onClick={() => navigate(`/chen/patients?highlight=${CHEN_AUTO_ROUTED_PATIENT_IDS.join(',')}`)}
          >
            <span className="activity-marker interaction" />
            <span>
              <em className="activity-kind agent-event-label">Agent</em>
              <strong>3 requests routed automatically</strong>
              <small>2 visits · 1 e-consult</small>
            </span>
            <b>View patients →</b>
          </button>
        </div>
      </section>
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
      {tab === 'overview' && <AgentOverviewPanel overview={overview} representation={representation} navigate={navigate} trainPath={trainingPath('chen')} personaId="chen" onRepresentationChanged={() => { getAgentOverview('chen').then(setOverview).catch(() => {}); getPracticeRepresentation('chen').then(setRepresentation).catch(() => {}) }} />}
      {tab === 'train' && <TrainTab trainProjection={trainProjection} navigate={navigate} trainPath={trainingPath('chen')} personaId="chen" learningOpportunities={overview.learning_opportunities} focusId={params?.get('focus') ?? null} onLearningChanged={() => getAgentOverview('chen').then(setOverview).catch(() => {})} />}
      {tab === 'test' && <ChatTab personaId="chen" agentName={agentName} navigate={navigate} trainPath={trainingPath('chen')} />}
    </>}
  </main>
}

