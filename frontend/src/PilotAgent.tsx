import { useEffect, useState, type FormEvent } from 'react'
import { ApiError } from './api.ts'
import { LaminaMark } from './LaminaMark.tsx'
import {
  answerLearningQuestion, clarifyProposal, confirmProposal, getPilotMetrics, getPublicProfilePreview, getTeaching,
  publishPublicProfile, rejectProposal, savePublicProfileSettings, setRulePublishable, teachAgent, unpublishPublicProfile,
  type LearningQuestion, type MetricSection, type PilotMetrics, type PilotStatus, type Proposal, type PublicProfilePreview,
} from './pilotApi.ts'
import { MODALITY_LABELS, pilotErrorCopy, pilotPaths, ruleFormFrom, ruleInput, type RuleForm } from './pilotState.ts'
import { PublicProfileView } from './PublicPages.tsx'

type Navigate = (path: string) => void
const errorText = (err: unknown, fallback: string) =>
  pilotErrorCopy(err instanceof ApiError ? err.code : null, err instanceof Error ? err.message : fallback)

/* ------------------------------------------------------------------ teach */

function ProposalSummary({ proposal }: { proposal: Proposal }) {
  const content = proposal.content
  const lines: string[] = []
  if (content.required.length) lines.push(`Require before review: ${content.required.map((item) => item.freshness_days ? `${item.label} (within ${item.freshness_days} days)` : item.label).join(', ')}`)
  if (content.helpful.length) lines.push(`Helpful: ${content.helpful.map((item) => item.label).join(', ')}`)
  if (content.good_fit.length) lines.push(`Good fit: ${content.good_fit.join('; ')}`)
  if (content.redirect.length) lines.push(`Outside your scope: ${content.redirect.join('; ')}`)
  if (content.urgent_signals.length) lines.push(`Treat as urgent: ${content.urgent_signals.join('; ')}`)
  if (content.modality !== 'unspecified') lines.push(`Default modality: ${MODALITY_LABELS[content.modality]}${content.modality_notes ? ` — ${content.modality_notes}` : ''}`)
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
  return <section className="pilot-card pilot-question">
    <div className="pilot-triage-head"><LaminaMark active /><div><p className="eyebrow">A question from your agent</p><h2>{question.question}</h2></div></div>
    <p className="muted-note">I’ll ask at most one question like this a day. Nothing changes unless you say yes.</p>
    {depends && <label><span>When does it apply? (optional)</span><textarea rows={2} value={note} onChange={(event) => setNote(event.target.value)} /></label>}
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

export function AgentPage({ status }: { status: PilotStatus }) {
  const [data, setData] = useState<Awaited<ReturnType<typeof getTeaching>> | null>(null)
  const [text, setText] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const physician = status.role === 'physician'
  const load = () => getTeaching().then(setData).catch((err) => setError(errorText(err, 'Could not load your agent')))
  useEffect(() => { void load() }, [])
  const teach = async (event: FormEvent) => {
    event.preventDefault()
    if (text.trim().length < 3) return
    setBusy(true); setError('')
    try { await teachAgent(text.trim()); setText(''); void load() } catch (err) { setError(errorText(err, 'Could not interpret that.')) } finally { setBusy(false) }
  }
  return <main className="page-shell pilot-page pilot-narrow">
    <h1>Your practice agent</h1>
    <p className="muted-note">Teach Lamina how you want referrals handled. Every instruction becomes a proposed rule you confirm; nothing changes triage until you do.</p>
    {physician && data?.question && <QuestionCard question={data.question} onChange={() => void load()} />}
    {physician ? <form className="pilot-card auth-form pilot-form pilot-teach" onSubmit={(event) => void teach(event)}>
      <label><span>Teach your agent</span><textarea rows={2} value={text} onChange={(event) => setText(event.target.value)} placeholder="e.g. I usually want a recent A1c before reviewing diabetes referrals." maxLength={2000} disabled={busy} /></label>
      {error && <p className="error-banner" role="alert">{error}</p>}
      <button className="button-primary" type="submit" disabled={busy}>{busy ? 'Interpreting…' : 'Teach'}</button>
    </form> : <p className="muted-note">Only the physician can teach the agent or confirm what it learned.</p>}
    <h2 className="pilot-subhead">Waiting for your confirmation</h2>
    {data && data.proposals.length === 0 && <p className="muted-note">Nothing pending.</p>}
    {(data?.proposals ?? []).map((proposal) => <div id={`proposal-${proposal.id}`} key={proposal.id}>{physician ? <ProposalCard proposal={proposal} referralTypes={data?.referral_types ?? []} onChange={() => void load()} /> : <section className="pilot-card"><ProposalSummary proposal={proposal} /></section>}</div>)}
  </main>
}

/* --------------------------------------------------------- public profile */

export function PublicSettingsPage({ status }: { status: PilotStatus }) {
  const [preview, setPreview] = useState<PublicProfilePreview | null>(null)
  const [draft, setDraft] = useState<{ slug: string; intro: string; insurance: string; how_to_refer: string; hours: string; locations: string } | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const physician = status.role === 'physician'
  const apply = (next: PublicProfilePreview) => {
    setPreview(next)
    setDraft({ slug: next.slug, intro: next.settings.intro, insurance: next.settings.insurance, how_to_refer: next.settings.how_to_refer, hours: next.settings.hours, locations: next.settings.locations.join('\n') })
  }
  useEffect(() => { getPublicProfilePreview().then(apply).catch((err) => setError(errorText(err, 'Could not load the public profile'))) }, [])
  const run = async (action: () => Promise<PublicProfilePreview | unknown>) => {
    setBusy(true); setError('')
    try { const result = await action(); apply(result && typeof result === 'object' && 'slug' in result ? result as PublicProfilePreview : await getPublicProfilePreview()) }
    catch (err) { setError(errorText(err, 'That didn’t work.')) } finally { setBusy(false) }
  }
  if (!preview || !draft) return <main className="page-shell pilot-page"><p className="muted-note">{error || 'Loading…'}</p></main>
  const publicUrl = `${window.location.origin}${pilotPaths.publicPage(preview.slug)}`
  const set = (key: keyof typeof draft) => (event: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => setDraft({ ...draft, [key]: event.target.value })
  return <main className="page-shell pilot-page">
    <div className="pilot-section-head"><div><h1>Public referral page</h1>
      <p className="muted-note">{preview.status === 'published' ? <>Live at <a href={pilotPaths.publicPage(preview.slug)} target="_blank" rel="noreferrer">{publicUrl}</a> · version {preview.published_version?.version}</> : preview.status === 'unpublished' ? 'Unpublished — the page is offline.' : 'Not published yet.'}{preview.unpublished_changes && preview.status === 'published' ? ' · You have changes that aren’t live yet.' : ''}</p></div>
      {physician && <div className="onboarding-actions">
        <button className="button-primary" disabled={busy} onClick={() => void run(publishPublicProfile)}>{preview.status === 'published' ? 'Publish update' : 'Publish'}</button>
        {preview.status === 'published' && <button className="text-button" disabled={busy} onClick={() => void run(unpublishPublicProfile)}>Unpublish</button>}
      </div>}
    </div>
    {error && <div className="error-banner" role="alert">{error}</div>}
    <p className="muted-note">Only what you see in the preview is ever public. Internal notes, urgency signals, unpublished rules, and all referral data stay private.</p>
    <div className="pilot-detail-grid">
      <section className="pilot-card">
        <h2>What to publish</h2>
        <h3>Referral rules</h3>
        {preview.rules.length === 0 && <p className="muted-note">Add referral rules first.</p>}
        {preview.rules.map((rule) => <label key={rule.id} className="pilot-check"><input type="checkbox" checked={rule.publishable} disabled={!physician || busy} onChange={(event) => void run(() => setRulePublishable(rule.id, event.target.checked))} /> {rule.referral_type} <small className="muted-note">v{rule.version}</small></label>)}
        <form className="auth-form pilot-form" onSubmit={(event) => { event.preventDefault(); void run(() => savePublicProfileSettings({ slug: draft.slug, intro: draft.intro, insurance: draft.insurance, how_to_refer: draft.how_to_refer, hours: draft.hours, locations: draft.locations.split('\n').map((line) => line.trim()).filter(Boolean) })) }}>
          <label><span>Page address</span><input value={draft.slug} onChange={set('slug')} disabled={!physician} /></label>
          <label><span>Short introduction</span><textarea rows={2} value={draft.intro} onChange={set('intro')} disabled={!physician} /></label>
          <label><span>Locations — one per line</span><textarea rows={2} value={draft.locations} onChange={set('locations')} disabled={!physician} /></label>
          <label><span>Hours</span><input value={draft.hours} onChange={set('hours')} disabled={!physician} /></label>
          <label><span>Insurance information</span><textarea rows={2} value={draft.insurance} onChange={set('insurance')} disabled={!physician} /></label>
          <label><span>How to refer</span><textarea rows={2} value={draft.how_to_refer} onChange={set('how_to_refer')} disabled={!physician} /></label>
          {physician && <button className="button-secondary" type="submit" disabled={busy}>Save draft</button>}
        </form>
      </section>
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
  const table = (metrics: PilotMetrics) => (Object.keys(SECTION_TITLES) as MetricSection[]).map((section) => <section key={section} className="pilot-card">
    <h2>{SECTION_TITLES[section]}</h2>
    <dl className="pilot-facts">{Object.entries(metrics[section]).map(([key, value]) => <div key={key}><dt>{label(key)}</dt><dd>{show(value)}</dd></div>)}</dl>
  </section>)
  return <main className="page-shell pilot-page pilot-narrow">
    <button className="text-button back-link" onClick={() => navigate(pilotPaths.home)}>← Home</button>
    <h1>Pilot metrics</h1>
    {error && <div className="error-banner" role="alert">{error}</div>}
    {data && <>
      <section className="pilot-briefing"><div className="pilot-briefing-mark"><LaminaMark active /></div><div><p className="eyebrow">This week</p><p className="pilot-weekly">{data.weekly.text}</p></div></section>
      <p className="muted-note">All figures are counts or durations from recorded events. Lamina doesn’t estimate “time saved”.</p>
      <h2 className="pilot-subhead">All time</h2>
      {table(data.all_time)}
    </>}
  </main>
}
