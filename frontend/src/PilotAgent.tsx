import { useEffect, useState, type FormEvent } from 'react'
import { AgentAvatar } from './AgentAvatar.tsx'
import { ApiError } from './api.ts'
import {
  answerLearningQuestion, clarifyProposal, confirmProposal, createPracticeRule, getPilotMetrics, getPracticeRules,
  getPublicProfilePreview, getTeaching, listReferrals, publishPublicProfile, rejectProposal, retirePracticeRule,
  revisePracticeRule, savePublicProfileSettings, setRulePublishable, teachAgent, unpublishPublicProfile,
  type LearningQuestion, type MetricSection, type Modality, type PilotMetrics, type PilotStatus, type PracticeRule,
  type Proposal, type PublicProfilePreview, type ReferralSummary,
  getLearningSummary, getRepresentation, type LearningSummary, type Representation,
} from './pilotApi.ts'
import {
  AGENT_TABS, emptyRuleForm, isClosed, MODALITY_LABELS, physicianLabel, pilotErrorCopy, thirdPerson, pilotPaths, proposalLines,
  representationGroups, representationPortrait, ruleFormFrom, ruleInput, setupProgressLine,
  itemKindEffect, itemKindLabel, TOPIC_LABELS, type AgentTab, type RuleForm,
} from './pilotState.ts'
import { useOnPilotDataChange } from './pilotSync.ts'
import { TrainingReminderBand } from './pilotUi.tsx'
import { PublicProfileView } from './PublicPages.tsx'

type Navigate = (path: string) => void
const errorText = (err: unknown, fallback: string) =>
  pilotErrorCopy(err instanceof ApiError ? err.code : null, err instanceof Error ? err.message : fallback)
const formatDate = (iso: string | null | undefined) => iso ? new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' }) : '—'
const plural = (count: number, one: string, many: string) => `${count} ${count === 1 ? one : many}`

/* ------------------------------------------------------------------ teach */

function ProposalSummary({ proposal }: { proposal: Proposal }) {
  const lines = proposalLines(proposal.content)
  return <div className="pilot-proposal-body">
    <p className="pilot-quote">“{proposal.source_text}”</p>
    {proposal.structured
      ? <><p><strong>I understood:</strong> for <em>{proposal.referral_type === 'Unassigned' ? 'which referral type?' : proposal.referral_type}</em> referrals —</p><ul>{lines.map((line) => <li key={line}>{line}</li>)}</ul></>
      : <p className="muted-note">I couldn’t turn this into a structured rule, so I kept it as a note. Edit it into a rule if you want me to act on it.</p>}
    {/* What was NOT turned into a rule (negations, exceptions, vague recency) — check before confirming. */}
    {(proposal.review_notes ?? []).length > 0 && <div className="pilot-panel"><p><strong>Check before confirming</strong></p><ul>{(proposal.review_notes ?? []).map((note) => <li key={note}>{note}</li>)}</ul></div>}
    {proposal.content.modality_notes && <p className="muted-note">Kept as a note (not applied by triage): {proposal.content.modality_notes}</p>}
    {/* A setup answer is the physician's own answer: no "confidence" number for it. */}
    {proposal.suggested && <p><span className="pilot-suggested-tag">Suggested</span> <span className="muted-note">A common {proposal.referral_type} referral type for your specialty — confirm it only if it fits you.</span></p>}
    {proposal.suggested_by_role === 'staff' && <p><span className="pilot-suggested-tag">Staff suggestion</span> <span className="muted-note">Suggested by {proposal.suggested_by_name ?? 'a staff member'}. It changes nothing unless a physician confirms it.</span></p>}
    <p className="muted-note">{proposal.source === 'onboarding' ? 'From your setup answer · not active until you confirm'
      : `${proposal.source === 'correction_pattern' ? 'Learned from your repeated corrections' : 'From your instruction'} · confidence ${proposal.confidence != null ? `${Math.round(proposal.confidence * 100)}%` : '—'} · not active until you confirm`}</p>
  </div>
}

