import { useEffect, useMemo, useReducer, useRef, useState, type FormEvent } from 'react'
import { chatWithAgent, getActiveReferral, getAgentOverview, getConsultationHistory, getEncounter, getHandoff, getPhysicianReferrals, getPracticeRepresentation, type AgentOverview, type ConsultationRecord, type Referral } from './api.ts'
import { answerWorkspaceQuestion, DOCK_SUGGESTED_PROMPTS, type AgentReply } from './agentConversation.ts'
import { withMinimumTyping } from './agentChat.tsx'
import { CHEN_AGENT_NAME, CHEN_ID, CHEN_NAME, PCP_AGENT_NAME, PCP_NAME, patientName } from './demoIdentity.ts'
import { DEMO_PATIENTS, type DemoPatientSummary } from './demoPatients.ts'
import { clarificationFocusPath, trainingPath } from './Engagement.tsx'
import { timeAwareGreeting } from './greeting.ts'
import { buildBriefing, buildPhysicianQueue, buildSpecialistQueue, countWord, dashboardNeeds, type AgentLogEntry, type PhysicianQueue, type PracticeQuestion, type QueueItem } from './physicianQueue.ts'
import { CHEN_AUTO_ROUTED_PATIENT_IDS, markReferralJustAccepted, RequestReviewModal } from './Referral.tsx'
import { specialistNextSteps, type SpecialistCareState } from './specialistWorklist.ts'

/**
 * Physician-agent home pass. A physician's Dashboard ("my agent has already
 * been working; here is what needs me"), the For you queue, and the docked
 * "Ask your agent" panel -- for the referring physician (Lucy) and the
 * receiving specialist (Chen). All three surfaces read one shared snapshot per
 * physician, adapted into a PhysicianQueue by physicianQueue.ts -- no parallel
 * task store.
 */

type Navigate = (path: string) => void
export type AgentPersona = 'lucy' | 'chen'

/** The physician-owned demo patients with a real consult-engine case. */
export const LUCY_QUEUE_PATIENTS = DEMO_PATIENTS.filter((patient) => patient.implemented && patient.owner !== 'chen')
/** Chen's own panel. Referred patients (Tonjit) join it only through a real
 * referral -- see AgentDock's knownPatients. */
const CHEN_PANEL_PATIENTS = DEMO_PATIENTS.filter((patient) => patient.owner === 'chen')

type PersonaConfig = {
  firstName: string; agentName: string; forYouPath: string; agentPath: string
  patientPath: (id: string) => string; patients: DemoPatientSummary[]
  firstJob: { now: string; done: string }
}

const PERSONAS: Record<AgentPersona, PersonaConfig> = {
  lucy: {
    firstName: PCP_NAME.split(' ')[1], agentName: PCP_AGENT_NAME, forYouPath: '/for-you', agentPath: '/agent?tab=overview',
    patientPath: (id) => `/patients/${id}`, patients: LUCY_QUEUE_PATIENTS,
    firstJob: { now: 'Reviewing new referrals and network updates…', done: 'Reviewed new referrals and network updates' },
  },
  chen: {
    firstName: CHEN_NAME.split(' ')[1], agentName: CHEN_AGENT_NAME, forYouPath: '/chen/for-you', agentPath: '/chen/agent?tab=overview',
    patientPath: (id) => `/chen/patients/${id}`, patients: CHEN_PANEL_PATIENTS,
    firstJob: { now: 'Reviewing incoming referrals and network updates…', done: 'Reviewed incoming referrals and network updates' },
  },
}

/* ------------------------------------------------------------- snapshots */

type LucyRaw = {
  records: ConsultationRecord[]; referrals: Map<string, Referral | null>
  handoffViewedAt: Map<string, string>; practiceQuestions: PracticeQuestion[]
}
type ChenRaw = { incoming: Referral[]; all: Referral[]; careState: SpecialistCareState }
type Snapshot<T> = { loading: boolean; error: boolean; overview: AgentOverview | null; data: T | null }

