import { useEffect, useRef, useState, type ReactNode } from 'react'
import {
  ApiError,
  answerTrainingQuestion,
  chatWithAgent,
  completeTrainingReview,
  createPracticeUpdate,
  createProfessionalPost,
  dismissPracticeUpdate,
  dismissProfessionalPost,
  draftProfessionalPost,
  editPracticeUpdate,
  editProfessionalPost,
  enrichPhysicianProfile,
  finishTrainingSession,
  getAgentInitialization,
  getAgentOverview,
  getAgentTestCases,
  getNetworkFeed,
  getNetworkPhysicianProfile,
  getPhysicianInterests,
  getPhysicianTraining,
  getPhysicianUpdates,
  getProfessionalPosts,
  getProfessionalProfile,
  getProfileEnrichment,
  getTrainingHistory,
  publishPracticeUpdate,
  publishProfessionalPost,
  resumeTrainingSession,
  reviewProfileCandidate,
  savePhysicianInterest,
  startFocusedTraining,
  startTrainingSession,
  submitAgentChatFeedback,
  updateProfessionalProfileItem,
  updateProposedLearning,
  type AgentChatResponse,
  type AgentInitialization,
  type AgentOverview,
  type AgentTestCase,
  type ConsultationRecord,
  type DemoPhysicianPerspective,
  type FocusedTrainingSeed,
  type NetworkFeed,
  type NetworkFeedItem,
  type PhysicianIdentity,
  type PhysicianInterest,
  type PhysicianInterestType,
  type PostType,
  type PracticeRepresentation,
  type PracticeUpdate,
  type PracticeUpdateType,
  type ProfessionalPost,
  type ProfessionalProfile,
  type ProfileCandidateFact,
  type ProfileCategory,
  type ProfileEnrichmentJob,
  type ProfileItem,
  type ProposedLearning,
  type TrainingCompletionSummary,
  type TrainingHistoryEntry,
  type TrainingQuestion,
  type TrainingResponse,
  type TrainingSession,
  type TrainProjection,
} from './api.ts'
import { cleanName, patientName } from './demoIdentity.ts'
import { LaminaMark } from './LaminaMark.tsx'
import { AgentAvatar } from './AgentAvatar.tsx'

type Navigate = (path: string) => void

function NetworkMark({ active = false, resolved = false }: { active?: boolean; resolved?: boolean }) {
  return <LaminaMark active={active} resolved={resolved} />
}

const prefersReducedMotion = () => window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false

/** Calm relative-day label for training/activity timestamps, e.g. "today", "yesterday", "Oct 3". */
function relativeDayLabel(value: string) {
  const date = new Date(value)
  const now = new Date()
  const startOf = (item: Date) => new Date(item.getFullYear(), item.getMonth(), item.getDate()).getTime()
  const diffDays = Math.round((startOf(now) - startOf(date)) / 86400000)
  if (diffDays === 0) return 'today'
  if (diffDays === 1) return 'yesterday'
  return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
}

/* -------------------------------------------------------------------- paths */

export const trainingPath = (perspective: PhysicianIdentity) => (perspective === 'iain' ? '/specialist/agent/train' : perspective === 'owner' ? '/me/agent/train' : '/agent/train')
export const professionalProfilePath = (perspective: DemoPhysicianPerspective) => (perspective === 'iain' ? '/specialist/profile' : '/profile')
export const networkProfilePath = (perspective: DemoPhysicianPerspective, controlledId: string) => (perspective === 'iain' ? `/specialist/network/profile/${controlledId}` : `/network/profile/${controlledId}`)
export const networkUpdatesPath = (perspective: DemoPhysicianPerspective) => (perspective === 'iain' ? '/specialist/network?tab=feed' : '/network?tab=feed')
export const networkPath = (perspective: DemoPhysicianPerspective) => (perspective === 'iain' ? '/specialist/network' : '/network')
export const settingsPath = '/settings'

/* ------------------------------------------------------------- Home: engagement */

/**
 * Maps the canonical TrainProjection directly to the agent banner's CTA and supporting
 * line. Only `.state`/`.action`/`.active_session_id`/`.review_session_id`/
 * `.answered_count`/`.answer_target` are read — never independently inferred (e.g. never
 * "unfinished", never guessing resume vs start from answered_count alone). Counts describe
 * *this* session only — never a finite completion percentage for the open-ended
 * representation as a whole.
 */
function agentBannerPlan(training: TrainProjection, trainPath: string): { label: string; href: string; support: string } | null {
  const activeId = training.active_session_id
  const reviewId = training.review_session_id
  const target = training.answer_target ?? 10
  const remaining = Math.max(1, target - training.answered_count)
  if (training.action === 'continue_setup') {
    return { label: 'Continue setup', href: `${trainPath}?mode=initialization`, support: "Let's build your agent's starting picture of your practice." }
  }
  if (training.action === 'resume_training' && activeId) {
    return { label: `Answer ${remaining} question${remaining === 1 ? '' : 's'}`, href: `${trainPath}?resume=${activeId}`, support: `${remaining} quick question${remaining === 1 ? '' : 's'} ${remaining === 1 ? 'is' : 'are'} ready.` }
  }
  if (training.action === 'start_training' && activeId) {
    return { label: `Answer ${target} question${target === 1 ? '' : 's'}`, href: `${trainPath}?resume=${activeId}`, support: `${target} quick question${target === 1 ? '' : 's'} ${target === 1 ? 'is' : 'are'} ready.` }
  }
  if (training.action === 'start_training') {
    return { label: `Answer ${target} question${target === 1 ? '' : 's'}`, href: `${trainPath}?mode=daily`, support: 'Continue refining how your agent represents your practice.' }
  }
  if (training.action === 'review_training' && reviewId) {
    return { label: 'Review what your agent learned', href: `${trainPath}?review=${reviewId}`, support: 'A proposed learning from training is ready for your review.' }
  }
  return null
}

type DigestTile = { key: string; count: number; label: string; detail: string }

/** A recap of outcomes, never a duplicate of the raw event log (that's Recent
 * Activity). Built only from records/overview stats already fetched by the caller —
 * no new data source, and nothing is shown that current state doesn't support.
 * Structured as scannable number-first tiles, not prose — see HomeAgentCard's
 * expanded digest grid. */
function buildAgentDigest(records: ConsultationRecord[], overview: AgentOverview): DigestTile[] {
  if (records.length === 0) return []
  const totalConsulted = records.reduce((sum, record) => sum + record.result.consultation.length, 0)
  const tiles: DigestTile[] = [
    {
      key: 'coordination',
      count: totalConsulted,
      label: `Physician agent${totalConsulted === 1 ? '' : 's'} consulted`,
      detail: records.map((record) => patientName(record.patient_id)).join(' · '),
    },
    {
      key: 'recommendations',
      count: records.length,
      label: `Recommendation${records.length === 1 ? '' : 's'} returned`,
      detail: records.map((record) => record.result.recommended_physician.specialty).join(' · '),
    },
  ]
  const confirmed = overview.stats.confirmed_practice_learnings
  if (confirmed > 0) {
    tiles.push({
      key: 'learning',
      count: confirmed,
      label: `Practice preference${confirmed === 1 ? '' : 's'} confirmed`,
      detail: 'Shapes how your agent represents your practice.',
    })
  } else {
    tiles.push({
      key: 'guidance',
      count: totalConsulted,
      label: 'Network guidance items surfaced',
      detail: 'Workup and access details ready',
    })
  }
  return tiles.slice(0, 3)
}

/** The persistent agent object woven through the workspace, not a separate module.
 * Muted mineral surface — "your agent" is a distinct semantic color from physician-
 * action copper. Never an artificial quality score, XP, consecutive-day mechanic, or
 * finite completion percentage for the open-ended representation.
 *
 * Left side answers "what has my agent been doing for me?" (a collapsed digest,
 * expandable into up to three outcome tiles — never a raw activity duplicate). Right
 * side answers "how can I make my agent more like me?" (a small training burst that
 * opens a modal, not the full My Agent -> Train environment). */
export function HomeAgentCard({ overview, navigate, trainPath, viewAgentPath, matchesReady = 0, records = [], personaId }: {
  overview: AgentOverview | null; navigate: Navigate; trainPath: string; viewAgentPath: string; matchesReady?: number; records?: ConsultationRecord[]; personaId: PhysicianIdentity
}) {
  const [expanded, setExpanded] = useState(false)
  const [trainingOpen, setTrainingOpen] = useState(false)
  if (!overview) return null
  const training = overview.training
  const plan = agentBannerPlan(training, trainPath)
  const tiles = buildAgentDigest(records, overview)
  const isReview = training.action === 'review_training'
  return <section className="agent-banner">
    <div className="agent-banner-main">
      <div className="agent-banner-glyph" aria-hidden="true">
        <span className="agent-banner-ring r1" /><span className="agent-banner-ring r2" /><span className="agent-banner-ring r3" /><span className="agent-banner-ring r4" /><span className="agent-banner-ring r5" /><span className="agent-banner-ring r6" />
        <span className="agent-banner-sparkle">✧</span>
      </div>
      <p className="eyebrow">Your agent</p>
      <h2>See what your agent has done while you've been away.</h2>
      <div className="agent-banner-view-row">
        {tiles.length > 0 && <button className="text-button agent-digest-toggle" aria-expanded={expanded} onClick={() => setExpanded((value) => !value)}>{expanded ? 'Hide agent update ↑' : 'See agent update ↓'}</button>}
        <button className="text-button agent-banner-view" onClick={() => navigate(viewAgentPath)}>View My Agent →</button>
      </div>
    </div>
    <div className="agent-banner-action">
      <h3>Make your agent more like you.</h3>
      <p className="agent-banner-support">{plan ? 'A few quick answers help your agent represent your practice more faithfully.' : 'Training is up to date.'}</p>
      {plan && isReview && <button className="button-primary" onClick={() => navigate(plan.href)}>{plan.label} <span>→</span></button>}
      {plan && !isReview && <button className="button-primary" onClick={() => setTrainingOpen(true)}>Answer 3 quick questions <span>→</span></button>}
    </div>
    <div className={`agent-digest-expanded ${expanded ? 'open' : ''}`} aria-hidden={!expanded}>
      <div className="agent-digest-grid">{tiles.map((tile) => <div className="agent-digest-tile" key={tile.key}>
        <span className="agent-digest-count" aria-hidden="true">{tile.count}</span>
        <div><p className="agent-digest-tile-label">{tile.label}</p><p className="agent-digest-tile-detail">{tile.detail}</p></div>
      </div>)}</div>
    </div>
    {trainingOpen && <QuickTrainingModal personaId={personaId} onClose={() => setTrainingOpen(false)} onFinished={() => setTrainingOpen(false)} />}
  </section>
}

/** The Dashboard's small-batch training burst: a modal, never the full My Agent ->
 * Train page. Reuses the exact same session/question/branch API as full training
 * (including Depends -> narrower-follow-up) via the "quick" session mode, just
 * scoped to ~3 questions instead of the normal 10. Question-type rendering mirrors
 * TrainingPage's (yes_no / yes_no_depends / single_choice / multi_select /
 * short_text) so a multiple-choice question looks and behaves identically here and
 * in the full flow. */
