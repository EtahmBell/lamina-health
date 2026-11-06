import { useEffect, useMemo, useReducer, useRef, useState, type FormEvent } from 'react'
import { chatWithAgent, getActiveReferral, getAgentOverview, getConsultationHistory, getHandoff, type AgentOverview, type ConsultationRecord, type Referral } from './api.ts'
import { answerWorkspaceQuestion, DOCK_SUGGESTED_PROMPTS, type AgentReply } from './agentConversation.ts'
import { withMinimumTyping } from './agentChat.tsx'
import { PCP_AGENT_NAME } from './demoIdentity.ts'
import { DEMO_PATIENTS } from './demoPatients.ts'
import { clarificationFocusPath, trainingPath } from './Engagement.tsx'
import { timeAwareGreeting } from './greeting.ts'
import { buildBriefing, buildPhysicianQueue, countWord, dashboardNeeds, type AgentLogEntry, type PhysicianQueue, type QueueItem } from './physicianQueue.ts'

/**
 * Physician-agent home pass. Lucy's Dashboard ("my agent has already been
 * working; here is what needs me"), the For you queue, and the docked "Ask
 * your agent" panel. All three read one shared workspace snapshot, adapted
 * into a PhysicianQueue by physicianQueue.ts -- no parallel task store.
 */

type Navigate = (path: string) => void

/** The physician-owned demo patients with a real consult-engine case. */
export const LUCY_QUEUE_PATIENTS = DEMO_PATIENTS.filter((patient) => patient.implemented && patient.owner !== 'chen')

/* ------------------------------------------------------------- snapshot */

type RawSnapshot = {
  loading: boolean; error: boolean
  records: ConsultationRecord[]; referrals: Map<string, Referral | null>
  handoffViewedAt: Map<string, string>; overview: AgentOverview | null
}

let raw: RawSnapshot = { loading: true, error: false, records: [], referrals: new Map(), handoffViewedAt: new Map(), overview: null }
let inflight: Promise<void> | null = null
const listeners = new Set<() => void>()
const emit = () => listeners.forEach((listener) => listener())

function loadSnapshot(): Promise<void> {
  if (inflight) return inflight
  inflight = (async () => {
    const [records, referralList, overview] = await Promise.all([
      getConsultationHistory().catch(() => null),
      Promise.all(LUCY_QUEUE_PATIENTS.map((patient) => getActiveReferral(patient.id).catch(() => null))),
      getAgentOverview('lucy').catch(() => null),
    ])
    const referrals = new Map(LUCY_QUEUE_PATIENTS.map((patient, index) => [patient.id, referralList[index]]))
    const handoffViewedAt = new Map<string, string>()
    await Promise.all([...referrals.values()].map(async (referral) => {
      if (!referral || referral.id == null || referral.status !== 'consult_returned') return
      const handoff = await getHandoff(referral.id).catch(() => null)
      if (handoff?.viewed_by_referring_physician_at) handoffViewedAt.set(referral.patient_id, handoff.viewed_by_referring_physician_at)
    }))
    raw = { loading: false, error: records === null, records: records ?? [], referrals, handoffViewedAt, overview }
    emit()
  })().finally(() => { inflight = null })
  return inflight
}

/* Items the physician moved to Later -- a per-browser convenience only. */
const DEFERRED_KEY = 'lamina-for-you-later'
function readDeferred(): Set<string> {
  try { return new Set(JSON.parse(window.sessionStorage.getItem(DEFERRED_KEY) ?? '[]') as string[]) } catch { return new Set() }
}
function setDeferred(id: string, deferred: boolean) {
  const next = readDeferred()
  if (deferred) next.add(id); else next.delete(id)
  try { window.sessionStorage.setItem(DEFERRED_KEY, JSON.stringify([...next])) } catch { /* storage unavailable */ }
  emit()
}

export function useWorkspaceSnapshot() {
  const [, rerender] = useReducer((value: number) => value + 1, 0)
  useEffect(() => {
    listeners.add(rerender)
    void loadSnapshot()
    return () => { listeners.delete(rerender) }
  }, [])
  const deferred = readDeferred()
  const deferredKey = [...deferred].sort().join('|')
  const queue = useMemo<PhysicianQueue>(() => buildPhysicianQueue({
    patients: LUCY_QUEUE_PATIENTS, records: raw.records, referrals: raw.referrals,
    handoffViewedAt: raw.handoffViewedAt,
    clarifications: raw.overview?.learning_opportunities ?? [],
    clarificationPath: (id) => clarificationFocusPath(trainingPath('lucy'), id),
    deferred, now: new Date(),
  }), [raw, deferredKey]) // eslint-disable-line react-hooks/exhaustive-deps
  return { loading: raw.loading, error: raw.error, overview: raw.overview, queue }
}