const snapshots: { lucy: Snapshot<LucyRaw>; chen: Snapshot<ChenRaw> } = {
  lucy: { loading: true, error: false, overview: null, data: null },
  chen: { loading: true, error: false, overview: null, data: null },
}
const inflight: Partial<Record<AgentPersona, Promise<void>>> = {}
const listeners = new Set<() => void>()
const emit = () => listeners.forEach((listener) => listener())

async function loadLucy(): Promise<Snapshot<LucyRaw>> {
  const [records, referralList, overview, representation] = await Promise.all([
    getConsultationHistory().catch(() => null),
    Promise.all(LUCY_QUEUE_PATIENTS.map((patient) => getActiveReferral(patient.id).catch(() => null))),
    getAgentOverview('lucy').catch(() => null),
    getPracticeRepresentation('lucy').catch(() => null),
  ])
  const referrals = new Map(LUCY_QUEUE_PATIENTS.map((patient, index) => [patient.id, referralList[index]]))
  const handoffViewedAt = new Map<string, string>()
  await Promise.all([...referrals.values()].map(async (referral) => {
    if (!referral || referral.id == null || referral.status !== 'consult_returned') return
    const handoff = await getHandoff(referral.id).catch(() => null)
    if (handoff?.viewed_by_referring_physician_at) handoffViewedAt.set(referral.patient_id, handoff.viewed_by_referring_physician_at)
  }))
  const practiceQuestions = (representation?.gaps.unanswered_questions ?? [])
    .filter((question) => question.status === 'unanswered')
    .map((question) => ({ id: question.id, prompt: question.prompt, priority: question.priority }))
  return { loading: false, error: records === null, overview, data: { records: records ?? [], referrals, handoffViewedAt, practiceQuestions } }
}

/** The same real referral/encounter/handoff reads Chen's worklist has always used. */
async function loadChen(): Promise<Snapshot<ChenRaw>> {
  const [submitted, all, overview] = await Promise.all([
    getPhysicianReferrals(CHEN_ID, 'submitted').catch(() => null),
    getPhysicianReferrals(CHEN_ID).catch(() => null),
    getAgentOverview('chen').catch(() => null),
  ])
  const careState: SpecialistCareState = new Map()
  await Promise.all((all ?? []).filter((referral) => ['accepted', 'scheduled', 'consult_returned'].includes(referral.status)).map(async (referral) => {
    if (referral.id == null) return
    const [encounter, handoff] = await Promise.all([getEncounter(referral.id).catch(() => null), getHandoff(referral.id, CHEN_ID).catch(() => null)])
    careState.set(referral.id, { encounter, handoff })
  }))
  const error = submitted === null || all === null
  return { loading: false, error, overview, data: { incoming: submitted ?? [], all: all ?? [], careState } }
}

function loadSnapshot(persona: AgentPersona): Promise<void> {
  const pending = inflight[persona]
  if (pending) return pending
  const next = (persona === 'lucy'
    ? loadLucy().then((value) => { snapshots.lucy = value })
    : loadChen().then((value) => { snapshots.chen = value })
  ).then(emit).finally(() => { delete inflight[persona] })
  inflight[persona] = next
  return next
}

/* Items the physician moved to Later -- a per-browser convenience only. */
const deferredKey = (persona: AgentPersona) => (persona === 'lucy' ? 'lamina-for-you-later' : `lamina-for-you-later-${persona}`)
function readDeferred(persona: AgentPersona): Set<string> {
  try { return new Set(JSON.parse(window.sessionStorage.getItem(deferredKey(persona)) ?? '[]') as string[]) } catch { return new Set() }
}
function setDeferred(persona: AgentPersona, id: string, deferred: boolean) {
  const next = readDeferred(persona)
  if (deferred) next.add(id); else next.delete(id)
  try { window.sessionStorage.setItem(deferredKey(persona), JSON.stringify([...next])) } catch { /* storage unavailable */ }
  emit()
}

const EMPTY_QUEUE: PhysicianQueue = { needs: [], later: [], done: [], waiting: [], log: [] }

