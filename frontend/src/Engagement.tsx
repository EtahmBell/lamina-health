import { useEffect, useRef, useState, type ReactNode } from 'react'
import {
  ApiError,
  answerTrainingQuestion,
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
  getNetworkFeed,
  getNetworkPhysicianProfile,
  getPhysicianInterests,
  getPhysicianTraining,
  getPhysicianUpdates,
  getProfessionalPosts,
  getProfessionalProfile,
  getProfileEnrichment,
  publishPracticeUpdate,
  publishProfessionalPost,
  resumeTrainingSession,
  reviewProfileCandidate,
  savePhysicianInterest,
  startTrainingSession,
  updateProfessionalProfileItem,
  updateProposedLearning,
  type AgentInitialization,
  type DemoPhysicianPerspective,
  type NetworkFeed,
  type NetworkFeedItem,
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
  type TrainingQuestion,
  type TrainingQueueSummary,
  type TrainingResponse,
  type TrainingSession,
} from './api.ts'
import { patientName } from './demoIdentity.ts'
import { LaminaMark } from './LaminaMark.tsx'

type Navigate = (path: string) => void

function NetworkMark({ active = false, resolved = false }: { active?: boolean; resolved?: boolean }) {
  return <LaminaMark active={active} resolved={resolved} />
}

const prefersReducedMotion = () => window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false

/* -------------------------------------------------------------------- paths */

export const trainingPath = (perspective: DemoPhysicianPerspective) => (perspective === 'iain' ? '/specialist/agent/train' : '/agent/train')
export const professionalProfilePath = (perspective: DemoPhysicianPerspective) => (perspective === 'iain' ? '/specialist/profile' : '/profile')
export const networkProfilePath = (perspective: DemoPhysicianPerspective, controlledId: string) => (perspective === 'iain' ? `/specialist/network/profile/${controlledId}` : `/network/profile/${controlledId}`)
export const networkUpdatesPath = (perspective: DemoPhysicianPerspective) => (perspective === 'iain' ? '/specialist/network/updates' : '/network/updates')
export const settingsPath = '/settings'

/* ------------------------------------------------------------- Home: engagement */

export function ImproveAgentCard({ representation, queueSummary, resumeSessionId, navigate, trainPath }: {
  representation: PracticeRepresentation | null; queueSummary: TrainingQueueSummary | null
  resumeSessionId: number | null; navigate: Navigate; trainPath: string
}) {
  if (!representation) return null
  const waiting = representation.completeness.questions_waiting
  const confirmedCount = representation.completeness.confirmed_practice_item_count
  const recommendedToday = queueSummary?.recommended_today ?? waiting
  return <section className={`improve-agent-card ${waiting === 0 && !resumeSessionId ? 'done' : ''}`}>
    <p className="eyebrow">Improve your agent</p>
    {resumeSessionId
      ? <h2>You have an unfinished training session.</h2>
      : waiting > 0
        ? <h2>{recommendedToday} recommended question{recommendedToday === 1 ? '' : 's'} today could help your agent represent your practice more accurately.</h2>
        : <h2>Your agent is up to date.</h2>}
    <p className="improve-agent-stat">{confirmedCount} practice area{confirmedCount === 1 ? '' : 's'} confirmed{waiting > 0 ? ` · ${waiting} question${waiting === 1 ? '' : 's'} waiting` : ''}.</p>
    {resumeSessionId
      ? <button className="button-primary" onClick={() => navigate(`${trainPath}?resume=${resumeSessionId}`)}>Resume training <span>→</span></button>
      : waiting > 0 && <button className="button-primary" onClick={() => navigate(`${trainPath}?mode=daily`)}>Start daily training <span>→</span></button>}
  </section>
}

const FEED_TYPE_LABELS: Record<string, string> = {
  practice_focus: 'Practice', referral_guidance: 'Referral guidance', availability: 'Availability',
  publication: 'Research', research: 'Research', research_update: 'Research', teaching: 'Teaching', teaching_update: 'Teaching',
  location: 'Practice', professional_update: 'Practice update', profile_update: 'Profile update', practice_update: 'Practice',
  share_paper: 'Research', interesting_case: 'Case reflection', other: 'Update',
}

function FeedCard({ item, navigate, perspective }: { item: NetworkFeedItem; navigate: Navigate; perspective: DemoPhysicianPerspective }) {
  return <article className="feed-card">
    <div className="feed-card-physician"><strong>{item.physician.name}</strong><small>{item.physician.specialty}</small></div>
    <span className="feed-card-tag">{FEED_TYPE_LABELS[item.type] ?? 'Update'}</span>
    <p className="feed-card-title">{item.title}</p>
    <p className="feed-card-body">{item.body}</p>
    <button className="text-button" onClick={() => navigate(networkProfilePath(perspective, item.physician.id))}>View profile <b>→</b></button>
  </article>
}