export function ProposalCard({ proposal, referralTypes, onChange, extraActions }: { proposal: Proposal; referralTypes: string[]; onChange: () => void; extraActions?: React.ReactNode }) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [answer, setAnswer] = useState('')
  const [editing, setEditing] = useState(false)
  const [form, setForm] = useState<RuleForm>(() => ruleFormFrom({ referral_type: proposal.referral_type === 'Unassigned' ? '' : proposal.referral_type, content: proposal.content }))
  const run = async (action: () => Promise<unknown>) => {
    setBusy(true); setError('')
    try { await action(); onChange() } catch (err) { setError(errorText(err, 'That didn’t work.')) } finally { setBusy(false) }
  }
  const set = (key: keyof RuleForm) => (event: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>) => setForm((current) => ({ ...current, [key]: event.target.value }))
  return <section className="pilot-card pilot-proposal">
    <ProposalSummary proposal={proposal} />
    {proposal.clarification && <div className="pilot-panel">
      <h3>{proposal.clarification.question}</h3>
      <div className="pilot-actions">{proposal.clarification.options.map((option) => <button key={option} className="button-secondary" disabled={busy} onClick={() => void run(() => clarifyProposal(proposal.id, option))}>{option}</button>)}</div>
      <div className="pilot-inline-form"><label><span>Or name a new referral type</span><input value={answer} onChange={(event) => setAnswer(event.target.value)} disabled={busy} /></label>
        <button className="text-button" disabled={busy || !answer.trim()} onClick={() => void run(() => clarifyProposal(proposal.id, answer.trim()))}>Use this type</button></div>
    </div>}
    {editing && <div className="pilot-panel auth-form pilot-form">
      <label><span>Referral type</span><input list="pilot-teach-types" value={form.referralType} onChange={set('referralType')} /></label>
      <datalist id="pilot-teach-types">{referralTypes.map((type) => <option key={type} value={type} />)}</datalist>
      <label><span>Required — one per line; each item’s own time window after “|” (e.g. “Recent lab result | 90”)</span><textarea rows={3} value={form.required} onChange={set('required')} /></label>
      <label><span>Helpful but not required — one per line, optional “| days”</span><textarea rows={2} value={form.helpful} onChange={set('helpful')} /></label>
      <label><span>Urgency signals — one per line</span><textarea rows={2} value={form.urgent} onChange={set('urgent')} /></label>
      <label><span>Also called — other names for this referral type, one per line</span><textarea rows={2} value={form.aliases} onChange={set('aliases')} /></label>
      <label><span>Note (not used by triage)</span><input value={form.note} onChange={set('note')} /></label>
      <label><span>Scope</span><select value={form.scopePolicy} onChange={set('scopePolicy')}><option value="">Not stated</option><option value="accept">I see these</option><option value="out_of_scope">Out of scope</option><option value="case_by_case">I decide case by case</option></select></label>
      <label><span>Preferences (suggested only, never block) — one per line</span><textarea rows={2} value={form.preferences} onChange={set('preferences')} /></label>
      <label><span>Exceptions (kept as notes, not applied) — one per line</span><textarea rows={2} value={form.exceptions} onChange={set('exceptions')} /></label>
      <label><span>Decisions you keep for yourself — one per line</span><textarea rows={2} value={form.judgment} onChange={set('judgment')} /></label>
      <label><span>Outside scope — one per line</span><textarea rows={2} value={form.outsideScope} onChange={set('outsideScope')} /></label>
      <label><span>Good fit — one per line</span><textarea rows={2} value={form.goodFit} onChange={set('goodFit')} /></label>
      <label><span>Default modality</span><select value={form.modality} onChange={set('modality')}>{Object.entries(MODALITY_LABELS).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>
      <div className="onboarding-actions"><button className="button-primary" disabled={busy || !form.referralType.trim()} onClick={() => void run(() => confirmProposal(proposal.id, ruleInput(form)))}>Confirm edited rule</button><button className="text-button" onClick={() => setEditing(false)}>Cancel</button></div>
    </div>}
    {error && <p className="error-banner" role="alert">{error}</p>}
    {!editing && <div className="pilot-actions">
      {proposal.structured && !proposal.clarification && <button className="button-primary" disabled={busy} onClick={() => void run(() => confirmProposal(proposal.id))}>Confirm</button>}
      <button className="button-secondary" disabled={busy} onClick={() => setEditing(true)}>Edit</button>
      <button className="text-button" disabled={busy} onClick={() => void run(() => rejectProposal(proposal.id))}>Reject</button>
      {extraActions}
    </div>}
  </section>
}

export function QuestionCard({ question, onChange }: { question: LearningQuestion; onChange: () => void }) {
  const [busy, setBusy] = useState(false)
  const [note, setNote] = useState('')
  const [depends, setDepends] = useState(false)
  const [error, setError] = useState('')
  const answer = async (value: 'yes' | 'depends' | 'ignore') => {
    setBusy(true); setError('')
    try { await answerLearningQuestion(question.id, value, note); onChange() } catch (err) { setError(errorText(err, 'Could not save your answer.')) } finally { setBusy(false) }
  }
  return <section className="agent-learned-this-week-card pilot-question">
    <p className="eyebrow">A question from your agent</p>
    <h3 className="pilot-question-text">{question.question}</h3>
    <p className="muted-note">I’ll ask at most one question like this a day. Nothing changes unless you say yes.</p>
    {depends && <label className="pilot-inline-label"><span>When does it apply? (optional)</span><textarea rows={2} value={note} onChange={(event) => setNote(event.target.value)} /></label>}
    {error && <p className="error-banner" role="alert">{error}</p>}
    <div className="pilot-actions">
      <button className="button-primary" disabled={busy} onClick={() => void answer('yes')}>Yes</button>
      <a className="button-secondary" href={`#proposal-${question.proposal_id}`}>Edit</a>
      {!depends ? <button className="button-secondary" disabled={busy} onClick={() => setDepends(true)}>Not always / Depends</button>
        : <button className="button-secondary" disabled={busy} onClick={() => void answer('depends')}>Save “depends”</button>}
      <button className="text-button" disabled={busy} onClick={() => void answer('ignore')}>Ignore</button>
    </div>
  </section>
}

const TAB_LABELS: Record<AgentTab, string> = { overview: 'Overview', teach: 'Train', rules: 'Rules' }

/** My Agent, in the demo's structure: agent hero, Overview / Train / Rules tabs. Overview
 * follows the demo's order — learning band, current representation, the agent's real
 * recent work, what it learned this week, then the detailed representation. Every learning
 * count comes from ONE backend summary (`/representation/summary`). */