/** Standing synthetic context Chen's agent handled before this session -- the
 * same three auto-routed requests his Dashboard has always shown. */
const CHEN_STANDING_LOG: AgentLogEntry[] = [{
  id: 'chen-auto-routed', time: '', text: 'Routed 3 routine requests automatically: 2 visits, 1 e-consult',
  path: `/chen/patients?highlight=${CHEN_AUTO_ROUTED_PATIENT_IDS.join(',')}`,
}]

export function useWorkspaceSnapshot(persona: AgentPersona = 'lucy') {
  const [, rerender] = useReducer((value: number) => value + 1, 0)
  useEffect(() => {
    listeners.add(rerender)
    void loadSnapshot(persona)
    return () => { listeners.delete(rerender) }
  }, [persona])
  const deferred = readDeferred(persona)
  const deferredToken = [...deferred].sort().join('|')
  const snapshot = snapshots[persona]
  const queue = useMemo<PhysicianQueue>(() => {
    const now = new Date()
    if (persona === 'lucy') {
      const data = snapshots.lucy.data
      if (!data) return EMPTY_QUEUE
      return buildPhysicianQueue({
        patients: LUCY_QUEUE_PATIENTS, records: data.records, referrals: data.referrals, handoffViewedAt: data.handoffViewedAt,
        clarifications: snapshots.lucy.overview?.learning_opportunities ?? [],
        clarificationPath: (id) => clarificationFocusPath(trainingPath('lucy'), id),
        practiceQuestions: data.practiceQuestions, practiceQuestionsPath: trainingPath('lucy'),
        deferred, now,
      })
    }
    const data = snapshots.chen.data
    if (!data) return EMPTY_QUEUE
    const accepted = data.all.filter((referral) => ['accepted', 'scheduled', 'consult_returned'].includes(referral.status))
    return buildSpecialistQueue({
      steps: specialistNextSteps(data.incoming, accepted, data.careState, now, PCP_NAME),
      referrals: data.all, careState: data.careState,
      patientName, patientPath: PERSONAS.chen.patientPath, referringName: PCP_NAME,
      clarifications: snapshots.chen.overview?.learning_opportunities ?? [],
      clarificationPath: (id) => clarificationFocusPath(trainingPath('chen'), id),
      standingLog: CHEN_STANDING_LOG, deferred, now,
    })
  }, [persona, snapshot, deferredToken]) // eslint-disable-line react-hooks/exhaustive-deps
  const incoming = persona === 'chen' ? snapshots.chen.data?.incoming ?? [] : []
  return { loading: snapshot.loading, error: snapshot.error, overview: snapshot.overview, queue, incoming }
}

/** Sidebar "For you" count -- the same queue the pages render. */
const COUNT_REFRESH_MS = 8000

/** Sidebar "For you" count -- the same queue the pages render. The shell
 * stays mounted while the physician works inside Patient Detail (where a
 * referral can be created or accepted), so the count quietly re-reads the
 * same snapshot while the tab is visible. */
export function useNeedsCount(persona: AgentPersona = 'lucy'): number {
  useEffect(() => {
    const timer = window.setInterval(() => { if (document.visibilityState === 'visible') void loadSnapshot(persona) }, COUNT_REFRESH_MS)
    return () => window.clearInterval(timer)
  }, [persona])
  return useWorkspaceSnapshot(persona).queue.needs.length
}

/** The highlighted patient name, keeping a possessive ("'s") inside the
 * highlight so no gap opens between the name and the apostrophe. */
function BriefingLead({ lead }: { lead: { name: string | null; rest: string } }) {
  if (!lead.name) return <>{lead.rest}</>
  const possessive = lead.rest.startsWith("'s") ? "'s" : ''
  return <><span className="agent-ent">{lead.name}{possessive}</span>{lead.rest.slice(possessive.length)}</>
}

/* --------------------------------------------------------------- shared */

export function AgentOrb({ still = false }: { still?: boolean }) {
  return <span className={`agent-orb ${still ? 'still' : ''}`} aria-hidden="true" />
}

