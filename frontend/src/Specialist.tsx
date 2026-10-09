import { useEffect, useState } from 'react'
import {
  ApiError,
  getAgentOverview,
  getNetworkFeed,
  getPracticeRepresentation,
  getProfessionalPosts,
  getSpecialistCase,
  getSpecialistCases,
  getSpecialistWorkspace,
  getTrainingHistory,
  markSpecialistCaseReviewed,
  updateSpecialistCalibration,
  type AgentOverview,
  type NetworkFeed,
  type NetworkFeedItem,
  type PracticeRepresentation,
  type ProfessionalPost,
  type SpecialistCaseDetail,
  type SpecialistCaseSummary,
  type SpecialistOutcome,
  type SpecialistWorkspace,
  type TrainProjection,
} from './api.ts'
import { eventDomId } from './agentActivity.ts'
import { AgentActivityList, AgentOverviewPanel, ChatTab, findPendingReviewHistoryEntry, HomeAgentCard, NetworkFeedTab, NetworkHighlights, NetworkTabs, TrainTab, networkProfilePath, trainingPath, type AgentActivityRow, type NetworkTab } from './Engagement.tsx'
import { timeAwareGreeting } from './greeting.ts'
import { LaminaMark } from './LaminaMark.tsx'

type Navigate = (path: string) => void

export const specialistCasePath = (recordId: number) => `/specialist/cases/${recordId}`

function NetworkMark({ active = false, resolved = false }: { active?: boolean; resolved?: boolean }) {
  return <LaminaMark active={active} resolved={resolved} />
}