/* --------------------------------------------------------------- shared */

export function AgentOrb({ still = false }: { still?: boolean }) {
  return <span className={`agent-orb ${still ? 'still' : ''}`} aria-hidden="true" />
}

const logTime = (iso: string) => {
  const date = new Date(iso)
  const now = new Date()
  return date.toDateString() === now.toDateString()
    ? date.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })
    : date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
}

function NeedRow({ item, navigate }: { item: QueueItem; navigate: Navigate }) {
  return <div className="agent-item" data-kind={item.kind}>
    <div className="agent-item-text"><div className="agent-item-title">{item.title}</div><div className="agent-item-sub">{item.detail}</div></div>
    <button className="agent-btn" onClick={() => setDeferred(item.id, true)}>Later</button>
    <button className="agent-btn primary" onClick={() => navigate(item.path)} aria-label={`${item.action} ${item.title}`}>{item.action}</button>
  </div>
}

/* ----------------------------------------------------------- agent status */

type StatusJob = { now: string; done: string }
/** The status line plays once per session, then rests on "All caught up". */
let statusPlayed = false
const justNowLog: AgentLogEntry[] = []

function useAgentStatus(loading: boolean, leadFirstName: string | null) {
  const final = "All caught up. I'll keep watching."
  const [text, setText] = useState(() => (statusPlayed ? final : 'Reviewing new referrals and network updates…'))
  const [, rerender] = useReducer((value: number) => value + 1, 0)
  useEffect(() => {
    if (statusPlayed || loading) return
    statusPlayed = true
    const reduced = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false
    const jobs: StatusJob[] = [{ now: 'Reviewing new referrals and network updates…', done: 'Reviewed new referrals and network updates' }]
    if (leadFirstName) jobs.push({ now: `Checking ${leadFirstName}'s referral readiness…`, done: `Checked ${leadFirstName}'s referral readiness` })
    const finish = (job: StatusJob) => { justNowLog.unshift({ id: `just-now-${justNowLog.length}`, time: new Date().toISOString(), text: job.done, path: null }); rerender() }
    if (reduced) { jobs.forEach(finish); setText(final); return }
    const timers: number[] = []
    finish(jobs[0])
    if (jobs[1]) {
      setText(jobs[1].now)
      timers.push(window.setTimeout(() => { finish(jobs[1]); setText(final) }, 2600))
    } else setText(final)
    return () => timers.forEach((timer) => window.clearTimeout(timer))
  }, [loading, leadFirstName])
  return { text, justNow: justNowLog }
}

/* ------------------------------------------------------------- Dashboard */

export function AgentDashboard({ navigate }: { navigate: Navigate }) {
  const { loading, error, queue } = useWorkspaceSnapshot()
  const top = dashboardNeeds(queue)
  const hidden = queue.needs.length - top.length
  const briefing = buildBriefing(queue.needs)
  const leadPatient = queue.needs[0]?.patientId ? queue.needs[0].title.split(' ')[0] : null
  const status = useAgentStatus(loading, leadPatient)
  const [logOpen, setLogOpen] = useState(false)
  const log = [...status.justNow, ...queue.log]
  const handled = queue.log.length
  return <main className="agent-home" aria-label="Dashboard">
    <h1 className="agent-home-greeting">{timeAwareGreeting('Lucy')}</h1>
    <div className="agent-status" role="status"><AgentOrb /><span>{loading ? 'Reviewing new referrals and network updates…' : status.text}</span></div>
    {error && <p className="agent-home-error" role="alert">Some recent workspace activity is temporarily unavailable. Patient records remain accessible.</p>}
    {!loading && <>
      <p className="agent-brief">
        {briefing.opening}
        {briefing.lead && <>{briefing.lead.name && <span className="agent-ent">{briefing.lead.name}</span>}{briefing.lead.rest}</>}
        {' '}<span className="agent-brief-quiet">{briefing.closing}</span>
      </p>
      {top.length > 0 && <section className="agent-needs" aria-label="Needs you">
        <h2 className="agent-label">Needs you</h2>
        <div className="agent-list">{top.map((item) => <NeedRow key={item.id} item={item} navigate={navigate} />)}</div>
        {hidden > 0 && <button className="agent-link" onClick={() => navigate('/for-you')}>See {hidden} more in For you →</button>}
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
  </main>
}

/* --------------------------------------------------------------- For you */

export function ForYouPage({ navigate }: { navigate: Navigate }) {
  const { loading, queue } = useWorkspaceSnapshot()
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
        <div className="agent-list">{needs.map((item) => <NeedRow key={item.id} item={item} navigate={navigate} />)}</div>
      </section>}
      {later.length > 0 && <section className="for-you-section" aria-label="Later"><h2 className="agent-label">Later</h2>
        <div className="agent-list">{later.map((item) => <div className="agent-item quiet" key={item.id} data-kind={item.kind}>
          <div className="agent-item-text"><div className="agent-item-title">{item.title}</div><div className="agent-item-sub">{item.detail}</div></div>
          {item.deferred
            ? <button className="agent-btn" onClick={() => setDeferred(item.id, false)}>Bring back</button>
            : <button className="agent-btn" onClick={() => navigate(item.path)} aria-label={`${item.action} ${item.title}`}>{item.action}</button>}
        </div>)}</div>
      </section>}
      {done.length > 0 && <section className="for-you-section" aria-label="Done today"><h2 className="agent-label">Done today</h2>
        <div className="agent-list">{done.map((item) => <button className="agent-item quiet done" key={item.id} onClick={() => navigate(item.path)}>
          <div className="agent-item-text"><div className="agent-item-title">{item.title}</div><div className="agent-item-sub">{item.detail}</div></div>
          <span className="agent-item-when">✓ Done</span>
        </button>)}</div>
      </section>}
    </>}
  </main>
}