export function AgentPage({ status, navigate, tab }: { status: PilotStatus; navigate: Navigate; tab: AgentTab }) {
  const [teaching, setTeaching] = useState<Awaited<ReturnType<typeof getTeaching>> | null>(null)
  const [rules, setRules] = useState<PracticeRule[] | null>(null)
  const [referrals, setReferrals] = useState<ReferralSummary[] | null>(null)
  const [weekly, setWeekly] = useState<string | null>(null)
  const [summary, setSummary] = useState<LearningSummary | null>(null)
  const [representation, setRepresentation] = useState<Representation | null>(null)
  const [error, setError] = useState('')
  const physician = status.role === 'physician'
  const loadTeaching = () => getTeaching().then(setTeaching).catch((err) => setError(errorText(err, 'Could not load your agent')))
  const loadRules = () => getPracticeRules().then(setRules).catch((err) => setError(errorText(err, 'Could not load rules')))
  const loadRepresentation = () => {
    getLearningSummary().then(setSummary).catch((err) => setError(errorText(err, 'Could not load what your agent learned')))
    getRepresentation().then(setRepresentation).catch((err) => setError(errorText(err, 'Could not load your representation')))
  }
  const reload = () => { void loadTeaching(); void loadRules(); loadRepresentation() }
  useEffect(() => {
    reload()
    listReferrals().then(setReferrals).catch(() => setReferrals([]))
    if (physician) getPilotMetrics().then((data) => setWeekly(data.weekly.text)).catch(() => setWeekly(null))
  }, []) // eslint-disable-line react-hooks/exhaustive-deps
  // Proposals confirmed from chat, Home, or here: every view re-reads the backend.
  useOnPilotDataChange(() => { reload(); listReferrals().then(setReferrals).catch(() => undefined) })
  const practice = status.practice
  const lifecycle = summary?.lifecycle
  const trainBadge = summary ? summary.counts.pending_learnings + summary.counts.open_questions : 0
  const doctor = physicianLabel(status.physician_name)
  return <main className="page-shell agent-page pilot-agent-page">
    <section className="agent-hero"><div className="agent-hero-mark"><AgentAvatar tone="copper" /></div><div>
      <p className="eyebrow">{physician ? 'Your physician agent' : `${doctor}’s agent`}</p>
      <h1>{practice?.name ?? 'Your practice'}</h1>
      <p>{practice?.specialty ? `${practice.specialty} · ` : ''}{physician
        ? <>Represents how you and your practice work. {lifecycle?.label ?? 'Shadow mode — your agent recommends; you decide.'}</>
        : <>Represents how {doctor} and the practice work. It recommends; {doctor} decides. You can see what it knows and suggest changes for {doctor} to confirm.</>}</p>
    </div></section>
    <nav className="agent-tabs" aria-label="My Agent sections">{AGENT_TABS.map((item) => <button key={item} className={tab === item ? 'active' : ''} aria-current={tab === item ? 'page' : undefined} onClick={() => navigate(pilotPaths.agentTab(item))}>{TAB_LABELS[item]}{item === 'teach' && trainBadge > 0 ? ` · ${trainBadge}` : ''}</button>)}</nav>
    {error && <div className="error-banner" role="alert">{error}</div>}
    {tab === 'overview' && <AgentOverview status={status} navigate={navigate} rules={rules} summary={summary} representation={representation} referrals={referrals} weekly={weekly} />}
    {tab === 'teach' && <TeachTab physician={physician} doctor={doctor} data={teaching} summary={summary} navigate={navigate} onChange={reload} />}
    {tab === 'rules' && <RulesTab physician={physician} rules={rules} onChange={reload} />}
  </main>
}