const formatTime = (value: string) => new Date(value).toLocaleString('en-US', { month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' })

const nameInitials = (name: string) => name.split(/\s+/).filter(Boolean).map((part) => part[0]).slice(0, 2).join('').toUpperCase()

/** Calm, descriptive labels for the backend-provided outcome — never a quality score. */
export const SPECIALIST_OUTCOME_LABELS: Record<SpecialistOutcome, string> = {
  recommended: 'Recommended',
  alternative: 'Alternative',
  redirected: 'Redirected',
  consulted_not_selected: 'Consulted · not selected',
}

function OutcomeBadge({ outcome }: { outcome: SpecialistOutcome }) {
  return <span className={`specialist-outcome-badge ${outcome}`}><i aria-hidden="true" />{SPECIALIST_OUTCOME_LABELS[outcome]}</span>
}

function networkOutcomeSentence(outcome: SpecialistCaseDetail['network_outcome']) {
  if (outcome.was_recommended) return 'You were recommended as the referral destination.'
  if (outcome.specialist_outcome === 'alternative') return `${outcome.recommended_physician} was recommended. Your agent remained an appropriate alternative.`
  if (outcome.specialist_outcome === 'redirected') return `${outcome.recommended_physician} was recommended. Your agent redirected this case toward a different specialty.`
  return `${outcome.recommended_physician} was recommended. Your agent was consulted but not selected.`
}

/** The empty-state helper every specialist page offers back to the referring-physician demo. */
function SwitchToLucyHelper({ navigate, copy }: { navigate: Navigate; copy: string }) {
  return <div className="specialist-demo-helper">
    <p>{copy}</p>
    <button className="button-secondary" onClick={() => navigate('/home')}>Switch to Dr. Lucy Saruhashi →</button>
  </div>
}

/* ---------------------------------------------------------------- Home */

function SpecialistCurrentWorkRow({ item, navigate }: { item: SpecialistCaseSummary; navigate: Navigate }) {
  return <button className="lam-row" onClick={() => navigate(specialistCasePath(item.consultation_record_id))}>
    <span className="lam-row-mark patient-row-avatar">{nameInitials(item.patient_name)}</span>
    <span className="lam-row-main">
      <strong>{item.patient_name}</strong>
      <span>Network consultation from {item.referring_physician}</span>
      <small>{item.referral_question}</small>
    </span>
    <OutcomeBadge outcome={item.specialist_outcome} />
    <span className="lam-row-action">Needs review <b>→</b></span>
  </button>
}

function SpecialistActivityRow({ item, navigate }: { item: SpecialistCaseSummary; navigate: Navigate }) {
  const detail = item.was_recommended
    ? 'You were recommended as the referral destination'
    : `${SPECIALIST_OUTCOME_LABELS[item.specialist_outcome]} · ${item.recommendation_physician} recommended`
  return <button className="lam-row" onClick={() => navigate(specialistCasePath(item.consultation_record_id))}>
    <span className="lam-row-mark patient-row-avatar">{nameInitials(item.patient_name)}</span>
    <span className="lam-row-main">
      <strong>Your agent responded to {item.patient_name}'s network consultation</strong>
      <span>{detail}</span>
      <small>{formatTime(item.consulted_at)}{item.reviewed ? ' · Case reviewed' : ''}</small>
    </span>
    <span className="lam-row-action">View case <b>→</b></span>
  </button>
}

export function SpecialistHomePage({ navigate }: { navigate: Navigate }) {
  const [workspace, setWorkspace] = useState<SpecialistWorkspace | null>(null)
  const [error, setError] = useState('')
  const [feed, setFeed] = useState<NetworkFeed | null>(null)
  const [overview, setOverview] = useState<AgentOverview | null>(null)
  useEffect(() => {
    getSpecialistWorkspace().then(setWorkspace).catch((err: Error) => setError(err.message))
    getNetworkFeed('iain').then(setFeed).catch(() => {})
    getAgentOverview('iain').then(setOverview).catch(() => {})
  }, [])
  const needsReview = workspace?.recent_cases.filter((item) => !item.reviewed) ?? []
  const recent = workspace?.recent_cases ?? []
  const training = overview?.training ?? null
  const trainReviewHref = training?.state === 'review_pending' && training.review_session_id ? `${trainingPath('iain')}?review=${training.review_session_id}` : null
  const greetingName = `Dr. ${workspace?.physician.physician.split(' ').at(-1) ?? 'Jung'}`
  const situationSummary = needsReview.length > 0 ? `${needsReview.length} case${needsReview.length === 1 ? '' : 's'} ${needsReview.length === 1 ? 'needs' : 'need'} your review.` : null
  return <main className="page-shell home-page dashboard-page">
    <header className="dashboard-greeting"><p className="eyebrow">Dashboard</p><h1>{timeAwareGreeting(greetingName)}</h1>{situationSummary && <p className="dashboard-situation">{situationSummary}</p>}</header>
    {error && <div className="error-banner" role="alert">Specialist workspace activity is temporarily unavailable.</div>}
    {!workspace && !error && <div className="home-loading"><div className="loading-line" /><p>Opening specialist workspace…</p></div>}
    {workspace && <>
      <section className="dashboard-needs-you"><div className="home-section-heading"><div><h2>Needs you</h2></div>{(needsReview.length > 0 || trainReviewHref) && <span>{needsReview.length + (trainReviewHref ? 1 : 0)}</span>}</div>
        {needsReview.length > 0 || trainReviewHref
          ? <div className="lam-list needs-attention">
            {needsReview.map((item) => <SpecialistCurrentWorkRow key={item.consultation_record_id} item={item} navigate={navigate} />)}
            {trainReviewHref && <button className="lam-row" onClick={() => navigate(trainReviewHref)}><span className="lam-row-mark agent-row-avatar">◇</span><span className="lam-row-main"><strong>Confirm proposed learning</strong><small>Your agent finished a training session and has a proposed learning ready for review.</small></span><span className="lam-row-status your-move">Your move</span></button>}
          </div>
          : <p className="dashboard-empty-note">Nothing needs you right now.</p>}
      </section>
      <HomeAgentCard overview={overview} navigate={navigate} trainPath={trainingPath('iain')} viewAgentPath="/specialist/agent?tab=overview" />
      {workspace.case_count > 0
        ? <section className="home-activity"><div className="home-section-heading"><div><h2>Recent activity</h2></div></div>
          <div className="lam-list quiet">{recent.slice(0, 5).map((item) => <SpecialistActivityRow key={item.consultation_record_id} item={item} navigate={navigate} />)}</div>
        </section>
        : <div className="empty-state specialist-empty">
          <NetworkMark />
          <h2>No cases involving your agent yet</h2>
          <p>Cases will appear here when your agent participates in a network consultation.</p>
          <SwitchToLucyHelper navigate={navigate} copy="Run a network consultation from the referring-physician perspective to see the specialist side." />
        </div>}
      <NetworkHighlights feed={feed} navigate={navigate} perspective="iain" />
    </>}
  </main>
}

/* --------------------------------------------------------------- Cases */

function SpecialistCaseListRow({ item, navigate }: { item: SpecialistCaseSummary; navigate: Navigate }) {
  const ageLocation = [item.patient_age != null ? `${item.patient_age} years` : null, item.patient_location].filter(Boolean).join(' · ')
  return <button className="lam-row" onClick={() => navigate(specialistCasePath(item.consultation_record_id))}>
    <span className="lam-row-mark patient-row-avatar">{nameInitials(item.patient_name)}</span>
    <span className="lam-row-main">
      <strong>{item.patient_name}</strong>
      <span>{item.referral_question}</span>
      <small>{ageLocation}{ageLocation ? ' · ' : ''}Network consultation from {item.referring_physician} · {formatTime(item.consulted_at)}</small>
    </span>
    <OutcomeBadge outcome={item.specialist_outcome} />
    <span className="lam-row-action">Open case <b>→</b></span>
  </button>
}

export function SpecialistCasesPage({ navigate }: { navigate: Navigate }) {
  const [cases, setCases] = useState<SpecialistCaseSummary[] | null>(null)
  const [error, setError] = useState('')
  useEffect(() => { getSpecialistCases().then(setCases).catch((err: Error) => setError(err.message)) }, [])
  const needsReview = (cases ?? []).filter((item) => !item.reviewed)
  const reviewed = (cases ?? []).filter((item) => item.reviewed)
  const group = (title: string, items: SpecialistCaseSummary[]) => items.length > 0 && <section className="patient-group" key={title}>
    <div className="patient-group-heading"><h2>{title}</h2><span>{items.length}</span></div>
    <div className="lam-list">{items.map((item) => <SpecialistCaseListRow key={item.consultation_record_id} item={item} navigate={navigate} />)}</div>
  </section>
  return <main className="page-shell history-page">
    <p className="eyebrow">Specialist case records</p>
    <h1>Cases</h1>
    <p className="page-intro">Network consultations where your agent participated.</p>
    {error && <div className="error-banner" role="alert">{error}</div>}
    {!cases && !error && <p className="muted-note">Loading cases…</p>}
    {cases && cases.length === 0 && <div className="empty-state history-empty">
      <NetworkMark />
      <h2>No network cases yet</h2>
      <p>Cases will appear here when your agent participates in a network consultation.</p>
      <SwitchToLucyHelper navigate={navigate} copy="Run a network consultation from the referring-physician perspective to see the specialist side." />
    </div>}
    {group('Needs review', needsReview)}
    {group('Reviewed', reviewed)}
  </main>
}

/* ---------------------------------------------------------- Case detail */

export function SpecialistCaseDetailPage({ recordId, navigate }: { recordId: number; navigate: Navigate }) {
  const [detail, setDetail] = useState<SpecialistCaseDetail | null>(null)
  const [notFound, setNotFound] = useState(false)
  const [error, setError] = useState('')
  const [networkOpen, setNetworkOpen] = useState(false)
  const [calibrationOpen, setCalibrationOpen] = useState(false)
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState('')
  const [busy, setBusy] = useState(false)
  const [actionError, setActionError] = useState('')

  const load = () => getSpecialistCase(recordId)
    .then((data) => { setDetail(data); setNotFound(false); setError('') })
    .catch((err: unknown) => {
      if (err instanceof ApiError && err.status === 404) setNotFound(true)
      else setError(err instanceof Error ? err.message : 'Could not open this case')
    })
  useEffect(() => { setDetail(null); setNotFound(false); setError(''); setCalibrationOpen(false); setEditing(false); void load() }, [recordId]) // eslint-disable-line react-hooks/exhaustive-deps

  const markReviewed = async () => {
    setBusy(true); setActionError('')
    try { await markSpecialistCaseReviewed(recordId); await load() }
    catch (err) { setActionError(err instanceof Error ? err.message : 'Could not save your review') }
    finally { setBusy(false) }
  }
  const act = async (action: 'confirm' | 'edit' | 'reject', statement?: string) => {
    if (!detail) return
    setBusy(true); setActionError('')
    try {
      await updateSpecialistCalibration(recordId, detail.calibration.key, action, statement)
      await markSpecialistCaseReviewed(recordId)
      setEditing(false)
      await load()
    } catch (err) { setActionError(err instanceof Error ? err.message : 'Could not save your correction') }
    finally { setBusy(false) }
  }

  if (notFound) return <main className="page-shell specialist-case-page">
    <button className="text-button back-link" onClick={() => navigate('/specialist/cases')}>← All cases</button>
    <div className="empty-state"><NetworkMark /><h2>Case unavailable</h2><p>This case isn't available in your current workspace.</p><button className="button-primary" onClick={() => navigate('/specialist/cases')}>Back to Cases →</button></div>
  </main>
  if (error) return <main className="page-shell specialist-case-page">
    <button className="text-button back-link" onClick={() => navigate('/specialist/cases')}>← All cases</button>
    <div className="error-banner" role="alert">{error}</div>
  </main>
  if (!detail) return <main className="page-shell specialist-case-page"><div className="page-state embedded"><div className="loading-line" /><p>Opening case…</p></div></main>

  const calibration = detail.calibration
  // "edit" keeps the backend status 'suggested' (an edited draft, not yet confirmed),
  // so visibility must key off whether the specialist has acted at all, not the status.
  const showCalibrationCard = calibrationOpen || calibration.updated_at !== null
  const clarifications = detail.agent_response.interactions.filter((item) => item.message_type === 'follow_up_question' || item.message_type === 'follow_up_answer')
  const ageLocation = [detail.patient_age != null ? `${detail.patient_age} years` : null, detail.patient_location].filter(Boolean).join(' · ')
  const fitLabel = `${detail.agent_response.fit.charAt(0).toUpperCase()}${detail.agent_response.fit.slice(1)} fit`

  return <main className="page-shell specialist-case-page">
    <button className="text-button back-link" onClick={() => navigate('/specialist/cases')}>← All cases</button>
    <p className="eyebrow">Network case</p>
    <h1>{detail.patient_name}</h1>
    {ageLocation && <p className="specialist-case-meta">{ageLocation}</p>}
    <p className="specialist-case-referrer">Network consultation initiated by <b>{detail.case_context.referring_physician.name}</b> · {detail.case_context.referring_physician.specialty}</p>

    <section className="specialist-role-card">
      <span className="section-label">Your agent's role</span>
      <OutcomeBadge outcome={detail.specialist_outcome} />
      <p className="specialist-referral-note">Network recommendation · referral not yet submitted</p>
    </section>

    <section className="specialist-section">
      <h2>Why your agent was consulted</h2>
      <p>{detail.case_context.consultation_purpose}</p>
    </section>

    <section className="specialist-section">
      <h2>What your agent received</h2>
      <p className="specialist-section-note">Bounded clinical context provided to your agent for this network consultation.</p>
      <p>{detail.agent_received.summary}</p>
      {detail.agent_received.facts.length > 0 && <div className="specialist-fact-group"><span className="section-label">Patient facts</span><ul className="clinical-list">{detail.agent_received.facts.map((fact) => <li key={fact}>{fact}</li>)}</ul></div>}
      {detail.agent_received.signals.length > 0 && <div className="specialist-fact-group"><span className="section-label">Routing signals</span><ul className="clinical-list">{detail.agent_received.signals.map((signal) => <li key={signal}>{signal}</li>)}</ul></div>}
    </section>

    <section className="specialist-section">
      <h2>What your agent said</h2>
      <div className="specialist-said-grid">
        <div><span className="section-label">Clinical fit</span><strong>{fitLabel}</strong></div>
        <div><span className="section-label">Access</span><strong>{detail.agent_response.access}</strong></div>
      </div>
      {detail.agent_response.required_workup.length > 0 && <div className="specialist-fact-group"><span className="section-label">Required before referral</span><div className="specialist-workup-chips">{detail.agent_response.required_workup.map((item) => <span key={item}>{item}</span>)}</div></div>}
      {detail.agent_response.explicit_rules_used.length > 0 && <div className="specialist-fact-group"><span className="section-label">Practice rule applied</span><ul className="clinical-list">{detail.agent_response.explicit_rules_used.map((rule) => <li key={rule}>{rule}</li>)}</ul></div>}
      {clarifications.length > 0 && <div className="specialist-fact-group"><span className="section-label">Clarification</span>{clarifications.map((item) => <p key={item.event_id} id={eventDomId(item.event_id)} className="specialist-clarification-line">{item.summary}</p>)}</div>}
    </section>

    <section className="specialist-section">
      <h2>Network outcome</h2>
      <p>{networkOutcomeSentence(detail.network_outcome)}</p>
      <p className="specialist-section-note">{detail.network_outcome.final_synthesis}</p>
    </section>

    <section className="specialist-review">
      <p className="section-label">Review your agent</p>
      <h2>Does your agent's response reflect how you would practice?</h2>
      {actionError && <p className="demo-reset-error" role="alert">{actionError}</p>}
      {detail.reviewed && <p className="specialist-reviewed-note" role="status"><b>✓</b> Reviewed{detail.reviewed_at ? ` · ${formatTime(detail.reviewed_at)}` : ''}</p>}
      {!detail.reviewed && <div className="recommendation-feedback"><span>Confirm or correct your agent's response.</span><button className="text-button" disabled={busy} onClick={markReviewed}>Yes</button><button className="text-button" disabled={busy} onClick={() => setCalibrationOpen(true)}>Not quite <b>→</b></button></div>}
      {showCalibrationCard && <article className="learning-card">
        <span className={`learning-status ${calibration.status}`}>{calibration.status === 'suggested' ? 'Proposed · needs confirmation' : calibration.status === 'confirmed' ? 'Physician-confirmed' : 'Rejected'}</span>
        <p>{calibration.statement}</p>
        <small>Source: {calibration.provenance}</small>
        {editing
          ? <div className="learning-edit"><label htmlFor="specialist-calibration-edit">Correct your agent's response</label><textarea id="specialist-calibration-edit" maxLength={500} value={draft} onChange={(event) => setDraft(event.target.value)} /><div><button className="button-primary" disabled={!draft.trim() || busy} onClick={() => act('edit', draft)}>Save draft</button><button className="text-button" onClick={() => setEditing(false)}>Cancel</button></div></div>
          : <div className="learning-actions"><button onClick={() => act('confirm')} disabled={busy || calibration.status === 'confirmed'}>Confirm</button><button onClick={() => { setEditing(true); setDraft(calibration.statement) }} disabled={busy}>Edit</button><button onClick={() => act('reject')} disabled={busy || calibration.status === 'rejected'}>Reject</button></div>}
      </article>}
    </section>

    <section className="network-transparency">
      <button className="network-transparency-toggle" onClick={() => setNetworkOpen(!networkOpen)} aria-expanded={networkOpen}>
        <span><NetworkMark resolved /><span><b>View network consultation</b><small>{detail.network_context.participants.length} physician-agent conclusions</small></span></span>
        <em>{networkOpen ? 'Hide' : 'View'} <i>⌄</i></em>
      </button>
      {networkOpen && <div className="specialist-network-detail">{detail.network_context.participants.map((participant) => <div key={participant.physician_id} className="specialist-participant-row">
        <div><strong>{participant.physician_name}</strong><small>{participant.specialty}</small></div>
        <OutcomeBadge outcome={participant.interaction_outcome} />
        <p>{participant.agent_response_summary}</p>
      </div>)}</div>}
    </section>
    <p className="disclaimer">{detail.disclaimer}</p>
  </main>
}

/* ------------------------------------------------------------- My Agent */

/** Overview absorbed the old separate Practice tab (post-8B consolidation); Activity
 * moved to the Dashboard. */
const AGENT_TABS = ['overview', 'train', 'test'] as const
type AgentTab = typeof AGENT_TABS[number]
const LEGACY_SPECIALIST_AGENT_TAB_ALIASES: Record<string, AgentTab> = { practice: 'overview', chat: 'test', activity: 'overview' }
const resolveSpecialistAgentTab = (value: string | null): AgentTab => {
  if (value && (AGENT_TABS as readonly string[]).includes(value)) return value as AgentTab
  if (value && value in LEGACY_SPECIALIST_AGENT_TAB_ALIASES) return LEGACY_SPECIALIST_AGENT_TAB_ALIASES[value]
  return 'overview'
}

export function SpecialistAgentPage({ navigate, params }: { navigate: Navigate; params?: URLSearchParams }) {
  const tabParam = params?.get('tab') ?? null
  const [workspace, setWorkspace] = useState<SpecialistWorkspace | null>(null)
  const [representation, setRepresentation] = useState<PracticeRepresentation | null>(null)
  const [overview, setOverview] = useState<AgentOverview | null>(null)
  const [trainProjection, setTrainProjection] = useState<TrainProjection | null>(null)
  const [tab, setTab] = useState<AgentTab>(() => resolveSpecialistAgentTab(tabParam))
  const [error, setError] = useState('')
  useEffect(() => {
    getSpecialistWorkspace().then(setWorkspace).catch((err: Error) => setError(err.message))
    getPracticeRepresentation('iain').then(setRepresentation).catch(() => {})
    getAgentOverview('iain').then(setOverview).catch(() => {})
    getTrainingHistory('iain').then(setTrainProjection).catch(() => {})
  }, [])
  useEffect(() => { setTab(resolveSpecialistAgentTab(tabParam)) }, [tabParam])
  const selectTab = (next: AgentTab) => { setTab(next); window.history.replaceState({}, '', `/specialist/agent?tab=${next}`) }
  return <main className="page-shell agent-page">
    {error && <div className="error-banner" role="alert">{error}</div>}
    {!workspace && !error && <p className="muted-note">Opening your agent…</p>}
    {workspace && <>
      <section className="agent-hero"><div className="agent-hero-mark"><NetworkMark /></div><div>
        <p className="eyebrow">Specialist agent</p>
        <h1>{workspace.physician.agent_name}</h1>
        <p>{workspace.physician.specialty} · Represents your practice when other physician agents consult the Lamina network.</p>
        <span className="agent-status-badge reserved"><i />Reserved synthetic profile</span>
      </div></section>

      <nav className="agent-tabs" aria-label="My Agent sections">{AGENT_TABS.map((item) => <button key={item} className={tab === item ? 'active' : ''} aria-current={tab === item ? 'page' : undefined} onClick={() => selectTab(item)}>{item[0].toUpperCase() + item.slice(1)}</button>)}</nav>

      {tab === 'overview' && <AgentOverviewPanel overview={overview} representation={representation} navigate={navigate} trainPath={trainingPath('iain')} />}
      {tab === 'train' && <TrainTab trainProjection={trainProjection} navigate={navigate} trainPath={trainingPath('iain')} />}
      {tab === 'test' && <ChatTab personaId="iain" agentName={workspace.physician.agent_name} navigate={navigate} trainPath={trainingPath('iain')} />}
    </>}
  </main>
}

/* ------------------------------------------------------------------ Patients */

export function SpecialistPatientsPage({ navigate }: { navigate: Navigate }) {
  return <main className="page-shell selector-page">
    <header className="selector-header"><div><p className="eyebrow">Specialist patients</p><h1>Patients</h1><p>People you actually care for, connected to this workspace.</p></div></header>
    <div className="empty-state specialist-empty">
      <NetworkMark />
      <h2>No patient panel connected in this specialist demo</h2>
      <p>Cases where your agent participates appear under Cases.</p>
      <button className="button-secondary" onClick={() => navigate('/specialist/cases')}>View Cases →</button>
    </div>
  </main>
}

/* ---------------------------------------------------------------- Network */

function dedupePhysicians(items: NetworkFeedItem[]) {
  const seen = new Map<string, NetworkFeedItem['physician']>()
  for (const item of items) seen.set(item.physician.id, item.physician)
  return [...seen.values()]
}

/**
 * Iain's "My Network" stays feed-derived rather than the graph/explicit-roster/NPPES-add
 * experience Lucy gets: `/api/workspace/network*` takes no persona parameter and is built
 * entirely around the PCP's own referral history, so there is no backend-supported
 * "Iain's network graph" to wire up here. See Pass 7C report.
 */
function SpecialistMyNetworkTab({ navigate }: { navigate: Navigate }) {
  const [feed, setFeed] = useState<NetworkFeed | null>(null)
  const [error, setError] = useState('')
  useEffect(() => { getNetworkFeed('iain').then(setFeed).catch((err: Error) => setError(err.message)) }, [])
  const physicians = feed ? dedupePhysicians(feed.items) : []
  return <div className="my-network-tab">
    <p className="network-intro">Physicians relevant to your practice — explicitly added to your network, or whose agents have interacted with yours.</p>
    {error && <div className="error-banner" role="alert">{error}</div>}
    {!feed && !error && <p className="muted-note">Loading network…</p>}
    {feed && physicians.length === 0 && <div className="empty-state history-empty"><NetworkMark /><h2>No relevant physicians yet</h2><p>Physicians appear here once your agent participates in a network consultation, or once a professional connection is added.</p></div>}
    {physicians.length > 0 && <div className="lam-list">{physicians.map((physician) => <button className="lam-row" key={physician.id} onClick={() => navigate(networkProfilePath('iain', physician.id))}>
      <span className="lam-row-mark patient-row-avatar">{physician.name.replace('Dr. ', '').split(/\s+/).map((part) => part[0]).slice(0, 2).join('')}</span>
      <span className="lam-row-main"><strong>{physician.name}</strong><span>{physician.specialty}</span><small>{physician.location}</small></span>
      <span className="lam-row-action">View professional profile <b>→</b></span>
    </button>)}</div>}
  </div>
}

/** Feed is the default/primary tab — a colleague directory is secondary. */
export function SpecialistNetworkPage({ navigate, params }: { navigate: Navigate; params?: URLSearchParams }) {
  const tabParam = params?.get('tab') ?? null
  const [tab, setTab] = useState<NetworkTab>(tabParam === 'my-network' ? 'my-network' : 'feed')
  useEffect(() => { setTab(tabParam === 'my-network' ? 'my-network' : 'feed') }, [tabParam])
  const selectTab = (next: NetworkTab) => { setTab(next); window.history.replaceState({}, '', next === 'my-network' ? '/specialist/network?tab=my-network' : '/specialist/network') }
  return <main className="page-shell physician-directory-page">
    <header className="directory-hero"><div><p className="eyebrow">Physician-agent network</p><h1>Network</h1><p>The physicians, practices, and professional updates connected through your Lamina network.</p></div></header>
    <NetworkTabs tab={tab} onSelect={selectTab} />
    {tab === 'my-network' ? <SpecialistMyNetworkTab navigate={navigate} /> : <NetworkFeedTab personaId="iain" navigate={navigate} />}
  </main>
}
