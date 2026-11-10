import { useEffect, useState, type FormEvent } from 'react'
import { AgentAvatar } from './AgentAvatar.tsx'
import { ApiError } from './api.ts'
import {
  answerLearningQuestion, clarifyProposal, confirmProposal, createPracticeRule, getPilotMetrics, getPracticeRules,
  getPublicProfilePreview, getTeaching, listReferrals, publishPublicProfile, rejectProposal, retirePracticeRule,
  revisePracticeRule, savePublicProfileSettings, setRulePublishable, teachAgent, unpublishPublicProfile,
  type LearningQuestion, type MetricSection, type Modality, type PilotMetrics, type PilotStatus, type PracticeRule,
  type Proposal, type PublicProfilePreview, type ReferralSummary,
} from './pilotApi.ts'
import {
  AGENT_TABS, emptyRuleForm, isClosed, MODALITY_LABELS, pilotErrorCopy, pilotPaths, practicePortrait, proposalLines,
  ruleFormFrom, ruleInput, type AgentTab, type RuleForm,
} from './pilotState.ts'
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
    <p className="muted-note">{proposal.source === 'correction_pattern' ? 'Learned from your repeated corrections' : 'From your instruction'} · confidence {proposal.confidence != null ? `${Math.round(proposal.confidence * 100)}%` : '—'} · not active until you confirm</p>
  </div>
}