const logTime = (iso: string) => {
  if (!iso) return 'Earlier'
  const date = new Date(iso)
  const now = new Date()
  return date.toDateString() === now.toDateString()
    ? date.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })
    : date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
}

/** Opening a queue item: an incoming referral opens the existing referral
 * review (RequestReviewModal) exactly as Chen's worklist always has --
 * accepting it lands on his existing Patient Detail. Everything else
 * navigates to the item's own existing page. */
function useOpenItem(persona: AgentPersona, navigate: Navigate, incoming: Referral[]) {
  const [reviewing, setReviewing] = useState<Referral | null>(null)
  const open = (item: QueueItem) => {
    const referral = item.kind === 'incoming_referral' ? incoming.find((candidate) => candidate.id === item.referralId) : undefined
    if (referral) setReviewing(referral)
    else navigate(item.path)
  }
  const handleAccepted = (updated: Referral) => {
    setReviewing(null)
    markReferralJustAccepted(updated.patient_id)
    void loadSnapshot(persona)
    navigate(`/chen/patients/${updated.patient_id}`)
  }
  const modal = reviewing && <RequestReviewModal referral={reviewing} receivingPhysicianName={CHEN_NAME} onAccepted={handleAccepted} onClose={() => setReviewing(null)} />
  return { open, modal }
}

function NeedRow({ item, persona, onOpen }: { item: QueueItem; persona: AgentPersona; onOpen: (item: QueueItem) => void }) {
  return <div className="agent-item" data-kind={item.kind}>
    <div className="agent-item-text"><div className="agent-item-title">{item.title}</div><div className="agent-item-sub">{item.detail}</div></div>
    <button className="agent-btn" onClick={() => setDeferred(persona, item.id, true)}>Later</button>
    <button className="agent-btn primary" onClick={() => onOpen(item)} aria-label={`${item.action} ${item.title}`}>{item.action}</button>
  </div>
}

/* ----------------------------------------------------------- agent status */

type StatusJob = { now: string; done: string }
/** The status line plays once per session per physician, then rests on "All caught up". */
const statusPlayed: Partial<Record<AgentPersona, boolean>> = {}
const justNowLog: Record<AgentPersona, AgentLogEntry[]> = { lucy: [], chen: [] }
const FINAL_STATUS = "All caught up. I'll keep watching."

function useAgentStatus(persona: AgentPersona, loading: boolean, leadFirstName: string | null) {
  const firstJob = PERSONAS[persona].firstJob
  const [text, setText] = useState(() => (statusPlayed[persona] ? FINAL_STATUS : firstJob.now))
  const [, rerender] = useReducer((value: number) => value + 1, 0)
  useEffect(() => {
    if (statusPlayed[persona] || loading) return
    statusPlayed[persona] = true
    const reduced = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false
    const jobs: StatusJob[] = [firstJob]
    if (leadFirstName) jobs.push({ now: `Checking ${leadFirstName}'s referral readiness…`, done: `Checked ${leadFirstName}'s referral readiness` })
    const finish = (job: StatusJob) => { justNowLog[persona].unshift({ id: `just-now-${persona}-${justNowLog[persona].length}`, time: new Date().toISOString(), text: job.done, path: null }); rerender() }
    if (reduced) { jobs.forEach(finish); setText(FINAL_STATUS); return }
    const timers: number[] = []
    finish(jobs[0])
    if (jobs[1]) {
      setText(jobs[1].now)
      timers.push(window.setTimeout(() => { finish(jobs[1]); setText(FINAL_STATUS) }, 2600))
    } else setText(FINAL_STATUS)
    return () => timers.forEach((timer) => window.clearTimeout(timer))
  }, [persona, loading, leadFirstName]) // eslint-disable-line react-hooks/exhaustive-deps
  return { text, justNow: justNowLog[persona] }
}

/* ------------------------------------------------------------- Dashboard */