function AgentOverview({ status, navigate, rules, summary, representation, referrals, weekly }: {
  status: PilotStatus; navigate: Navigate; rules: PracticeRule[] | null; summary: LearningSummary | null
  representation: Representation | null; referrals: ReferralSummary[] | null; weekly: string | null
}) {
  const physician = status.role === 'physician'
  const doctor = physicianLabel(status.physician_name)
  // Staff read the physician's agent in the third person.
  const whose = physician ? 'your' : `${doctor}’s`
  if (!rules || !summary || !representation) return <div className="page-state embedded"><div className="loading-line" /><p>Opening your agent…</p></div>
  const lifecycle = summary.lifecycle
  const open = (referrals ?? []).filter((item) => !isClosed(item.status))
  const triaged = (referrals ?? []).filter((item) => item.fit !== null)
  const { counts } = summary
  return <div className="agent-overview-v2">
    {/* Resume entry: the one "your move" while the agent doesn't represent the physician yet. */}
    {physician && lifecycle.state === 'initializing' && <section className="pilot-setup-resume" aria-label="Agent setup">
      <div><p className="eyebrow">Set up your agent</p>
        <h2>Finish telling your agent how you practise</h2>
        <p>{setupProgressLine(lifecycle)}. Until you confirm it, your agent records referrals but doesn’t represent you.</p></div>
      <button className="button-primary" onClick={() => navigate(pilotPaths.setup(lifecycle.next_stage ?? 'review'))}>Continue setup <span>→</span></button>
    </section>}
    <TrainingReminderBand
      title={physician ? 'Your agent keeps learning from your work.' : `${doctor}’s agent keeps learning from ${doctor}’s corrections.`}
      support={physician ? 'It drafts an update when your corrections repeat, and asks only when your judgment adds something it can’t safely infer. You can always train it directly.' : `Only ${doctor} can confirm what it learns. You can suggest something; it stays a suggestion until ${doctor} confirms it.`}
      action={<button className="button-secondary" onClick={() => navigate(pilotPaths.agentTab('teach'))}>{physician ? 'Train your agent' : `Suggest something to ${doctor}`} <span>→</span></button>} />
    <section className="agent-portrait-card">
      <p className="eyebrow">{physician ? 'Your agent currently represents your practice as' : `${doctor}’s agent currently represents the practice as`}</p>
      <p className="agent-portrait-text">{representationPortrait(status.practice, representation)}</p>
      {lifecycle.label && <p className="pilot-lifecycle-line"><span className={`pilot-lifecycle-dot state-${lifecycle.state ?? 'none'}`} aria-hidden="true" />{physician ? lifecycle.label : thirdPerson(lifecycle.label, doctor)}</p>}
    </section>
    <hr className="agent-overview-divider" />
    <section className="agent-network-activity">
      <h2 className="band-heading">{physician ? 'Your agent at work' : `${doctor}’s agent at work`}</h2>
      <p className="practice-subheading">Recent activity in the practice</p>
      {referrals && referrals.length === 0
        ? <p className="agent-empty-note">No referrals yet. This fills in once your practice enters or receives its first referral.</p>
        : <ul className="network-activity-list">
          {weekly && <li className="network-activity-item"><div><strong>This week</strong><span className="network-activity-detail">{weekly}</span></div>
            <button type="button" className="text-button" onClick={() => navigate(pilotPaths.metrics)}>View metrics →</button></li>}
          {referrals && <li className="network-activity-item"><div>
            <strong>{plural(triaged.length, 'referral triaged', 'referrals triaged')} against {whose} confirmed representation</strong>
            <span className="network-activity-detail">Fit, readiness, priority, and visit type checked; missing information flagged</span>
            {open.length > 0 && <span className="network-activity-outcome">✓ {plural(open.length, 'referral', 'referrals')} open now</span>}
            {open.filter((item) => item.status === 'needs_information').length > 0 && <span className="network-activity-outcome">✓ {plural(open.filter((item) => item.status === 'needs_information').length, 'referral', 'referrals')} waiting on the referring office</span>}
          </div><button type="button" className="text-button" onClick={() => navigate(pilotPaths.patients)}>View patients →</button></li>}
        </ul>}
    </section>
    <hr className="agent-overview-divider" />
    <section className="agent-learned-this-week-card">
      <p className="eyebrow">{physician ? 'What your agent learned this week' : `What ${doctor}’s agent learned this week`}</p>
      {/* Every number here comes from the one summary endpoint — the same one Home and the Train badge use. */}
      <ul className="pilot-learned-counts" aria-label="This week">
        <li><strong>{counts.confirmed_this_week}</strong> newly confirmed</li>
        <li><strong>{counts.pending_learnings}</strong> pending {counts.pending_learnings === 1 ? 'learning' : 'learnings'}</li>
        <li><strong>{counts.open_questions}</strong> {counts.open_questions === 1 ? 'question' : 'questions'} for today</li>
        {counts.queued_questions > 0 && <li><strong>{counts.queued_questions}</strong> queued</li>}
      </ul>
      {counts.queued_questions > 0 && <p className="agent-empty-note">{physician ? 'Your agent asks' : `The agent asks ${doctor}`} one question a day; {plural(counts.queued_questions, 'more question waits', 'more questions wait')} for the coming days.</p>}
      {summary.confirmed_this_week.length > 0 && <ul className="learned-this-week-list">{summary.confirmed_this_week.slice(0, 5).map((item) => <li key={item.rule_id}>
        <span>{item.referral_type} — version {item.version} confirmed {formatDate(item.confirmed_at)}{item.layer === 'physician' ? ' · just you' : ''}</span>
        <button type="button" className="text-button" onClick={() => navigate(pilotPaths.agentTab('rules'))}>Review →</button>
      </li>)}</ul>}
      {counts.pending_learnings + counts.open_questions > 0
        ? <button className="button-primary" onClick={() => navigate(pilotPaths.agentTab('teach'))}>Review {physician ? '' : 'pending '}learnings <span>→</span></button>
        : counts.confirmed_this_week === 0 && <p className="agent-empty-note">{physician ? 'Nothing new this week, and nothing needs your input right now.' : `Nothing new this week, and nothing is waiting for ${doctor}.`}</p>}
    </section>
    <hr className="agent-overview-divider" />
    <div className="agent-detail-divider">
      <h2>{physician ? 'How your agent currently represents your practice' : `How ${doctor}’s agent currently represents the practice`}</h2>
      <p className="page-intro">{physician
        ? 'Built only from what you confirmed. Requirements and scope drive triage; preferences and your judgment shape suggestions and explanations. Every recommendation cites the version it used.'
        : `Built only from what ${doctor} confirmed. Requirements and scope drive triage; preferences and ${doctor}’s judgment shape suggestions and explanations. Every recommendation cites the version it used.`}</p>
    </div>
    <PracticeRepresentation representation={representation} navigate={navigate} physician={physician} doctor={doctor} />
  </div>
}

/** The demo's practice-representation sections, fed by the confirmed representation only:
 * statements grouped by referral type, each labelled with its kind, plus honest unknowns. */