function ProposalCard({ proposal, referralTypes, onChange }: { proposal: Proposal; referralTypes: string[]; onChange: () => void }) {
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
      <label><span>Required — one per line, optional “| days”</span><textarea rows={2} value={form.required} onChange={set('required')} /></label>
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

const TAB_LABELS: Record<AgentTab, string> = { overview: 'Overview', teach: 'Teach', rules: 'Rules' }

/** My Agent, in the demo's structure: agent hero, Overview / Teach / Rules tabs. Overview
 * follows the demo's order — learning band, current representation, the agent's real
 * recent work, what it learned this week, then the detailed practice representation. */
export function AgentPage({ status, navigate, tab }: { status: PilotStatus; navigate: Navigate; tab: AgentTab }) {
  const [teaching, setTeaching] = useState<Awaited<ReturnType<typeof getTeaching>> | null>(null)
  const [rules, setRules] = useState<PracticeRule[] | null>(null)
  const [referrals, setReferrals] = useState<ReferralSummary[] | null>(null)
  const [weekly, setWeekly] = useState<string | null>(null)
  const [error, setError] = useState('')
  const physician = status.role === 'physician'
  const loadTeaching = () => getTeaching().then(setTeaching).catch((err) => setError(errorText(err, 'Could not load your agent')))
  const loadRules = () => getPracticeRules().then(setRules).catch((err) => setError(errorText(err, 'Could not load rules')))
  const reload = () => { void loadTeaching(); void loadRules() }
  useEffect(() => {
    reload()
    listReferrals().then(setReferrals).catch(() => setReferrals([]))
    if (physician) getPilotMetrics().then((data) => setWeekly(data.weekly.text)).catch(() => setWeekly(null))
  }, []) // eslint-disable-line react-hooks/exhaustive-deps
  const practice = status.practice
  return <main className="page-shell agent-page pilot-agent-page">
    <section className="agent-hero"><div className="agent-hero-mark"><AgentAvatar tone="copper" /></div><div>
      <p className="eyebrow">Your physician agent</p>
      <h1>{practice?.name ?? 'Your practice'}</h1>
      <p>{practice?.specialty ? `${practice.specialty} · ` : ''}Represents how you and your practice work. Shadow mode — your agent recommends; your team decides.</p>
    </div></section>
    <nav className="agent-tabs" aria-label="My Agent sections">{AGENT_TABS.map((item) => <button key={item} className={tab === item ? 'active' : ''} aria-current={tab === item ? 'page' : undefined} onClick={() => navigate(pilotPaths.agentTab(item))}>{TAB_LABELS[item]}{item === 'teach' && (teaching?.proposals.length ?? 0) > 0 ? ` · ${teaching?.proposals.length}` : ''}</button>)}</nav>
    {error && <div className="error-banner" role="alert">{error}</div>}
    {tab === 'overview' && <AgentOverview status={status} navigate={navigate} rules={rules} teaching={teaching} referrals={referrals} weekly={weekly} />}
    {tab === 'teach' && <TeachTab physician={physician} data={teaching} onChange={reload} />}
    {tab === 'rules' && <RulesTab physician={physician} rules={rules} onChange={reload} />}
  </main>
}

function AgentOverview({ status, navigate, rules, teaching, referrals, weekly }: {
  status: PilotStatus; navigate: Navigate; rules: PracticeRule[] | null; teaching: Awaited<ReturnType<typeof getTeaching>> | null
  referrals: ReferralSummary[] | null; weekly: string | null
}) {
  const physician = status.role === 'physician'
  if (!rules) return <div className="page-state embedded"><div className="loading-line" /><p>Opening your agent…</p></div>
  const weekAgo = Date.now() - 7 * 24 * 3600 * 1000
  const learned = rules.filter((rule) => rule.confirmed_at && new Date(rule.confirmed_at).getTime() >= weekAgo)
  const pending = teaching?.proposals ?? []
  const open = (referrals ?? []).filter((item) => !isClosed(item.status))
  const triaged = (referrals ?? []).filter((item) => item.fit !== null)
  return <div className="agent-overview-v2">
    <TrainingReminderBand
      title="Your agent keeps learning from your team’s work."
      support={physician ? 'It drafts a rule when your corrections repeat, and asks only when your judgment adds something it can’t safely infer. You can always teach it directly.' : 'It drafts rules from the team’s corrections. Only the physician can teach it directly or confirm what it learned.'}
      action={physician ? <button className="button-primary" onClick={() => navigate(pilotPaths.agentTab('teach'))}>Teach your agent <span>→</span></button> : undefined} />
    <section className="agent-portrait-card">
      <p className="eyebrow">Your agent currently represents your practice as</p>
      <p className="agent-portrait-text">{practicePortrait(status.practice, rules)}</p>
    </section>
    <hr className="agent-overview-divider" />
    <section className="agent-network-activity">
      <h2 className="band-heading">Your agent at work</h2>
      <p className="practice-subheading">Recent activity in your practice</p>
      {referrals && referrals.length === 0
        ? <p className="agent-empty-note">No referrals yet. This fills in once your practice enters or receives its first referral.</p>
        : <ul className="network-activity-list">
          {weekly && <li className="network-activity-item"><div><strong>This week</strong><span className="network-activity-detail">{weekly}</span></div>
            <button type="button" className="text-button" onClick={() => navigate(pilotPaths.metrics)}>View metrics →</button></li>}
          {referrals && <li className="network-activity-item"><div>
            <strong>{plural(triaged.length, 'referral triaged', 'referrals triaged')} against your rules</strong>
            <span className="network-activity-detail">Fit, readiness, priority, and modality checked; missing information flagged</span>
            {open.length > 0 && <span className="network-activity-outcome">✓ {plural(open.length, 'referral', 'referrals')} open now</span>}
            {open.filter((item) => item.status === 'needs_information').length > 0 && <span className="network-activity-outcome">✓ {plural(open.filter((item) => item.status === 'needs_information').length, 'referral', 'referrals')} waiting on the referring office</span>}
          </div><button type="button" className="text-button" onClick={() => navigate(pilotPaths.patients)}>View patients →</button></li>}
        </ul>}
    </section>
    <hr className="agent-overview-divider" />
    <section className="agent-learned-this-week-card">
      <p className="eyebrow">What your agent learned this week</p>
      {learned.length > 0 && <ul className="learned-this-week-list">{learned.map((rule) => <li key={rule.id}>
        <span>{rule.referral_type} — version {rule.version} confirmed {formatDate(rule.confirmed_at)}</span>
        <button type="button" className="text-button" onClick={() => navigate(pilotPaths.agentTab('rules'))}>Review →</button>
      </li>)}</ul>}
      {pending.length > 0
        ? <>
          <p>{plural(pending.length, 'proposed rule is', 'proposed rules are')} waiting for {physician ? 'your' : 'the physician’s'} confirmation.</p>
          <button className="button-primary" onClick={() => navigate(pilotPaths.agentTab('teach'))}>Review <span>→</span></button>
        </>
        : learned.length === 0 && <p className="agent-empty-note">Nothing needs your input right now.</p>}
    </section>
    <hr className="agent-overview-divider" />
    <div className="agent-detail-divider">
      <h2>How your agent currently represents your practice</h2>
      <p className="page-intro">A structured picture built only from your confirmed referral rules. Triage reads exactly these rules, and every recommendation cites the version it used.</p>
    </div>
    <PracticeRepresentation rules={rules} navigate={navigate} />
  </div>
}

/** The demo's practice-representation sections, fed by confirmed rules only. */
function PracticeRepresentation({ rules, navigate }: { rules: PracticeRule[]; navigate: Navigate }) {
  if (!rules.length) return <p className="agent-empty-note">No referral rules yet. <button type="button" className="text-button" onClick={() => navigate(pilotPaths.agentTab('rules'))}>Add your first rule →</button></p>
  const many = new Set(rules.map((rule) => rule.referral_type)).size > 1
  const tag = (rule: PracticeRule, text: string) => (many ? `${rule.referral_type}: ${text}` : text)
  const good = rules.flatMap((rule) => rule.content.good_fit.map((item) => tag(rule, item)))
  const notFit = rules.flatMap((rule) => rule.content.redirect.map((item) => tag(rule, item)))
  const urgent = rules.flatMap((rule) => rule.content.urgent_signals.map((item) => tag(rule, item)))
  const required = [...new Set(rules.flatMap((rule) => rule.content.required.map((item) => item.freshness_days ? `${item.label} (≤${item.freshness_days} days)` : item.label)))]
  const helpful = [...new Set(rules.flatMap((rule) => rule.content.helpful.map((item) => item.label)))]
  const modalities = rules.filter((rule) => rule.content.modality !== 'unspecified').map((rule) => tag(rule, MODALITY_LABELS[rule.content.modality as Modality]))
  return <div className="practice-tab">
    <section className="practice-section practice-section-focus">
      <h3 className="practice-section-heading">Referral types</h3>
      <div className="practice-chip-group prominent">{[...new Set(rules.map((rule) => rule.referral_type))].map((type) => <span className="practice-chip" key={type}>{type}</span>)}</div>
    </section>
    {(good.length > 0 || notFit.length > 0 || urgent.length > 0) && <section className="practice-section practice-section-fit">
      <h3 className="practice-section-heading">Referral fit</h3>
      <div className="practice-fit-columns">
        {good.length > 0 && <div className="practice-fit-column good"><p className="practice-subheading">Usually a good fit</p><ul className="practice-fit-list">{good.map((item) => <li key={item}><span aria-hidden="true">✓</span> {item}</li>)}</ul></div>}
        {notFit.length > 0 && <div className="practice-fit-column not-fit"><p className="practice-subheading">Usually not a fit</p><ul className="practice-fit-list">{notFit.map((item) => <li key={item}><span aria-hidden="true">—</span> {item}</li>)}</ul></div>}
      </div>
      {urgent.length > 0 && <div className="practice-care-pathway"><p className="practice-subheading">Treated as urgent</p><ul className="practice-fit-list">{urgent.map((item) => <li key={item}><span aria-hidden="true">→</span> {item}</li>)}</ul></div>}
    </section>}
    {(required.length > 0 || helpful.length > 0 || modalities.length > 0) && <section className="practice-section practice-section-workup">
      <h3 className="practice-section-heading">Before referral</h3>
      <div className="practice-workup-columns">
        {required.length > 0 && <div className="practice-workup-block"><p className="practice-subheading">Required before review</p><div className="practice-chip-group">{required.map((item) => <span className="practice-chip" key={item}>{item}</span>)}</div></div>}
        {helpful.length > 0 && <div className="practice-workup-block"><p className="practice-subheading">Helpful when available</p><div className="practice-chip-group">{helpful.map((item) => <span className="practice-chip" key={item}>{item}</span>)}</div></div>}
        {modalities.length > 0 && <div className="practice-workup-block"><p className="practice-subheading">Modality preference</p><p className="practice-access-line">{modalities.join(' · ')}</p></div>}
      </div>
    </section>}
    <section className="practice-section practice-section-learnings">
      <h3 className="practice-section-heading">Confirmed rules</h3>
      <ul className="practice-rule-list">{rules.map((rule) => <li className="practice-rule-row" key={rule.id}>
        <div className="practice-rule-row-main"><span>{rule.referral_type}</span><small className="practice-rule-provenance">Version {rule.version} · {rule.physician_confirmed ? 'physician-confirmed' : rule.operational_status.replace('_', ' ')} · since {formatDate(rule.confirmed_at ?? rule.created_at)}</small></div>
        <span className="practice-rule-row-actions"><button type="button" className="text-button" onClick={() => navigate(pilotPaths.agentTab('rules'))}>View rule →</button></span>
      </li>)}</ul>
    </section>
  </div>
}

function TeachTab({ physician, data, onChange }: { physician: boolean; data: Awaited<ReturnType<typeof getTeaching>> | null; onChange: () => void }) {
  const [text, setText] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const teach = async (event: FormEvent) => {
    event.preventDefault()
    if (text.trim().length < 3) return
    setBusy(true); setError('')
    try { await teachAgent(text.trim()); setText(''); onChange() } catch (err) { setError(errorText(err, 'Could not interpret that.')) } finally { setBusy(false) }
  }
  return <div className="pilot-teach-tab">
    <p className="page-intro">Teach Lamina how you want referrals handled. Every instruction becomes a proposed rule you confirm; nothing changes triage until you do.</p>
    {physician && data?.question && <QuestionCard question={data.question} onChange={onChange} />}
    {physician ? <form className="pilot-teach-composer" onSubmit={(event) => void teach(event)}>
      <label><span className="practice-subheading">Teach your agent</span><textarea rows={2} value={text} onChange={(event) => setText(event.target.value)} placeholder="e.g. I usually want a recent A1c before reviewing diabetes referrals." maxLength={2000} disabled={busy} /></label>
      {error && <p className="error-banner" role="alert">{error}</p>}
      <div className="pilot-actions"><button className="button-primary" type="submit" disabled={busy || text.trim().length < 3}>{busy ? 'Interpreting…' : 'Teach'} <span>→</span></button></div>
    </form> : <p className="agent-empty-note">Only the physician can teach the agent or confirm what it learned.</p>}
    <h2 className="pilot-subhead">Waiting for confirmation</h2>
    {data && data.proposals.length === 0 && <p className="agent-empty-note">Nothing pending.</p>}
    {(data?.proposals ?? []).map((proposal) => <div id={`proposal-${proposal.id}`} key={proposal.id}>{physician ? <ProposalCard proposal={proposal} referralTypes={data?.referral_types ?? []} onChange={onChange} /> : <section className="pilot-card"><ProposalSummary proposal={proposal} /></section>}</div>)}
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
    <label><span>Good fit — one per line</span><textarea rows={3} value={form.goodFit} onChange={set('goodFit')} placeholder="Type 2 diabetes not at goal on two agents" disabled={busy} /></label>
    <label><span>Outside my scope — one per line</span><textarea rows={2} value={form.outsideScope} onChange={set('outsideScope')} placeholder="Type 1 diabetes pump management" disabled={busy} /></label>
    <label><span>Required before review — one per line, optional “| days” for recency</span><textarea rows={3} value={form.required} onChange={set('required')} placeholder={'Recent HbA1c | 180\nCurrent medication list'} disabled={busy} /></label>
    <label><span>Helpful but not required</span><textarea rows={2} value={form.helpful} onChange={set('helpful')} placeholder="Glucose log" disabled={busy} /></label>
    <label><span>Urgency signals — one per line</span><textarea rows={2} value={form.urgent} onChange={set('urgent')} placeholder="Recent DKA admission" disabled={busy} /></label>
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