export function AgentDashboard({ navigate, persona = 'lucy' }: { navigate: Navigate; persona?: AgentPersona }) {
  const config = PERSONAS[persona]
  const { loading, error, queue, incoming } = useWorkspaceSnapshot(persona)
  const { open, modal } = useOpenItem(persona, navigate, incoming)
  const top = dashboardNeeds(queue)
  const hidden = queue.needs.length - top.length
  const briefing = buildBriefing(queue.needs)
  const leadPatient = queue.needs[0]?.patientId ? queue.needs[0].title.split(' ')[0] : null
  const status = useAgentStatus(persona, loading, leadPatient)
  const [logOpen, setLogOpen] = useState(false)
  const log = [...status.justNow, ...queue.log]
  const handled = queue.log.length
  return <main className="agent-home" aria-label="Home">
    <h1 className="agent-home-greeting">{timeAwareGreeting(config.firstName)}</h1>
    <div className="agent-status" role="status"><AgentOrb /><span>{loading ? config.firstJob.now : status.text}</span></div>
    {error && <p className="agent-home-error" role="alert">Some recent workspace activity is temporarily unavailable. Patient records remain accessible.</p>}
    {!loading && <>
      <p className="agent-brief">
        {briefing.opening}
        {briefing.lead && <BriefingLead lead={briefing.lead} />}
        {' '}<span className="agent-brief-quiet">{briefing.closing}</span>
      </p>
      {top.length > 0 && <section className="agent-needs" aria-label="Needs you">
        <h2 className="agent-label">Needs you</h2>
        <div className="agent-list">{top.map((item) => <NeedRow key={item.id} item={item} persona={persona} onOpen={open} />)}</div>
        {hidden > 0 && <button className="agent-link" onClick={() => navigate(config.forYouPath)}>See {hidden} more in For you →</button>}
      </section>}
      <section className="agent-away" aria-label="While you were away">
        <p className="agent-away-line">
          <span>{handled ? `While you were away I handled ${countWord(handled).toLowerCase()} thing${handled === 1 ? '' : 's'} on my own.` : 'While you were away nothing new needed handling.'}</span>
          {log.length > 0 && <button className="agent-link" aria-expanded={logOpen} onClick={() => setLogOpen((value) => !value)}>{logOpen ? 'Hide' : handled ? 'See what I did' : 'See what I checked'}</button>}
        </p>
        {logOpen && <div className="agent-log">{log.slice(0, 10).map((entry) => {
          const body = <><span className="agent-log-time">{entry.path ? logTime(entry.time) : 'Just now'}</span><span>{entry.text}</span></>
          return entry.path
            ? <button key={entry.id} className="agent-log-row" onClick={() => navigate(entry.path!)}>{body}</button>
            : <div key={entry.id} className="agent-log-row">{body}</div>
        })}</div>}
      </section>
    </>}
    {modal}
  </main>
}

/* --------------------------------------------------------------- For you */

export function ForYouPage({ navigate, persona = 'lucy' }: { navigate: Navigate; persona?: AgentPersona }) {
  const { loading, queue, incoming } = useWorkspaceSnapshot(persona)
  const { open, modal } = useOpenItem(persona, navigate, incoming)
  const { needs, later, done } = queue
  const statusLine = needs.length
    ? `${countWord(needs.length)} ${needs.length === 1 ? 'thing needs' : 'things need'} you${later.length ? ` · ${later.length} for later` : ''}`
    : "You're all caught up."
  return <main className="agent-home for-you" aria-label="For you">
    <h1 className="agent-home-greeting">For you</h1>
    <div className="agent-status muted">{loading ? 'Gathering everything that needs you…' : statusLine}</div>
    <p className="for-you-intro">Everything I can't or shouldn't finish without you. I handle what I'm ready for and bring the rest here.</p>
    {!loading && <>
      {needs.length > 0 && <section className="for-you-section" aria-label="Needs you"><h2 className="agent-label">Needs you</h2>
        <div className="agent-list">{needs.map((item) => <NeedRow key={item.id} item={item} persona={persona} onOpen={open} />)}</div>
      </section>}
      {later.length > 0 && <section className="for-you-section" aria-label="Later"><h2 className="agent-label">Later</h2>
        <div className="agent-list">{later.map((item) => <div className="agent-item quiet" key={item.id} data-kind={item.kind}>
          <div className="agent-item-text"><div className="agent-item-title">{item.title}</div><div className="agent-item-sub">{item.detail}</div></div>
          {item.deferred
            ? <button className="agent-btn" onClick={() => setDeferred(persona, item.id, false)}>Bring back</button>
            : <button className="agent-btn" onClick={() => open(item)} aria-label={`${item.action} ${item.title}`}>{item.action}</button>}
        </div>)}</div>
      </section>}
      {done.length > 0 && <section className="for-you-section" aria-label="Done today"><h2 className="agent-label">Done today</h2>
        <div className="agent-list">{done.map((item) => <button className="agent-item quiet done" key={item.id} onClick={() => navigate(item.path)}>
          <div className="agent-item-text"><div className="agent-item-title">{item.title}</div><div className="agent-item-sub">{item.detail}</div></div>
          <span className="agent-item-when">✓ Done</span>
        </button>)}</div>
      </section>}
    </>}
    {modal}
  </main>
}