/* ------------------------------------------------------- Ask your agent */

type DockMessage = { id: string; role: 'physician' | 'agent'; reply?: AgentReply; text?: string; pending?: boolean }

/** The conversation survives moving between Dashboard and For you. */
let dockMessages: DockMessage[] = [{ id: 'hello', role: 'agent', reply: { paragraphs: ['Hi Lucy. Ask me about a patient, or what I have been working on.'] } }]
let dockSent = false

const DOCK_KEY = 'lamina-agent-dock'
const DOCK_WIDE_QUERY = '(min-width: 1101px)'
function initialDockOpen(): boolean {
  try { const saved = window.localStorage.getItem(DOCK_KEY); if (saved) return saved === 'open' } catch { /* storage unavailable */ }
  return window.matchMedia?.(DOCK_WIDE_QUERY).matches ?? true
}

export function AgentDock({ navigate }: { navigate: Navigate }) {
  const snapshot = useWorkspaceSnapshot()
  const [open, setOpenState] = useState(initialDockOpen)
  const [messages, setMessagesState] = useState<DockMessage[]>(dockMessages)
  const [input, setInput] = useState('')
  const [busy, setBusy] = useState(false)
  const bodyRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  const setMessages = (update: (prev: DockMessage[]) => DockMessage[]) => setMessagesState((prev) => { dockMessages = update(prev); return dockMessages })
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
    dockSent = true
    setOpen(true)
    setInput('')
    setBusy(true)
    const pendingId = `pending-${Date.now()}`
    setMessages((prev) => [...prev, { id: `me-${Date.now()}`, role: 'physician', text: trimmed }, { id: pendingId, role: 'agent', pending: true }])
    const local = answerWorkspaceQuestion(trimmed, { queue: snapshot.queue, overview: snapshot.overview, patients: LUCY_QUEUE_PATIENTS })
    let reply: AgentReply
    try {
      reply = local
        ? await withMinimumTyping(Promise.resolve(local), 650)
        : await withMinimumTyping(chatWithAgent('lucy', { mode: 'practice_question', message: trimmed, origin: 'practice' }).then((response) => ({ paragraphs: [response.answer] })), 650)
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
      <div className="agent-dock-who">Your agent<span>{PCP_AGENT_NAME} · knows your patients and referrals</span></div>
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
    {!dockSent && <div className="agent-dock-suggest">{DOCK_SUGGESTED_PROMPTS.map((prompt) => <button key={prompt} onClick={() => void send(prompt)}>{prompt}</button>)}</div>}
    <form className="agent-dock-input" onSubmit={submit}>
      <input ref={inputRef} value={input} onChange={(event) => setInput(event.target.value)} placeholder="Ask your agent…" aria-label="Ask your agent" autoComplete="off" />
      <button className="agent-dock-send" aria-label="Send" disabled={busy || !input.trim()}>
        <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M7 12V2M2.5 6.5L7 2l4.5 4.5" /></svg>
      </button>
    </form>
  </aside>
}

/** Sidebar "For you" count -- the same queue the pages render. */
export function useNeedsCount(): number {
  return useWorkspaceSnapshot().queue.needs.length
}