function PracticeRepresentation({ representation, navigate, physician, doctor }: { representation: Representation; navigate: Navigate; physician: boolean; doctor: string }) {
  // Staff read the physician's statements in the third person.
  const say = (text: string) => (physician ? text : thirdPerson(text, doctor))
  const types = representation.types.filter((type) => representationGroups(type).confirmed.length > 0)
  if (!types.length) return <p className="agent-empty-note">Nothing confirmed yet, so your agent can record referrals but can’t judge fit or completeness.{physician && <> <button type="button" className="text-button" onClick={() => navigate(pilotPaths.setup())}>Start setup →</button></>}</p>
  return <div className="practice-tab">
    <section className="practice-section practice-section-focus">
      <h3 className="practice-section-heading">Referral types</h3>
      <div className="practice-chip-group prominent pilot-representation-chips">{types.map((type) => <span className="practice-chip" key={type.referral_type}>{type.referral_type}{type.scope_policy === 'out_of_scope' ? ' · out of scope' : type.scope_policy === 'case_by_case' ? ' · case by case' : ''}</span>)}</div>
    </section>
    {types.map((type) => { const { confirmed } = representationGroups(type); return <section key={type.referral_type} className="practice-section pilot-representation-type">
      <h3 className="practice-section-heading">{type.referral_type}{type.aliases.length > 0 && <small className="muted-note"> · also {type.aliases.join(', ')}</small>}</h3>
      <ul className="pilot-statement-list">{confirmed.map((item, index) => <li key={`${item.rule_id}-${index}`}>
        <span className={`pilot-kind-tag kind-${item.kind}`}>{say(itemKindLabel(item))}</span>
        <span>{say(item.text)}</span>
        <small className="muted-note">{say(itemKindEffect(item))} · v{item.version}{item.layer === 'physician' ? ' · just you' : ''}</small>
      </li>)}</ul>
      {physician && type.unknown_topics.length > 0 && <p className="pilot-unknown-line">Not answered yet: {type.unknown_topics.map((topic) => TOPIC_LABELS[topic].toLowerCase()).join(', ')}. Your agent says it doesn’t know these.</p>}
    </section> })}
    {physician && representation.conflicts.length > 0 && <section className="practice-section"><h3 className="practice-section-heading">Conflicts to review</h3>
      <ul className="pilot-statement-list">{representation.conflicts.map((conflict, index) => <li key={index}><span className="pilot-kind-tag">Conflict</span><span>{conflict.referral_type}: practice and your own statements disagree ({conflict.kind === 'scope_policy' ? 'scope' : 'a requirement'}). Your agent won’t choose between them.</span></li>)}</ul></section>}
    {physician && <p className="muted-note">Representation version {representation.version?.version ?? '—'}. <button type="button" className="text-button" onClick={() => navigate(pilotPaths.setup('review'))}>Review everything →</button></p>}
  </div>
}

function TeachTab({ physician, doctor, data, summary, navigate, onChange }: { physician: boolean; doctor: string; data: Awaited<ReturnType<typeof getTeaching>> | null; summary: LearningSummary | null; navigate: Navigate; onChange: () => void }) {
  const [text, setText] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const teach = async (event: FormEvent) => {
    event.preventDefault()
    if (text.trim().length < 3) return
    setBusy(true); setError('')
    try { await teachAgent(text.trim()); setText(''); onChange() } catch (err) { setError(errorText(err, 'Could not interpret that.')) } finally { setBusy(false) }
  }
  // Pending learnings = the summary's list (teaching + corrections). Unreviewed setup answers
  // are reviewed in setup, not here.
  const pendingIds = new Set((summary?.pending_learnings ?? []).map((item) => item.id))
  // The learning the agent is asking about today stays reviewable here too, so the question's
  // "Edit" link always has its proposal to jump to (it is counted once, as the question).
  const asked = data?.question?.proposal_id
  const learnings = (data?.proposals ?? []).filter((proposal) => pendingIds.has(proposal.id) || proposal.id === asked)
  const setupPending = summary?.counts.setup_pending ?? 0
  return <div className="pilot-teach-tab">
    <p className="page-intro">{physician
      ? 'Train your agent: tell it how you want referrals handled, and review what it learned from your corrections. Every instruction becomes a proposal you confirm; nothing changes triage until you do.'
      : `Suggest how ${doctor}’s agent should handle referrals. A suggestion goes to ${doctor} as a pending learning; nothing changes triage unless ${doctor} confirms it.`}</p>
    {physician && summary?.lifecycle.state === 'initializing' && <p className="agent-empty-note">Setup isn’t finished. <button type="button" className="text-button" onClick={() => navigate(pilotPaths.setup(summary.lifecycle.next_stage ?? 'review'))}>Continue setup →</button></p>}
    {physician && setupPending > 0 && <p className="muted-note">{plural(setupPending, 'setup answer is', 'setup answers are')} waiting in setup review. <button type="button" className="text-button" onClick={() => navigate(pilotPaths.setup('review'))}>Review them →</button></p>}
    {physician && data?.question && <QuestionCard question={data.question} onChange={onChange} />}
    <form className="pilot-teach-composer" onSubmit={(event) => void teach(event)}>
      <label><span className="practice-subheading">{physician ? 'Teach your agent' : `Suggest something to ${doctor}`}</span><textarea rows={2} value={text} onChange={(event) => setText(event.target.value)} placeholder={physician ? 'e.g. I usually want a recent A1c before reviewing diabetes referrals.' : 'e.g. The office usually sends the A1c separately; could we ask for it up front?'} maxLength={2000} disabled={busy} /></label>
      {error && <p className="error-banner" role="alert">{error}</p>}
      <div className="pilot-actions"><button className="button-primary" type="submit" disabled={busy || text.trim().length < 3}>{busy ? 'Saving…' : physician ? 'Teach' : `Send to ${doctor}`} <span>→</span></button></div>
    </form>
    <h2 className="pilot-subhead">Pending learnings</h2>
    {data && learnings.length === 0 && <p className="agent-empty-note">Nothing pending.</p>}
    {learnings.map((proposal) => <div id={`proposal-${proposal.id}`} key={proposal.id}>{physician ? <ProposalCard proposal={proposal} referralTypes={data?.referral_types ?? []} onChange={onChange} /> : <section className="pilot-card"><ProposalSummary proposal={proposal} /></section>}</div>)}
  </div>
}