function QuickTrainingModal({ personaId, onClose, onFinished }: { personaId: PhysicianIdentity; onClose: () => void; onFinished: () => void }) {
  const [phase, setPhase] = useState<'loading' | 'questions' | 'completed' | 'error'>('loading')
  const [session, setSession] = useState<TrainingSession | null>(null)
  const [queue, setQueue] = useState<TrainingQuestion[]>([])
  const [index, setIndex] = useState(0)
  const [answeredCount, setAnsweredCount] = useState(0)
  const [answerTarget, setAnswerTarget] = useState(3)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [multiSelected, setMultiSelected] = useState<string[]>([])
  const [textAnswer, setTextAnswer] = useState('')
  const [learnings, setLearnings] = useState<ProposedLearning[]>([])

  useEffect(() => {
    let cancelled = false
    const open = async () => {
      const training = await getTrainingHistory(personaId, 'quick')
      if (cancelled) return
      const activeId = training.active_session_id
      const started = activeId
        ? await resumeTrainingSession(personaId, activeId)
        : await startTrainingSession(personaId, { mode: 'quick', limit: 3 })
      if (cancelled) return
      const answeredIds = new Set((started.responses ?? []).map((item) => item.question_id))
      const remaining = (started.questions ?? []).filter((item) => !answeredIds.has(item.id))
      setSession(started)
      setQueue(remaining)
      setAnsweredCount(started.answered_count ?? (started.responses ?? []).length)
      setAnswerTarget(started.answer_target ?? 3)
      setPhase(remaining.length > 0 ? 'questions' : 'completed')
    }
    void open().catch((err: unknown) => {
      if (!cancelled) { setError(err instanceof Error ? err.message : 'Could not open training'); setPhase('error') }
    })
    return () => { cancelled = true }
  }, [personaId])

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => { if (event.key === 'Escape') onClose() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  const current = queue[index]

  const finish = async (activeSession: TrainingSession) => {
    try {
      const result = await finishTrainingSession(personaId, activeSession.id)
      setLearnings(result.proposed_learnings ?? [])
      setPhase('completed')
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not finish training')
      setPhase('error')
    }
  }

  const submit = async (answer: string | string[] | null, skipped: boolean) => {
    if (!session || !current || busy) return
    setBusy(true); setError('')
    try {
      const response = await answerTrainingQuestion(personaId, session.id, current.id, skipped ? { skipped: true } : { answer: answer ?? undefined })
      setAnsweredCount(response.answered_count ?? answeredCount + 1)
      setAnswerTarget(response.answer_target ?? answerTarget)
      setMultiSelected([]); setTextAnswer('')
      const nextQuestion = response.next_question
      if (response.questions_complete) {
        void finish(session)
      } else if (nextQuestion) {
        setQueue((prev) => { const copy = [...prev]; copy.splice(index + 1, 0, nextQuestion); return copy })
        setIndex((value) => value + 1)
      } else if (index + 1 >= queue.length) {
        void finish(session)
      } else {
        setIndex((value) => value + 1)
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not save your answer')
    } finally {
      setBusy(false)
    }
  }

  return <div className="post-flow-overlay" role="presentation" onClick={(event) => { if (event.target === event.currentTarget) onClose() }}>
    <div className="training-modal" role="dialog" aria-modal="true" aria-label="Teach your agent">
      <button className="text-button post-flow-close" onClick={onClose} aria-label="Close">×</button>
      {phase === 'loading' && <div className="training-modal-loading"><div className="loading-line" /><p>Opening a few quick questions…</p></div>}
      {phase === 'error' && <div className="error-banner" role="alert">{error}</div>}
      {phase === 'completed' && <div className="training-modal-complete">
        <p className="eyebrow">Teach your agent</p>
        <h2>A little more like you.</h2>
        <p className="training-modal-sub">{learnings.length > 0 ? `${learnings.length} new preference${learnings.length === 1 ? '' : 's'} ready for your agent.` : 'Your agent is up to date.'}</p>
        <p className="training-modal-reassure">You can refine these anytime.</p>
        <button className="button-primary" onClick={onFinished}>Back to your Dashboard <span>→</span></button>
      </div>}
      {phase === 'questions' && current && <>
        <p className="eyebrow">Teach your agent</p>
        <div className="training-progress-row"><span>Question {Math.min(answerTarget, answeredCount + 1)} of {answerTarget}</span><div className="training-progress-bar" role="progressbar" aria-valuenow={Math.min(answerTarget, answeredCount + 1)} aria-valuemin={1} aria-valuemax={answerTarget}><span style={{ width: `${Math.round((answeredCount / answerTarget) * 100)}%` }} /></div></div>
        <h2 className="training-prompt">{current.prompt}</h2>
        {current.why_this_matters && <p className="training-modal-why">{current.why_this_matters}</p>}
        {current.question_type === 'yes_no_depends' && <div className="training-choices spatial">
          <button className="training-choice no" disabled={busy} onClick={() => submit('No', false)}>No</button>
          <button className="training-choice depends" disabled={busy} onClick={() => submit('Depends', false)}>Depends</button>
          <button className="training-choice yes" disabled={busy} onClick={() => submit('Yes', false)}>Yes</button>
        </div>}
        {current.question_type === 'yes_no' && <div className="training-choices spatial two">
          <button className="training-choice no" disabled={busy} onClick={() => submit('No', false)}>No</button>
          <button className="training-choice yes" disabled={busy} onClick={() => submit('Yes', false)}>Yes</button>
        </div>}
        {current.question_type === 'single_choice' && <div className="training-choices column">{current.answer_options.map((option) => <button key={option} className="training-choice-plain" disabled={busy} onClick={() => submit(option, false)}>{option}</button>)}</div>}
        {current.question_type === 'multi_select' && <>
          <div className="training-choices column multi">{current.answer_options.map((option) => { const selected = multiSelected.includes(option); return <button key={option} type="button" aria-pressed={selected} className={`training-choice-plain ${selected ? 'selected' : ''}`} onClick={() => setMultiSelected((prev) => (selected ? prev.filter((item) => item !== option) : [...prev, option]))}>{selected ? '✓ ' : ''}{option}</button> })}</div>
          <button className="button-primary training-continue" disabled={!multiSelected.length || busy} onClick={() => submit(multiSelected, false)}>Continue <span>→</span></button>
        </>}
        {current.question_type === 'short_text' && <div className="training-text-answer">
          <textarea value={textAnswer} onChange={(event) => setTextAnswer(event.target.value)} maxLength={500} />
          <button className="button-primary" disabled={!textAnswer.trim() || busy} onClick={() => submit(textAnswer.trim(), false)}>Continue <span>→</span></button>
        </div>}
        {error && <p className="demo-reset-error" role="alert">{error}</p>}
        <div className="training-modal-footer">
          <button className="text-button" disabled={busy} onClick={() => submit(null, true)}>Skip</button>
          <p className="training-modal-reassure">You can refine these anytime.</p>
        </div>
      </>}
    </div>
  </div>
}

const FEED_TYPE_LABELS: Record<string, string> = {
  practice_focus: 'Practice', referral_guidance: 'Referral guidance', availability: 'Availability',
  publication: 'Research', research: 'Research', research_update: 'Research', teaching: 'Teaching', teaching_update: 'Teaching',
  location: 'Practice', professional_update: 'Practice update', profile_update: 'Profile update', practice_update: 'Practice',
  share_paper: 'Research', interesting_case: 'Case reflection', other: 'Update',
}

/** Posts optionally carry a plain static path under frontend/public/post_images/
 * (served by Vite as-is — never a data: URI, never fetched from an external host).
 * A post with no image_url renders as text-only; nothing here requires an image. */
function FeedPostImage({ item }: { item: NetworkFeedItem }) {
  if (!item.image_url) return null
  const fit = item.media_style === 'contain' ? 'contain' : 'cover'
  return <div className={`feed-post-image-frame fit-${fit}`}>
    <img className="feed-post-image" src={item.image_url} alt={item.image_alt ?? ''} loading="lazy" />
  </div>
}

function feedInitials(name: string) {
  return name.split(' ').filter(Boolean).map((part) => part[0]).slice(0, 2).join('').toUpperCase()
}

function FeedCard({ item, navigate, perspective }: { item: NetworkFeedItem; navigate: Navigate; perspective: DemoPhysicianPerspective }) {
  const when = item.published_at ?? item.created_at
  const [expanded, setExpanded] = useState(false)
  const isLong = item.body.length > 220
  const preview = isLong && !expanded ? `${item.body.slice(0, 220).trimEnd()}…` : item.body
  return <article className="feed-post">
    <div className="feed-post-header">
      <span className="feed-post-avatar" aria-hidden="true">{feedInitials(item.physician.name)}</span>
      <div className="feed-post-byline">
        <button className="feed-post-author" onClick={() => navigate(networkProfilePath(perspective, item.physician.id))}>{item.physician.name}</button>
        <small>{item.physician.specialty} · {relativeDayLabel(when)}</small>
      </div>
      <span className="feed-post-tag">{FEED_TYPE_LABELS[item.type] ?? 'Update'}</span>
    </div>
    <p className="feed-post-title">{item.title}</p>
    <p className="feed-post-body">{preview}{isLong && <button type="button" className="text-button feed-post-more" onClick={() => setExpanded((value) => !value)}>{expanded ? 'See less' : 'See more'}</button>}</p>
    <FeedPostImage item={item} />
  </article>
}

/** Home's tiny network preview — at most 2 compact rows, omitted entirely when there is nothing to show. Never a feed, never an empty state on Home. */
export function NetworkHighlights({ feed, navigate, perspective }: { feed: NetworkFeed | null; navigate: Navigate; perspective: DemoPhysicianPerspective }) {
  if (!feed || feed.items.length === 0) return null
  const items = feed.items.slice(0, 2)
  return <section className="home-network-highlights">
    <div className="home-section-heading"><h2>Recent network</h2></div>
    <div className="home-network-highlight-rows">{items.map((item) => <button key={item.id} className="home-network-highlight-row" onClick={() => navigate(networkProfilePath(perspective, item.physician.id))}>
      <span className="home-network-highlight-physician">{item.physician.name} · {item.physician.specialty}</span>
      <span className="home-network-highlight-title">{item.title}</span>
      <b>View →</b>
    </button>)}</div>
    <button className="text-button" onClick={() => navigate(networkUpdatesPath(perspective))}>View network →</button>
  </section>
}

export const NETWORK_TABS = ['my-network', 'feed'] as const
export type NetworkTab = typeof NETWORK_TABS[number]
const NETWORK_TAB_LABELS: Record<NetworkTab, string> = { 'my-network': 'Colleagues', feed: 'Feed' }

export function NetworkTabs({ tab, onSelect }: { tab: NetworkTab; onSelect: (next: NetworkTab) => void }) {
  return <nav className="network-tabs" aria-label="Network sections">{NETWORK_TABS.map((item) => <button key={item} className={tab === item ? 'active' : ''} aria-current={tab === item ? 'page' : undefined} onClick={() => onSelect(item)}>{NETWORK_TAB_LABELS[item]}</button>)}</nav>
}

/** Network → Feed: the canonical professional-update destination. Published items only, chronological, backend-decided eligibility. */
export function NetworkFeedTab({ personaId, navigate, onPublished }: { personaId: DemoPhysicianPerspective; navigate: Navigate; onPublished?: (post: ProfessionalPost) => void }) {
  const [feed, setFeed] = useState<NetworkFeed | null>(null)
  const [error, setError] = useState('')
  const load = () => { getNetworkFeed(personaId).then(setFeed).catch((err: Error) => setError(err.message)) }
  useEffect(load, [personaId]) // eslint-disable-line react-hooks/exhaustive-deps
  return <div className="network-feed-tab">
    <div className="network-feed-tab-header">
      <div><h2>Feed</h2><p className="page-intro">Professional updates from physicians and practices your network interacts with.</p></div>
      <PostButton personaId={personaId} triggerLabel="Post" compact={false} onPublished={(post) => { onPublished?.(post); load() }} />
    </div>
    {error && <div className="error-banner" role="alert">{error}</div>}
    {!feed && !error && <p className="muted-note">Loading your network feed…</p>}
    {feed && feed.items.length === 0 && <div className="empty-state history-empty">
      <NetworkMark />
      <h2>No updates from your network yet.</h2>
      <p>Updates will appear as physicians and agents in your network share professional changes.</p>
    </div>}
    {feed && feed.items.length > 0 && <div className="feed-stream">{feed.items.map((item) => <FeedCard key={item.id} item={item} navigate={navigate} perspective={personaId} />)}</div>}
  </div>
}

/* --------------------------------------------------------------------- Train */

function questionSource(question: TrainingQuestion): { tag: string; detail: string } {
  switch (question.source_type as string) {
    case 'network_question':
      return { tag: 'From your network', detail: question.asked_count ? `Asked by ${question.asked_count} referring physician agent${question.asked_count === 1 ? '' : 's'}` : 'Asked by referring physician agents' }
    case 'canonical_case':
      return { tag: 'From a recent case', detail: question.source_reference ? `${patientName(question.source_reference)} network consultation` : 'From a recent network consultation' }
    case 'profile_confirmation':
      return { tag: 'Practice profile', detail: 'Confirm how your practice should be represented' }
    case 'initialization':
      return { tag: 'Agent initialization', detail: 'Help define your practice' }
    case 'unresolved_branch':
    case 'practice_gap':
    case 'deterministic_branch':
      return { tag: 'Practice gap', detail: 'Your agent is missing guidance here' }
    case 'bounded_practice_context':
      return { tag: 'Practice context', detail: 'Helps your agent understand bounded practice context' }
    case 'agent_chat_correction':
      return { tag: 'From a chat correction', detail: "Based on your \"Not quite\" feedback in Chat" }
    default:
      return { tag: 'Referral guidance', detail: 'Help your agent answer this consistently' }
  }
}

function TrainingLearningCard({ learning, editing, draft, onEdit, onCancelEdit, onDraftChange, onAction, busy }: {
  learning: ProposedLearning; editing: boolean; draft: string
  onEdit: () => void; onCancelEdit: () => void; onDraftChange: (value: string) => void
  onAction: (learning: ProposedLearning, action: 'confirm' | 'edit' | 'reject', statement?: string) => void
  busy: boolean
}) {
  return <article className="learning-card">
    <span className={`learning-status ${learning.status}`}>{learning.status === 'suggested' ? 'Proposed · needs confirmation' : learning.status === 'confirmed' ? 'Physician-confirmed' : 'Rejected'}</span>
    <p>{learning.statement}</p>
    <small>Source: {learning.provenance}</small>
    {editing
      ? <div className="learning-edit"><label htmlFor={`training-learning-${learning.id}`}>Correct this learning</label><textarea id={`training-learning-${learning.id}`} maxLength={500} value={draft} onChange={(event) => onDraftChange(event.target.value)} /><div><button className="button-primary" disabled={!draft.trim() || busy} onClick={() => onAction(learning, 'edit', draft)}>Save draft</button><button className="text-button" onClick={onCancelEdit}>Cancel</button></div></div>
      : <div className="learning-actions"><button disabled={busy || learning.status === 'confirmed'} onClick={() => onAction(learning, 'confirm')}>Confirm</button><button disabled={busy} onClick={onEdit}>Edit</button><button disabled={busy || learning.status === 'rejected'} onClick={() => onAction(learning, 'reject')}>Reject</button></div>}
  </article>
}

type TrainingPhase = 'loading' | 'empty' | 'questions' | 'completed' | 'reviewing' | 'review_complete' | 'error'
type TrainingMode = 'initialization' | 'daily'

export function TrainingPage({ personaId, agentName, navigate, exitPath, params }: { personaId: PhysicianIdentity; agentName: string; navigate: Navigate; exitPath: string; params?: URLSearchParams }) {
  const modeParam = (params?.get('mode') as TrainingMode | null) ?? 'daily'
  const resumeParam = params?.get('resume')
  const reviewParam = params?.get('review')
  const [phase, setPhase] = useState<TrainingPhase>('loading')
  const [session, setSession] = useState<TrainingSession | null>(null)
  const [queue, setQueue] = useState<TrainingQuestion[]>([])
  const [index, setIndex] = useState(0)
  const [answeredCount, setAnsweredCount] = useState(0)
  const [answerTarget, setAnswerTarget] = useState(10)
  const [cardState, setCardState] = useState<'idle' | 'leaving'>('idle')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [multiSelected, setMultiSelected] = useState<string[]>([])
  const [textAnswer, setTextAnswer] = useState('')
  const [completionSummary, setCompletionSummary] = useState<TrainingCompletionSummary | null>(null)
  const [learnings, setLearnings] = useState<ProposedLearning[]>([])
  const [editingLearningId, setEditingLearningId] = useState<number | null>(null)
  const [draft, setDraft] = useState('')
  const [branchNote, setBranchNote] = useState<string | null>(null)
  useEffect(() => {
    let cancelled = false
    setPhase('loading'); setIndex(0); setCardState('idle'); setBranchNote(null)
    setCompletionSummary(null); setLearnings([]); setMultiSelected([]); setTextAnswer(''); setError('')
    const openReview = async (sessionId: number) => {
      const resumedSession = await resumeTrainingSession(personaId, sessionId)
      if (cancelled) return
      const prefix = `session:${sessionId}:`
      setSession(resumedSession)
      if (personaId === 'owner') {
        setLearnings((resumedSession.proposed_learnings ?? []).filter((item) => item.source_reference.startsWith(prefix)))
      } else {
        const workspace = await getPhysicianTraining(personaId)
        if (cancelled) return
        setLearnings(workspace.proposed_learnings.filter((item) => item.source_reference.startsWith(prefix)))
      }
      setPhase('reviewing')
    }
    const openTraining = async () => {
      if (reviewParam) {
        await openReview(Number(reviewParam))
        return
      }
      const training = await getTrainingHistory(personaId)
      if (cancelled) return
      if (training.state === 'review_pending' && training.review_session_id) {
        await openReview(training.review_session_id)
        return
      }
      if (training.state === 'caught_up') {
        setPhase('empty')
        return
      }
      const activeId = resumeParam ? Number(resumeParam) : training.active_session_id
      const started = activeId
        ? await resumeTrainingSession(personaId, activeId)
        : await startTrainingSession(personaId, {
          mode: training.state === 'initialization_needed' ? 'initialization' : modeParam,
        })
      if (cancelled) return
      const answeredIds = new Set((started.responses ?? []).map((item) => item.question_id))
      const answeredSoFar = (started.responses ?? []).length
      const remaining = (started.questions ?? []).filter((item) => !answeredIds.has(item.id))
      setSession(started)
      setQueue(remaining)
      setAnsweredCount(answeredSoFar)
      setAnswerTarget(started.answer_target ?? 10)
      setPhase(remaining.length > 0 ? 'questions' : 'empty')
    }
    void openTraining().catch((err: unknown) => {
      if (!cancelled) {
        setError(err instanceof Error ? err.message : 'Could not open training')
        setPhase('error')
      }
    })
    return () => { cancelled = true }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [personaId, modeParam, resumeParam, reviewParam])

  const current = queue[index]
  const isFocused = session?.mode === 'focused'

  const finish = async (activeSession: TrainingSession) => {
    try {
      const result = await finishTrainingSession(personaId, activeSession.id)
      setLearnings(result.proposed_learnings ?? [])
      setCompletionSummary(result.completion_summary ?? null)
      setPhase(activeSession.mode === 'focused' ? 'reviewing' : 'completed')
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not finish training')
      setPhase('error')
    }
  }

  const advance = (activeSession: TrainingSession, note: string | null, atEnd: boolean) => {
    setMultiSelected([]); setTextAnswer('')
    const calm = prefersReducedMotion()
    if (calm) {
      setBranchNote(note)
      if (atEnd) void finish(activeSession)
      else setIndex((value) => value + 1)
      return
    }
    setCardState('leaving')
    window.setTimeout(() => {
      setCardState('idle'); setBranchNote(note)
      if (atEnd) void finish(activeSession)
      else setIndex((value) => value + 1)
    }, 220)
  }

  const submit = async (answer: string | string[] | null, skipped: boolean) => {
    if (!session || !current || busy) return
    setBusy(true); setError('')
    try {
      const response = await answerTrainingQuestion(personaId, session.id, current.id, skipped ? { skipped: true } : { answer: answer ?? undefined })
      setAnsweredCount(response.answered_count ?? answeredCount + 1)
      setAnswerTarget(response.answer_target ?? answerTarget)
      const nextQuestion = response.next_question
      if (response.questions_complete) {
        advance(session, response.deferred_branch ? 'Follow-up saved for your next session.' : null, true)
      } else if (nextQuestion) {
        setQueue((prev) => { const copy = [...prev]; copy.splice(index + 1, 0, nextQuestion); return copy })
        advance(session, null, false)
      } else {
        const resolvedBranch = current.branch_depth > 0
        advance(session, resolvedBranch ? (isFocused ? 'Got it.' : 'Got it. Lamina can propose a practice rule from these answers.') : null, index + 1 >= queue.length)
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not save your answer')
    } finally {
      setBusy(false)
    }
  }

  const trainTenMore = async () => {
    setBusy(true); setError('')
    try {
      const started = await startTrainingSession(personaId, { mode: 'daily' })
      setSession(started)
      setQueue(started.questions ?? [])
      setAnsweredCount(0)
      setAnswerTarget(started.answer_target ?? 10)
      setLearnings([]); setCompletionSummary(null); setIndex(0); setCardState('idle'); setBranchNote(null)
      setPhase((started.questions ?? []).length > 0 ? 'questions' : 'empty')
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not start a new training session')
      setPhase('error')
    } finally { setBusy(false) }
  }

  useEffect(() => {
    if (!branchNote) return
    const timer = window.setTimeout(() => setBranchNote(null), 2400)
    return () => window.clearTimeout(timer)
  }, [branchNote])

  useEffect(() => {
    if (phase !== 'questions' || !current) return
    if (current.question_type !== 'yes_no' && current.question_type !== 'yes_no_depends') return
    const onKey = (event: KeyboardEvent) => {
      if (busy) return
      if (event.key === 'ArrowLeft') void submit('No', false)
      else if (event.key === 'ArrowRight') void submit('Yes', false)
      else if (event.key === 'ArrowDown' && current.question_type === 'yes_no_depends') void submit('Depends', false)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phase, current?.id, busy])

  const actOnLearning = async (learning: ProposedLearning, action: 'confirm' | 'edit' | 'reject', statement?: string) => {
    setBusy(true)
    try {
      const result = await updateProposedLearning(personaId, learning.id, action, statement)
      setLearnings((prev) => prev.map((item) => (item.id === learning.id ? result.learning : item)))
      setEditingLearningId(null)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not save your correction')
    } finally {
      setBusy(false)
    }
  }

  const finishReview = async () => {
    if (!session) return
    const pendingRemaining = learnings.filter((item) => item.status === 'suggested').length
    setBusy(true); setError('')
    try {
      await completeTrainingReview(personaId, session.id, pendingRemaining > 0)
      setPhase('review_complete')
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not complete the review')
    } finally { setBusy(false) }
  }

  if (phase === 'loading') return <main className="training-shell"><div className="page-state embedded"><div className="loading-line" /><p>Preparing training…</p></div></main>
  if (phase === 'error') return <main className="training-shell training-empty"><div className="error-banner" role="alert">{error}</div><button className="button-secondary" onClick={() => navigate(exitPath)}>← Back</button></main>
  if (phase === 'empty') return <main className="training-shell training-empty">
    <NetworkMark resolved />
    <h1>{modeParam === 'initialization' ? 'Initialization questions are already answered' : 'Your agent is caught up for now'}</h1>
    <p>No new questions are waiting right now. Check back after your agent participates in more network activity.</p>
    <button className="button-primary" onClick={() => navigate(exitPath)}>Back to My Agent <span>→</span></button>
  </main>

  if (phase === 'completed') {
    const answered = completionSummary?.answered_count ?? answeredCount
    const proposedCount = completionSummary?.proposed_learning_count ?? learnings.length
    return <main className="training-shell training-review">
      <p className="eyebrow">Train your agent</p>
      <h1>Thanks for training your agent.</h1>
      <p className="training-review-intro">You answered {answered} question{answered === 1 ? '' : 's'}.</p>
      {completionSummary && <p className="training-completion-findings">Lamina found: {proposedCount} possible practice learning{proposedCount === 1 ? '' : 's'}{completionSummary.unresolved_question_count > 0 ? ` · ${completionSummary.unresolved_question_count} question saved for your next session` : ''}.</p>}
      {error && <p className="demo-reset-error" role="alert">{error}</p>}
      <div className="training-summary">
        {proposedCount > 0 && <button className="button-primary" onClick={() => setPhase('reviewing')}>Review what my agent learned <span>→</span></button>}
        <button className="button-secondary" onClick={() => navigate(exitPath)}>Done for now</button>
      </div>
    </main>
  }

  if (phase === 'reviewing') {
    return <main className="training-shell training-review">
      <p className="eyebrow">Train your agent</p>
      <h1>Review what your agent learned.</h1>
      {error && <p className="demo-reset-error" role="alert">{error}</p>}
      {learnings.length === 0
        ? <p className="agent-empty-note">No new proposed learnings from this session.</p>
        : <div className="learning-grid">{learnings.map((learning) => <TrainingLearningCard key={learning.id} learning={learning} busy={busy} editing={editingLearningId === learning.id} draft={draft} onEdit={() => { setEditingLearningId(learning.id); setDraft(learning.statement) }} onCancelEdit={() => setEditingLearningId(null)} onDraftChange={setDraft} onAction={actOnLearning} />)}</div>}
      <div className="training-summary">
        <button className="button-primary" disabled={busy} onClick={finishReview}>Done reviewing <span>→</span></button>
      </div>
    </main>
  }

  if (phase === 'review_complete') {
    return <main className="training-shell training-review">
      <p className="eyebrow">Train your agent</p>
      <h1>Training complete.</h1>
      {error && <p className="demo-reset-error" role="alert">{error}</p>}
      <div className="training-summary">
        <button className="button-primary" disabled={busy} onClick={trainTenMore}>Train 10 more <span>→</span></button>
        <button className="button-secondary" onClick={() => navigate(exitPath)}>Back to My Agent</button>
      </div>
    </main>
  }

  if (!current) return null
  const source = questionSource(current)
  const hasDepends = current.question_type === 'yes_no_depends'
  const isFollowUp = current.branch_depth > 0
  const displayNumber = Math.min(answerTarget, answeredCount + 1)
  return <main className={`training-shell training-active ${cardState}`}>
    <div className="training-header">
      <p className="eyebrow">{isFocused ? 'Focused training' : 'Train your agent'}</p>
      {isFocused
        ? <p className="training-focused-subtitle">Let's clarify this case.</p>
        : <div className="training-progress-row"><span>Question {displayNumber} of {answerTarget}</span><div className="training-progress-bar" role="progressbar" aria-valuenow={displayNumber} aria-valuemin={1} aria-valuemax={answerTarget}><span style={{ width: `${Math.round(((displayNumber - 1) / answerTarget) * 100)}%` }} /></div></div>}
      <button className="text-button training-exit" onClick={() => navigate(exitPath)}>Exit</button>
    </div>
    {branchNote && <p className="training-branch-note" role="status">{branchNote}</p>}
    <div className="training-stage">
      <article className={`training-card ${cardState}`} key={current.id}>
        <span className="training-source-tag">{source.tag}</span>
        <p className="training-source-detail">{source.detail}</p>
        {isFollowUp && <p className="training-branch-context">Follow-up {current.branch_depth}{current.branch_condition ? ` · Based on: ${current.branch_condition}` : ''}</p>}
        <h2 className="training-prompt">{current.prompt}</h2>
        {current.question_type === 'yes_no_depends' && <div className="training-choices spatial">
          <button className="training-choice no" disabled={busy} onClick={() => submit('No', false)}><span className="training-key" aria-hidden="true">←</span> No</button>
          <button className="training-choice depends" disabled={busy} onClick={() => submit('Depends', false)}>Depends</button>
          <button className="training-choice yes" disabled={busy} onClick={() => submit('Yes', false)}>Yes <span className="training-key" aria-hidden="true">→</span></button>
        </div>}
        {current.question_type === 'yes_no' && <div className="training-choices spatial two">
          <button className="training-choice no" disabled={busy} onClick={() => submit('No', false)}><span className="training-key" aria-hidden="true">←</span> No</button>
          <button className="training-choice yes" disabled={busy} onClick={() => submit('Yes', false)}>Yes <span className="training-key" aria-hidden="true">→</span></button>
        </div>}
        {current.question_type === 'single_choice' && <div className="training-choices row">{current.answer_options.map((option) => <button key={option} className="training-choice-plain" disabled={busy} onClick={() => submit(option, false)}>{option}</button>)}</div>}
        {current.question_type === 'multi_select' && <>
          <div className="training-choices row multi">{current.answer_options.map((option) => { const selected = multiSelected.includes(option); return <button key={option} type="button" aria-pressed={selected} className={`training-choice-plain ${selected ? 'selected' : ''}`} onClick={() => setMultiSelected((prev) => (selected ? prev.filter((item) => item !== option) : [...prev, option]))}>{selected ? '✓ ' : ''}{option}</button> })}</div>
          <button className="button-primary training-continue" disabled={!multiSelected.length || busy} onClick={() => submit(multiSelected, false)}>Continue <span>→</span></button>
        </>}
        {current.question_type === 'short_text' && <div className="training-text-answer">
          <label htmlFor="training-text-input">Your answer</label>
          <textarea id="training-text-input" value={textAnswer} onChange={(event) => setTextAnswer(event.target.value)} maxLength={500} />
          <button className="button-primary" disabled={!textAnswer.trim() || busy} onClick={() => submit(textAnswer.trim(), false)}>Continue <span>→</span></button>
        </div>}
        <p className="training-why">{current.why_this_matters}</p>
      </article>
    </div>
    {error && <p className="demo-reset-error" role="alert">{error}</p>}
    <div className="training-footer">
      <button className="text-button" disabled={busy} onClick={() => submit(null, true)}>Skip</button>
      {(current.question_type === 'yes_no' || hasDepends) && <p className="training-keyboard-hint">← No{hasDepends ? ' · ↓ Depends' : ''} · Yes →</p>}
    </div>
  </main>
}

/* ------------------------------------------------------------- Profile: shared */

const CATEGORY_LABELS: Record<ProfileCategory, string> = {
  about: 'About', training: 'Training', experience: 'Experience', affiliations: 'Affiliations',
  clinical_interests: 'Clinical interests', skills_or_procedures: 'Skills / procedures',
  research: 'Research', publications: 'Publications', teaching: 'Teaching',
  languages: 'Languages', locations: 'Locations', professional_links: 'Professional links',
}

function provenanceLabel(item: ProfileItem) {
  if (item.provenance === 'physician_entered') return 'Added by you'
  if (item.provenance === 'confirmed_by_physician') return 'Physician-confirmed'
  if (item.provenance === 'nppes') return 'Directory source'
  if (item.provenance === 'imported') return 'Imported'
  return 'Synthetic demo profile'
}

function ProfileItemForm({ category, initial, onSave, onCancel, busy }: {
  category: ProfileCategory; initial?: ProfileItem
  onSave: (fields: { title: string; detail: string; shareable: boolean }) => void
  onCancel: () => void; busy: boolean
}) {
  const [title, setTitle] = useState(initial?.title ?? '')
  const [detail, setDetail] = useState(initial?.detail ?? '')
  const [shareable, setShareable] = useState(initial?.shareable ?? true)
  const uid = initial?.id ?? `new-${category}`
  return <div className="profile-item-form">
    <label htmlFor={`profile-title-${uid}`}>Title</label>
    <input id={`profile-title-${uid}`} value={title} onChange={(event) => setTitle(event.target.value)} maxLength={240} />
    <label htmlFor={`profile-detail-${uid}`}>Detail <em>Optional</em></label>
    <textarea id={`profile-detail-${uid}`} value={detail} onChange={(event) => setDetail(event.target.value)} maxLength={1000} />
    <label className="profile-shareable-toggle"><input type="checkbox" checked={shareable} onChange={(event) => setShareable(event.target.checked)} /> Visible on my public professional profile</label>
    <div><button className="button-primary" disabled={!title.trim() || busy} onClick={() => onSave({ title: title.trim(), detail: detail.trim(), shareable })}>Save</button><button className="text-button" onClick={onCancel}>Cancel</button></div>
  </div>
}

function ProfileSection({ category, items, personaId, onSaved, itemActions, heading, id, quiet, readOnly }: {
  category: ProfileCategory; items: ProfileItem[]; personaId?: PhysicianIdentity
  onSaved?: () => void; itemActions?: (item: ProfileItem) => ReactNode; heading?: string; id?: string; quiet?: boolean; readOnly?: boolean
}) {
  const [adding, setAdding] = useState(false)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const save = async (itemId: string, fields: { title: string; detail: string; shareable: boolean }) => {
    if (!personaId) return
    setBusy(true)
    try {
      await updateProfessionalProfileItem(personaId, itemId, { category, title: fields.title, detail: fields.detail || undefined, shareable: fields.shareable })
      onSaved?.()
      setAdding(false); setEditingId(null)
    } finally { setBusy(false) }
  }
  return <section id={id} className={`profile-section-v2 ${quiet ? 'quiet' : ''}`}>
    <div className="profile-section-heading"><h2>{heading ?? CATEGORY_LABELS[category]}</h2>{!readOnly && <button className="text-button" onClick={() => { setAdding(true); setEditingId(null) }}>+ Add</button>}</div>
    {items.length === 0 && !adding && <p className="profile-section-empty">Nothing added yet.</p>}
    <div className="profile-item-list">{items.map((item) => (editingId === item.id
      ? <ProfileItemForm key={item.id} category={category} initial={item} busy={busy} onCancel={() => setEditingId(null)} onSave={(fields) => save(item.id, fields)} />
      : <div className="profile-item-row" key={item.id}>
        <div><strong>{item.title}</strong>{item.detail && <p>{item.detail}</p>}{!readOnly && <small>{provenanceLabel(item)}</small>}{itemActions && <div className="profile-item-extra-actions">{itemActions(item)}</div>}</div>
        {!readOnly && <button className="text-button" onClick={() => { setEditingId(item.id); setAdding(false) }}>Edit</button>}
      </div>))}
    </div>
    {adding && <ProfileItemForm category={category} busy={busy} onCancel={() => setAdding(false)} onSave={(fields) => save(`item-${crypto.randomUUID()}`, fields)} />}
  </section>
}

/** Own-profile-only editable chip section (Skills & procedures, Languages). Each chip is a real button because clicking one enters edit mode — never a decorative fake control. */
function ProfileChipSection({ category, items, personaId, onSaved, heading, readOnly }: {
  category: ProfileCategory; items: ProfileItem[]; personaId?: PhysicianIdentity; onSaved?: () => void; heading?: string; readOnly?: boolean
}) {
  const [adding, setAdding] = useState(false)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const save = async (itemId: string, fields: { title: string; detail: string; shareable: boolean }) => {
    if (!personaId) return
    setBusy(true)
    try {
      await updateProfessionalProfileItem(personaId, itemId, { category, title: fields.title, detail: fields.detail || undefined, shareable: fields.shareable })
      onSaved?.(); setAdding(false); setEditingId(null)
    } finally { setBusy(false) }
  }
  return <section id={`profile-section-${category}`} className="profile-section-v2">
    <div className="profile-section-heading"><h2>{heading ?? CATEGORY_LABELS[category]}</h2>{!readOnly && <button className="text-button" onClick={() => { setAdding(true); setEditingId(null) }}>+ Add</button>}</div>
    {items.length === 0 && !adding && <p className="profile-section-empty">Nothing added yet.</p>}
    <div className="profile-chip-group">{items.filter((item) => editingId !== item.id).map((item) => (readOnly
      ? <span key={item.id} className="profile-chip static">{item.title}</span>
      : <button key={item.id} className="profile-chip" onClick={() => { setEditingId(item.id); setAdding(false) }}>{item.title}</button>))}</div>
    {!readOnly && items.filter((item) => editingId === item.id).map((item) => <ProfileItemForm key={item.id} category={category} initial={item} busy={busy} onCancel={() => setEditingId(null)} onSave={(fields) => save(item.id, fields)} />)}
    {adding && <ProfileItemForm category={category} busy={busy} onCancel={() => setAdding(false)} onSave={(fields) => save(`item-${crypto.randomUUID()}`, fields)} />}
  </section>
}

/** Vertical professional timeline for one Background subcategory (Training / Experience / Affiliations). */
function ProfileTimelineGroup({ category, items, personaId, onSaved, readOnly }: {
  category: ProfileCategory; items: ProfileItem[]; personaId?: PhysicianIdentity; onSaved?: () => void; readOnly?: boolean
}) {
  const [adding, setAdding] = useState(false)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const save = async (itemId: string, fields: { title: string; detail: string; shareable: boolean }) => {
    if (!personaId) return
    setBusy(true)
    try {
      await updateProfessionalProfileItem(personaId, itemId, { category, title: fields.title, detail: fields.detail || undefined, shareable: fields.shareable })
      onSaved?.(); setAdding(false); setEditingId(null)
    } finally { setBusy(false) }
  }
  if (readOnly && items.length === 0) return null
  return <div className="profile-timeline-group">
    <div className="profile-timeline-heading"><h3>{CATEGORY_LABELS[category]}</h3>{!readOnly && <button className="text-button" onClick={() => { setAdding(true); setEditingId(null) }}>+ Add</button>}</div>
    {items.length === 0 && !adding && <p className="profile-section-empty">Nothing added yet.</p>}
    <div className="profile-timeline">{items.map((item) => (editingId === item.id
      ? <ProfileItemForm key={item.id} category={category} initial={item} busy={busy} onCancel={() => setEditingId(null)} onSave={(fields) => save(item.id, fields)} />
      : <div className="profile-timeline-item" key={item.id}>
        <span className="profile-timeline-dot" aria-hidden="true" />
        <div><strong>{item.title}</strong>{item.detail && <p>{item.detail}</p>}{!readOnly && <small>{provenanceLabel(item)}</small>}</div>
        {!readOnly && <button className="text-button" onClick={() => { setEditingId(item.id); setAdding(false) }}>Edit</button>}
      </div>))}
    </div>
    {adding && <ProfileItemForm category={category} busy={busy} onCancel={() => setAdding(false)} onSave={(fields) => save(`item-${crypto.randomUUID()}`, fields)} />}
  </div>
}

/** About reads as a biography paragraph, not a metadata row — but reuses the same canonical save path as every other profile item. */
function AboutSection({ items, personaId, onSaved, readOnly }: { items: ProfileItem[]; personaId?: PhysicianIdentity; onSaved?: () => void; readOnly?: boolean }) {
  const [editing, setEditing] = useState(false)
  const [busy, setBusy] = useState(false)
  const existing = items[0] ?? null
  const save = async (fields: { title: string; detail: string; shareable: boolean }) => {
    if (!personaId) return
    setBusy(true)
    try {
      await updateProfessionalProfileItem(personaId, existing?.id ?? `item-${crypto.randomUUID()}`, { category: 'about', title: fields.title, detail: fields.detail || undefined, shareable: fields.shareable })
      onSaved?.(); setEditing(false)
    } finally { setBusy(false) }
  }
  if (readOnly && !existing) return null
  return <section id="profile-section-about" className="profile-block profile-about">
    <h2 className="profile-block-heading">About</h2>
    {editing
      ? <ProfileItemForm category="about" initial={existing ?? undefined} busy={busy} onCancel={() => setEditing(false)} onSave={save} />
      : existing
        ? <><p className="profile-about-text">{existing.title}</p>{existing.detail && <p className="profile-about-text">{existing.detail}</p>}{!readOnly && <button className="text-button" onClick={() => setEditing(true)}>Edit</button>}</>
        : <button className="text-button" onClick={() => setEditing(true)}>+ Add an introduction about your practice →</button>}
  </section>
}

function PostCard({ post, personaId, onChanged }: { post: ProfessionalPost; personaId: DemoPhysicianPerspective; onChanged: (updated: ProfessionalPost) => void }) {
  const [editing, setEditing] = useState(false)
  const [title, setTitle] = useState(post.title)
  const [body, setBody] = useState(post.body)
  const [busy, setBusy] = useState(false)
  const act = async (action: 'publish' | 'dismiss') => {
    setBusy(true)
    try {
      const result = action === 'publish' ? await publishProfessionalPost(personaId, Number(post.id)) : await dismissProfessionalPost(personaId, Number(post.id))
      onChanged(result)
    } finally { setBusy(false) }
  }
  const saveEdit = async () => {
    setBusy(true)
    try { const result = await editProfessionalPost(personaId, Number(post.id), { type: post.type, title: title.trim(), body: body.trim(), case_origin: post.synthetic_case ? 'synthetic_demo' : undefined }); onChanged(result); setEditing(false) } finally { setBusy(false) }
  }
  return <article className="practice-update-card">
    <span className={`practice-update-status ${post.status}`}>{post.status === 'draft' ? 'Draft' : post.status === 'published' ? 'Published' : 'Dismissed'}</span>
    {post.drafted_by === 'lamina_agent' && <span className="practice-update-agent-drafted">Drafted with your Lamina agent</span>}
    {post.synthetic_case && <span className="practice-update-agent-drafted">{post.case_safety_label ?? 'Synthetic/demo case'}</span>}
    {editing
      ? <div className="profile-item-form"><input value={title} onChange={(event) => setTitle(event.target.value)} maxLength={240} /><textarea value={body} onChange={(event) => setBody(event.target.value)} maxLength={2000} /><div><button className="button-primary" disabled={busy} onClick={saveEdit}>Save</button><button className="text-button" onClick={() => setEditing(false)}>Cancel</button></div></div>
      : <><p className="practice-update-title">{post.title}</p><p className="practice-update-body">{post.body}</p></>}
    {post.status === 'draft' && !editing && <div className="learning-actions"><button disabled={busy} onClick={() => act('publish')}>Publish</button><button disabled={busy} onClick={() => setEditing(true)}>Edit</button><button disabled={busy} onClick={() => act('dismiss')}>Dismiss</button></div>}
  </article>
}

/* --------------------------------------------------------------------- Post */

/** Tags are metadata, not the first decision — the composer opens straight to a
 * blank page a physician can start writing in immediately. A tag only narrows how
 * the post is categorized afterward, with a quiet default (Practice) already
 * selected so publishing never requires picking one first. */
const PRIMARY_POST_TAGS: Array<{ type: PostType; label: string }> = [
  { type: 'practice_update', label: 'Practice' },
  { type: 'research_update', label: 'Research' },
  { type: 'referral_guidance', label: 'Referral guidance' },
  { type: 'teaching_update', label: 'Teaching' },
]
const MORE_POST_TAGS: Array<{ type: PostType; label: string }> = [
  { type: 'share_paper', label: 'Share a paper' },
  { type: 'interesting_case', label: 'Interesting case' },
  { type: 'availability', label: 'Availability' },
  { type: 'professional_update', label: 'Professional update' },
  { type: 'other', label: 'Other' },
]

type PostFlowStage = 'closed' | 'compose' | 'preview'

export function PostButton({ personaId, onPublished, paperTitle, triggerLabel = 'Share update', compact = false }: { personaId: DemoPhysicianPerspective; onPublished?: (post: ProfessionalPost) => void; paperTitle?: string; triggerLabel?: string; compact?: boolean }) {
  const [stage, setStage] = useState<PostFlowStage>('closed')
  const [intent, setIntent] = useState<PostType>('practice_update')
  const [title, setTitle] = useState(paperTitle ?? '')
  const [showLink, setShowLink] = useState(Boolean(paperTitle))
  const [moreTagsOpen, setMoreTagsOpen] = useState(false)
  const [note, setNote] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [draftPost, setDraftPost] = useState<ProfessionalPost | null>(null)
  const [editingPreview, setEditingPreview] = useState(false)
  const [previewTitle, setPreviewTitle] = useState('')
  const [previewBody, setPreviewBody] = useState('')

  const reset = () => {
    setStage('closed'); setIntent('practice_update'); setTitle(paperTitle ?? ''); setShowLink(Boolean(paperTitle))
    setMoreTagsOpen(false); setNote(''); setError(''); setDraftPost(null); setEditingPreview(false)
  }

  useEffect(() => {
    if (stage === 'closed') return
    const onKey = (event: KeyboardEvent) => { if (event.key === 'Escape') reset() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [stage])

  const draftWithAgent = async () => {
    setBusy(true); setError('')
    try {
      const result = await draftProfessionalPost(personaId, { type: intent, source_material: { title, note }, case_origin: intent === 'interesting_case' ? 'synthetic_demo' : undefined })
      setDraftPost(result.post)
      setStage('preview')
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not draft this update')
    } finally { setBusy(false) }
  }

  const act = async (action: 'publish' | 'dismiss') => {
    if (!draftPost) return
    setBusy(true); setError('')
    try {
      const result = action === 'publish' ? await publishProfessionalPost(personaId, Number(draftPost.id)) : await dismissProfessionalPost(personaId, Number(draftPost.id))
      if (action === 'publish') onPublished?.(result)
      reset()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not save this update')
    } finally { setBusy(false) }
  }

  const saveEditedPreview = async () => {
    if (!draftPost) return
    setBusy(true)
    try {
      const result = await editProfessionalPost(personaId, Number(draftPost.id), { type: draftPost.type, title: previewTitle.trim(), body: previewBody.trim(), case_origin: draftPost.synthetic_case ? 'synthetic_demo' : undefined })
      setDraftPost(result); setEditingPreview(false)
    } finally { setBusy(false) }
  }

  return <>
    <button className={compact ? 'text-button' : 'button-secondary post-trigger'} onClick={() => { if (paperTitle) setIntent('share_paper'); setStage('compose') }}>{triggerLabel} <span>{compact ? '→' : '+'}</span></button>
    {stage !== 'closed' && <div className="post-flow-overlay" role="presentation" onClick={(event) => { if (event.target === event.currentTarget) reset() }}>
      <div className="post-flow-dialog" role="dialog" aria-modal="true" aria-label="Share an update">
        <button className="text-button post-flow-close" onClick={reset} aria-label="Close">×</button>
        {stage === 'compose' && <>
          <p className="eyebrow">Share update</p>
          <h2>Share an update</h2>
          {intent === 'interesting_case' && <p className="post-synthetic-notice">Demo mode supports synthetic case reflections only.</p>}
          <textarea id="post-note" className="post-composer-body" aria-label="Update text" value={note} onChange={(event) => setNote(event.target.value)} maxLength={2000} placeholder="What would you like to share with your network?" autoFocus />
          <div className="post-optional-controls">
            <button type="button" className="text-button" disabled title="Coming soon">+ Add image</button>
            <button type="button" className="text-button" onClick={() => setShowLink((value) => !value)} aria-expanded={showLink}>+ Add paper/link</button>
          </div>
          {showLink && <input id="post-title" value={title} onChange={(event) => setTitle(event.target.value)} maxLength={240} placeholder="Title, citation, or DOI/URL" aria-label="Paper title or link" />}
          <div className="post-tag-area">
            <span className="post-tag-label">Tag</span>
            <div className="post-tag-chips">
              {PRIMARY_POST_TAGS.map((tag) => <button key={tag.type} type="button" className={`post-tag-chip ${intent === tag.type ? 'active' : ''}`} aria-pressed={intent === tag.type} onClick={() => setIntent(tag.type)}>{tag.label}</button>)}
              <button type="button" className={`post-tag-chip ${moreTagsOpen ? 'active' : ''}`} aria-expanded={moreTagsOpen} onClick={() => setMoreTagsOpen((value) => !value)}>More</button>
            </div>
            {moreTagsOpen && <div className="post-tag-chips post-tag-chips-more">{MORE_POST_TAGS.map((tag) => <button key={tag.type} type="button" className={`post-tag-chip ${intent === tag.type ? 'active' : ''}`} aria-pressed={intent === tag.type} onClick={() => setIntent(tag.type)}>{tag.label}</button>)}</div>}
          </div>
          {error && <p className="demo-reset-error" role="alert">{error}</p>}
          <div className="post-flow-actions"><button className="button-primary" disabled={!note.trim() || busy} onClick={draftWithAgent}>Draft with my agent <span>→</span></button></div>
        </>}
        {stage === 'preview' && draftPost && <>
          <p className="post-drafted-label">Drafted with your Lamina agent</p>
          {editingPreview
            ? <div className="profile-item-form"><input value={previewTitle} onChange={(event) => setPreviewTitle(event.target.value)} maxLength={240} /><textarea value={previewBody} onChange={(event) => setPreviewBody(event.target.value)} maxLength={2000} /></div>
            : <article className="practice-update-card post-preview-card"><p className="practice-update-title">{draftPost.title}</p><p className="practice-update-body">{draftPost.body}</p></article>}
          {error && <p className="demo-reset-error" role="alert">{error}</p>}
          <div className="post-flow-actions">
            {editingPreview
              ? <><button className="button-primary" disabled={!previewTitle.trim() || busy} onClick={saveEditedPreview}>Save</button><button className="text-button" onClick={() => setEditingPreview(false)}>Cancel</button></>
              : <><button className="button-primary" disabled={busy} onClick={() => act('publish')}>Publish</button><button className="button-secondary" disabled={busy} onClick={() => { setEditingPreview(true); setPreviewTitle(draftPost.title); setPreviewBody(draftPost.body) }}>Edit</button><button className="text-button" disabled={busy} onClick={() => act('dismiss')}>Dismiss</button></>}
          </div>
        </>}
      </div>
    </div>}
  </>
}

/* ------------------------------------------------------------------ Interests */

const INTEREST_TYPES: PhysicianInterestType[] = ['case_interest', 'clinical_interest', 'research_interest', 'teaching_interest']
const INTEREST_TYPE_LABELS: Record<PhysicianInterestType, string> = {
  case_interest: 'Case interests', clinical_interest: 'Clinical interests',
  research_interest: 'Research interests', teaching_interest: 'Teaching interests',
}

function InterestForm({ initial, onSave, onCancel, busy }: { initial?: PhysicianInterest; onSave: (fields: { title: string; detail: string }) => void; onCancel: () => void; busy: boolean }) {
  const [title, setTitle] = useState(initial?.title ?? '')
  const [detail, setDetail] = useState(initial?.detail ?? '')
  const uid = initial?.id ?? 'new-interest'
  return <div className="profile-item-form">
    <label htmlFor={`interest-title-${uid}`}>What kind of case or interest?</label>
    <input id={`interest-title-${uid}`} value={title} onChange={(event) => setTitle(event.target.value)} maxLength={240} />
    <label htmlFor={`interest-detail-${uid}`}>Detail <em>Optional</em></label>
    <textarea id={`interest-detail-${uid}`} value={detail} onChange={(event) => setDetail(event.target.value)} maxLength={1000} />
    <div><button className="button-primary" disabled={!title.trim() || busy} onClick={() => onSave({ title: title.trim(), detail: detail.trim() })}>Save</button><button className="text-button" onClick={onCancel}>Cancel</button></div>
  </div>
}

export function InterestGroup({ interestType, items, personaId, onSaved, readOnly }: { interestType: PhysicianInterestType; items: PhysicianInterest[]; personaId?: PhysicianIdentity; onSaved?: () => void; readOnly?: boolean }) {
  const [adding, setAdding] = useState(false)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const save = async (interestId: string | undefined, fields: { title: string; detail: string }) => {
    if (!personaId) return
    setBusy(true)
    try {
      await savePhysicianInterest(personaId, { interest_type: interestType, title: fields.title, detail: fields.detail || null, confirmed: true, shareable: true }, interestId)
      onSaved?.(); setAdding(false); setEditingId(null)
    } finally { setBusy(false) }
  }
  if (readOnly && items.length === 0) return null
  return <div className={`interest-group ${interestType === 'case_interest' ? 'primary' : ''}`}>
    <div className="profile-section-heading"><h3>{INTEREST_TYPE_LABELS[interestType]}</h3>{!readOnly && <button className="text-button" onClick={() => { setAdding(true); setEditingId(null) }}>+ Add</button>}</div>
    {items.length === 0 && !adding && <p className="profile-section-empty">Nothing added yet.</p>}
    <div className="interest-item-list">{items.map((item) => (editingId === item.id
      ? <InterestForm key={item.id} initial={item} busy={busy} onCancel={() => setEditingId(null)} onSave={(fields) => save(item.id, fields)} />
      : <div className="profile-item-row interest-row" key={item.id}>
        <div><strong>{item.title}</strong>{item.detail && <p>{item.detail}</p>}</div>
        {!readOnly && <button className="text-button" onClick={() => { setEditingId(item.id); setAdding(false) }}>Edit</button>}
      </div>))}
    </div>
    {adding && <InterestForm busy={busy} onCancel={() => setAdding(false)} onSave={(fields) => save(undefined, fields)} />}
  </div>
}

export function InterestsPanel({ interests, personaId, onSaved, navigate, trainPath, types = INTEREST_TYPES, id, explainer, readOnly }: {
  interests: PhysicianInterest[]; personaId?: PhysicianIdentity; onSaved?: () => void
  navigate?: Navigate; trainPath?: string; types?: PhysicianInterestType[]; id?: string; explainer?: string; readOnly?: boolean
}) {
  return <section id={id} className="profile-section-v2 interests-panel">
    {!readOnly && <p className="profile-section-explainer">{explainer ?? 'Tell Lamina what areas of medicine and kinds of cases you are particularly interested in. Interests help your agent understand the work you are especially interested in — they do not guarantee referral eligibility or override clinical fit.'}</p>}
    {types.map((type) => <InterestGroup key={type} interestType={type} items={interests.filter((item) => item.interest_type === type)} personaId={personaId} onSaved={onSaved} readOnly={readOnly} />)}
    {navigate && trainPath && interests.length > 0 && <p className="profile-section-explainer interest-training-hint">Lamina can ask follow-up questions based on these interests. <button className="text-button" onClick={() => navigate(trainPath)}>Continue training →</button></p>}
  </section>
}

/* ----------------------------------------------------------------- Enrichment */

function EnrichmentCandidateCard({ candidate, personaId, onReviewed }: { candidate: ProfileCandidateFact; personaId: PhysicianIdentity; onReviewed: (candidate: ProfileCandidateFact) => void }) {
  const [editing, setEditing] = useState(false)
  const [title, setTitle] = useState(candidate.proposed_title)
  const [busy, setBusy] = useState(false)
  const act = async (action: 'confirm' | 'edit_confirm' | 'reject') => {
    setBusy(true)
    try {
      const result = await reviewProfileCandidate(personaId, candidate.candidate_id, action === 'edit_confirm' ? { action, title: title.trim() } : { action })
      onReviewed(result.candidate)
      setEditing(false)
    } finally { setBusy(false) }
  }
  return <article className="learning-card enrichment-candidate">
    <span className="learning-status suggested">Suggested for</span>
    <strong className="enrichment-category">{CATEGORY_LABELS[candidate.category]}</strong>
    {editing ? <input className="enrichment-edit-input" value={title} onChange={(event) => setTitle(event.target.value)} maxLength={240} /> : <p>{candidate.proposed_title}</p>}
    {candidate.proposed_detail && !editing && <p className="enrichment-detail">{candidate.proposed_detail}</p>}
    <p className="enrichment-provenance">Source: {candidate.source_title}{candidate.source_url && <> · <a href={candidate.source_url} target="_blank" rel="noreferrer">View source →</a></>}</p>
    {editing
      ? <div className="learning-edit"><div><button className="button-primary" disabled={!title.trim() || busy} onClick={() => act('edit_confirm')}>Add to profile</button><button className="text-button" onClick={() => setEditing(false)}>Cancel</button></div></div>
      : <div className="learning-actions"><button disabled={busy} onClick={() => act('confirm')}>Add to profile</button><button disabled={busy} onClick={() => setEditing(true)}>Edit &amp; add</button><button disabled={busy} onClick={() => act('reject')}>Dismiss</button></div>}
  </article>
}

function ProfileSuggestionsModal({ personaId, candidates, onClose, onReviewed, triggerRef }: {
  personaId: PhysicianIdentity; candidates: ProfileCandidateFact[]
  onClose: () => void; onReviewed: (candidate: ProfileCandidateFact) => void
  triggerRef: { current: HTMLButtonElement | null }
}) {
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => { if (event.key === 'Escape') onClose() }
    window.addEventListener('keydown', onKey)
    return () => { window.removeEventListener('keydown', onKey); triggerRef.current?.focus() }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])
  return <div className="post-flow-overlay" role="presentation" onClick={(event) => { if (event.target === event.currentTarget) onClose() }}>
    <div className="post-flow-dialog suggestions-dialog" role="dialog" aria-modal="true" aria-label="Profile suggestions">
      <button className="text-button post-flow-close" onClick={onClose} aria-label="Close">×</button>
      <p className="eyebrow">Profile suggestions</p>
      <h2>Lamina found these from public professional sources.</h2>
      <p className="profile-section-explainer">Nothing is added until you approve it.</p>
      {candidates.length === 0
        ? <p className="profile-section-empty">All caught up — no suggestions waiting for review.</p>
        : <div className="learning-grid">{candidates.map((candidate) => <EnrichmentCandidateCard key={candidate.candidate_id} candidate={candidate} personaId={personaId} onReviewed={onReviewed} />)}</div>}
    </div>
  </div>
}

/** Replaces the old inline "Suggested additions" block: a small, dismissible entry point, never the dominant Profile content. */
export function ProfileSuggestionsEntry({ personaId, onConfirmed }: { personaId: PhysicianIdentity; onConfirmed: () => void }) {
  const [job, setJob] = useState<ProfileEnrichmentJob | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [message, setMessage] = useState('')
  const [open, setOpen] = useState(false)
  const triggerRef = useRef<HTMLButtonElement | null>(null)
  useEffect(() => { getProfileEnrichment(personaId).then(setJob).catch(() => {}) }, [personaId])
  useEffect(() => { if (!message) return; const timer = window.setTimeout(() => setMessage(''), 4000); return () => window.clearTimeout(timer) }, [message])

  const runEnrichment = async () => {
    setLoading(true); setError(''); setMessage('')
    try {
      const result = await enrichPhysicianProfile(personaId)
      setJob(result)
      const found = result.candidates.filter((item) => item.review_status === 'suggested').length
      if (found === 0) setMessage('No new profile information found.')
    } catch {
      setError('Public profile enrichment is temporarily unavailable.')
    } finally { setLoading(false) }
  }
  const onReviewed = (candidate: ProfileCandidateFact) => {
    setJob((prev) => (prev ? { ...prev, candidates: prev.candidates.map((item) => (item.candidate_id === candidate.candidate_id ? candidate : item)) } : prev))
    if (candidate.review_status === 'confirmed' || candidate.review_status === 'edited') onConfirmed()
  }
  const pending = job?.candidates.filter((item) => item.review_status === 'suggested') ?? []

  return <div className="profile-suggestions-row">
    {pending.length > 0
      ? <button ref={triggerRef} className="profile-suggestions-indicator" onClick={() => setOpen(true)}>
        <strong>{pending.length} profile suggestion{pending.length === 1 ? '' : 's'}</strong>
        <span>Lamina found public information that may help complete your profile.</span>
        <b>Review suggestions →</b>
      </button>
      : <button ref={triggerRef} className="text-button" disabled={loading} onClick={runEnrichment}>{loading ? 'Looking for public professional information…' : 'Find public information →'}</button>}
    {message && <p className="muted-note" role="status">{message}</p>}
    {error && <p className="demo-reset-error" role="alert">{error}</p>}
    {open && <ProfileSuggestionsModal personaId={personaId} candidates={pending} onClose={() => setOpen(false)} onReviewed={onReviewed} triggerRef={triggerRef} />}
  </div>
}

/* -------------------------------------------------------------- Initialization */

export function InitializationCard({ initialization, navigate, trainPath }: { initialization: AgentInitialization | null; navigate: Navigate; trainPath: string }) {
  if (!initialization || initialization.initialized) return null
  const remaining = initialization.required_steps.filter((step) => !initialization.completed_steps.some((item) => item.id === step.id))
  return <section className="improve-agent-card initialization-card">
    <p className="eyebrow">Set up your agent</p>
    <h2>Build your agent's starting picture of your practice.</h2>
    {remaining.length > 0 && <ul className="initialization-steps">{remaining.map((step) => <li key={step.id}>{step.label}</li>)}</ul>}
    <button className="button-primary" onClick={() => navigate(`${trainPath}?mode=initialization`)}>Continue setup <span>→</span></button>
  </section>
}

/* ------------------------------------------------------------- My Agent: Overview */

/**
 * What the agent is actually doing in the network, not an onboarding/completion
 * metaphor -- built only from real consultation records (each physician-agent
 * evaluation the network returned carries its own specialty), no fabricated
 * metrics. Renders nothing when there's no consultation history yet rather than
 * inventing placeholder activity.
 */
function AgentNetworkActivity({ records }: { records: ConsultationRecord[] }) {
  if (records.length === 0) return null
  const agentNames = new Set<string>()
  const specialtyCounts = new Map<string, number>()
  for (const record of records) {
    for (const evaluation of record.result.consultation) {
      agentNames.add(evaluation.physician_name)
      specialtyCounts.set(evaluation.specialty, (specialtyCounts.get(evaluation.specialty) ?? 0) + 1)
    }
  }
  const ranked = [...specialtyCounts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5)
  const maxCount = ranked[0]?.[1] ?? 1
  return <section className="agent-network-activity">
    <h3 className="agent-analytics-heading">How your agent is behaving in the network</h3>
    <div className="agent-network-stats">
      <div><em>{records.length}</em><span>Network consultation{records.length === 1 ? '' : 's'}</span></div>
      <div><em>{agentNames.size}</em><span>Physician agent{agentNames.size === 1 ? '' : 's'} consulted</span></div>
    </div>
    {ranked.length > 0 && <div className="agent-specialty-distribution">
      <p className="practice-subheading">Specialties your agent reaches out to most</p>
      <ul className="agent-specialty-ranked">{ranked.map(([specialty, count]) => <li key={specialty}>
        <span className="agent-specialty-label">{specialty}</span>
        <span className="agent-specialty-bar-track"><span className="agent-specialty-bar-fill" style={{ width: `${(count / maxCount) * 100}%` }} /></span>
        <span className="agent-specialty-count">{count}</span>
      </li>)}</ul>
    </div>}
  </section>
}

/**
 * Overview now absorbs what used to be a separate Practice tab (post-8B consolidation):
 * identity/summary, confirmed representation, and gaps all live in one place — "How does
 * my agent currently represent me?" is answered on one screen, not split across two.
 */
export function AgentOverviewPanel({ overview, representation, navigate, trainPath, personaId, consultationRecords = [], extra }: {
  overview: AgentOverview | null; representation: PracticeRepresentation | null
  navigate: Navigate; trainPath: string; personaId: PhysicianIdentity; consultationRecords?: ConsultationRecord[]; extra?: ReactNode
}) {
  if (!overview) return <div className="page-state embedded"><div className="loading-line" /><p>Opening your agent…</p></div>
  const training = overview.training
  const primary = training.action === 'continue_setup'
    ? { label: 'Continue setup', href: `${trainPath}?mode=initialization` }
    : training.action === 'resume_training' && training.active_session_id
      ? { label: 'Resume training', href: `${trainPath}?resume=${training.active_session_id}` }
      : training.action === 'start_training' && training.active_session_id
        ? { label: 'Start training', href: `${trainPath}?resume=${training.active_session_id}` }
        : training.action === 'start_training'
        ? { label: 'Train my agent', href: `${trainPath}?mode=daily` }
        : training.action === 'review_training' && training.review_session_id
          ? { label: 'Review training', href: `${trainPath}?review=${training.review_session_id}` }
        : null
  const reviewHref = training.state === 'review_pending' && training.review_session_id ? `${trainPath}?review=${training.review_session_id}` : null
  return <div className="agent-overview-v2">
    <section className="agent-portrait-card">
      <p className="eyebrow">Your agent currently represents you as</p>
      <p className="agent-portrait-text">{overview.portrait}</p>
    </section>
    <div className="agent-stats-row">
      <div><em>{overview.stats.questions_answered_total}</em><span>Questions answered</span></div>
      <div><em>{overview.stats.confirmed_practice_learnings}</em><span>Practice rules confirmed</span></div>
      {overview.stats.case_interests_count > 0 && <div><em>{overview.stats.case_interests_count}</em><span>Case interests</span></div>}
      {overview.stats.network_cases_count > 0 && <div><em>{overview.stats.network_cases_count}</em><span>Network cases</span></div>}
    </div>
    {overview.last_trained_at && <p className="agent-last-trained">Last trained {relativeDayLabel(overview.last_trained_at)}</p>}
    <InitializationCard initialization={overview.initialization} navigate={navigate} trainPath={trainPath} />
    {/* InitializationCard already carries the Continue-setup CTA while setup is
     * incomplete -- a second identical button here would be a visible duplicate. */}
    <div className="agent-overview-actions">
      {primary && training.action !== 'continue_setup' && <button className="button-primary" onClick={() => navigate(primary.href)}>{primary.label} <span>→</span></button>}
      {!primary && <p className="agent-empty-note">Your agent is up to date.</p>}
    </div>
    <AgentNetworkActivity records={consultationRecords} />
    <div className="agent-detail-divider">
      <h2>How your agent currently represents your practice</h2>
      <p className="page-intro">A detailed, structured picture built from setup, training, and your confirmed preferences.</p>
    </div>
    {representation
      ? <PracticeTab representation={representation} personaId={personaId} portrait={null} reviewHref={reviewHref} navigate={navigate} heading={false} extra={extra} />
      : <div className="page-state embedded"><div className="loading-line" /><p>Opening your confirmed representation…</p></div>}
  </div>
}

/* ------------------------------------------------------------- My Agent: Activity */

export type AgentActivityRow = {
  id: string; kind: 'interaction' | 'milestone' | 'training' | 'update'
  title: string; detail: string; time: string; onClick?: () => void
}
const ACTIVITY_KIND_LABELS: Record<AgentActivityRow['kind'], string> = {
  interaction: 'Agent interaction', milestone: 'Consultation milestone', training: 'Training', update: 'Practice update',
}

export function AgentActivityList({ rows }: { rows: AgentActivityRow[] }) {
  if (rows.length === 0) return <p className="agent-empty-note">No agent activity yet. Activity will appear as your agent participates in the Lamina network.</p>
  return <div className="agent-activity-rows">{rows.map((row) => {
    const content = <><NetworkMark resolved={row.kind === 'milestone'} /><span><em className="activity-kind">{ACTIVITY_KIND_LABELS[row.kind]}</em><strong>{row.title}</strong><small>{row.detail}</small><i>{relativeDayLabel(row.time)}</i></span>{row.onClick && <b>→</b>}</>
    return row.onClick
      ? <button className={`agent-activity-row ${row.kind}`} key={row.id} onClick={row.onClick}>{content}</button>
      : <div className={`agent-activity-row ${row.kind} static`} key={row.id}>{content}</div>
  })}</div>
}

/* -------------------------------------------------------------- My Agent: Practice */

const normalizeLabel = (value: string) => value.trim().toLowerCase().replace(/\s+/g, ' ')
/** Internal signal codes (e.g. "ckd_stage_3") are not physician-facing phrases; omit rather than show raw identifiers. */
const isRawSignalCode = (value: string) => /^[a-z][a-z0-9]*(_[a-z0-9]+)+$/.test(value.trim())
const practiceSummarySentence = (portrait: string | undefined | null) => {
  if (!portrait) return null
  const idx = portrait.indexOf('. ')
  return idx === -1 ? portrait : portrait.slice(0, idx + 1)
}

function ChipGroup({ items, prominent }: { items: string[]; prominent?: boolean }) {
  return <div className={`practice-chip-group ${prominent ? 'prominent' : ''}`}>{items.map((item) => <span className="practice-chip" key={item}>{item}</span>)}</div>
}

const INTEREST_CATEGORY_ORDER: PhysicianInterestType[] = ['case_interest', 'clinical_interest', 'research_interest', 'teaching_interest']
const INTEREST_CATEGORY_HEADINGS: Record<PhysicianInterestType, string> = {
  case_interest: "Areas you're especially interested in seeing",
  clinical_interest: 'Clinical interests',
  research_interest: 'Research interests',
  teaching_interest: 'Teaching interests',
}

/**
 * Groups confirmed interests by category for Practice display. Only clinical_interest is
 * suppressed against an identical Clinical Focus label — it's the generic category most
 * likely to just restate a focus area. Case/research/teaching interests keep their own
 * meaning even when the phrase overlaps with a Clinical Focus chip (e.g. a case interest
 * can legitimately repeat a focus area to say "this is the kind of case I want to see").
 * Within-category exact duplicates are still collapsed either way.
 */
export function categorizeInterests(interests: PhysicianInterest[], clinicalFocus: string[]): Array<{ category: PhysicianInterestType; items: PhysicianInterest[] }> {
  const focusLabels = new Set(clinicalFocus.map(normalizeLabel))
  return INTEREST_CATEGORY_ORDER.map((category) => {
    const seen = new Set<string>()
    const items = interests.filter((item) => {
      if (item.interest_type !== category) return false
      const label = normalizeLabel(item.title)
      if (category === 'clinical_interest' && focusLabels.has(label)) return false
      if (seen.has(label)) return false
      seen.add(label)
      return true
    })
    return { category, items }
  }).filter((group) => group.items.length > 0)
}

function ExpandableList({ items, initialCount = 5 }: { items: ReactNode[]; initialCount?: number }) {
  const [expanded, setExpanded] = useState(false)
  const visible = expanded ? items : items.slice(0, initialCount)
  return <>
    <ul className="practice-rule-list">{visible}</ul>
    {items.length > initialCount && <button className="text-button practice-rule-expand" aria-expanded={expanded} onClick={() => setExpanded((value) => !value)}>{expanded ? 'Show fewer' : `Show all ${items.length} rules`} <span>{expanded ? '↑' : '→'}</span></button>}
  </>
}

/** A rule/learning row with a lightweight, always-available revision affordance --
 * these are the physician's CURRENT confirmed representation, not a one-time review
 * queue, so "Looks right" / "Adjust" stays available indefinitely, not just right
 * after training. "Looks right" best-effort reaffirms a real training-derived
 * learning (ids from confirmed_learnings with source_type training_response map to
 * a real proposed-learning record); it is a quiet no-op for plain profile facts,
 * which have no individual backing record to confirm. "Adjust" always just opens
 * Train, where the existing branching/focused-training flow already lives. */
function RuleRow({ text, onAgree, agreed, trainPath, navigate }: {
  text: ReactNode; onAgree?: () => void; agreed?: boolean; trainPath: string; navigate: Navigate
}) {
  return <li className="practice-rule-row">
    <span>{text}</span>
    <span className="practice-rule-row-actions">
      {onAgree && (agreed
        ? <em className="practice-rule-agreed">✓ Looks right</em>
        : <button type="button" className="text-button" onClick={onAgree}>Looks right</button>)}
      <button type="button" className="text-button" onClick={() => navigate(trainPath)}>Adjust</button>
    </span>
  </li>
}

export function PracticeTab({ representation, personaId, portrait, reviewHref, navigate, extra, heading = true }: {
  representation: PracticeRepresentation; personaId: PhysicianIdentity; portrait?: string | null; reviewHref?: string | null; navigate: Navigate; extra?: ReactNode; heading?: boolean
}) {
  const sections = representation.sections
  const summary = practiceSummarySentence(portrait)
  const practiceTrainPath = trainingPath(personaId)
  const [agreedIds, setAgreedIds] = useState<Set<string>>(new Set())
  const agree = (id: number | string, sourceType: string) => {
    setAgreedIds((prev) => new Set(prev).add(String(id)))
    if (sourceType === 'training_response') {
      updateProposedLearning(personaId, Number(id), 'confirm').catch(() => { /* reaffirming is best-effort in this demo */ })
    }
  }
  const clinicalFocus = sections.clinical_focus

  const interestsByCategory = categorizeInterests(sections.interests, clinicalFocus)

  const goodFit = sections.good_fit.filter((item) => !isRawSignalCode(item))
  const notFit = sections.not_a_fit.filter((item) => !isRawSignalCode(item))

  const workupSameAsReferral = sections.referral_requirements.length > 0
    && sections.preferred_workup.length > 0
    && JSON.stringify(sections.referral_requirements) === JSON.stringify(sections.preferred_workup)
  const workupGroups = workupSameAsReferral
    ? [{ label: 'Preferred workup', items: sections.preferred_workup }]
    : [
      { label: 'Referral preferences', items: sections.referral_requirements },
      { label: 'Preferred workup', items: sections.preferred_workup },
    ].filter((group) => group.items.length > 0)

  const ruleLabels = new Set(sections.explicit_rules.map(normalizeLabel))
  const extraLearnings = sections.confirmed_learnings.filter((item) => !ruleLabels.has(normalizeLabel(item.statement)))

  return <div className="practice-tab">
    {heading && <><p className="eyebrow">Practice representation</p><h2>How your agent represents your practice</h2></>}
    {summary && <p className="practice-summary">{summary}</p>}
    {reviewHref && <p className="practice-review-link"><button className="text-button" onClick={() => navigate(reviewHref)}>Review training results →</button></p>}

    {clinicalFocus.length > 0 && <section className="practice-section practice-section-focus">
      <h3 className="practice-section-heading">Clinical focus</h3>
      <ChipGroup items={clinicalFocus} prominent />
    </section>}

    {interestsByCategory.length > 0 && <section className="practice-section practice-section-interests">
      <h3 className="practice-section-heading">Interests</h3>
      {interestsByCategory.map((group) => <div className="practice-interest-group" key={group.category}>
        <p className="practice-subheading">{INTEREST_CATEGORY_HEADINGS[group.category]}</p>
        <ChipGroup items={group.items.map((item) => item.title)} prominent={group.category === 'case_interest'} />
        {group.category === 'case_interest' && sections.interest_safety && <small className="profile-interest-disclaimer">{sections.interest_safety}</small>}
      </div>)}
    </section>}

    {(goodFit.length > 0 || notFit.length > 0) && <section className="practice-section practice-section-fit">
      <h3 className="practice-section-heading">Referral fit</h3>
      <div className="practice-fit-columns">
        {goodFit.length > 0 && <div className="practice-fit-column good"><p className="practice-subheading">Usually a good fit</p><ul className="practice-fit-list">{goodFit.map((item) => <li key={item}><span aria-hidden="true">✓</span> {item}</li>)}</ul></div>}
        {notFit.length > 0 && <div className="practice-fit-column not-fit"><p className="practice-subheading">Usually not a fit</p><ul className="practice-fit-list">{notFit.map((item) => <li key={item}><span aria-hidden="true">—</span> {item}</li>)}</ul></div>}
      </div>
    </section>}

    {(workupGroups.length > 0 || sections.access_facts.length > 0) && <section className="practice-section practice-section-workup">
      <h3 className="practice-section-heading">Before referral</h3>
      <div className="practice-workup-columns">
        {workupGroups.map((group) => <div className="practice-workup-block" key={group.label}><p className="practice-subheading">{group.label}</p><ChipGroup items={group.items} /></div>)}
        {sections.access_facts.length > 0 && <div className="practice-workup-block"><p className="practice-subheading">Access</p><p className="practice-access-line">{sections.access_facts.join(' · ')}</p></div>}
      </div>
    </section>}

    {sections.explicit_rules.length > 0 && <section className="practice-section practice-section-rules">
      <h3 className="practice-section-heading">Practice rules</h3>
      <p className="practice-subcopy">Confirmed guidance your agent uses when representing how you practice. Not set in stone -- revise anytime.</p>
      <ExpandableList items={sections.explicit_rules.map((item) => <RuleRow key={item} text={item} trainPath={practiceTrainPath} navigate={navigate} />)} />
    </section>}

    {extraLearnings.length > 0 && <section className="practice-section practice-section-learnings">
      <h3 className="practice-section-heading">Confirmed from your training</h3>
      <ExpandableList items={extraLearnings.map((item) => <RuleRow key={item.id} text={item.statement} trainPath={practiceTrainPath} navigate={navigate} agreed={agreedIds.has(String(item.id))} onAgree={() => agree(item.id, item.source_type)} />)} />
    </section>}

    {extra}
  </div>
}

/* ----------------------------------------------------------------- My Agent: Train */

function trainHistorySummaryLine(entry: TrainingHistoryEntry) {
  const parts: string[] = []
  if (entry.confirmed_count) parts.push(`${entry.confirmed_count} learning${entry.confirmed_count === 1 ? '' : 's'} confirmed`)
  if (entry.edited_count) parts.push(`${entry.edited_count} learning${entry.edited_count === 1 ? '' : 's'} edited`)
  if (parts.length > 0) return parts.join(' · ')
  if (entry.proposed_count > entry.confirmed_count + entry.edited_count + entry.rejected_count) return 'Review pending'
  return 'No new practice rules'
}

export function findPendingReviewHistoryEntry(history: TrainingHistoryEntry[]): TrainingHistoryEntry | null {
  return history.find((item) => item.proposed_count > item.confirmed_count + item.edited_count + item.rejected_count) ?? null
}

export function TrainTab({ trainProjection, navigate, trainPath }: {
  trainProjection: TrainProjection | null
  navigate: Navigate; trainPath: string
}) {
  if (!trainProjection) return <div className="page-state embedded"><div className="loading-line" /><p>Opening training…</p></div>
  const activeId = trainProjection.active_session_id
  const reviewId = trainProjection.review_session_id
  return <div className="train-tab-v2">
    <h2>Train your agent</h2>
    <p className="panel-intro">Answer a few quick questions about how you practice. Your answers help Lamina represent your preferences more accurately.</p>
    {trainProjection.state === 'initialization_needed'
      ? <div className="train-primary-card">
        <p className="section-label">Set up your agent</p>
        <h3>Complete your first 10-question session</h3>
        <button className="button-primary" onClick={() => navigate(activeId ? `${trainPath}?resume=${activeId}` : `${trainPath}?mode=initialization`)}>Continue setup <span>→</span></button>
      </div>
      : trainProjection.state === 'active_unstarted' && activeId
        ? <div className="train-primary-card">
          <p className="section-label">Train your agent</p>
          <h3>{trainProjection.answer_target ?? 10} questions</h3>
          <button className="button-primary" onClick={() => navigate(`${trainPath}?resume=${activeId}`)}>Start training <span>→</span></button>
        </div>
        : trainProjection.state === 'active_in_progress' && activeId
          ? <div className="train-primary-card">
            <p className="section-label">Training in progress</p>
            <h3>{trainProjection.answered_count} of {trainProjection.answer_target ?? 10} answered</h3>
            <button className="button-primary" onClick={() => navigate(`${trainPath}?resume=${activeId}`)}>Resume training <span>→</span></button>
          </div>
      : trainProjection.state === 'review_pending' && reviewId
        ? <div className="train-primary-card">
          <p className="section-label">Training complete</p>
          <h3>Review what your agent learned</h3>
          <button className="button-primary" onClick={() => navigate(`${trainPath}?review=${reviewId}`)}>Review learnings <span>→</span></button>
        </div>
        : trainProjection.state === 'ready'
          ? <div className="train-primary-card">
            <p className="section-label">Today's training</p>
            <h3>10 questions</h3>
            <button className="button-primary" onClick={() => navigate(`${trainPath}?mode=daily`)}>Start training <span>→</span></button>
          </div>
          : <p className="agent-empty-note">Your agent is caught up for now.</p>}
    {(trainProjection.questions_answered_total > 0 || trainProjection.recent_training_history.length > 0) && <div className="train-history-summary">
      <span>{trainProjection.questions_answered_total} questions answered</span>
      <span>{trainProjection.sessions_completed} session{trainProjection.sessions_completed === 1 ? '' : 's'} completed</span>
      {trainProjection.last_trained_at && <span>Last trained {relativeDayLabel(trainProjection.last_trained_at)}</span>}
    </div>}
    {trainProjection.recent_training_history.length > 0 && <div className="train-history">
      <p className="section-label">Training history</p>
      {trainProjection.recent_training_history.map((entry) => <div className="train-history-row" key={entry.session_id}>
        <strong>{relativeDayLabel(entry.started_at)}</strong>
        <span>{entry.target_count} question{entry.target_count === 1 ? '' : 's'}</span>
        <small>{trainHistorySummaryLine(entry)}</small>
      </div>)}
    </div>}
  </div>
}

/* ------------------------------------------------------------------ My Agent: Chat */

const CHAT_STARTER_PROMPTS = [
  'What kinds of cases am I most interested in?',
  'What have you learned about how I practice?',
  'When would I choose nephrology over cardiology?',
  'What do I usually want before a referral?',
  'Where are you still unsure about me?',
]

type ChatMessage = {
  id: string; role: 'physician' | 'agent'; text: string
  response?: AgentChatResponse; feedbackState?: 'reflects' | 'not_quite'
  focusedSeed?: FocusedTrainingSeed | null
}

function ChatMessageBubble({ message, agentName, onFeedback, onStartFocused, busy }: {
  message: ChatMessage; agentName: string
  onFeedback: (message: ChatMessage, value: 'reflects' | 'not_quite') => void
  onStartFocused: (seed: FocusedTrainingSeed) => void
  busy: boolean
}) {
  if (message.role === 'physician') return <p className="chat-message physician">{message.text}</p>
  const response = message.response
  return <div className="chat-message agent">
    <span className="chat-agent-label"><AgentAvatar /> {agentName}</span>
    <p>{message.text}</p>
    {response?.uncertainty && <p className="chat-uncertainty">{response.uncertainty}</p>}
    {response && (response.based_on.length > 0 || response.evidence_summary.length > 0) && <p className="chat-grounding">Based on: {response.based_on.length > 0 ? `${response.based_on.length} confirmed practice rule${response.based_on.length === 1 ? '' : 's'}` : response.evidence_summary.join(', ')}</p>}
    {!message.feedbackState && <div className="chat-feedback"><span>Does this reflect how you would practice?</span><button className="text-button" onClick={() => onFeedback(message, 'reflects')}>Yes, that's right</button><button className="text-button" onClick={() => onFeedback(message, 'not_quite')}>Not quite</button></div>}
    {message.feedbackState === 'reflects' && <p className="chat-feedback-done">Thanks — noted.</p>}
    {message.feedbackState === 'not_quite' && message.focusedSeed && <div className="chat-focused-prompt">
      <p className="section-label">Teach your agent about this</p>
      <p>I can ask a few focused questions to understand what you would do instead.</p>
      <button className="button-secondary" disabled={busy} onClick={() => onStartFocused(message.focusedSeed!)}>Start focused training <span>→</span></button>
    </div>}
  </div>
}

const VISIBLE_STARTER_PROMPT_COUNT = 3

export function ChatTab({ personaId, agentName, navigate, trainPath }: {
  personaId: PhysicianIdentity; agentName: string; navigate: Navigate; trainPath: string
}) {
  const [cases, setCases] = useState<AgentTestCase[]>([])
  const [casesOpen, setCasesOpen] = useState(true)
  const [messages, setMessages] = useState<ChatMessage[]>([])
  const [activeCase, setActiveCase] = useState<AgentTestCase | null>(null)
  const [input, setInput] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [promptRotation, setPromptRotation] = useState(0)
  useEffect(() => { getAgentTestCases(personaId).then(setCases).catch(() => {}) }, [personaId])
  const visiblePrompts = Array.from(
    { length: Math.min(VISIBLE_STARTER_PROMPT_COUNT, CHAT_STARTER_PROMPTS.length) },
    (_, i) => CHAT_STARTER_PROMPTS[(promptRotation + i) % CHAT_STARTER_PROMPTS.length],
  )

  const sendStarterPrompt = (prompt: string) => {
    setPromptRotation((value) => value + 1)
    void send(prompt, 'practice_question')
  }

  const send = async (text: string, mode: 'practice_question' | 'synthetic_case', testCaseId?: string) => {
    const trimmed = text.trim()
    if (!trimmed || busy) return
    setBusy(true); setError('')
    setMessages((prev) => [...prev, { id: `u-${crypto.randomUUID()}`, role: 'physician', text: trimmed }])
    setInput('')
    try {
      const response = await chatWithAgent(personaId, { mode, message: trimmed, controlled_test_case_id: testCaseId, origin: mode === 'synthetic_case' ? 'synthetic_demo' : 'practice' })
      setMessages((prev) => [...prev, { id: response.response_id, role: 'agent', text: response.answer, response }])
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not reach your agent')
    } finally { setBusy(false) }
  }

  const tryCase = (testCase: AgentTestCase) => { setActiveCase(testCase); void send('How would I handle this?', 'synthetic_case', testCase.id) }

  const feedback = async (message: ChatMessage, value: 'reflects' | 'not_quite') => {
    setMessages((prev) => prev.map((item) => (item.id === message.id ? { ...item, feedbackState: value } : item)))
    try {
      const result = await submitAgentChatFeedback(personaId, message.id, value)
      if (value === 'not_quite') setMessages((prev) => prev.map((item) => (item.id === message.id ? { ...item, focusedSeed: result.focused_training_seed } : item)))
    } catch { /* feedback is best-effort in this demo */ }
  }

  const startFocused = async (seed: FocusedTrainingSeed) => {
    setBusy(true); setError('')
    try {
      const session = await startFocusedTraining(personaId, seed.seed_id)
      navigate(`${trainPath}?resume=${session.id}`)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not start focused training')
    } finally { setBusy(false) }
  }

  return <div className="chat-tab-grid">
    <div className="chat-tab-main">
      <p className="eyebrow">Test</p>
      <h2>Test how your agent currently represents you.</h2>
      <p className="panel-intro">Ask how your agent represents your practice, or try it on a synthetic case.</p>
      <p className="chat-boundary-note">Synthetic · no PHI. Use synthetic or hypothetical cases in this demo.</p>
      {messages.length > 0 && <div className="chat-thread" role="log" aria-live="polite">
        {activeCase && <div className="chat-case-context"><span className="section-label">Synthetic case</span><strong>{activeCase.title}</strong><ul className="clinical-list">{activeCase.facts.map((fact) => <li key={fact}>{fact}</li>)}</ul></div>}
        {messages.map((message) => <ChatMessageBubble key={message.id} message={message} agentName={agentName} onFeedback={feedback} onStartFocused={startFocused} busy={busy} />)}
        {busy && <div className="chat-message agent typing"><span className="chat-agent-label"><AgentAvatar /> {agentName}</span><p className="chat-typing-dots" aria-label={`${agentName} is answering`}><span /><span /><span /></p></div>}
      </div>}
      {error && <p className="demo-reset-error" role="alert">{error}</p>}
      <div className="chat-starter-prompts">{visiblePrompts.map((prompt) => <button key={prompt} type="button" className="chat-starter-prompt" disabled={busy} onClick={() => sendStarterPrompt(prompt)}>{prompt}</button>)}</div>
      <form className="chat-composer" onSubmit={(event) => { event.preventDefault(); void send(input, 'practice_question') }}>
        <label htmlFor="chat-input" className="sr-only">Ask your agent about your practice</label>
        <input id="chat-input" value={input} onChange={(event) => setInput(event.target.value)} placeholder="Ask your agent about your practice…" disabled={busy} />
        <button className="button-primary" type="submit" disabled={busy || !input.trim()}>Send</button>
      </form>
    </div>
    {cases.length > 0 && <aside className="chat-case-panel patient-top-card">
      <button type="button" className="chat-case-panel-toggle" aria-expanded={casesOpen} onClick={() => setCasesOpen((value) => !value)}>
        <span>Try a synthetic case</span><span aria-hidden="true">{casesOpen ? '−' : '+'}</span>
      </button>
      {casesOpen && <div className="chat-case-panel-list">{cases.map((item) => <button key={item.id} type="button" className={`chat-case-panel-item ${activeCase?.id === item.id ? 'active' : ''}`} onClick={() => tryCase(item)}>
        <strong>{item.title}</strong><span>{item.summary}</span>
      </button>)}</div>}
    </aside>}
  </div>
}

const BACKGROUND_CATEGORIES: ProfileCategory[] = ['training', 'experience', 'affiliations']
const agentPracticePath = (perspective: PhysicianIdentity) => (perspective === 'iain' ? '/specialist/agent' : perspective === 'owner' ? '/me/agent?tab=practice' : '/agent?tab=knowledge')
/** Legacy ?tab= deep links degrade to a scroll target on the one continuous page, or a redirect for the retired Updates tab. */
const LEGACY_PROFILE_TAB_SECTION: Record<string, string | null> = {
  overview: null, background: 'profile-section-training', research: 'profile-section-research', interests: 'profile-section-interests',
}

export function ProfessionalProfilePage({ personaId, navigate, params }: { personaId: PhysicianIdentity; navigate: Navigate; params?: URLSearchParams }) {
  const [profile, setProfile] = useState<ProfessionalProfile | null>(null)
  const [initialization, setInitialization] = useState<AgentInitialization | null>(null)
  const [error, setError] = useState('')
  const [savedNote, setSavedNote] = useState('')
  const load = () => {
    getProfessionalProfile(personaId).then(setProfile).catch((err: Error) => setError(err.message))
    getAgentInitialization(personaId).then(setInitialization).catch(() => {})
  }
  useEffect(load, [personaId]) // eslint-disable-line react-hooks/exhaustive-deps
  const tabParam = params?.get('tab') ?? null
  useEffect(() => {
    if (tabParam === 'updates') { if (personaId !== 'owner') navigate(networkUpdatesPath(personaId)); return }
    const sectionId = tabParam ? LEGACY_PROFILE_TAB_SECTION[tabParam] : null
    if (!sectionId || !profile) return
    const frame = window.requestAnimationFrame(() => document.getElementById(sectionId)?.scrollIntoView({ behavior: 'smooth', block: 'start' }))
    return () => window.cancelAnimationFrame(frame)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tabParam, profile])
  useEffect(() => { if (!savedNote) return; const timer = window.setTimeout(() => setSavedNote(''), 2600); return () => window.clearTimeout(timer) }, [savedNote])
  const onItemSaved = () => { load(); setSavedNote('Saved.') }

  if (error) return <main className="page-shell profile-page"><div className="error-banner" role="alert">{error}</div></main>
  if (!profile) return <main className="page-shell profile-page"><p className="muted-note">Opening professional profile…</p></main>

  const initials = profile.physician.name.replace('Dr. ', '').split(/\s+/).map((part) => part[0]).slice(0, 2).join('')
  const scrollToAbout = () => document.getElementById('profile-section-about')?.scrollIntoView({ behavior: 'smooth', block: 'start' })

  const researchInterests = profile.interests.filter((item) => item.interest_type === 'research_interest')
  const teachingInterests = profile.interests.filter((item) => item.interest_type === 'teaching_interest')
  const hasResearchSection = profile.sections.research.length > 0 || profile.sections.publications.length > 0 || researchInterests.length > 0
  const hasTeachingSection = profile.sections.teaching.length > 0 || teachingInterests.length > 0
  const hasSkills = profile.sections.skills_or_procedures.length > 0
  const hasLanguages = profile.sections.languages.length > 0
  const hasLocations = profile.sections.locations.length > 0
  const hasLinks = profile.sections.professional_links.length > 0

  return <main className="page-shell profile-page professional-profile-page">
    <header className="profile-hero">
      <span className="clinician-avatar large">{initials}</span>
      <div>
        <h1>{profile.physician.name}</h1>
        <p className="profile-role">{profile.physician.specialty}</p>
        <p className="profile-location">{profile.physician.location}</p>
      </div>
    </header>
    <div className="profile-header-actions">
      <button className="button-secondary" onClick={scrollToAbout}>Edit profile</button>
      {personaId !== 'owner' && <button className="text-button" onClick={() => navigate(networkProfilePath(personaId, profile.physician.id))}>View as others see it →</button>}
      <button className="text-button" onClick={() => navigate(agentPracticePath(personaId))}>View how my agent represents me →</button>
    </div>
    {savedNote && <p className="profile-save-note" role="status">{savedNote}</p>}
    <InitializationCard initialization={initialization} navigate={navigate} trainPath={trainingPath(personaId)} />
    <ProfileSuggestionsEntry personaId={personaId} onConfirmed={load} />

    <AboutSection items={profile.sections.about} personaId={personaId} onSaved={onItemSaved} />

    <section id="profile-section-training" className="profile-block">
      <h2 className="profile-block-heading">Background</h2>
      {BACKGROUND_CATEGORIES.map((category) => <ProfileTimelineGroup key={category} category={category} items={profile.sections[category]} personaId={personaId} onSaved={onItemSaved} />)}
    </section>

    <InterestsPanel
      id="profile-section-interests"
      interests={profile.interests}
      personaId={personaId}
      onSaved={onItemSaved}
      navigate={navigate}
      trainPath={trainingPath(personaId)}
      types={['case_interest', 'clinical_interest']}
      explainer="Case interests describe areas of professional interest. Clinical appropriateness still determines referral fit."
    />

    {hasResearchSection && <section id="profile-section-research" className="profile-block">
      <h2 className="profile-block-heading">Research &amp; publications</h2>
      {researchInterests.length > 0 && <InterestGroup interestType="research_interest" items={researchInterests} personaId={personaId} onSaved={onItemSaved} />}
      <ProfileSection category="research" items={profile.sections.research} personaId={personaId} onSaved={onItemSaved} quiet />
      <ProfileSection category="publications" items={profile.sections.publications} personaId={personaId} onSaved={onItemSaved} quiet
        itemActions={personaId === 'owner' ? undefined : (item) => <PostButton personaId={personaId} paperTitle={item.title} triggerLabel="Share this paper" compact />} />
    </section>}

    {hasTeachingSection && <section id="profile-section-teaching" className="profile-block">
      <h2 className="profile-block-heading">Teaching</h2>
      {teachingInterests.length > 0 && <InterestGroup interestType="teaching_interest" items={teachingInterests} personaId={personaId} onSaved={onItemSaved} />}
      <ProfileSection category="teaching" items={profile.sections.teaching} personaId={personaId} onSaved={onItemSaved} quiet />
    </section>}

    {hasSkills && <ProfileChipSection category="skills_or_procedures" items={profile.sections.skills_or_procedures} personaId={personaId} onSaved={onItemSaved} heading="Skills &amp; procedures" />}
    {hasLanguages && <ProfileChipSection category="languages" items={profile.sections.languages} personaId={personaId} onSaved={onItemSaved} />}
    {hasLocations && <ProfileSection category="locations" items={profile.sections.locations} personaId={personaId} onSaved={onItemSaved} heading="Practice &amp; locations" />}
    {hasLinks && <ProfileSection category="professional_links" items={profile.sections.professional_links} personaId={personaId} onSaved={onItemSaved} heading="Professional links" />}
  </main>
}

export function NetworkPhysicianProfilePage({ controlledId, navigate, backPath }: { controlledId: string; navigate: Navigate; backPath: string }) {
  const [data, setData] = useState<import('./api.ts').NetworkPhysicianProfile | null>(null)
  const [error, setError] = useState('')
  useEffect(() => { setData(null); setError(''); getNetworkPhysicianProfile(controlledId).then(setData).catch((err: Error) => setError(err.message)) }, [controlledId])
  if (error) return <main className="page-shell profile-page"><button className="text-button back-link" onClick={() => navigate(backPath)}>← Back</button><div className="error-banner" role="alert">{error}</div></main>
  if (!data) return <main className="page-shell profile-page"><button className="text-button back-link" onClick={() => navigate(backPath)}>← Back</button><p className="muted-note">Opening profile…</p></main>
  const rep = data.practice_representation
  const caseInterests = rep.interests.filter((item) => item.interest_type === 'case_interest')
  const otherInterests = rep.interests.filter((item) => item.interest_type !== 'case_interest')
  const initials = data.physician.name.replace('Dr. ', '').split(/\s+/).map((part) => part[0]).slice(0, 2).join('')
  const sections = data.professional_profile.sections
  const researchInterests = data.professional_profile.interests.filter((item) => item.interest_type === 'research_interest')
  const teachingInterests = data.professional_profile.interests.filter((item) => item.interest_type === 'teaching_interest')
  const hasResearchSection = sections.research.length > 0 || sections.publications.length > 0 || researchInterests.length > 0
  const hasTeachingSection = sections.teaching.length > 0 || teachingInterests.length > 0
  return <main className="page-shell profile-page">
    <button className="text-button back-link" onClick={() => navigate(backPath)}>← Back</button>
    <header className="profile-hero"><span className="clinician-avatar large">{initials}</span><div><h1>{data.physician.name}</h1><p className="profile-role">{data.physician.specialty}</p><p className="profile-location">{data.physician.location}</p></div></header>
    <section className="practice-representation-panel"><p className="eyebrow">How the network sees this practice</p>
      {rep.clinical_focus.length > 0 && <div><span className="section-label">Clinical focus</span><ul className="clinical-list">{rep.clinical_focus.map((item) => <li key={item}>{item}</li>)}</ul></div>}
      {rep.good_fit.length > 0 && <div><span className="section-label">Good-fit cases</span><ul className="clinical-list">{rep.good_fit.map((item) => <li key={item}>{item}</li>)}</ul></div>}
      {rep.preferred_workup.length > 0 && <div><span className="section-label">Referral guidance</span><ul className="clinical-list">{rep.preferred_workup.map((item) => <li key={item}>{item}</li>)}</ul></div>}
      {caseInterests.length > 0 && <div><span className="section-label">Areas {data.physician.name} is especially interested in seeing</span><ul className="clinical-list">{caseInterests.map((item) => <li key={item.id}>{item.title}</li>)}</ul><small className="profile-interest-disclaimer">Interests reflect what {data.physician.name} wants referring physicians to know. They do not guarantee referral eligibility or override clinical fit.</small></div>}
      {otherInterests.length > 0 && <div><span className="section-label">Research &amp; teaching interests</span><ul className="clinical-list">{otherInterests.map((item) => <li key={item.id}>{item.title}</li>)}</ul></div>}
    </section>

    <AboutSection items={sections.about} readOnly />

    {(sections.training.length > 0 || sections.experience.length > 0 || sections.affiliations.length > 0) && <section className="profile-block">
      <h2 className="profile-block-heading">Background</h2>
      <ProfileTimelineGroup category="training" items={sections.training} readOnly />
      <ProfileTimelineGroup category="experience" items={sections.experience} readOnly />
      <ProfileTimelineGroup category="affiliations" items={sections.affiliations} readOnly />
    </section>}

    {(sections.clinical_interests.length > 0 || data.professional_profile.interests.some((item) => item.interest_type === 'case_interest' || item.interest_type === 'clinical_interest')) &&
      <InterestsPanel interests={data.professional_profile.interests} types={['case_interest', 'clinical_interest']} readOnly />}

    {hasResearchSection && <section className="profile-block">
      <h2 className="profile-block-heading">Research &amp; publications</h2>
      {researchInterests.length > 0 && <InterestGroup interestType="research_interest" items={researchInterests} readOnly />}
      <ProfileSection category="research" items={sections.research} quiet readOnly />
      <ProfileSection category="publications" items={sections.publications} quiet readOnly />
    </section>}

    {hasTeachingSection && <section className="profile-block">
      <h2 className="profile-block-heading">Teaching</h2>
      {teachingInterests.length > 0 && <InterestGroup interestType="teaching_interest" items={teachingInterests} readOnly />}
      <ProfileSection category="teaching" items={sections.teaching} quiet readOnly />
    </section>}

    {sections.skills_or_procedures.length > 0 && <ProfileChipSection category="skills_or_procedures" items={sections.skills_or_procedures} readOnly heading="Skills &amp; procedures" />}
    {sections.languages.length > 0 && <ProfileChipSection category="languages" items={sections.languages} readOnly />}
    {sections.locations.length > 0 && <ProfileSection category="locations" items={sections.locations} readOnly heading="Practice &amp; locations" />}
    {sections.professional_links.length > 0 && <ProfileSection category="professional_links" items={sections.professional_links} readOnly heading="Professional links" />}

    {data.published_updates.length > 0 && <section className="profile-section-v2"><div className="profile-section-heading"><h2>Practice updates</h2></div>{data.published_updates.map((update) => <article className="practice-update-card" key={update.id}><p className="practice-update-title">{update.title}</p><p className="practice-update-body">{update.body}</p></article>)}</section>}
    <p className="disclaimer">{data.disclaimer}</p>
  </main>
}