export function NetworkFeedSection({ feed, navigate, perspective, limit = 4 }: { feed: NetworkFeed | null; navigate: Navigate; perspective: DemoPhysicianPerspective; limit?: number }) {
  if (!feed) return null
  return <section className="network-feed-section">
    <div className="home-section-heading"><div><h2>Network pulse</h2><p className="network-pulse-subtitle">What changed among the physicians and practices your network actually interacts with.</p></div>{feed.items.length > 0 && <button className="text-button" onClick={() => navigate(networkUpdatesPath(perspective))}>View all →</button>}</div>
    {feed.items.length === 0
      ? <p className="home-empty">No network updates yet. Updates will appear as physicians and agents in your network share changes.</p>
      : <div className="feed-grid">{feed.items.slice(0, limit).map((item) => <FeedCard key={item.id} item={item} navigate={navigate} perspective={perspective} />)}</div>}
  </section>
}

export function FullNetworkFeedPage({ feed, navigate, perspective, error }: { feed: NetworkFeed | null; navigate: Navigate; perspective: DemoPhysicianPerspective; error: string }) {
  return <main className="page-shell history-page">
    <p className="eyebrow">Network pulse</p>
    <h1>Network updates</h1>
    <p className="page-intro">The chronological, relationship-derived feed for physicians and practices your network actually interacts with.</p>
    {error && <div className="error-banner" role="alert">{error}</div>}
    {!feed && !error && <p className="muted-note">Loading network updates…</p>}
    {feed && feed.items.length === 0 && <p className="home-empty">No network updates yet. Updates will appear as physicians and agents in your network share changes.</p>}
    {feed && feed.items.length > 0 && <div className="feed-grid full-feed-grid">{feed.items.map((item) => <FeedCard key={item.id} item={item} navigate={navigate} perspective={perspective} />)}</div>}
  </main>
}

/* ---------------------------------------------------- Practice representation */