/* ----------------------------------------------------------------- rules */

function RuleEditor({ initial, onSave, onCancel }: { initial: RuleForm; onSave: (form: RuleForm) => Promise<void>; onCancel: () => void }) {
  const [form, setForm] = useState<RuleForm>(initial)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const set = (key: keyof RuleForm) => (event: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>) => setForm((current) => ({ ...current, [key]: event.target.value }))
  const save = async (event: FormEvent) => {
    event.preventDefault()
    if (!form.referralType.trim()) { setError('Name the referral type.'); return }
    setBusy(true); setError('')
    try { await onSave(form) } catch (err) { setError(errorText(err, 'Could not save the rule.')) } finally { setBusy(false) }
  }
  return <form className="auth-form pilot-form pilot-card" onSubmit={(event) => void save(event)}>
    <label><span>Referral type</span><input value={form.referralType} onChange={set('referralType')} placeholder="e.g. Diabetes management" disabled={busy} /></label>
    <label><span>Also called — other names offices use for this type, one per line</span><textarea rows={2} value={form.aliases} onChange={set('aliases')} placeholder="Other names referring offices use" disabled={busy} /></label>
    <label><span>Good fit — one per line</span><textarea rows={3} value={form.goodFit} onChange={set('goodFit')} placeholder="Type 2 diabetes not at goal on two agents" disabled={busy} /></label>
    <label><span>Outside my scope — one per line</span><textarea rows={2} value={form.outsideScope} onChange={set('outsideScope')} placeholder="Type 1 diabetes pump management" disabled={busy} /></label>
    <label><span>Required before review — one per line, optional “| days” for recency</span><textarea rows={3} value={form.required} onChange={set('required')} placeholder={'Recent HbA1c | 180\nCurrent medication list'} disabled={busy} /></label>
    <label><span>Helpful but not required</span><textarea rows={2} value={form.helpful} onChange={set('helpful')} placeholder="Glucose log" disabled={busy} /></label>
    <label><span>Urgency signals — one per line</span><textarea rows={2} value={form.urgent} onChange={set('urgent')} placeholder="Recent DKA admission" disabled={busy} /></label>
    <label><span>Scope</span><select value={form.scopePolicy} onChange={set('scopePolicy')} disabled={busy}><option value="">Not stated</option><option value="accept">I see these</option><option value="out_of_scope">Out of scope</option><option value="case_by_case">I decide case by case</option></select></label>
    <label><span>Preferences (suggested only, never block) — one per line</span><textarea rows={2} value={form.preferences} onChange={set('preferences')} disabled={busy} /></label>
    <label><span>Decisions you keep for yourself — one per line</span><textarea rows={2} value={form.judgment} onChange={set('judgment')} disabled={busy} /></label>
    <label><span>Exceptions (kept as notes, not applied) — one per line</span><textarea rows={2} value={form.exceptions} onChange={set('exceptions')} disabled={busy} /></label>
    <div className="pilot-form-row">
      <label><span>Default modality</span><select value={form.modality} onChange={set('modality')} disabled={busy}>{(Object.keys(MODALITY_LABELS) as Modality[]).map((value) => <option key={value} value={value}>{MODALITY_LABELS[value]}</option>)}</select></label>
      <label><span>Note</span><input value={form.note} onChange={set('note')} disabled={busy} /></label>
    </div>
    {error && <p className="error-banner" role="alert">{error}</p>}
    <div className="onboarding-actions"><button className="button-primary" type="submit" disabled={busy}>{busy ? 'Saving…' : 'Save rule'}</button><button className="text-button" type="button" onClick={onCancel}>Cancel</button></div>
  </form>
}

/** Referral rules: the ONE operational rule store triage reads. Edits create a new
 * version; retired rules stop applying. Only physicians change rules (hidden for staff). */