/* ------------------------------------------------------- Ask your agent */

type DockMessage = { id: string; role: 'physician' | 'agent'; reply?: AgentReply; text?: string; pending?: boolean }

/** Each physician's conversation survives moving between Dashboard and For you. */
const dockMessages: Record<AgentPersona, DockMessage[]> = {
  lucy: [{ id: 'hello', role: 'agent', reply: { paragraphs: [`Hi ${PERSONAS.lucy.firstName}. Ask me about a patient, or what I have been working on.`] } }],
  chen: [{ id: 'hello', role: 'agent', reply: { paragraphs: [`Hi ${PERSONAS.chen.firstName}. Ask me about a patient, or what I have been working on.`] } }],
}
const dockSent: Partial<Record<AgentPersona, boolean>> = {}

const DOCK_KEY = 'lamina-agent-dock'
const DOCK_WIDE_QUERY = '(min-width: 1101px)'
function initialDockOpen(): boolean {
  try { const saved = window.localStorage.getItem(DOCK_KEY); if (saved) return saved === 'open' } catch { /* storage unavailable */ }
  return window.matchMedia?.(DOCK_WIDE_QUERY).matches ?? true
}

export function AgentDock({ navigate, persona = 'lucy' }: { navigate: Navigate; persona?: AgentPersona }) {
  const config = PERSONAS[persona]
  const snapshot = useWorkspaceSnapshot(persona)
  const [open, setOpenState] = useState(initialDockOpen)
  const [messages, setMessagesState] = useState<DockMessage[]>(dockMessages[persona])
  const [input, setInput] = useState('')
  const [busy, setBusy] = useState(false)
  const bodyRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  const setMessages = (update: (prev: DockMessage[]) => DockMessage[]) => setMessagesState((prev) => { dockMessages[persona] = update(prev); return dockMessages[persona] })
  const setOpen = (next: boolean, focus = false) => {
    setOpenState(next)
    try { window.localStorage.setItem(DOCK_KEY, next ? 'open' : 'collapsed') } catch { /* storage unavailable */ }
    if (next && focus) window.setTimeout(() => inputRef.current?.focus(), 220)
  }
  useEffect(() => {
    document.body.classList.toggle('agent-dock-open', open)
    return () => document.body.classList.remove('agent-dock-open')
  }, [open])
  useEffect(() => {
    if (!open) return
    const onKey = (event: KeyboardEvent) => { if (event.key === 'Escape' && !(window.matchMedia?.(DOCK_WIDE_QUERY).matches ?? true)) setOpen(false) }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [open]) // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { const body = bodyRef.current; if (body) body.scrollTop = body.scrollHeight }, [messages, open])

  const send = async (text: string) => {
    const trimmed = text.trim()
    if (!trimmed || busy) return
    dockSent[persona] = true
    setOpen(true)
    setInput('')
    setBusy(true)
    const pendingId = `pending-${Date.now()}`
    setMessages((prev) => [...prev, { id: `me-${Date.now()}`, role: 'physician', text: trimmed }, { id: pendingId, role: 'agent', pending: true }])
    // The physician's own panel, plus any patient their queue knows through a real referral.
    const queued = new Set([...snapshot.queue.needs, ...snapshot.queue.later, ...snapshot.queue.waiting].map((item) => item.patientId))
    const knownPatients = [...config.patients, ...DEMO_PATIENTS.filter((patient) => queued.has(patient.id) && !config.patients.includes(patient))]
    const local = answerWorkspaceQuestion(trimmed, { queue: snapshot.queue, overview: snapshot.overview, patients: knownPatients, patientPath: config.patientPath, agentPath: config.agentPath })
    let reply: AgentReply
    try {
      reply = local
        ? await withMinimumTyping(Promise.resolve(local), 650)
        : await withMinimumTyping(chatWithAgent(persona, { mode: 'practice_question', message: trimmed, origin: 'practice' }).then((response) => ({ paragraphs: [response.answer] })), 650)
    } catch {
      reply = { paragraphs: ["I couldn't reach my practice notes just now. Ask me again in a moment."] }
    }
    setMessages((prev) => prev.map((item) => (item.id === pendingId ? { id: pendingId, role: 'agent', reply } : item)))
    setBusy(false)
  }
  const submit = (event: FormEvent) => { event.preventDefault(); void send(input) }

  if (!open) return <aside className="agent-dock collapsed" aria-label="Ask your agent">
    <button className="agent-dock-rail" onClick={() => setOpen(true, true)} aria-label="Open conversation with your agent" aria-expanded={false}><AgentOrb /><span>Ask your agent</span></button>
  </aside>

  return <aside className="agent-dock" aria-label="Ask your agent">
    <div className="agent-dock-head">
      <AgentOrb />
      <div className="agent-dock-who">Your agent<span>{config.agentName} · knows your patients and referrals</span></div>
      <button className="agent-dock-toggle" onClick={() => setOpen(false)} aria-label="Collapse conversation" aria-expanded={true} title="Collapse">
        <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><rect x="1.75" y="2.25" width="12.5" height="11.5" rx="2" /><line x1="10" y1="2.5" x2="10" y2="13.5" /><path d="M5.5 6 L7.25 8 L5.5 10" /></svg>
      </button>
    </div>
    <div className="agent-dock-body" ref={bodyRef} aria-live="polite">{messages.map((message) => message.role === 'physician'
      ? <div key={message.id} className="agent-msg me">{message.text}</div>
      : <div key={message.id} className="agent-msg agent"><AgentOrb still />
        {message.pending
          ? <div className="agent-typing" role="status" aria-label="Your agent is responding"><i /><i /><i /></div>
          : <div className="agent-msg-body">
            {message.reply?.paragraphs.map((paragraph, index) => <p key={index}>{paragraph}</p>)}
            {message.reply?.bullets && <ul>{message.reply.bullets.map((bullet, index) => <li key={index}>{bullet}</li>)}</ul>}
            {message.reply?.link && <div className="agent-msg-card"><div><strong>{message.reply.link.label}</strong><span>{message.reply.link.detail}</span></div><button className="agent-btn primary" onClick={() => navigate(message.reply!.link!.path)}>{message.reply.link.action}</button></div>}
          </div>}
      </div>)}</div>
    {!dockSent[persona] && <div className="agent-dock-suggest">{DOCK_SUGGESTED_PROMPTS.map((prompt) => <button key={prompt} onClick={() => void send(prompt)}>{prompt}</button>)}</div>}
    <form className="agent-dock-input" onSubmit={submit}>
      <input ref={inputRef} value={input} onChange={(event) => setInput(event.target.value)} placeholder="Ask your agent…" aria-label="Ask your agent" autoComplete="off" />
      <button className="agent-dock-send" aria-label="Send" disabled={busy || !input.trim()}>
        <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M7 12V2M2.5 6.5L7 2l4.5 4.5" /></svg>
      </button>
    </form>
  </aside>
}