export function PracticeRepresentationPanel({ representation }: { representation: PracticeRepresentation }) {
  const sections = representation.sections
  const group = (label: string, items: string[]) => items.length > 0 && <div key={label}><span className="section-label">{label}</span><ul className="clinical-list">{items.map((item) => <li key={item}>{item}</li>)}</ul></div>
  const caseInterests = sections.interests.filter((item) => item.interest_type === 'case_interest')
  return <section className="practice-representation-panel">
    <p className="eyebrow">How the network sees your practice</p>
    <h2>How your agent represents you</h2>
    {group('Clinical focus', sections.clinical_focus)}
    {caseInterests.length > 0 && <div><span className="section-label">Case interests</span><ul className="clinical-list">{caseInterests.map((item) => <li key={item.id}>{item.title}</li>)}</ul></div>}
    {group('Good-fit cases', sections.good_fit)}
    {group('Usually not a fit', sections.not_a_fit)}
    {group('Referral guidance', sections.preferred_workup)}
    {group('Confirmed rules', sections.explicit_rules)}
    {sections.confirmed_learnings.length > 0 && <div><span className="section-label">Confirmed from training</span><ul className="clinical-list">{sections.confirmed_learnings.map((item) => <li key={item.id}>{item.statement}</li>)}</ul></div>}
    <p className="practice-representation-note">{representation.completeness.meaning}</p>
    {sections.interest_safety && <p className="practice-representation-note">{sections.interest_safety}</p>}
  </section>
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
      return { tag: 'Practice gap', detail: 'Your agent is missing guidance here' }
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

type TrainingPhase = 'loading' | 'empty' | 'questions' | 'reviewing' | 'error'
type TrainingMode = 'initialization' | 'daily' | 'extended'

export function TrainingPage({ personaId, agentName, navigate, exitPath, params }: { personaId: DemoPhysicianPerspective; agentName: string; navigate: Navigate; exitPath: string; params?: URLSearchParams }) {
  const modeParam = (params?.get('mode') as TrainingMode | null) ?? 'daily'
  const resumeParam = params?.get('resume')
  const [phase, setPhase] = useState<TrainingPhase>('loading')
  const [session, setSession] = useState<TrainingSession | null>(null)
  const [queue, setQueue] = useState<TrainingQuestion[]>([])
  const [index, setIndex] = useState(0)
  const [cardState, setCardState] = useState<'idle' | 'leaving'>('idle')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [multiSelected, setMultiSelected] = useState<string[]>([])
  const [textAnswer, setTextAnswer] = useState('')
  const [finishResult, setFinishResult] = useState<{ responses: TrainingResponse[] } | null>(null)
  const [learnings, setLearnings] = useState<ProposedLearning[]>([])
  const [editingLearningId, setEditingLearningId] = useState<number | null>(null)
  const [draft, setDraft] = useState('')
  const [branchNote, setBranchNote] = useState<string | null>(null)
  const [queueSummary, setQueueSummary] = useState<TrainingQueueSummary | null>(null)
  const starterRef = useRef<{ key: string; promise: ReturnType<typeof startTrainingSession> } | null>(null)

  useEffect(() => {
    let cancelled = false
    const key = `${personaId}:${modeParam}:${resumeParam ?? ''}`
    setPhase('loading'); setIndex(0); setCardState('idle'); setBranchNote(null)
    setFinishResult(null); setLearnings([]); setMultiSelected([]); setTextAnswer(''); setError('')
    if (!starterRef.current || starterRef.current.key !== key) {
      starterRef.current = { key, promise: resumeParam ? resumeTrainingSession(personaId, Number(resumeParam)) : startTrainingSession(personaId, { mode: modeParam }) }
    }
    const starter = starterRef.current.promise
    starter.then((started) => {
      if (cancelled) return
      const answeredIds = new Set((started.responses ?? []).map((item) => item.question_id))
      const remaining = (started.questions ?? []).filter((item) => !answeredIds.has(item.id))
      setSession(started)
      setQueue(remaining)
      setPhase(remaining.length > 0 ? 'questions' : 'empty')
    }).catch((err: unknown) => { if (!cancelled) { setError(err instanceof Error ? err.message : 'Could not start training'); setPhase('error') } })
    return () => { cancelled = true }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [personaId, modeParam, resumeParam])

  useEffect(() => {
    if (!session) return
    getPhysicianTraining(personaId).then((workspace) => setQueueSummary(workspace.queue_summary)).catch(() => {})
  }, [personaId, phase, session])

  const current = queue[index]

  const finish = async (activeSession: TrainingSession) => {
    try {
      const result = await finishTrainingSession(personaId, activeSession.id)
      setFinishResult({ responses: result.responses ?? [] })
      setLearnings(result.proposed_learnings ?? [])
      setPhase('reviewing')
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
      const nextQuestion = response.next_question
      if (nextQuestion) {
        setQueue((prev) => { const copy = [...prev]; copy.splice(index + 1, 0, nextQuestion); return copy })
        advance(session, null, false)
      } else {
        const resolvedBranch = current.branch_depth > 0
        advance(session, resolvedBranch ? 'Got it. Lamina can propose a practice rule from these answers.' : null, index + 1 >= queue.length)
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not save your answer')
    } finally {
      setBusy(false)
    }
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

  if (phase === 'loading') return <main className="training-shell"><div className="page-state embedded"><div className="loading-line" /><p>Preparing training…</p></div></main>
  if (phase === 'error') return <main className="training-shell training-empty"><div className="error-banner" role="alert">{error}</div><button className="button-secondary" onClick={() => navigate(exitPath)}>← Back</button></main>
  if (phase === 'empty') return <main className="training-shell training-empty">
    <NetworkMark resolved />
    <h1>{modeParam === 'initialization' ? 'Initialization questions are already answered' : 'Your agent is caught up for now'}</h1>
    <p>No new questions are waiting right now. Check back after your agent participates in more network activity.</p>
    <button className="button-primary" onClick={() => navigate(exitPath)}>Back to My Agent <span>→</span></button>
  </main>

  if (phase === 'reviewing') {
    const answeredCount = (finishResult?.responses ?? []).filter((item) => !item.skipped).length
    const askedSoFar = (queueSummary?.answered_today ?? 0)
    const moreAvailable = queueSummary ? Math.max(0, queueSummary.available_total - askedSoFar) : 0
    return <main className="training-shell training-review">
      <p className="eyebrow">Train your agent</p>
      <h1>{modeParam === 'daily' ? 'Daily questions complete' : 'Training complete'}</h1>
      <p className="training-review-intro">Review what your agent learned.</p>
      {error && <p className="demo-reset-error" role="alert">{error}</p>}
      {learnings.length === 0
        ? <p className="agent-empty-note">No new proposed learnings from this session.</p>
        : <div className="learning-grid">{learnings.map((learning) => <TrainingLearningCard key={learning.id} learning={learning} busy={busy} editing={editingLearningId === learning.id} draft={draft} onEdit={() => { setEditingLearningId(learning.id); setDraft(learning.statement) }} onCancelEdit={() => setEditingLearningId(null)} onDraftChange={setDraft} onAction={actOnLearning} />)}</div>}
      <div className="training-summary">
        <p>{agentName} is better prepared to answer {answeredCount} referral question{answeredCount === 1 ? '' : 's'}.</p>
        <button className="button-primary" onClick={() => navigate(exitPath)}>Back to My Agent <span>→</span></button>
      </div>
      {moreAvailable > 0 && <div className="training-keep-going">
        <p>Want to keep going? {moreAvailable} more question{moreAvailable === 1 ? '' : 's'} available.</p>
        <button className="button-secondary" onClick={() => navigate(`${trainingPath(personaId)}?mode=extended`)}>Keep training <span>→</span></button>
      </div>}
    </main>
  }

  if (!current) return null
  const source = questionSource(current)
  const hasDepends = current.question_type === 'yes_no_depends'
  const isFollowUp = current.branch_depth > 0
  return <main className={`training-shell training-active ${cardState}`}>
    <div className="training-header">
      <p className="eyebrow">Train your agent</p>
      <div className="training-progress-row"><span>Question {index + 1} of {queue.length}</span><div className="training-progress-bar" role="progressbar" aria-valuenow={index + 1} aria-valuemin={1} aria-valuemax={queue.length}><span style={{ width: `${Math.round((index / queue.length) * 100)}%` }} /></div></div>
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

const PROFILE_CATEGORIES: ProfileCategory[] = ['about', 'training', 'experience', 'affiliations', 'clinical_interests', 'skills_or_procedures', 'research', 'publications', 'teaching', 'languages', 'locations', 'professional_links']
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

function ProfileSection({ category, items, personaId, onSaved, itemActions }: {
  category: ProfileCategory; items: ProfileItem[]; personaId: DemoPhysicianPerspective
  onSaved: () => void; itemActions?: (item: ProfileItem) => ReactNode
}) {
  const [adding, setAdding] = useState(false)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const save = async (itemId: string, fields: { title: string; detail: string; shareable: boolean }) => {
    setBusy(true)
    try {
      await updateProfessionalProfileItem(personaId, itemId, { category, title: fields.title, detail: fields.detail || undefined, shareable: fields.shareable })
      onSaved()
      setAdding(false); setEditingId(null)
    } finally { setBusy(false) }
  }
  return <section className="profile-section-v2">
    <div className="profile-section-heading"><h2>{CATEGORY_LABELS[category]}</h2><button className="text-button" onClick={() => { setAdding(true); setEditingId(null) }}>+ Add</button></div>
    {items.length === 0 && !adding && <p className="profile-section-empty">Nothing added yet.</p>}
    <div className="profile-item-list">{items.map((item) => (editingId === item.id
      ? <ProfileItemForm key={item.id} category={category} initial={item} busy={busy} onCancel={() => setEditingId(null)} onSave={(fields) => save(item.id, fields)} />
      : <div className="profile-item-row" key={item.id}>
        <div><strong>{item.title}</strong>{item.detail && <p>{item.detail}</p>}<small>{provenanceLabel(item)}</small>{itemActions && <div className="profile-item-extra-actions">{itemActions(item)}</div>}</div>
        <button className="text-button" onClick={() => { setEditingId(item.id); setAdding(false) }}>Edit</button>
      </div>))}
    </div>
    {adding && <ProfileItemForm category={category} busy={busy} onCancel={() => setAdding(false)} onSave={(fields) => save(`item-${crypto.randomUUID()}`, fields)} />}
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

const POST_INTENTS: Array<{ type: PostType; label: string; prompt: string }> = [
  { type: 'practice_update', label: 'Update my practice', prompt: 'What changed in your practice?' },
  { type: 'referral_guidance', label: 'Share referral guidance', prompt: 'What would you like referring physicians to know?' },
  { type: 'share_paper', label: 'Share a paper', prompt: 'What should your network know about it?' },
  { type: 'research_update', label: 'Share research', prompt: 'What would you like to share?' },
  { type: 'teaching_update', label: 'Share teaching', prompt: 'What would you like to share?' },
  { type: 'interesting_case', label: 'Share an interesting case', prompt: 'Describe the synthetic/demo case reflection.' },
  { type: 'availability', label: 'Share availability', prompt: 'What should your network know about your availability?' },
  { type: 'professional_update', label: 'Professional update', prompt: 'What would you like to share?' },
  { type: 'other', label: 'Other', prompt: 'What would you like to share?' },
]

type PostFlowStage = 'closed' | 'intent' | 'compose' | 'preview'

export function PostButton({ personaId, onPublished, paperTitle, triggerLabel = 'Share update', compact = false }: { personaId: DemoPhysicianPerspective; onPublished?: (post: ProfessionalPost) => void; paperTitle?: string; triggerLabel?: string; compact?: boolean }) {
  const [stage, setStage] = useState<PostFlowStage>('closed')
  const [intent, setIntent] = useState<PostType | null>(null)
  const [title, setTitle] = useState(paperTitle ?? '')
  const [note, setNote] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [draftPost, setDraftPost] = useState<ProfessionalPost | null>(null)
  const [editingPreview, setEditingPreview] = useState(false)
  const [previewTitle, setPreviewTitle] = useState('')
  const [previewBody, setPreviewBody] = useState('')

  const reset = () => { setStage('closed'); setIntent(null); setTitle(paperTitle ?? ''); setNote(''); setError(''); setDraftPost(null); setEditingPreview(false) }

  useEffect(() => {
    if (stage === 'closed') return
    const onKey = (event: KeyboardEvent) => { if (event.key === 'Escape') reset() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [stage])

  const chooseIntent = (type: PostType) => { setIntent(type); setStage('compose') }

  const draftWithAgent = async () => {
    if (!intent) return
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

  const selected = POST_INTENTS.find((item) => item.type === intent)
  return <>
    <button className={compact ? 'text-button' : 'button-secondary post-trigger'} onClick={() => { if (paperTitle) { setIntent('share_paper'); setStage('compose') } else { setStage('intent') } }}>{triggerLabel} <span>{compact ? '→' : '+'}</span></button>
    {stage !== 'closed' && <div className="post-flow-overlay" role="presentation" onClick={(event) => { if (event.target === event.currentTarget) reset() }}>
      <div className="post-flow-dialog" role="dialog" aria-modal="true" aria-label="Share a professional update">
        <button className="text-button post-flow-close" onClick={reset} aria-label="Close">×</button>
        {stage === 'intent' && <>
          <p className="eyebrow">Share update</p>
          <h2>What would you like to share?</h2>
          <div className="post-intent-grid">{POST_INTENTS.map((item) => <button key={item.type} className="post-intent-option" onClick={() => chooseIntent(item.type)}>{item.label}</button>)}</div>
        </>}
        {stage === 'compose' && selected && <>
          <p className="eyebrow">{selected.label}</p>
          {selected.type === 'interesting_case' && <p className="post-synthetic-notice">Demo mode supports synthetic case reflections only.</p>}
          <label htmlFor="post-title">Title <em>Optional</em></label>
          <input id="post-title" value={title} onChange={(event) => setTitle(event.target.value)} maxLength={240} />
          <label htmlFor="post-note">{selected.prompt}</label>
          <textarea id="post-note" value={note} onChange={(event) => setNote(event.target.value)} maxLength={2000} />
          {error && <p className="demo-reset-error" role="alert">{error}</p>}
          <div className="post-flow-actions"><button className="button-primary" disabled={!note.trim() || busy} onClick={draftWithAgent}>Draft with my agent <span>→</span></button><button className="text-button" onClick={() => setStage('intent')}>Back</button></div>
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

function InterestGroup({ interestType, items, personaId, onSaved }: { interestType: PhysicianInterestType; items: PhysicianInterest[]; personaId: DemoPhysicianPerspective; onSaved: () => void }) {
  const [adding, setAdding] = useState(false)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const save = async (interestId: string | undefined, fields: { title: string; detail: string }) => {
    setBusy(true)
    try {
      await savePhysicianInterest(personaId, { interest_type: interestType, title: fields.title, detail: fields.detail || null, confirmed: true, shareable: true }, interestId)
      onSaved(); setAdding(false); setEditingId(null)
    } finally { setBusy(false) }
  }
  return <div className={`interest-group ${interestType === 'case_interest' ? 'primary' : ''}`}>
    <div className="profile-section-heading"><h3>{INTEREST_TYPE_LABELS[interestType]}</h3><button className="text-button" onClick={() => { setAdding(true); setEditingId(null) }}>+ Add</button></div>
    {items.length === 0 && !adding && <p className="profile-section-empty">Nothing added yet.</p>}
    <div className="interest-item-list">{items.map((item) => (editingId === item.id
      ? <InterestForm key={item.id} initial={item} busy={busy} onCancel={() => setEditingId(null)} onSave={(fields) => save(item.id, fields)} />
      : <div className="profile-item-row interest-row" key={item.id}>
        <div><strong>{item.title}</strong>{item.detail && <p>{item.detail}</p>}</div>
        <button className="text-button" onClick={() => { setEditingId(item.id); setAdding(false) }}>Edit</button>
      </div>))}
    </div>
    {adding && <InterestForm busy={busy} onCancel={() => setAdding(false)} onSave={(fields) => save(undefined, fields)} />}
  </div>
}

export function InterestsPanel({ interests, personaId, onSaved, navigate, trainPath }: { interests: PhysicianInterest[]; personaId: DemoPhysicianPerspective; onSaved: () => void; navigate?: Navigate; trainPath?: string }) {
  return <section className="profile-section-v2 interests-panel">
    <p className="profile-section-explainer">Tell Lamina what areas of medicine and kinds of cases you are particularly interested in. Interests help your agent understand the work you are especially interested in — they do not guarantee referral eligibility or override clinical fit.</p>
    {INTEREST_TYPES.map((type) => <InterestGroup key={type} interestType={type} items={interests.filter((item) => item.interest_type === type)} personaId={personaId} onSaved={onSaved} />)}
    {navigate && trainPath && interests.length > 0 && <p className="profile-section-explainer interest-training-hint">Lamina can ask follow-up questions based on these interests. <button className="text-button" onClick={() => navigate(trainPath)}>Continue training →</button></p>}
  </section>
}

/* ----------------------------------------------------------------- Enrichment */

function EnrichmentCandidateCard({ candidate, personaId, onReviewed }: { candidate: ProfileCandidateFact; personaId: DemoPhysicianPerspective; onReviewed: (candidate: ProfileCandidateFact) => void }) {
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
    <span className="learning-status suggested">Suggested</span>
    <strong className="enrichment-category">{CATEGORY_LABELS[candidate.category]}</strong>
    {editing ? <input className="enrichment-edit-input" value={title} onChange={(event) => setTitle(event.target.value)} maxLength={240} /> : <p>{candidate.proposed_title}</p>}
    {candidate.proposed_detail && !editing && <p className="enrichment-detail">{candidate.proposed_detail}</p>}
    <small>Source: {candidate.source_title}</small>
    {editing
      ? <div className="learning-edit"><div><button className="button-primary" disabled={!title.trim() || busy} onClick={() => act('edit_confirm')}>Save &amp; confirm</button><button className="text-button" onClick={() => setEditing(false)}>Cancel</button></div></div>
      : <div className="learning-actions"><button disabled={busy} onClick={() => act('confirm')}>Confirm</button><button disabled={busy} onClick={() => setEditing(true)}>Edit</button><button disabled={busy} onClick={() => act('reject')}>Reject</button></div>}
  </article>
}

export function EnrichmentPanel({ personaId, onConfirmed }: { personaId: DemoPhysicianPerspective; onConfirmed: () => void }) {
  const [job, setJob] = useState<ProfileEnrichmentJob | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  useEffect(() => { getProfileEnrichment(personaId).then(setJob).catch(() => {}) }, [personaId])
  const start = async () => {
    setLoading(true); setError('')
    try { const result = await enrichPhysicianProfile(personaId); setJob(result) } catch (err) { setError(err instanceof Error ? err.message : 'Could not search for professional information') } finally { setLoading(false) }
  }
  const onReviewed = (candidate: ProfileCandidateFact) => {
    setJob((prev) => (prev ? { ...prev, candidates: prev.candidates.map((item) => (item.candidate_id === candidate.candidate_id ? candidate : item)) } : prev))
    if (candidate.review_status === 'confirmed' || candidate.review_status === 'edited') onConfirmed()
  }
  const pending = job?.candidates.filter((item) => item.review_status === 'suggested') ?? []
  if (!job || job.status === 'idle') return <section className="profile-section-v2 enrichment-panel">
    <div className="profile-section-heading"><h2>Help fill my profile</h2></div>
    <p className="profile-section-explainer">Lamina can suggest professional background for you to review and confirm.</p>
    {error && <p className="demo-reset-error" role="alert">{error}</p>}
    <button className="button-secondary" disabled={loading} onClick={start}>{loading ? 'Searching…' : 'Help fill my profile →'}</button>
  </section>
  return <section className="profile-section-v2 enrichment-panel">
    <div className="profile-section-heading"><h2>Suggested additions</h2></div>
    {pending.length === 0
      ? <p className="profile-section-empty">No new profile suggestions.</p>
      : <><p className="profile-section-explainer">{job.found_count} suggested addition{job.found_count === 1 ? '' : 's'} found. Review each before it joins your profile.</p>
        <div className="learning-grid">{pending.map((candidate) => <EnrichmentCandidateCard key={candidate.candidate_id} candidate={candidate} personaId={personaId} onReviewed={onReviewed} />)}</div></>}
  </section>
}

/* -------------------------------------------------------------- Initialization */

export function InitializationCard({ initialization, navigate, trainPath }: { initialization: AgentInitialization | null; navigate: Navigate; trainPath: string }) {
  if (!initialization || initialization.incomplete_sections.length === 0) return null
  const total = initialization.initialized_sections.length + initialization.incomplete_sections.length
  return <section className="improve-agent-card initialization-card">
    <p className="eyebrow">Build your professional presence</p>
    <h2>{initialization.initialized_sections.length} of {total} areas initialized</h2>
    <p className="improve-agent-stat">{initialization.meaning}</p>
    <button className="button-primary" onClick={() => navigate(`${trainPath}?mode=initialization`)}>Continue setup <span>→</span></button>
  </section>
}

const PROFILE_TABS = ['overview', 'background', 'research', 'interests', 'updates'] as const
type ProfileTab = typeof PROFILE_TABS[number]
const PROFILE_TAB_LABELS: Record<ProfileTab, string> = { overview: 'Overview', background: 'Background', research: 'Research & Teaching', interests: 'Interests', updates: 'Updates' }
const BACKGROUND_CATEGORIES: ProfileCategory[] = ['training', 'experience', 'affiliations', 'skills_or_procedures', 'languages', 'locations', 'professional_links', 'clinical_interests']
const RESEARCH_CATEGORIES: ProfileCategory[] = ['research', 'publications', 'teaching']
const agentPracticePath = (perspective: DemoPhysicianPerspective) => (perspective === 'iain' ? '/specialist/agent' : '/agent?tab=knowledge')

export function ProfessionalProfilePage({ personaId, navigate }: { personaId: DemoPhysicianPerspective; navigate: Navigate }) {
  const [tab, setTab] = useState<ProfileTab>('overview')
  const [profile, setProfile] = useState<ProfessionalProfile | null>(null)
  const [posts, setPosts] = useState<ProfessionalPost[] | null>(null)
  const [initialization, setInitialization] = useState<AgentInitialization | null>(null)
  const [error, setError] = useState('')
  const [savedNote, setSavedNote] = useState('')
  const load = () => {
    getProfessionalProfile(personaId).then(setProfile).catch((err: Error) => setError(err.message))
    getProfessionalPosts(personaId).then(setPosts).catch(() => setPosts([]))
    getAgentInitialization(personaId).then(setInitialization).catch(() => {})
  }
  useEffect(load, [personaId]) // eslint-disable-line react-hooks/exhaustive-deps
  const onItemSaved = () => { load(); setSavedNote('Saved. A suggested update was drafted in Updates for your review.') }
  const onPostChanged = (updated: ProfessionalPost) => setPosts((prev) => (prev ?? []).map((item) => (item.id === updated.id ? updated : item)))
  const onPostPublished = (published: ProfessionalPost) => setPosts((prev) => [published, ...(prev ?? []).filter((item) => item.id !== published.id)])
  if (error) return <main className="page-shell profile-page"><div className="error-banner" role="alert">{error}</div></main>
  if (!profile) return <main className="page-shell profile-page"><p className="muted-note">Opening professional profile…</p></main>
  const suggestedDrafts = (posts ?? []).filter((item) => item.status === 'draft' && item.provenance?.startsWith('agent_drafted_from_'))
  const yourDrafts = (posts ?? []).filter((item) => item.status === 'draft' && !item.provenance?.startsWith('agent_drafted_from_'))
  const published = (posts ?? []).filter((item) => item.status === 'published')
  const initials = profile.physician.name.replace('Dr. ', '').split(/\s+/).map((part) => part[0]).slice(0, 2).join('')
  const aboutItems = profile.sections.about
  const locationItems = profile.sections.locations
  const recentPublished = published.slice(0, 3)
  return <main className="page-shell profile-page professional-profile-page">
    <header className="profile-hero">
      <span className="clinician-avatar large">{initials}</span>
      <div><p className="eyebrow">Professional profile</p><h1>{profile.physician.name}</h1><p className="profile-role">{profile.physician.specialty} · {profile.physician.location}</p></div>
    </header>
    <p className="profile-benefit-note">Your professional profile helps Lamina understand your background and expertise. Explicit referral preferences are managed separately in My Agent.</p>
    <nav className="profile-tabs" aria-label="Professional profile sections">{PROFILE_TABS.map((item) => <button key={item} className={tab === item ? 'active' : ''} aria-current={tab === item ? 'page' : undefined} onClick={() => setTab(item)}>{PROFILE_TAB_LABELS[item]}</button>)}</nav>
    {savedNote && <p className="profile-save-note" role="status">{savedNote}</p>}

    {tab === 'overview' && <div className="profile-overview-tab">
      <section className="profile-completeness"><p className="eyebrow">Practice representation</p><h2>{profile.completeness.completed_section_count} of {profile.completeness.total_section_count} sections completed</h2></section>
      <InitializationCard initialization={initialization} navigate={navigate} trainPath={trainingPath(personaId)} />
      <EnrichmentPanel personaId={personaId} onConfirmed={load} />
      <ProfileSection category="about" items={aboutItems} personaId={personaId} onSaved={onItemSaved} />
      {locationItems.length > 0 && <div className="profile-overview-fact"><span className="section-label">Locations</span><p>{locationItems.map((item) => item.title).join(' · ')}</p></div>}
      {recentPublished.length > 0 && <div className="profile-section-v2"><div className="profile-section-heading"><h2>Recent professional updates</h2></div>{recentPublished.map((post) => <article className="practice-update-card" key={post.id}><p className="practice-update-title">{post.title}</p><p className="practice-update-body">{post.body}</p></article>)}</div>}
      <button className="text-button" onClick={() => navigate(agentPracticePath(personaId))}>View how my agent represents me →</button>
    </div>}

    {tab === 'background' && <div className="profile-background-tab">
      {BACKGROUND_CATEGORIES.map((category) => <ProfileSection key={category} category={category} items={profile.sections[category]} personaId={personaId} onSaved={onItemSaved} />)}
    </div>}

    {tab === 'research' && <div className="profile-research-tab">
      {RESEARCH_CATEGORIES.map((category) => <ProfileSection
        key={category}
        category={category}
        items={profile.sections[category]}
        personaId={personaId}
        onSaved={onItemSaved}
        itemActions={category === 'publications' ? (item) => <PostButton personaId={personaId} onPublished={onPostPublished} paperTitle={item.title} triggerLabel="Share this paper" compact /> : undefined}
      />)}
    </div>}

    {tab === 'interests' && <InterestsPanel interests={profile.interests} personaId={personaId} onSaved={load} navigate={navigate} trainPath={trainingPath(personaId)} />}

    {tab === 'updates' && <div className="profile-updates-tab">
      <PostButton personaId={personaId} onPublished={onPostPublished} />
      {suggestedDrafts.length > 0 && <div className="practice-update-group"><p className="section-label">Suggested drafts</p>{suggestedDrafts.map((post) => <PostCard key={post.id} post={post} personaId={personaId} onChanged={onPostChanged} />)}</div>}
      {yourDrafts.length > 0 && <div className="practice-update-group"><p className="section-label">Your drafts</p>{yourDrafts.map((post) => <PostCard key={post.id} post={post} personaId={personaId} onChanged={onPostChanged} />)}</div>}
      {published.length > 0 && <div className="practice-update-group"><p className="section-label">Published</p>{published.map((post) => <PostCard key={post.id} post={post} personaId={personaId} onChanged={onPostChanged} />)}</div>}
      {suggestedDrafts.length === 0 && yourDrafts.length === 0 && published.length === 0 && <p className="profile-section-empty">No published updates yet. Share something when there's something useful for your network to know.</p>}
    </div>}
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
  return <main className="page-shell profile-page">
    <button className="text-button back-link" onClick={() => navigate(backPath)}>← Back</button>
    <header className="profile-hero"><span className="clinician-avatar large">{initials}</span><div><p className="eyebrow">Professional profile</p><h1>{data.physician.name}</h1><p className="profile-role">{data.physician.specialty} · {data.physician.location}</p></div></header>
    <section className="practice-representation-panel"><p className="eyebrow">How the network sees this practice</p>
      {rep.clinical_focus.length > 0 && <div><span className="section-label">Clinical focus</span><ul className="clinical-list">{rep.clinical_focus.map((item) => <li key={item}>{item}</li>)}</ul></div>}
      {rep.good_fit.length > 0 && <div><span className="section-label">Good-fit cases</span><ul className="clinical-list">{rep.good_fit.map((item) => <li key={item}>{item}</li>)}</ul></div>}
      {rep.preferred_workup.length > 0 && <div><span className="section-label">Referral guidance</span><ul className="clinical-list">{rep.preferred_workup.map((item) => <li key={item}>{item}</li>)}</ul></div>}
      {caseInterests.length > 0 && <div><span className="section-label">Areas {data.physician.name} is especially interested in seeing</span><ul className="clinical-list">{caseInterests.map((item) => <li key={item.id}>{item.title}</li>)}</ul><small className="profile-interest-disclaimer">Interests reflect what {data.physician.name} wants referring physicians to know. They do not guarantee referral eligibility or override clinical fit.</small></div>}
      {otherInterests.length > 0 && <div><span className="section-label">Research &amp; teaching interests</span><ul className="clinical-list">{otherInterests.map((item) => <li key={item.id}>{item.title}</li>)}</ul></div>}
    </section>
    {PROFILE_CATEGORIES.map((category) => data.professional_profile.sections[category].length > 0 && <section className="profile-section-v2" key={category}><div className="profile-section-heading"><h2>{CATEGORY_LABELS[category]}</h2></div><div className="profile-item-list">{data.professional_profile.sections[category].map((item) => <div className="profile-item-row" key={item.id}><div><strong>{item.title}</strong>{item.detail && <p>{item.detail}</p>}</div></div>)}</div></section>)}
    {data.published_updates.length > 0 && <section className="profile-section-v2"><div className="profile-section-heading"><h2>Practice updates</h2></div>{data.published_updates.map((update) => <article className="practice-update-card" key={update.id}><p className="practice-update-title">{update.title}</p><p className="practice-update-body">{update.body}</p></article>)}</section>}
    <p className="disclaimer">{data.disclaimer}</p>
  </main>
}