function RulesTab({ physician, rules, onChange }: { physician: boolean; rules: PracticeRule[] | null; onChange: () => void }) {
  const [editing, setEditing] = useState<'new' | string | null>(null)
  const [error, setError] = useState('')
  return <div className="pilot-rules-tab">
    <div className="pilot-section-head"><p className="page-intro">How Lamina triages each kind of referral. Every triage cites the rule version it used; edits create a new version and never rewrite history.</p>
      {physician && editing === null && <button className="button-primary" onClick={() => setEditing('new')}>Add rule <span>+</span></button>}</div>
    {error && <div className="error-banner" role="alert">{error}</div>}
    {editing === 'new' && <RuleEditor initial={emptyRuleForm()} onCancel={() => setEditing(null)} onSave={async (form) => { await createPracticeRule(ruleInput(form)); setEditing(null); onChange() }} />}
    {!rules && <div className="page-state embedded"><div className="loading-line" /><p>Opening rules…</p></div>}
    {rules && rules.length === 0 && editing === null && <p className="agent-empty-note">{physician ? 'No rules yet. Add one rule per referral type you receive.' : 'The physician hasn’t added referral rules yet.'}</p>}
    {(rules ?? []).map((rule) => editing === rule.id
      ? <RuleEditor key={rule.id} initial={ruleFormFrom(rule)} onCancel={() => setEditing(null)} onSave={async (form) => { await revisePracticeRule(rule.id, ruleInput(form)); setEditing(null); onChange() }} />
      : <section key={rule.id} className="pilot-card pilot-rule">
        <div className="pilot-section-head"><div><h2>{rule.referral_type}</h2><p className="muted-note">Version {rule.version} · {rule.physician_confirmed ? 'physician-confirmed' : rule.operational_status.replace('_', ' ')} · since {formatDate(rule.confirmed_at ?? rule.created_at)}</p></div>
          {physician && <div className="onboarding-actions"><button className="text-button" onClick={() => setEditing(rule.id)}>Edit</button><button className="text-button" onClick={() => void retirePracticeRule(rule.id).then(onChange).catch((err) => setError(errorText(err, 'Could not retire rule.')))}>Retire</button></div>}</div>
        <dl className="pilot-facts">
          {(rule.content.aliases ?? []).length > 0 && <div><dt>Also called</dt><dd>{(rule.content.aliases ?? []).join('; ')}</dd></div>}
          {rule.content.good_fit.length > 0 && <div><dt>Good fit</dt><dd>{rule.content.good_fit.join('; ')}</dd></div>}
          {rule.content.redirect.length > 0 && <div><dt>Outside scope</dt><dd>{rule.content.redirect.join('; ')}</dd></div>}
          {rule.content.required.length > 0 && <div><dt>Required</dt><dd>{rule.content.required.map((item) => item.freshness_days ? `${item.label} (≤${item.freshness_days} days)` : item.label).join('; ')}</dd></div>}
          {rule.content.helpful.length > 0 && <div><dt>Helpful</dt><dd>{rule.content.helpful.map((item) => item.label).join('; ')}</dd></div>}
          {rule.content.urgent_signals.length > 0 && <div><dt>Urgent if</dt><dd>{rule.content.urgent_signals.join('; ')}</dd></div>}
          <div><dt>Modality</dt><dd>{MODALITY_LABELS[rule.content.modality]}</dd></div>
        </dl>
      </section>)}
  </div>
}

/* --------------------------------------------------------- public profile */

