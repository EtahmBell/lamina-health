import { useEffect, useState } from 'react'
import {
  answerTrainingQuestion,
  createPracticeUpdate,
  dismissPracticeUpdate,
  editPracticeUpdate,
  finishTrainingSession,
  getNetworkFeed,
  getNetworkPhysicianProfile,
  getPhysicianUpdates,
  getProfessionalProfile,
  publishPracticeUpdate,
  startTrainingSession,
  updateProfessionalProfileItem,
  updateProposedLearning,
  type DemoPhysicianPerspective,
  type NetworkFeed,
  type NetworkFeedItem,
  type PracticeRepresentation,
  type PracticeUpdate,
  type PracticeUpdateType,
  type ProfessionalProfile,
  type ProfileCategory,
  type ProfileItem,
  type ProposedLearning,
  type TrainingQuestion,
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

/* ------------------------------------------------------------- Home: engagement */

export function ImproveAgentCard({ representation, navigate, trainPath }: { representation: PracticeRepresentation | null; navigate: Navigate; trainPath: string }) {
  if (!representation) return null
  const waiting = representation.completeness.questions_waiting
  const confirmedCount = representation.completeness.confirmed_practice_item_count
  return <section className={`improve-agent-card ${waiting === 0 ? 'done' : ''}`}>
    <p className="eyebrow">Improve your agent</p>
    {waiting > 0
      ? <h2>{waiting} question{waiting === 1 ? '' : 's'} could help your agent represent your practice more accurately.</h2>
      : <h2>Your agent is up to date.</h2>}
    <p className="improve-agent-stat">{confirmedCount} practice area{confirmedCount === 1 ? '' : 's'} confirmed{waiting > 0 ? ` · ${waiting} question${waiting === 1 ? '' : 's'} waiting` : ''}.</p>
    {waiting > 0 && <button className="button-primary" onClick={() => navigate(trainPath)}>Start 2-minute training <span>→</span></button>}
  </section>
}

const FEED_TYPE_LABELS: Record<string, string> = {
  practice_focus: 'Practice', referral_guidance: 'Referral guidance', availability: 'Availability',
  publication: 'Research', research: 'Research', teaching: 'Teaching', location: 'Practice',
  professional_update: 'Practice update',
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

export function NetworkFeedSection({ feed, navigate, perspective }: { feed: NetworkFeed | null; navigate: Navigate; perspective: DemoPhysicianPerspective }) {
  if (!feed) return null
  return <section className="network-feed-section">
    <div className="home-section-heading"><div><h2>Network updates</h2></div></div>
    {feed.items.length === 0
      ? <p className="home-empty">No relevant network updates yet. Updates appear here once physicians in your network publish them.</p>
      : <div className="feed-grid">{feed.items.slice(0, 4).map((item) => <FeedCard key={item.id} item={item} navigate={navigate} perspective={perspective} />)}</div>}
  </section>
}

/* ---------------------------------------------------- Practice representation */

export function PracticeRepresentationPanel({ representation }: { representation: PracticeRepresentation }) {
  const sections = representation.sections
  const group = (label: string, items: string[]) => items.length > 0 && <div key={label}><span className="section-label">{label}</span><ul className="clinical-list">{items.map((item) => <li key={item}>{item}</li>)}</ul></div>
  return <section className="practice-representation-panel">
    <p className="eyebrow">How the network sees your practice</p>
    <h2>How your agent represents you</h2>
    {group('Clinical focus', sections.clinical_focus)}
    {group('Good-fit cases', sections.good_fit)}
    {group('Usually not a fit', sections.not_a_fit)}
    {group('Referral guidance', sections.preferred_workup)}
    {group('Confirmed rules', sections.explicit_rules)}
    {sections.confirmed_learnings.length > 0 && <div><span className="section-label">Confirmed from training</span><ul className="clinical-list">{sections.confirmed_learnings.map((item) => <li key={item.id}>{item.statement}</li>)}</ul></div>}
    <p className="practice-representation-note">{representation.completeness.meaning}</p>
  </section>
}

/* --------------------------------------------------------------------- Train */

function questionSource(question: TrainingQuestion): { tag: string; detail: string } {
  switch (question.source_type) {
    case 'network_question':
      return { tag: 'From your network', detail: question.asked_count ? `Asked by ${question.asked_count} referring physician agent${question.asked_count === 1 ? '' : 's'}` : 'Asked by referring physician agents' }
    case 'canonical_case':
      return { tag: 'From a recent case', detail: question.source_reference ? `${patientName(question.source_reference)} network consultation` : 'From a recent network consultation' }
    case 'profile_confirmation':
      return { tag: 'Practice profile', detail: 'Confirm how your practice should be represented' }
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

export function TrainingPage({ personaId, agentName, navigate, exitPath }: { personaId: DemoPhysicianPerspective; agentName: string; navigate: Navigate; exitPath: string }) {
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

  useEffect(() => {
    let cancelled = false
    startTrainingSession(personaId).then((started) => {
      if (cancelled) return
      setSession(started)
      setQueue(started.questions ?? [])
      setPhase((started.questions?.length ?? 0) > 0 ? 'questions' : 'empty')
    }).catch((err: unknown) => { if (!cancelled) { setError(err instanceof Error ? err.message : 'Could not start training'); setPhase('error') } })
    return () => { cancelled = true }
  }, [personaId])

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

  const advance = (activeSession: TrainingSession) => {
    setMultiSelected([]); setTextAnswer('')
    const calm = prefersReducedMotion()
    const isLast = index + 1 >= queue.length
    if (calm) {
      if (isLast) void finish(activeSession)
      else setIndex((value) => value + 1)
      return
    }
    setCardState('leaving')
    window.setTimeout(() => {
      setCardState('idle')
      if (isLast) void finish(activeSession)
      else setIndex((value) => value + 1)
    }, 220)
  }

  const submit = async (answer: string | string[] | null, skipped: boolean) => {
    if (!session || !current || busy) return
    setBusy(true); setError('')
    try {
      await answerTrainingQuestion(personaId, session.id, current.id, skipped ? { skipped: true } : { answer: answer ?? undefined })
      advance(session)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not save your answer')
    } finally {
      setBusy(false)
    }
  }

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
    <h1>You're all caught up</h1>
    <p>No new questions are waiting right now. Check back after your agent participates in more network activity.</p>
    <button className="button-primary" onClick={() => navigate(exitPath)}>Back to My Agent <span>→</span></button>
  </main>

  if (phase === 'reviewing') {
    const answeredCount = (finishResult?.responses ?? []).filter((item) => !item.skipped).length
    return <main className="training-shell training-review">
      <p className="eyebrow">Train your agent</p>
      <h1>Training complete</h1>
      <p className="training-review-intro">Review what your agent learned.</p>
      {error && <p className="demo-reset-error" role="alert">{error}</p>}
      {learnings.length === 0
        ? <p className="agent-empty-note">No new proposed learnings from this session.</p>
        : <div className="learning-grid">{learnings.map((learning) => <TrainingLearningCard key={learning.id} learning={learning} busy={busy} editing={editingLearningId === learning.id} draft={draft} onEdit={() => { setEditingLearningId(learning.id); setDraft(learning.statement) }} onCancelEdit={() => setEditingLearningId(null)} onDraftChange={setDraft} onAction={actOnLearning} />)}</div>}
      <div className="training-summary">
        <p>{agentName} is better prepared to answer {answeredCount} referral question{answeredCount === 1 ? '' : 's'}.</p>
        <button className="button-primary" onClick={() => navigate(exitPath)}>Back to My Agent <span>→</span></button>
      </div>
    </main>
  }

  if (!current) return null
  const source = questionSource(current)
  const hasDepends = current.question_type === 'yes_no_depends'
  return <main className={`training-shell training-active ${cardState}`}>
    <div className="training-header">
      <p className="eyebrow">Train your agent</p>
      <div className="training-progress-row"><span>Question {index + 1} of {queue.length}</span><div className="training-progress-bar" role="progressbar" aria-valuenow={index + 1} aria-valuemin={1} aria-valuemax={queue.length}><span style={{ width: `${Math.round((index / queue.length) * 100)}%` }} /></div></div>
      <button className="text-button training-exit" onClick={() => navigate(exitPath)}>Exit</button>
    </div>
    <div className="training-stage">
      <article className={`training-card ${cardState}`} key={current.id}>
        <span className="training-source-tag">{source.tag}</span>
        <p className="training-source-detail">{source.detail}</p>
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

function ProfileSection({ category, items, personaId, onSaved }: {
  category: ProfileCategory; items: ProfileItem[]; personaId: DemoPhysicianPerspective
  onSaved: () => void
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
        <div><strong>{item.title}</strong>{item.detail && <p>{item.detail}</p>}<small>{provenanceLabel(item)}</small></div>
        <button className="text-button" onClick={() => { setEditingId(item.id); setAdding(false) }}>Edit</button>
      </div>))}
    </div>
    {adding && <ProfileItemForm category={category} busy={busy} onCancel={() => setAdding(false)} onSave={(fields) => save(`item-${crypto.randomUUID()}`, fields)} />}
  </section>
}

const PRACTICE_UPDATE_TYPES: PracticeUpdateType[] = ['practice_focus', 'referral_guidance', 'research', 'publication', 'teaching', 'availability']
const PRACTICE_UPDATE_TYPE_OPTIONS: Record<PracticeUpdateType, string> = {
  practice_focus: 'Practice', referral_guidance: 'Referral guidance', availability: 'Availability',
  publication: 'Publication', research: 'Research', teaching: 'Teaching', location: 'Location', professional_update: 'Practice update',
}

function PracticeUpdateComposer({ personaId, onCreated }: { personaId: DemoPhysicianPerspective; onCreated: (update: PracticeUpdate) => void }) {
  const [open, setOpen] = useState(false)
  const [type, setType] = useState<PracticeUpdateType>('practice_focus')
  const [title, setTitle] = useState('')
  const [body, setBody] = useState('')
  const [busy, setBusy] = useState(false)
  if (!open) return <button className="text-button" onClick={() => setOpen(true)}>Share a practice update</button>
  const submit = async () => {
    setBusy(true)
    try {
      const update = await createPracticeUpdate(personaId, { type, title: title.trim(), body: body.trim() })
      onCreated(update); setOpen(false); setTitle(''); setBody('')
    } finally { setBusy(false) }
  }
  return <div className="practice-update-composer">
    <label htmlFor="update-type">Category</label>
    <select id="update-type" value={type} onChange={(event) => setType(event.target.value as PracticeUpdateType)}>{PRACTICE_UPDATE_TYPES.map((item) => <option key={item} value={item}>{PRACTICE_UPDATE_TYPE_OPTIONS[item]}</option>)}</select>
    <label htmlFor="update-title">Title</label>
    <input id="update-title" value={title} onChange={(event) => setTitle(event.target.value)} maxLength={240} />
    <label htmlFor="update-body">Update</label>
    <textarea id="update-body" value={body} onChange={(event) => setBody(event.target.value)} maxLength={2000} />
    <div><button className="button-primary" disabled={!title.trim() || !body.trim() || busy} onClick={submit}>Save as draft</button><button className="text-button" onClick={() => setOpen(false)}>Cancel</button></div>
  </div>
}

function PracticeUpdateCard({ update, personaId, onChanged }: { update: PracticeUpdate; personaId: DemoPhysicianPerspective; onChanged: (updated: PracticeUpdate) => void }) {
  const [editing, setEditing] = useState(false)
  const [title, setTitle] = useState(update.title)
  const [body, setBody] = useState(update.body)
  const [busy, setBusy] = useState(false)
  const act = async (action: 'publish' | 'dismiss') => {
    setBusy(true)
    try {
      const result = action === 'publish' ? await publishPracticeUpdate(personaId, Number(update.id)) : await dismissPracticeUpdate(personaId, Number(update.id))
      onChanged(result)
    } finally { setBusy(false) }
  }
  const saveEdit = async () => {
    setBusy(true)
    try { const result = await editPracticeUpdate(personaId, Number(update.id), { type: update.type, title: title.trim(), body: body.trim() }); onChanged(result); setEditing(false) } finally { setBusy(false) }
  }
  return <article className="practice-update-card">
    <span className={`practice-update-status ${update.status}`}>{update.status === 'draft' ? 'Draft' : update.status === 'published' ? 'Published' : 'Dismissed'}</span>
    {update.agent_drafted && <span className="practice-update-agent-drafted">Suggested update</span>}
    {editing
      ? <div className="profile-item-form"><input value={title} onChange={(event) => setTitle(event.target.value)} maxLength={240} /><textarea value={body} onChange={(event) => setBody(event.target.value)} maxLength={2000} /><div><button className="button-primary" disabled={busy} onClick={saveEdit}>Save</button><button className="text-button" onClick={() => setEditing(false)}>Cancel</button></div></div>
      : <><p className="practice-update-title">{update.title}</p><p className="practice-update-body">{update.body}</p></>}
    {update.status === 'draft' && !editing && <div className="learning-actions"><button disabled={busy} onClick={() => act('publish')}>Publish</button><button disabled={busy} onClick={() => setEditing(true)}>Edit</button><button disabled={busy} onClick={() => act('dismiss')}>Dismiss</button></div>}
  </article>
}

export function ProfessionalProfilePage({ personaId, navigate }: { personaId: DemoPhysicianPerspective; navigate: Navigate }) {
  const [profile, setProfile] = useState<ProfessionalProfile | null>(null)
  const [updates, setUpdates] = useState<PracticeUpdate[] | null>(null)
  const [error, setError] = useState('')
  const [savedNote, setSavedNote] = useState('')
  const load = () => {
    getProfessionalProfile(personaId).then(setProfile).catch((err: Error) => setError(err.message))
    getPhysicianUpdates(personaId).then(setUpdates).catch(() => setUpdates([]))
  }
  useEffect(load, [personaId]) // eslint-disable-line react-hooks/exhaustive-deps
  const onItemSaved = () => { load(); setSavedNote('Saved. A suggested update was drafted below for your review.') }
  const onUpdateChanged = (updated: PracticeUpdate) => setUpdates((prev) => (prev ?? []).map((item) => (item.id === updated.id ? updated : item)))
  const onUpdateCreated = (created: PracticeUpdate) => setUpdates((prev) => [created, ...(prev ?? [])])
  if (error) return <main className="page-shell profile-page"><div className="error-banner" role="alert">{error}</div></main>
  if (!profile) return <main className="page-shell profile-page"><p className="muted-note">Opening professional profile…</p></main>
  const drafts = (updates ?? []).filter((item) => item.status === 'draft')
  const published = (updates ?? []).filter((item) => item.status === 'published')
  const initials = profile.physician.name.replace('Dr. ', '').split(/\s+/).map((part) => part[0]).slice(0, 2).join('')
  return <main className="page-shell profile-page professional-profile-page">
    <header className="profile-hero">
      <span className="clinician-avatar large">{initials}</span>
      <div><p className="eyebrow">Professional profile</p><h1>{profile.physician.name}</h1><p className="profile-role">{profile.physician.specialty} · {profile.physician.location}</p></div>
    </header>
    <p className="profile-benefit-note">Your professional profile helps Lamina understand your background and expertise. Explicit referral preferences are managed separately in My Agent.</p>
    <section className="profile-completeness"><p className="eyebrow">Practice representation</p><h2>{profile.completeness.completed_section_count} of {profile.completeness.total_section_count} sections completed</h2></section>
    {savedNote && <p className="profile-save-note" role="status">{savedNote}</p>}
    {PROFILE_CATEGORIES.map((category) => <ProfileSection key={category} category={category} items={profile.sections[category]} personaId={personaId} onSaved={onItemSaved} />)}
    <section className="profile-section-v2 practice-updates-section">
      <div className="profile-section-heading"><h2>Practice updates</h2></div>
      <PracticeUpdateComposer personaId={personaId} onCreated={onUpdateCreated} />
      {drafts.length > 0 && <div className="practice-update-group"><p className="section-label">Drafts</p>{drafts.map((update) => <PracticeUpdateCard key={update.id} update={update} personaId={personaId} onChanged={onUpdateChanged} />)}</div>}
      {published.length > 0 && <div className="practice-update-group"><p className="section-label">Published</p>{published.map((update) => <PracticeUpdateCard key={update.id} update={update} personaId={personaId} onChanged={onUpdateChanged} />)}</div>}
      {drafts.length === 0 && published.length === 0 && <p className="profile-section-empty">No practice updates yet.</p>}
    </section>
  </main>
}

export function NetworkPhysicianProfilePage({ controlledId, navigate, backPath }: { controlledId: string; navigate: Navigate; backPath: string }) {
  const [data, setData] = useState<import('./api.ts').NetworkPhysicianProfile | null>(null)
  const [error, setError] = useState('')
  useEffect(() => { setData(null); setError(''); getNetworkPhysicianProfile(controlledId).then(setData).catch((err: Error) => setError(err.message)) }, [controlledId])
  if (error) return <main className="page-shell profile-page"><button className="text-button back-link" onClick={() => navigate(backPath)}>← Back</button><div className="error-banner" role="alert">{error}</div></main>
  if (!data) return <main className="page-shell profile-page"><button className="text-button back-link" onClick={() => navigate(backPath)}>← Back</button><p className="muted-note">Opening profile…</p></main>
  const rep = data.practice_representation
  const initials = data.physician.name.replace('Dr. ', '').split(/\s+/).map((part) => part[0]).slice(0, 2).join('')
  return <main className="page-shell profile-page">
    <button className="text-button back-link" onClick={() => navigate(backPath)}>← Back</button>
    <header className="profile-hero"><span className="clinician-avatar large">{initials}</span><div><p className="eyebrow">Professional profile</p><h1>{data.physician.name}</h1><p className="profile-role">{data.physician.specialty} · {data.physician.location}</p></div></header>
    <section className="practice-representation-panel"><p className="eyebrow">How the network sees this practice</p>
      {rep.clinical_focus.length > 0 && <div><span className="section-label">Clinical focus</span><ul className="clinical-list">{rep.clinical_focus.map((item) => <li key={item}>{item}</li>)}</ul></div>}
      {rep.good_fit.length > 0 && <div><span className="section-label">Good-fit cases</span><ul className="clinical-list">{rep.good_fit.map((item) => <li key={item}>{item}</li>)}</ul></div>}
      {rep.preferred_workup.length > 0 && <div><span className="section-label">Referral guidance</span><ul className="clinical-list">{rep.preferred_workup.map((item) => <li key={item}>{item}</li>)}</ul></div>}
    </section>
    {PROFILE_CATEGORIES.map((category) => data.professional_profile.sections[category].length > 0 && <section className="profile-section-v2" key={category}><div className="profile-section-heading"><h2>{CATEGORY_LABELS[category]}</h2></div><div className="profile-item-list">{data.professional_profile.sections[category].map((item) => <div className="profile-item-row" key={item.id}><div><strong>{item.title}</strong>{item.detail && <p>{item.detail}</p>}</div></div>)}</div></section>)}
    {data.published_updates.length > 0 && <section className="profile-section-v2"><div className="profile-section-heading"><h2>Practice updates</h2></div>{data.published_updates.map((update) => <article className="practice-update-card" key={update.id}><p className="practice-update-title">{update.title}</p><p className="practice-update-body">{update.body}</p></article>)}</section>}
    <p className="disclaimer">{data.disclaimer}</p>
  </main>
}