export function PublicSettingsPage({ status, navigate }: { status: PilotStatus; navigate: Navigate }) {
  const [preview, setPreview] = useState<PublicProfilePreview | null>(null)
  const [draft, setDraft] = useState<{ slug: string; intro: string; insurance: string; how_to_refer: string; hours: string; locations: string } | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const physician = status.role === 'physician'
  const draftFrom = (next: PublicProfilePreview) => ({ slug: next.slug, intro: next.settings.intro, insurance: next.settings.insurance, how_to_refer: next.settings.how_to_refer, hours: next.settings.hours, locations: next.settings.locations.join('\n') })
  // keepDraft: refresh the preview without discarding fields the physician is still editing.
  const apply = (next: PublicProfilePreview, keepDraft = false) => {
    setPreview(next)
    if (!keepDraft) setDraft(draftFrom(next))
  }
  useEffect(() => { getPublicProfilePreview().then((next) => apply(next)).catch((err) => setError(errorText(err, 'Could not load the public profile'))) }, [])
  const run = async (action: () => Promise<PublicProfilePreview | unknown>, keepDraft = false) => {
    setBusy(true); setError('')
    try { const result = await action(); apply(result && typeof result === 'object' && 'slug' in result ? result as PublicProfilePreview : await getPublicProfilePreview(), keepDraft) }
    catch (err) { setError(errorText(err, 'That didn’t work.')) } finally { setBusy(false) }
  }
  const back = <button className="text-button back-link" onClick={() => navigate(pilotPaths.practice)}>← Profile &amp; practice</button>
  if (!preview || !draft) return <main className="page-shell selector-page">{back}{error ? <div className="error-banner" role="alert">{error}</div> : <div className="page-state embedded"><div className="loading-line" /><p>Opening your public page…</p></div>}</main>
  const publicUrl = `${window.location.origin}${pilotPaths.publicPage(preview.slug)}`
  const set = (key: keyof typeof draft) => (event: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => setDraft({ ...draft, [key]: event.target.value })
  const saved = draftFrom(preview)
  const unsaved = (Object.keys(saved) as (keyof typeof saved)[]).some((key) => saved[key] !== draft[key])
  const saveSettings = () => savePublicProfileSettings({ slug: draft.slug, intro: draft.intro, insurance: draft.insurance, how_to_refer: draft.how_to_refer, hours: draft.hours, locations: draft.locations.split('\n').map((line) => line.trim()).filter(Boolean) })
  // Publishing always includes the edits on screen: save them first, then publish.
  const saveThenPublish = async () => { if (unsaved) await saveSettings(); return publishPublicProfile() }
  return <main className="page-shell selector-page pilot-public-settings">
    {back}
    <header className="selector-header">
      <div><p className="eyebrow">Public physician profile</p><h1>How colleagues and referring offices see you</h1>
        <p>{preview.status === 'published' ? <>Live at <a href={pilotPaths.publicPage(preview.slug)} target="_blank" rel="noreferrer">{publicUrl}</a> · version {preview.published_version?.version}</> : preview.status === 'unpublished' ? 'Unpublished — the page is offline.' : 'Not published yet.'}{preview.unpublished_changes && preview.status === 'published' ? ' · You have changes that aren’t live yet.' : ''}</p></div>
      {physician && <div className="onboarding-actions">
        <button className="button-primary" disabled={busy} onClick={() => void run(saveThenPublish)}>{preview.status === 'published' ? 'Publish update' : 'Publish'}</button>
        {preview.status === 'published' && <button className="text-button" disabled={busy} onClick={() => void run(unpublishPublicProfile)}>Unpublish</button>}
      </div>}
    </header>
    {error && <div className="error-banner" role="alert">{error}</div>}
    <p className="page-intro">Only what you see in the preview is ever public. Internal notes, urgency signals, unpublished rules, and all referral data stay private.</p>
    <div className={physician ? 'pilot-detail-grid' : ''}>
      {physician && <section className="pilot-card">
        <h2>What to publish</h2>
        <h3>Referral rules</h3>
        {preview.rules.length === 0 && <p className="muted-note">Add referral rules first.</p>}
        {preview.rules.map((rule) => <label key={rule.id} className="pilot-check"><input type="checkbox" checked={rule.publishable} disabled={busy} onChange={(event) => void run(() => setRulePublishable(rule.id, event.target.checked), true)} /> {rule.referral_type} <small className="muted-note">v{rule.version}</small></label>)}
        <form className="auth-form pilot-form" onSubmit={(event) => { event.preventDefault(); void run(saveSettings) }}>
          <label><span>Page address</span><input value={draft.slug} onChange={set('slug')} /></label>
          <label><span>Short introduction</span><textarea rows={2} value={draft.intro} onChange={set('intro')} /></label>
          <label><span>Locations — one per line</span><textarea rows={2} value={draft.locations} onChange={set('locations')} /></label>
          <label><span>Hours</span><input value={draft.hours} onChange={set('hours')} /></label>
          <label><span>Insurance information</span><textarea rows={2} value={draft.insurance} onChange={set('insurance')} /></label>
          <label><span>How to refer</span><textarea rows={2} value={draft.how_to_refer} onChange={set('how_to_refer')} /></label>
          {unsaved && <p className="muted-note" role="status">Unsaved changes — the preview updates when you save. Publish saves them too.</p>}
          <button className="button-secondary" type="submit" disabled={busy || !unsaved}>Save draft</button>
        </form>
      </section>}
      <section className="pilot-card pilot-public-preview"><p className="eyebrow">Preview — exactly what will be public</p><PublicProfileView profile={preview.draft_snapshot} slug={preview.slug} preview /></section>
    </div>
  </main>
}

/* ----------------------------------------------------------------- metrics */

const SECTION_TITLES: Record<MetricSection, string> = {
  usage: 'Usage', referral_quality: 'Referral quality', agent_trust: 'Agent trust', learning: 'Learning',
  public: 'Public page', operations: 'Operations (hours, median)',
}
const label = (key: string) => key.replace(/_/g, ' ').replace(/^./, (char) => char.toUpperCase())
const show = (value: unknown) => value == null ? '—' : typeof value === 'object' ? (Object.entries(value as Record<string, unknown>).map(([k, v]) => `${label(k)}: ${v}`).join(', ') || '—') : String(value)

export function MetricsPage({ navigate }: { navigate: Navigate }) {
  const [data, setData] = useState<Awaited<ReturnType<typeof getPilotMetrics>> | null>(null)
  const [error, setError] = useState('')
  useEffect(() => { getPilotMetrics().then(setData).catch((err) => setError(errorText(err, 'Could not load metrics'))) }, [])
  const table = (metrics: PilotMetrics) => (Object.keys(SECTION_TITLES) as MetricSection[]).map((section) => <section key={section} className="profile-section-v2">
    <div className="profile-section-heading"><h2>{SECTION_TITLES[section]}</h2></div>
    <dl className="pilot-facts">{Object.entries(metrics[section]).map(([key, value]) => <div key={key}><dt>{label(key)}</dt><dd>{show(value)}</dd></div>)}</dl>
  </section>)
  return <main className="page-shell profile-page pilot-metrics-page">
    <button className="text-button back-link" onClick={() => navigate(pilotPaths.practice)}>← Profile &amp; practice</button>
    <header className="selector-header"><div><p className="eyebrow">Pilot metrics</p><h1>How the pilot is going</h1><p>All figures are counts or durations from recorded events. Lamina doesn’t estimate “time saved”.</p></div></header>
    {error && <div className="error-banner" role="alert">{error}</div>}
    {data && <>
      <section className="agent-portrait-card pilot-weekly-card"><p className="eyebrow">This week</p><p className="agent-portrait-text">{data.weekly.text}</p></section>
      {table(data.all_time)}
    </>}
  </main>
}
