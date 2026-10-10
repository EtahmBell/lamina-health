import { useCallback, useEffect, useRef, useState } from 'react'
import laminaLogo from './assets/lamina-logo-source.png'
import { useAuth } from './AuthProvider.tsx'
import { consultNetwork, getAgentOverview, getConsultationHistory, getConsultationRecord, getMyAgent, getPatient, getPatientActivity, getNetworkFeed, getPracticeRepresentation, getTrainingHistory, resetJordanDemo, updateAgentLearning, type AgentLearning, type AgentOverview, type Consultation, type ConsultationMessage, type ConsultationRecord, type Evaluation, type MyAgent, type NetworkFeed, type Patient, type PatientActivity, type PracticeRepresentation, type TrainProjection } from './api.ts'
import { MyIdentitiesPage, PhysicianIdentitySearchPage, ProviderIdentityPage, SignInPage, signInPath, SignUpPage } from './Claim.tsx'
import { OwnerAgentPage, OwnerHomePage, OwnerProfilePage, OwnerTrainingPage } from './Owner.tsx'
import { LaminaMark } from './LaminaMark.tsx'
import { AgentAvatar } from './AgentAvatar.tsx'
import { activityPath, agentActivity, calibrationPath, consultationPath, eventDomId, learningKeyForPatient } from './agentActivity.ts'
import { clinicalTrends, labDate, labFlowsheet, labUnit } from './clinicalTrends.ts'
import { groupConsultationsByPatient } from './consultationGrouping.ts'
import { accessSuggestions, specialtySuggestion } from './contextSuggestions.ts'
import { groupConsultationMessages } from './consultationPresentation.ts'
import { JORDAN_ID, MARIA_ID, PCP_AGENT_ID, PCP_AGENT_NAME, PCP_NAME, SPECIALIST_AGENT_NAME, SPECIALIST_NAME, SPECIALIST_SPECIALTY, cleanName, patientName } from './demoIdentity.ts'
import { DEMO_PATIENTS, type DemoPatientSummary, type PatientStage } from './demoPatients.ts'
import { AgentOverviewPanel, ChatTab, HomeAgentCard, NetworkFeedTab, NetworkHighlights, NetworkPhysicianProfilePage, NetworkTabs, ProfessionalProfilePage, TrainingPage, TrainTab, networkProfilePath, networkUpdatesPath, settingsPath, trainingPath, type NetworkTab } from './Engagement.tsx'
import { timeAwareGreeting } from './greeting.ts'
import { MyNetworkTab, PhysicianProfilePage } from './PhysicianNetwork.tsx'
import { SpecialistAgentPage, SpecialistCaseDetailPage, SpecialistCasesPage, SpecialistHomePage, SpecialistNetworkPage, SpecialistPatientsPage } from './Specialist.tsx'
import { TrendChart } from './TrendChart.tsx'

type Navigate = (path: string) => void

function Brand() {
  return <div className="brand" aria-label="Lamina"><span className="brand-symbol" aria-hidden="true"><img src={laminaLogo} alt="" /></span><span className="wordmark">LAMINA</span></div>
}

function NetworkMark({ active = false, resolved = false }: { active?: boolean; resolved?: boolean }) {
  return <LaminaMark active={active} resolved={resolved} />
}

/** A warm, personal mark for the persistent bottom-left agent object — not the
 * abstract network glyph used elsewhere, and not animated. Simple enough to read as
 * "you" at 39px without feeling childish or visually dominant. */
function YouAvatar() {
  return <span className="you-avatar" aria-hidden="true">
    <svg viewBox="0 0 32 32" width="20" height="20" fill="none">
      <circle cx="11.5" cy="13.5" r="1.7" fill="currentColor" />
      <circle cx="20.5" cy="13.5" r="1.7" fill="currentColor" />
      <path d="M10.5 19.5c2.2 2.4 8.8 2.4 11 0" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
    </svg>
  </span>
}

function SyntheticStatus() {
  return <div className="synthetic-status"><span />Synthetic demo · no PHI</div>
}

/** Three top-level destinations. My Agent is deliberately not here — it lives as a
 * persistent object at the bottom of the sidebar (see .sidebar-clinician below).
 * Profile/account access moved to the avatar menu in the top-right workspace bar. */
const navItems = [
  { id: 'home', title: 'Dashboard', icon: '⌂', path: '/home' },
  { id: 'patients', title: 'Patients', icon: '✦', path: '/patients' },
  { id: 'network', title: 'Network', icon: '⌁', path: '/network' },
] as const

const SPECIALIST_NAV_ITEMS = [
  { id: 'specialist-home', title: 'Dashboard', icon: '⌂', path: '/specialist/home' },
  { id: 'specialist-patients', title: 'Patients', icon: '✦', path: '/specialist/patients' },
  { id: 'specialist-network', title: 'Network', icon: '⌁', path: '/specialist/network' },
] as const

function ProfileControl({ navigate }: { navigate: Navigate }) {
  return <button className="profile-control" onClick={() => navigate('/profile')} aria-label="Open clinician profile"><span>LS</span><strong>{PCP_NAME}</strong></button>
}

const DEMO_PERSPECTIVES = [
  { id: 'pcp' as const, name: PCP_NAME, role: 'Referring physician', initials: 'LS', path: '/home', profilePath: '/profile' },
  { id: 'specialist' as const, name: SPECIALIST_NAME, role: 'Specialist', initials: 'IJ', path: '/specialist/home', profilePath: '/specialist/profile' },
]

/** The top-right avatar/account control. Combines the demo perspective switch with
 * profile and settings access, now that Profile is no longer a primary-nav item. */
function PerspectiveSwitch({ navigate, perspective }: { navigate: Navigate; perspective: 'pcp' | 'specialist' }) {
  const [open, setOpen] = useState(false)
  const containerRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!open) return
    const onClick = (event: MouseEvent) => { if (containerRef.current && !containerRef.current.contains(event.target as Node)) setOpen(false) }
    const onKey = (event: KeyboardEvent) => { if (event.key === 'Escape') setOpen(false) }
    document.addEventListener('mousedown', onClick)
    document.addEventListener('keydown', onKey)
    return () => { document.removeEventListener('mousedown', onClick); document.removeEventListener('keydown', onKey) }
  }, [open])
  const current = DEMO_PERSPECTIVES.find((item) => item.id === perspective) ?? DEMO_PERSPECTIVES[0]
  const switchTo = (path: string) => { setOpen(false); navigate(path) }
  return <div className="perspective-switch" ref={containerRef}>
    <button className="profile-control avatar-control" onClick={() => setOpen((value) => !value)} aria-haspopup="menu" aria-expanded={open} aria-label="Account menu">
      <span>{current.initials}</span><strong>{current.name}</strong>
    </button>
    {open && <div className="perspective-menu" role="menu" aria-label="Account menu">
      <button role="menuitem" className="perspective-option" onClick={() => { setOpen(false); navigate(current.profilePath) }}>Profile</button>
      <div className="perspective-menu-divider" role="separator" /><button role="menuitem" className="perspective-option" onClick={() => { setOpen(false); navigate(settingsPath) }}>Settings &amp; demo</button>
      <div className="perspective-menu-divider" role="separator" /><p className="perspective-menu-label">Demo perspective</p>
      {DEMO_PERSPECTIVES.map((item) => <button key={item.id} role="menuitemradio" aria-checked={item.id === perspective} className={`perspective-option ${item.id === perspective ? 'active' : ''}`} onClick={() => switchTo(item.path)}>
        <span className="perspective-option-check" aria-hidden="true">{item.id === perspective ? '✓' : ''}</span>
        <span><strong>{item.name}</strong><small>{item.role}</small></span>
      </button>)}
    </div>}
  </div>
}

/** A quiet utility for returning physician-account holders — distinct from
 * Dr. Lucy Saruhashi's demo-workspace identity, and never competing with Enter
 * workspace. Renders nothing while auth is unconfigured or still loading. */
function PortalAccountControl({ navigate }: { navigate: Navigate }) {
  const { configured, loading, user } = useAuth()
  if (!configured || loading) return null
  return user
    ? <button className="text-button portal-account-link" onClick={() => navigate('/claim/my-identities')}>My physician identities</button>
    : <button className="text-button portal-account-link" onClick={() => navigate(signInPath('/claim/my-identities'))}>Sign in</button>
}

/** My Agent is a persistent object pinned to the bottom of the sidebar — not a
 * top-level nav item — so the agent stays visible from every workspace screen. It
 * is a real nav target (keyboard-reachable button) and picks up an active state
 * on any agent-related route. */
function ProductShell({ children, navigate, section, perspective = 'pcp' }: { children: React.ReactNode; navigate: Navigate; section: string; perspective?: 'pcp' | 'specialist' }) {
  const items = perspective === 'specialist' ? SPECIALIST_NAV_ITEMS : navItems
  const onAgent = section === 'agent' || section === 'specialist-agent'
  return <div className="app-shell">
    <aside className="sidebar">
      <div><button className="brand-button" onClick={() => navigate('/')} aria-label="Return to Lamina portal"><Brand /></button><p className="brand-subtitle">Specialty Care Network</p>
        <nav aria-label="Primary navigation">
          {items.map((item) => <button key={item.id} className={`nav-item ${section === item.id ? 'active' : ''}`} onClick={() => navigate(item.path)}><span className="nav-icon">{item.icon}</span><span className="nav-item-label">{item.title}</span></button>)}
        </nav>
      </div>
      {perspective === 'specialist'
        ? <button className={`sidebar-clinician ${onAgent ? 'active' : ''}`} aria-current={onAgent ? 'page' : undefined} onClick={() => navigate('/specialist/agent')} aria-label={`Open ${SPECIALIST_AGENT_NAME} overview`}><YouAvatar /><div><strong>{SPECIALIST_AGENT_NAME}</strong></div></button>
        : <button className={`sidebar-clinician ${onAgent ? 'active' : ''}`} aria-current={onAgent ? 'page' : undefined} onClick={() => navigate('/agent?tab=overview')} aria-label={`Open ${PCP_AGENT_NAME} overview`}><AgentAvatar /><div><strong>{PCP_AGENT_NAME}</strong></div></button>}
    </aside>
    <div className="workspace"><header className="workspace-bar"><div className="workspace-bar-actions"><SyntheticStatus /><PerspectiveSwitch navigate={navigate} perspective={perspective} /></div></header>{children}</div>
  </div>
}

function LandingPage({ navigate }: { navigate: Navigate }) {
  return <main className="landing-page">
    <header className="landing-header"><Brand /><div className="landing-header-actions"><PortalAccountControl navigate={navigate} /><SyntheticStatus /><ProfileControl navigate={navigate} /></div></header>
    <section className="landing-content">
      <p className="eyebrow">Primary care workspace</p>
      <h1>{timeAwareGreeting(PCP_NAME)}</h1>
      <p className="landing-question">Your agent is ready.</p>
      <button className="landing-network-control" onClick={() => navigate('/home')} aria-label="Enter workspace">
        <span className="ambient-ring one" /><span className="ambient-ring two" /><span className="ambient-line line-one" /><span className="ambient-line line-two" />
        <NetworkMark active />
        <span className="landing-agent-label">YOUR AGENT · ACTIVE</span>
        <strong>Enter workspace</strong><small>Current work and recent agent activity</small>
      </button>
      <button className="physician-identity-entry" onClick={() => navigate('/claim')}>
        <span>Are you a physician?</span>
        <strong>Find your Lamina identity <b>→</b></strong>
      </button>
    </section>
    <p className="landing-footnote">Lamina helps primary care teams find the right specialist, required workup, and appropriate access.</p>
  </main>
}

function formatTime(value: string) {
  return new Date(value).toLocaleString('en-US', { month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' })
}

/** Quiet list-row date, e.g. "Sep 25". */
function shortDate(value: string) {
  return new Date(value).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
}

const prefersReducedMotion = () => window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false

/** Compact activity timestamp, e.g. "Sep 25 · 10:58 PM". */
function eventTimestamp(value: string) {
  return new Date(value).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }).replace(', ', ' · ')
}

/** Feed is the default/primary tab — a colleague directory is secondary. */
function LucyNetworkPage({ navigate, params }: { navigate: Navigate; params: URLSearchParams }) {
  const tabParam = params.get('tab')
  const [tab, setTab] = useState<NetworkTab>(tabParam === 'my-network' ? 'my-network' : 'feed')
  useEffect(() => { setTab(tabParam === 'my-network' ? 'my-network' : 'feed') }, [tabParam])
  const selectTab = (next: NetworkTab) => { setTab(next); window.history.replaceState({}, '', next === 'my-network' ? '/network?tab=my-network' : '/network') }
  return <main className="page-shell physician-directory-page">
    <header className="directory-hero"><div><p className="eyebrow">Physician-agent network</p><h1>Network</h1><p>The physicians, practices, and professional updates connected through your Lamina network.</p></div></header>
    <NetworkTabs tab={tab} onSelect={selectTab} />
    {tab === 'my-network' ? <MyNetworkTab navigate={navigate} /> : <NetworkFeedTab personaId="lucy" navigate={navigate} />}
  </main>
}

/** Dashboard-scoped patient row. Deliberately built from `records` (already fetched
 * for currentWork), never `getPatientActivity` — Home stays on canonical consultation
 * state, matching the rest of the page, and never introduces a second data source.
 * Only patients with a real, actionable next step are included here — this is a
 * focused worklist, not a miniature Patients directory (see buildWatchRows' filter). */
type PatientWatchRow = { patient: DemoPatientSummary; status: WorklistStatus; detail: string; nextStep: string; action: string }

function buildWatchRows(records: ConsultationRecord[]): PatientWatchRow[] {
  return DEMO_PATIENTS.filter((patient) => patient.implemented).map((patient): PatientWatchRow => {
    const record = records.find((item) => item.patient_id === patient.id)
    const status: WorklistStatus = record ? 'Ready for your review' : 'Not yet consulted'
    const detail = record ? `${record.result.recommended_physician.specialty} · ${cleanName(record.result.recommended_physician.physician_name)}` : patient.reason
    return {
      patient, status, detail,
      nextStep: status === 'Ready for your review' ? 'Review referral options' : WORKLIST_NEXT_STEP[status],
      action: status === 'Ready for your review' ? 'Review' : 'View patient info',
    }
  }).sort((a, b) => WORKLIST_STATUS_PRIORITY[a.status] - WORKLIST_STATUS_PRIORITY[b.status])
}

function PatientWatchTable({ rows, navigate }: { rows: PatientWatchRow[]; navigate: Navigate }) {
  return <section className="dashboard-watchlist">
    <div className="home-section-heading"><div><h2>Patients with next steps</h2><p className="dashboard-watchlist-sub">Recent activity and the next step in their care.</p></div><button className="text-button" onClick={() => navigate('/patients')}>View all patients →</button></div>
    <div className="lam-list patient-worklist">{rows.map(({ patient, status, detail, nextStep, action }) => <button key={patient.id} className="lam-row worklist-row" onClick={() => navigate(`/patients/${patient.id}`)}>
      <span className="lam-row-mark patient-row-avatar">{patient.initials}</span>
      <span className="lam-row-main"><strong>{patient.name}</strong><small>{patient.age} years · {detail}</small></span>
      <span className={`worklist-status ${WORKLIST_STATUS_TONE[status]}`}>{status}</span>
      <span className="worklist-next-step">{nextStep}</span>
      <span className="lam-row-action">{action} <b>→</b></span>
    </button>)}</div>
  </section>
}

function HomePage({ navigate }: { navigate: Navigate }) {
  const [records, setRecords] = useState<ConsultationRecord[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(false)
  const [feed, setFeed] = useState<NetworkFeed | null>(null)
  const [overview, setOverview] = useState<AgentOverview | null>(null)
  useEffect(() => {
    getConsultationHistory()
      .then(setRecords)
      .catch(() => setError(true)).finally(() => setLoading(false))
    getNetworkFeed('lucy').then(setFeed).catch(() => {})
    getAgentOverview('lucy').then(setOverview).catch(() => {})
  }, [])
  const ordered = [...records].sort((a, b) => b.completed_at.localeCompare(a.completed_at))
  const latestByPatient = ordered.filter((record, index) => ordered.findIndex((item) => item.patient_id === record.patient_id) === index)
  const currentWork = latestByPatient.slice(0, 3)
  const activity = agentActivity(ordered).slice(0, 3)
  const watchRows = buildWatchRows(latestByPatient)
  const greetingName = `Dr. ${PCP_NAME.split(' ').at(-1)}`
  return <ProductShell navigate={navigate} section="home"><main className="page-shell home-page dashboard-page">
    <header className="dashboard-greeting"><p className="eyebrow">Dashboard</p><h1>{timeAwareGreeting(greetingName)}</h1><p className="dashboard-situation">Here's what needs your attention today.</p></header>
    {loading && <div className="home-loading"><div className="loading-line" /><p>Reviewing recent workspace activity…</p></div>}
    {error && <div className="error-banner" role="alert">Recent workspace activity is temporarily unavailable. Patient records remain accessible.</div>}
    {!loading && !error && <>
      <HomeAgentCard overview={overview} navigate={navigate} trainPath={trainingPath('lucy')} viewAgentPath="/agent?tab=overview" matchesReady={currentWork.length} records={records} personaId="lucy" />
      <PatientWatchTable rows={watchRows} navigate={navigate} />
      <div className="dashboard-bottom-row">
        <section className="home-activity"><div className="home-section-heading"><div><h2>Recent activity</h2></div><button className="text-button" onClick={() => navigate('/agent?tab=overview')}>View your agent →</button></div>{activity.length ? <div className="activity-stream">{activity.map((item) => <button key={item.id} className={`activity-row ${item.kind}`} onClick={() => navigate(activityPath(item))}><span className={`activity-marker ${item.kind}`} /><span>{item.kind === 'interaction' && <em className="activity-kind agent-event-label">Agent</em>}<strong>{item.title}</strong><small>{item.detail}</small><i>{eventTimestamp(item.time)} · {item.patientLabel}</i></span><b>{item.kind === 'interaction' ? 'View interaction' : 'View consultation'} →</b></button>)}</div> : <p className="home-empty">No agent activity yet.</p>}</section>
        <NetworkHighlights feed={feed} navigate={navigate} perspective="lucy" />
      </div>
    </>}
  </main></ProductShell>
}

/** A small controlled status vocabulary for the two patients with a wired
 * consult-engine case, derived only from real data (has_consultation / implemented)
 * — never invented. Every other patient gets a stage label from PATIENT_STAGE_META
 * below, which is honest cosmetic detail, not a claimed agent interaction. */
type WorklistStatus = 'Ready for your review' | 'Not yet consulted'
const WORKLIST_STATUS_PRIORITY: Record<WorklistStatus, number> = { 'Ready for your review': 0, 'Not yet consulted': 1 }
const WORKLIST_NEXT_STEP: Record<WorklistStatus, string> = { 'Ready for your review': 'Review options', 'Not yet consulted': 'Consult network' }
const WORKLIST_STATUS_TONE: Record<WorklistStatus, string> = { 'Ready for your review': 'copper', 'Not yet consulted': 'slate' }

/** Cosmetic worklist stage for the patients who have no wired consult-engine case
 * (everyone but Jordan and Maria — see demoPatients.ts). These never claim a real
 * agent interaction happened; they exist only so the worklist reads like an
 * established practice with cases at every stage, not a two-patient demo. */
const PATIENT_STAGE_META: Record<PatientStage, { label: string; tone: string; nextStep: string; priority: number }> = {
  new: { label: 'Newly received', tone: 'slate', nextStep: 'Review intake', priority: 3 },
  in_review: { label: "Agent reviewing", tone: 'slate', nextStep: 'View demo', priority: 4 },
  workup: { label: 'Awaiting workup', tone: 'slate', nextStep: 'View demo', priority: 5 },
  referred: { label: 'Referred · pending', tone: 'quiet', nextStep: 'View demo', priority: 6 },
  followup: { label: 'Follow-up scheduled', tone: 'quiet', nextStep: 'View demo', priority: 7 },
  closed: { label: 'Case closed', tone: 'quiet', nextStep: 'View demo', priority: 8 },
}

/** Rows priority-ranked below this line are grouped under "Previous care" (the
 * referral loop is complete or inactive) rather than "Active patients" (still
 * moving through care) — a care-state split, not a recency split. */
const PREVIOUS_CARE_PRIORITY = PATIENT_STAGE_META.followup.priority

function PatientSelector({ navigate }: { navigate: Navigate }) {
  const [query, setQuery] = useState('')
  const [activity, setActivity] = useState<PatientActivity[]>([])
  const [activityError, setActivityError] = useState(false)
  useEffect(() => { getPatientActivity().then(setActivity).catch(() => setActivityError(true)) }, [])
  const activityFor = (id: string) => activity.find((item) => item.patient_id === id)
  const visible = DEMO_PATIENTS.filter((patient) => `${patient.name} ${patient.reason} ${patient.location}`.toLowerCase().includes(query.toLowerCase()))
  const rows = visible.map((patient) => {
    const record = activityFor(patient.id)
    const implementedStatus: WorklistStatus | null = record?.has_consultation ? 'Ready for your review' : patient.implemented ? 'Not yet consulted' : null
    const updated = record?.has_consultation && record.latest_consulted_at ? shortDate(record.latest_consulted_at) : record?.last_opened ? shortDate(record.last_opened) : null
    if (implementedStatus) {
      return { patient, label: implementedStatus, tone: WORKLIST_STATUS_TONE[implementedStatus], nextStep: WORKLIST_NEXT_STEP[implementedStatus], priority: WORKLIST_STATUS_PRIORITY[implementedStatus], updated }
    }
    const meta = PATIENT_STAGE_META[patient.stage]
    return { patient, label: meta.label, tone: meta.tone, nextStep: meta.nextStep, priority: meta.priority, updated }
  }).sort((a, b) => a.priority - b.priority)
  const active = rows.filter((row) => row.priority < PREVIOUS_CARE_PRIORITY)
  const previous = rows.filter((row) => row.priority >= PREVIOUS_CARE_PRIORITY)
  return <ProductShell navigate={navigate} section="patients"><main className="page-shell selector-page worklist-page">
    <header className="selector-header"><div><h1>Patients</h1><p>Your active referral worklist.</p></div><span>{DEMO_PATIENTS.length} synthetic patients</span></header>
    <label className="patient-search"><svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="11" cy="11" r="6" /><path d="m16 16 4 4" /></svg><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search patients or clinical problem…" aria-label="Search patients" /></label>
    {activityError && <p className="muted-note">Lamina activity is temporarily unavailable; patient clinical records remain accessible.</p>}
    {active.length > 0 && <section className="patient-worklist-section">
      <div className="home-section-heading"><h2>Active patients</h2><span>{active.length}</span></div>
      <WorklistRows rows={active} navigate={navigate} />
    </section>}
    {previous.length > 0 && <section className="patient-worklist-section">
      <div className="home-section-heading"><h2>Previous care</h2><span>{previous.length}</span></div>
      <WorklistRows rows={previous} navigate={navigate} />
    </section>}
    {!visible.length && <div className="empty-state"><NetworkMark /><h2>No patients found</h2><p>Try a different name or clinical problem.</p></div>}
  </main></ProductShell>
}

type WorklistRowData = { patient: DemoPatientSummary; label: string; tone: string; nextStep: string; priority: number; updated: string | null }

/** "Active patients" (still moving through care) vs "Previous care" (loop complete or
 * inactive) — grouped by care state, never by recency. See PREVIOUS_CARE_PRIORITY. */
function WorklistRows({ rows, navigate }: { rows: WorklistRowData[]; navigate: Navigate }) {
  return <div className="lam-list patient-worklist">{rows.map(({ patient, label, tone, nextStep, updated }) => <button key={patient.id} className="lam-row worklist-row" onClick={() => navigate(`/patients/${patient.id}`)}>
    <span className="lam-row-mark patient-row-avatar">{patient.initials}</span>
    <span className="lam-row-main"><strong>{patient.name}</strong><small>{patient.age} years · {patient.reason}</small></span>
    <span className={`worklist-status ${tone}`}>{label}</span>
    <span className="worklist-next-step">{nextStep}</span>
    <span className="worklist-updated">{updated ? `Updated ${updated}` : ''}</span>
  </button>)}</div>
}

function ConsultationsPage({ navigate }: { navigate: Navigate }) {
  const [records, setRecords] = useState<ConsultationRecord[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  useEffect(() => { getConsultationHistory().then(setRecords).catch((err: Error) => setError(err.message)).finally(() => setLoading(false)) }, [])
  const groups = groupConsultationsByPatient(records)
  return <ProductShell navigate={navigate} section="patients"><main className="page-shell history-page"><p className="eyebrow">Patient consult records</p><h1>Consultations</h1><p className="page-intro">Completed specialty-care consultations from this Lamina workspace, grouped by patient.</p><p className="page-fineprint">No referral has been submitted.</p>
    {loading && <p className="muted-note">Loading consultations…</p>}{error && <div className="error-banner" role="alert">{error}</div>}
    {!loading && !error && !groups.length && <div className="empty-state history-empty"><NetworkMark /><h2>No network consultations yet</h2><p>Completed physician-network consultations will appear here.</p><button className="button-primary" onClick={() => navigate('/patients')}>Select a patient →</button></div>}
    {groups.length > 0 && <div className="lam-list">{groups.map((group) => <button className="lam-row" key={group.patientId} onClick={() => navigate(`/consultations/patient/${group.patientId}`)}><span className="lam-row-mark patient-row-avatar">{group.initials}</span><span className="lam-row-main"><strong>{group.patientLabel}</strong><span>{group.count} consultation{group.count === 1 ? '' : 's'}</span><small>Latest: {formatTime(group.latest.completed_at)}</small><small>Latest outcome: {group.latestPhysician} · {group.latestSpecialty}</small></span><span className="lam-row-action">View consultation history <b>→</b></span></button>)}</div>}
  </main></ProductShell>
}

function PatientConsultationsPage({ patientId, navigate }: { patientId: string; navigate: Navigate }) {
  const [records, setRecords] = useState<ConsultationRecord[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  useEffect(() => { getConsultationHistory().then(setRecords).catch((err: Error) => setError(err.message)).finally(() => setLoading(false)) }, [])
  const group = groupConsultationsByPatient(records).find((item) => item.patientId === patientId)
  return <ProductShell navigate={navigate} section="patients"><main className="page-shell history-page">
    <nav className="page-breadcrumb" aria-label="Breadcrumb"><button className="text-button" onClick={() => navigate('/consultations')}>Consultations</button><span aria-hidden="true">→</span><b>{patientName(patientId)}</b></nav>
    <h1>{patientName(patientId)}</h1>
    {loading && <p className="muted-note">Loading consultation history…</p>}{error && <div className="error-banner" role="alert">{error}</div>}
    {!loading && !error && !group && <div className="empty-state history-empty"><NetworkMark /><h2>No consultations yet</h2><p>Completed consultations for {patientName(patientId)} will appear here.</p><button className="button-primary" onClick={() => navigate(`/patients/${patientId}`)}>Open patient →</button></div>}
    {group && <><p className="page-intro">{group.count} consultation{group.count === 1 ? '' : 's'} · most recent first.</p>
      <div className="lam-list">{group.records.map((record) => <button className="lam-row" key={record.id} onClick={() => navigate(consultationPath(record.id))}><span className="lam-row-mark patient-row-avatar">{group.initials}</span><span className="lam-row-main"><strong>{formatTime(record.completed_at)}</strong><span>{cleanName(record.result.recommended_physician.physician_name)} · {record.result.recommended_physician.specialty}</span><small>Workup identified</small></span><span className="lam-row-action">View consultation <b>→</b></span></button>)}</div></>}
  </main></ProductShell>
}

function ConsultationRecordPage({ id, focusEventId, navigate }: { id: number; focusEventId: string | null; navigate: Navigate }) {
  const [record, setRecord] = useState<ConsultationRecord | null>(null)
  const [error, setError] = useState('')
  useEffect(() => { getConsultationRecord(id).then(setRecord).catch((err: Error) => setError(err.message)) }, [id])
  return <ProductShell navigate={navigate} section="patients"><main className="page-shell history-detail">{record ? <nav className="page-breadcrumb" aria-label="Breadcrumb"><button className="text-button" onClick={() => navigate('/consultations')}>Consultations</button><span aria-hidden="true">→</span><button className="text-button" onClick={() => navigate(`/consultations/patient/${record.patient_id}`)}>{patientName(record.patient_id)}</button></nav> : <button className="text-button back-link" onClick={() => navigate('/consultations')}>← Consultations</button>}{error && <div className="error-banner" role="alert">{error}</div>}{!record && !error && <p className="muted-note">Loading consultation record…</p>}{record && <><p className="eyebrow">Completed consultation · {formatTime(record.completed_at)}</p><h1>{patientName(record.patient_id)}</h1><p className="page-intro">A saved structured consultation. Clinical context remains in the patient workspace.</p><button className="text-button record-open-patient" onClick={() => navigate(`/patients/${record.patient_id}`)}>Open patient →</button><RecommendationView consultation={record.result} navigate={navigate} focusEventId={focusEventId} recordId={record.id} /></>}</main></ProductShell>
}

/** Overview absorbed the old separate Practice tab (post-8B consolidation) — the
 * physician's confirmed representation now lives in one place, not split across two
 * tabs. Activity moved to the Dashboard's "Recent activity" section. */
const AGENT_TABS = ['overview', 'train', 'test'] as const
type AgentTab = typeof AGENT_TABS[number]
const LEGACY_AGENT_TAB_ALIASES: Record<string, AgentTab> = { knowledge: 'overview', calibration: 'overview', practice: 'overview', chat: 'test', activity: 'overview' }
const resolveAgentTab = (value: string | null): AgentTab => {
  if (value && (AGENT_TABS as readonly string[]).includes(value)) return value as AgentTab
  if (value && value in LEGACY_AGENT_TAB_ALIASES) return LEGACY_AGENT_TAB_ALIASES[value]
  return 'overview'
}

function MyAgentPage({ navigate, params }: { navigate: Navigate; params: URLSearchParams }) {
  const tabParam = params.get('tab')
  const learningParam = params.get('learning')
  const caseParam = params.get('case')
  const recordParam = params.get('record')
  const [agent, setAgent] = useState<MyAgent | null>(null)
  const [tab, setTab] = useState<AgentTab>(() => resolveAgentTab(tabParam))
  const [selected, setSelected] = useState(learningParam || 'renal')
  const [focusedLearning, setFocusedLearning] = useState<string | null>(learningParam)
  const [editing, setEditing] = useState<string | null>(null)
  const [draft, setDraft] = useState('')
  const [error, setError] = useState('')
  const [representation, setRepresentation] = useState<PracticeRepresentation | null>(null)
  const [overview, setOverview] = useState<AgentOverview | null>(null)
  const [trainProjection, setTrainProjection] = useState<TrainProjection | null>(null)
  const [consultationRecords, setConsultationRecords] = useState<ConsultationRecord[]>([])
  const refresh = () => getMyAgent().then(setAgent).catch((err: Error) => setError(err.message))
  const refreshRepresentation = () => getPracticeRepresentation('lucy').then(setRepresentation).catch(() => {})
  const refreshOverview = () => getAgentOverview('lucy').then(setOverview).catch(() => {})
  const refreshTraining = () => getTrainingHistory('lucy').then(setTrainProjection).catch(() => {})
  const refreshConsultationRecords = () => getConsultationHistory().then(setConsultationRecords).catch(() => {})
  useEffect(() => {
    refresh(); refreshRepresentation(); refreshOverview(); refreshTraining(); refreshConsultationRecords()
  }, []) // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { setTab(resolveAgentTab(tabParam)) }, [tabParam])
  useEffect(() => { setFocusedLearning(learningParam); if (learningParam) setSelected(learningParam) }, [learningParam])
  useEffect(() => { if (editing) document.getElementById(`edit-${editing}`)?.scrollIntoView({ behavior: 'smooth', block: 'center' }) }, [editing])
  useEffect(() => {
    if (!focusedLearning || !agent || tab !== 'overview') return
    const frame = window.requestAnimationFrame(() => document.getElementById(`learning-${focusedLearning}`)?.scrollIntoView({ behavior: 'smooth', block: 'center' }))
    return () => window.cancelAnimationFrame(frame)
  }, [focusedLearning, agent, tab])
  const act = async (learning: AgentLearning, action: 'confirm' | 'edit' | 'reject', statement?: string) => {
    try { await updateAgentLearning(learning.key, action, statement); setEditing(null); setError(''); await refresh() } catch (err) { setError(err instanceof Error ? err.message : 'Could not save preference') }
  }
  const pending = agent?.learnings.filter((item) => item.status === 'suggested').length ?? 0
  const selectTab = (next: AgentTab) => { setTab(next); setFocusedLearning(null); window.history.replaceState({}, '', `/agent?tab=${next}`) }
  return <ProductShell navigate={navigate} section="agent"><main className="page-shell agent-page">
    {error && <div className="error-banner" role="alert">{error}</div>}{!agent && !error && <p className="muted-note">Opening your agent…</p>}
    {agent && <><section className="agent-hero"><div className="agent-hero-mark"><AgentAvatar /></div><div><p className="eyebrow">Your physician agent</p><h1>{PCP_AGENT_NAME}</h1><p>Primary Care · Represents how you practise across the Lamina network.</p><span className="agent-state"><i /> ACTIVE</span></div></section>
      <nav className="agent-tabs" aria-label="My Agent sections">{AGENT_TABS.map((item) => <button key={item} className={tab === item ? 'active' : ''} aria-current={tab === item ? 'page' : undefined} onClick={() => selectTab(item)}>{item[0].toUpperCase() + item.slice(1)}</button>)}</nav>
      {tab === 'overview' && <AgentOverviewPanel overview={overview} representation={representation} navigate={navigate} trainPath={trainingPath('lucy')} personaId="lucy" consultationRecords={consultationRecords} extra={
        tabParam === 'calibration' && pending > 0 && <section className="agent-panel learning-panel practice-legacy-review"><div className="panel-header"><div><p className="eyebrow">Needs your review</p><h2>Case-raised preferences</h2><p className="panel-intro">Suggestions raised from a completed consultation are not silently treated as your preferences. A proposal stays proposed until you confirm or edit it.</p></div></div>
          <div className="learning-grid">{(agent?.learnings ?? []).filter((learning) => learning.status === 'suggested').map((learning) => <article className={`learning-card ${focusedLearning === learning.key ? 'focused' : ''}`} id={`learning-${learning.key}`} key={learning.key}><span className={`learning-status ${learning.status}`}>Proposed · needs confirmation</span><p>{learning.statement}</p><small>Source: {learning.provenance}</small>{focusedLearning === learning.key && caseParam && <p className="learning-case-source">Raised from the {patientName(caseParam)} consultation.{recordParam && <button className="text-button" onClick={() => navigate(consultationPath(Number(recordParam)))}>View consultation →</button>}</p>}{editing === learning.key ? <div className="learning-edit"><label htmlFor={`edit-${learning.key}`}>Correct this preference</label><textarea id={`edit-${learning.key}`} maxLength={240} value={draft} onChange={(event) => setDraft(event.target.value)} /><div><button className="button-primary" disabled={!draft.trim()} onClick={() => act(learning, 'edit', draft)}>Save draft</button><button className="text-button" onClick={() => setEditing(null)}>Cancel</button></div></div> : <div className="learning-actions"><button onClick={() => act(learning, 'confirm')}>Confirm</button><button onClick={() => { setEditing(learning.key); setDraft(learning.statement) }}>Edit</button><button onClick={() => act(learning, 'reject')}>Reject</button></div>}</article>)}</div>
        </section>
      } />}
      {tab === 'train' && <TrainTab trainProjection={trainProjection} navigate={navigate} trainPath={trainingPath('lucy')} />}
      {tab === 'test' && <ChatTab personaId="lucy" agentName={PCP_AGENT_NAME} navigate={navigate} trainPath={trainingPath('lucy')} />}
    </>}
  </main></ProductShell>
}

/** Demo-only control. Clears Jordan's Lamina workflow history, never clinical data. */
function DemoResetControl() {
  const [stage, setStage] = useState<'idle' | 'confirming' | 'working' | 'done'>('idle')
  const [removed, setRemoved] = useState(0)
  const [error, setError] = useState('')
  const reset = async () => {
    setStage('working'); setError('')
    try {
      const result = await resetJordanDemo()
      setRemoved(result.removed_consultations)
      setStage('done')
    } catch (resetError) {
      setError(resetError instanceof Error ? resetError.message : 'Could not reset the demo case')
      setStage('confirming')
    }
  }
  return <div className="demo-reset-block">
    <div className="demo-reset">
      <div><strong>Jordan Lee demo case</strong><p>Reset Jordan to pre-consult state.</p></div>
      {stage !== 'confirming' && <button className="button-secondary" onClick={() => { setStage('confirming'); setError('') }}>Reset Jordan case</button>}
    </div>
    {stage === 'confirming' && <div className="demo-reset-confirm" role="group" aria-label="Confirm demo reset">
      <strong>Reset Jordan demo case?</strong>
      <p>This removes Jordan's Lamina consultation history and returns the case to its pre-consult demo state. Synthetic patient data is unchanged.</p>
      {error && <p className="demo-reset-error" role="alert">{error}</p>}
      <div><button className="text-button" onClick={() => setStage('idle')}>Cancel</button><button className="button-primary" onClick={reset}>Reset case</button></div>
    </div>}
    {stage === 'working' && <p className="muted-note">Resetting…</p>}
    {stage === 'done' && <p className="demo-reset-result" role="status"><b>✓</b>Jordan demo case reset.{removed > 0 ? ` ${removed} consultation${removed === 1 ? '' : 's'} removed.` : ''}</p>}
  </div>
}

/** Account/privacy/demo surface — deliberately separate from the Professional
 * Profile, which is now the primary-nav "Profile" destination. */
function SettingsPage({ navigate }: { navigate: Navigate }) {
  const { user } = useAuth()
  const [agent, setAgent] = useState<MyAgent | null>(null)
  const [error, setError] = useState('')
  useEffect(() => { getMyAgent().then(setAgent).catch((err: Error) => setError(err.message)) }, [])
  const access = (label: string) => agent?.access.find((item) => item.label === label)?.detail
  const sections = agent ? [
    { title: 'Practice', rows: [
      { label: 'Specialty', value: agent.specialty },
      { label: 'Location', value: agent.location },
      { label: 'Role in this workspace', value: 'Referring clinician' },
    ] },
    { title: 'Account', rows: [
      { label: 'Display name', value: agent.physician },
      { label: 'Physician agent', value: PCP_AGENT_NAME },
      { label: 'Agent identifier', value: agent.id },
      { label: 'Authentication', value: 'Not part of this demo' },
    ] },
    { title: 'Data & privacy', rows: [
      { label: 'Data', value: agent.synthetic ? 'Synthetic demo data · no PHI' : '' },
      { label: 'Patient context', value: access('Patient clinical context') },
      { label: 'Physician identity', value: access('Public physician identity') },
      { label: 'Scheduling', value: access('Scheduling') },
    ] },
  ] : []
  return <ProductShell navigate={navigate} section="settings"><main className="page-shell profile-page">
    {error && <div className="error-banner" role="alert">{error}</div>}
    {!agent && !error && <p className="muted-note">Opening settings…</p>}
    {agent && <>
      <header className="profile-hero">
        <span className="clinician-avatar large">LS</span>
        <div><p className="eyebrow">Settings &amp; demo</p><h1>{agent.physician}</h1><p className="profile-role">{agent.specialty} · {agent.location}</p></div>
      </header>
      {sections.map((section) => <section className="profile-section" key={section.title}>
        <h2>{section.title}</h2>
        <dl>{section.rows.filter((row) => row.value).map((row) => <div key={row.label}><dt>{row.label}</dt><dd>{row.value}</dd></div>)}</dl>
      </section>)}
      <section className="profile-section">
        <h2>Demo environment</h2>
        <dl><div><dt>Environment</dt><dd>Synthetic data · no PHI</dd></div></dl>
        <DemoResetControl />
      </section>
      {user && <p className="muted-note profile-identity-link">This workspace's Dr. Lucy Saruhashi is a separate concept from your signed-in physician account. <button className="text-button" onClick={() => navigate('/claim/my-identities')}>My physician identities →</button></p>}
      <p className="muted-note">Read-only for this demonstration. Account settings, credentialing, and production practice verification are not implemented.</p>
    </>}
  </main></ProductShell>
}

function UnfinishedPatient({ patient, navigate }: { patient: DemoPatientSummary; navigate: Navigate }) {
  return <ProductShell navigate={navigate} section="patients"><main className="page-shell unfinished-page"><button className="text-button back-link" onClick={() => navigate('/patients')}>← All patients</button><div className="unfinished-card"><p className="eyebrow">Synthetic patient</p><h1>{patient.name}</h1><p className="unfinished-meta">{patient.age} years · {patient.location}</p><div className="unfinished-reason"><span>Reason for consult</span><strong>{patient.reason}</strong></div><p className="unfinished-stage-note">{patient.stageNote}</p><NetworkMark /><h2>This demo does not simulate a live agent consultation for {patient.name}.</h2><p>Choose Jordan Lee or Maria Santos for a grounded physician-agent consultation. No recommendation has been fabricated for this patient.</p><button className="button-secondary" onClick={() => navigate(`/patients/${JORDAN_ID}`)}>Open Jordan Lee demo</button></div></main></ProductShell>
}

const physicianInitials = (name: string) => name.replace('Dr. ', '').replace(' (synthetic)', '').split(/\s+/).map((part) => part[0]).slice(0, 2).join('')
const evidenceFor = (evaluation: Evaluation, kind: string) => evaluation.evidence.find((item) => item.kind === kind)?.detail
const insuranceLabel = (status: string) => status.startsWith('In network') ? 'In-network' : 'Network unknown'
const messageSender = (message: ConsultationMessage) => message.sender_agent_id === PCP_AGENT_ID ? `${PCP_NAME} Agent` : message.sender_name

const messageLabel = (message: ConsultationMessage) => {
  if (message.message_type === 'fit_response') return `${String(message.metadata.clinical_fit || 'fit')} fit`
  return message.message_type.replaceAll('_', ' ')
}

function ConsultationLog({ messages, focusEventId, highlight }: { messages: ConsultationMessage[]; focusEventId?: string | null; highlight?: boolean }) {
  const stages = groupConsultationMessages(messages)
  return <div className="consult-record-stages"><header><strong>Structured consultation record</strong><small>{messages.length} backend events · original sequence preserved</small></header>{stages.map((stage) => <section className={`consult-record-stage ${stage.kind}`} key={stage.id}><div className="consult-record-stage-heading"><span>{stage.title}</span><small>{stage.messages.length} event{stage.messages.length === 1 ? '' : 's'}</small></div><div className="consult-record-events">{stage.messages.map((message) => <details className={`consult-record-event ${message.id === focusEventId ? 'targeted' : ''} ${message.id === focusEventId && highlight ? 'event-focus' : ''}`} id={eventDomId(message.id)} open={message.id === focusEventId} key={message.id}><summary><span>{message.sequence.toString().padStart(2, '0')}</span><div><strong>{messageSender(message)}</strong><small>{message.summary}</small></div><em>{messageLabel(message)}</em></summary><div className="consult-record-evidence"><p>{message.sender_role} → {message.recipient_agent_id === PCP_AGENT_ID ? PCP_AGENT_NAME : message.recipient_agent_id === 'network' ? 'Physician network' : 'Specialist agent'}</p>{message.related_patient_facts.map((fact) => <p key={fact}><b>Patient fact</b>{fact}</p>)}{message.evidence.map((item, index) => <p key={`${index}-${item.kind}`}><b>{item.kind.replaceAll('_', ' ')}</b>{item.detail}</p>)}{!message.evidence.length && !message.related_patient_facts.length && <p>No additional structured evidence on this event.</p>}</div></details>)}</div></section>)}</div>
}

function RecommendationView({ consultation, navigate, focusEventId = null, recordId }: { consultation: Consultation; navigate: Navigate; focusEventId?: string | null; recordId?: number }) {
  const [networkOpen, setNetworkOpen] = useState(Boolean(focusEventId))
  const [highlight, setHighlight] = useState(Boolean(focusEventId))
  const [detailsOpen, setDetailsOpen] = useState(false)
  const [alternativesOpen, setAlternativesOpen] = useState(false)
  const [referralStarted, setReferralStarted] = useState(false)
  const [affirmed, setAffirmed] = useState(false)
  const [selectedId, setSelectedId] = useState(consultation.recommended_physician.physician_id)
  const [swapping, setSwapping] = useState(false)
  useEffect(() => {
    if (!focusEventId) return
    setNetworkOpen(true); setHighlight(true)
    const timer = window.setTimeout(() => setHighlight(false), 4000)
    return () => window.clearTimeout(timer)
  }, [focusEventId])
  useEffect(() => {
    if (!focusEventId || !networkOpen) return
    const frame = window.requestAnimationFrame(() => document.getElementById(eventDomId(focusEventId))?.scrollIntoView({ behavior: 'smooth', block: 'center' }))
    return () => window.cancelAnimationFrame(frame)
  }, [focusEventId, networkOpen])
  const primary = consultation.recommended_physician
  const historical = evidenceFor(primary, 'historical_practice_similarity')
  const operational = evidenceFor(primary, 'operational')
  // Agent recommendation vs. physician selection are deliberately never
  // conflated: `selected` drives every visible field, but `primary` (the
  // agent's own top pick) is always known separately -- see isAgentPick.
  const candidates = [primary, ...consultation.alternatives]
  const selected = candidates.find((item) => item.physician_id === selectedId) ?? primary
  const isAgentPick = selected.physician_id === primary.physician_id
  const explicitRule = evidenceFor(selected, 'explicit_physician_rule')
  const supportingFacts = selected.evidence.filter((item) => item.kind === 'patient_fact').map((item) => item.detail).slice(0, 2)
  const reasons = [explicitRule, ...supportingFacts].filter(Boolean) as string[]
  const shortName = cleanName(selected.physician_name).split(' ').at(-1)
  const selectedClarificationIndex = consultation.messages.findIndex((message) => message.message_type === 'follow_up_question' && message.sender_name.includes(shortName || ''))
  const selectedClarificationAnswer = selectedClarificationIndex >= 0 ? consultation.messages.slice(selectedClarificationIndex + 1).find((message) => message.message_type === 'follow_up_answer') : undefined
  /**
   * ~150ms fade-out, swap the underlying candidate, ~200ms fade-in -- no
   * navigation, no page jump. Selection is presentation state for this
   * session only (see PatientWorkspace/runConsult's docs): there is no
   * backend concept of a "selected candidate" to persist it against.
   */
  const selectCandidate = (physicianId: string) => {
    if (physicianId === selectedId || swapping) return
    if (prefersReducedMotion()) { setSelectedId(physicianId); setReferralStarted(false); return }
    setSwapping(true)
    window.setTimeout(() => {
      setSelectedId(physicianId); setReferralStarted(false)
      requestAnimationFrame(() => requestAnimationFrame(() => setSwapping(false)))
    }, 150)
  }
  return <section className="recommendations" aria-label="Specialist recommendations" tabIndex={-1}>
    {/* Compact by default (see design_references/) -- only name, specialty, one fit
     * indicator, one metadata line, one rationale sentence, and the primary action.
     * Everything denser lives behind "Review match details" below. */}
    <article className={`best-fit-card compact ${swapping ? 'swapping' : ''}`}>
      <p className="best-fit-kicker">{isAgentPick ? 'Recommended physician' : 'Selected specialist'}</p>
      <div className="best-fit-physician"><span className="physician-avatar">{physicianInitials(selected.physician_name)}</span><div><h2>{cleanName(selected.physician_name)}</h2><p>{selected.specialty}</p></div></div>
      {!isAgentPick && <p className="selection-provenance">Selected by you</p>}
      <p className="fit-indicator">{selected.clinical_fit === 'strong' ? 'Strong clinical fit' : selected.clinical_fit === 'moderate' ? 'Moderate clinical fit' : 'Limited clinical fit'}</p>
      <p className="fit-meta">{insuranceLabel(selected.insurance_status)} · {selected.availability}</p>
      <p className="fit-rationale">{selected.reason}</p>
      <div className="best-fit-actions"><button className="button-primary" onClick={() => setReferralStarted(true)}>Start referral <span>→</span></button>{referralStarted && <div className="referral-prepared" role="status"><strong>Referral prepared for demo</strong><span>Destination: {cleanName(selected.physician_name)} · {selected.specialty}</span><span>Workup: {selected.required_workup.join(' · ') || 'None specified'}</span><span>No referral was transmitted.</span></div>}</div>
    </article>

    <div className="recommendation-feedback"><span>Does this reflect how you would practice?</span>{affirmed ? <em role="status">Noted. Nothing was changed on your agent.</em> : <><button className="text-button" onClick={() => setAffirmed(true)}>Yes</button><button className="text-button" onClick={() => navigate(calibrationPath(learningKeyForPatient(consultation.patient_id), consultation.patient_id, recordId))}>Not quite <b>→</b></button></>}</div>

    {/* One open surface -- whitespace and hairline rules separate groups,
     * never a bordered/shaded box nested inside the already-boxed card. */}
    <section className="options-section"><button className="options-toggle" aria-expanded={detailsOpen} onClick={() => setDetailsOpen(!detailsOpen)}>Review match details <span>{detailsOpen ? '−' : '+'}</span></button>
      {detailsOpen && <div className="match-details">
        {reasons.length > 0 && <div className="match-details-group"><p className="section-label">Why this match</p><ul className="reason-list">{reasons.map((reason) => <li key={reason}><span>✓</span>{reason}</li>)}</ul>{selectedClarificationAnswer && <p className="clarification-note">Clarified before referral: {selectedClarificationAnswer.summary}</p>}</div>}
        <div className="match-details-group"><p className="section-label">Before referral</p><p className="before-visit-plain">{selected.required_workup.length > 0 ? selected.required_workup.map((item) => item.includes('(') ? item.match(/\(([^)]+)\)/)?.[1] : item).join('   ') : 'None specified'}</p></div>
        <div className="match-details-group"><p className="section-label">Access &amp; coverage</p><p className="access-coverage-line">{insuranceLabel(selected.insurance_status)} · {selected.availability}</p></div>
      </div>}
    </section>

    <section className="options-section"><button className="options-toggle" aria-expanded={alternativesOpen} onClick={() => setAlternativesOpen(!alternativesOpen)}>Other referral options <span>{alternativesOpen ? '−' : '+'}</span></button>
      {alternativesOpen && <div className="alternatives-list">{candidates.filter((item) => item.physician_id !== selectedId).map((option) => <div className="alternative-row" key={option.physician_id}>
        <div><strong>{cleanName(option.physician_name)}</strong><span>{option.specialty}</span>{option.physician_id === primary.physician_id && <span className="agent-pick-tag">Agent's top recommendation</span>}</div>
        <p>{option.reason}{option.availability ? ` · ${option.availability.replace('Approximately ', '~')}` : ''}</p>
        <button type="button" className="text-button" onClick={() => selectCandidate(option.physician_id)}>Select this specialist <span>→</span></button>
      </div>)}</div>}
    </section>

    <section className="network-transparency"><button className="network-transparency-toggle" onClick={() => setNetworkOpen(!networkOpen)} aria-expanded={networkOpen}><span><b>How your agent handled this</b></span><em>{networkOpen ? 'Hide' : 'View'} <i>⌄</i></em></button>
      {networkOpen && <div className="network-record">
        <p className="agent-consult-count">{consultation.consultation.length} physician agent{consultation.consultation.length === 1 ? '' : 's'} consulted</p>
        <div className="agent-handling"><div><span>Patient facts</span><ul>{consultation.patient_facts_used.map((fact) => <li key={fact}>{fact}</li>)}</ul></div>{explicitRule && <div><span>Physician rule</span><p>{explicitRule}</p></div>}<div><span>Specialist-agent responses</span><ul>{consultation.consultation.map((agent) => <li key={agent.physician_id}><b>{cleanName(agent.physician_name)}:</b> {agent.reason}</li>)}</ul></div>{historical && <div><span>Practice footprint · fit signal, not quality</span><p>{historical}</p></div>}{operational && <div><span>Access consideration</span><p>{operational}</p></div>}</div>
        <div className="record-note">Deliberate structured messages and evidence only. Hidden model chain-of-thought is not stored or shown.</div><ConsultationLog messages={consultation.messages} focusEventId={focusEventId} highlight={highlight} /><div className="evaluation-record-heading">Physician evaluation records</div>{consultation.consultation.map((agent) => { const rule = evidenceFor(agent, 'explicit_physician_rule'); const history = evidenceFor(agent, 'historical_practice_similarity'); return <details key={agent.physician_id} open={agent.physician_id === primary.physician_id}><summary><span className="mini-avatar">{physicianInitials(agent.physician_name)}</span><span className="agent-name"><b>{cleanName(agent.physician_name)}</b><small>{agent.specialty}</small></span><span className={`decision-badge ${agent.clinical_fit}`}>{agent.accepts_case ? agent.clinical_fit === 'strong' ? 'Strong fit' : 'Accepts' : 'Redirect'}</span><span className="chevron">⌄</span></summary><div className="structured-evidence"><p>{agent.reason}</p><div className="evidence-grid"><div><span>Decision</span><strong>{agent.accepts_case ? 'Accepts case' : 'Redirects / does not accept'}</strong></div><div><span>Availability</span><strong>{agent.availability}</strong></div><div><span>Insurance</span><strong>{insuranceLabel(agent.insurance_status)}</strong></div><div><span>Required workup</span><strong>{agent.required_workup.join(' · ')}</strong></div>{rule && <div className="wide"><span>Relevant physician rule</span><strong>{rule}</strong></div>}{history && <div className="wide"><span>Historical-practice signal</span><strong>{history}</strong></div>}</div></div></details> })}
        <p>These are structured inputs and recorded conclusions, not private model reasoning.</p>
      </div>}
    </section>
    <p className="disclaimer">{consultation.disclaimer}</p>
  </section>
}

function PatientWorkspace({ patientId, navigate }: { patientId: string; navigate: Navigate }) {
  const [patient, setPatient] = useState<Patient | null>(null)
  const [consultation, setConsultation] = useState<Consultation | null>(null)
  const [recordId, setRecordId] = useState<number | undefined>(undefined)
  const [loading, setLoading] = useState(true)
  const [consulting, setConsulting] = useState(false)
  const [context, setContext] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [activity, setActivity] = useState<PatientActivity | null>(null)
  const [reconsulting, setReconsulting] = useState(false)
  const [nextStepPinned, setNextStepPinned] = useState(false)
  const demoPatient = DEMO_PATIENTS.find((item) => item.id === patientId)
  const refreshActivity = () => getPatientActivity()
    .then((records) => setActivity(records.find((item) => item.patient_id === patientId) ?? null))
    .catch(() => {})
  useEffect(() => { setLoading(true); getPatient(patientId).then(setPatient).catch((loadError: Error) => setError(loadError.message)).finally(() => setLoading(false)) }, [patientId])
  /**
   * On open, a patient who already has a completed consultation gets that
   * recommendation loaded directly -- the page reflects current care state, not
   * merely "a consultation exists somewhere" (see the idle-prior fallback below,
   * used only if this fetch fails).
   */
  useEffect(() => {
    let cancelled = false
    setReconsulting(false); setActivity(null); setConsultation(null); setRecordId(undefined)
    getPatientActivity().then(async (records) => {
      if (cancelled) return
      const found = records.find((item) => item.patient_id === patientId) ?? null
      setActivity(found)
      if (found?.has_consultation && found.latest_consultation_id != null) {
        try {
          const record = await getConsultationRecord(found.latest_consultation_id)
          if (!cancelled) { setConsultation(record.result); setRecordId(record.id) }
        } catch { /* idle-prior fallback below still works from activity alone */ }
      }
    }).catch(() => { if (!cancelled) setActivity(null) })
    return () => { cancelled = true }
  }, [patientId])
  /**
   * The Next step rail stays sticky only while its own content (loading card,
   * compact result, or expanded disclosures) still fits the viewport below the
   * sticky header -- otherwise it would pin content the physician can never
   * scroll to. A callback ref (not useRef+useLayoutEffect) is deliberate: this
   * page renders a loading placeholder before the real <aside> exists, so a
   * one-shot effect keyed to mount would attach while the ref is still null and
   * never observe anything. The callback ref instead fires exactly when the
   * node attaches (after loading resolves) and detaches, and its React 19
   * cleanup return handles teardown. Re-measures on attach, on window resize,
   * and on every height change inside the rail itself (disclosures opening/
   * closing, a candidate swap) via ResizeObserver -- never by synchronizing
   * scroll positions between the two columns, and never on mobile, where the
   * rail already renders in normal flow.
   */
  const nextStepRef = useCallback((node: HTMLElement | null) => {
    if (!node) return
    const STICKY_TOP_OFFSET = 76
    const BOTTOM_BREATHING_ROOM = 24
    const evaluate = () => {
      if (window.innerWidth <= 900) { setNextStepPinned(false); return }
      const availableHeight = window.innerHeight - STICKY_TOP_OFFSET - BOTTOM_BREATHING_ROOM
      setNextStepPinned(node.offsetHeight <= availableHeight)
    }
    evaluate()
    const observer = new ResizeObserver(evaluate)
    observer.observe(node)
    window.addEventListener('resize', evaluate)
    return () => { observer.disconnect(); window.removeEventListener('resize', evaluate) }
  }, [])
  /**
   * The synthetic demo request is often faster than a physician can actually
   * read "Consulting the network" -- so the consulting state is held open for
   * a minimum presentation floor, never added on top of a slower real
   * response. This is demo pacing only; a real owner clinical workflow must
   * never get artificial latency injected into it.
   */
  const runConsult = async () => {
    setConsulting(true); setConsultation(null); setRecordId(undefined); setError(null)
    const minimumConsultingDisplay = new Promise<void>((resolve) => window.setTimeout(resolve, 2000))
    try {
      const [result] = await Promise.all([consultNetwork(patientId, context), minimumConsultingDisplay])
      setConsultation(result)
      void refreshActivity()
    } catch (consultError) {
      setError(consultError instanceof Error ? consultError.message : 'Consultation failed')
    } finally {
      setConsulting(false)
    }
  }
  if (loading) return <ProductShell navigate={navigate} section="patients"><div className="page-state embedded"><div className="loading-line" /><p>Opening patient workspace…</p></div></ProductShell>
  if (!patient) return <ProductShell navigate={navigate} section="patients"><div className="page-state embedded error"><p>{error || 'Patient unavailable'}</p></div></ProductShell>
  const trends = clinicalTrends(patient.labs)
  const flowsheet = labFlowsheet(patient.labs)
  const resultDates = new Set(trends.latest.map((item) => item.date))
  const sharedResultDate = resultDates.size === 1 ? trends.latest[0].date : null
  const clinicalSource = patient.clinical_data_source === 'medplum_fhir' ? 'Synthetic FHIR via Medplum' : 'Local synthetic fixture'
  const priorConsultation = activity?.has_consultation === true && activity.latest_consultation_id !== null
  const careContext = [
    { label: 'Referring clinician', value: `${PCP_NAME} · Primary Care` },
    { label: 'Insurance', value: patient.insurance },
    { label: 'Clinical source', value: clinicalSource },
    { label: 'Patient ID', value: patient.id },
  ]
  const specialty = specialtySuggestion(patientId)
  const access = accessSuggestions(patient)
  const addedPhrases = context.split(/\.\s*/).map((part) => part.trim()).filter(Boolean)
  const addSuggestion = (text: string) => setContext((prev) => {
    const already = prev.split(/\.\s*/).map((part) => part.trim()).filter(Boolean).includes(text)
    return already ? prev : prev ? `${prev}. ${text}` : text
  })
  const chip = (item: { id: string; text: string; sourced: boolean }) => {
    const added = addedPhrases.includes(item.text)
    return <button type="button" key={item.id} className={`context-chip ${item.sourced ? '' : 'generic'} ${added ? 'added' : ''}`} aria-pressed={added} onClick={() => addSuggestion(item.text)}>{item.text}</button>
  }
  const suggestionChips = (specialty || access.length > 0) && <div className="context-suggestions">
    {specialty && <div className="context-suggestion-group"><span>Specialty</span><div className="context-chip-row">{chip(specialty)}</div></div>}
    {access.length > 0 && <div className="context-suggestion-group"><span>Access</span><div className="context-chip-row">{access.map(chip)}</div></div>}
  </div>
  const optionalGuidance = (label: string) => <details className="network-optional">
    <summary className="optional-guidance-label">Add optional guidance ↓</summary>
    <div className="network-field"><label htmlFor="patient-context-input">{label}</label><input id="patient-context-input" value={context} onChange={(event) => setContext(event.target.value)} maxLength={500} placeholder="Add a referral question, specialty preference, or care constraint" /></div>
    {suggestionChips}
  </details>
  const nextStepState: 'idle' | 'idle-prior' | 'consulting' | 'ready' = consulting ? 'consulting' : consultation ? 'ready' : priorConsultation ? 'idle-prior' : 'idle'
  const currentIssue = demoPatient?.reason ?? patient.diagnoses[0] ?? null
  const patientDisplayName = demoPatient?.name ?? cleanName(patient.display_name)
  const patientInitials = patientDisplayName.split(/\s+/).map((part) => part[0]).slice(0, 2).join('')
  return <ProductShell navigate={navigate} section="patients"><main className="page-shell patient-page">
    <button className="text-button back-link" onClick={() => navigate('/patients')}>← All patients</button>
    <header className="patient-identity"><span className="patient-row-avatar large">{patientInitials}</span><div><h1>{patientDisplayName}</h1><p>{patient.age} years · {patient.location}</p></div></header>
    {currentIssue && <p className="patient-current-issue"><span className="section-label">Current issue</span>{currentIssue}</p>}
    <hr className="patient-header-divider" />
    {error && <div className="error-banner" role="alert"><strong>Unable to complete this action.</strong> {error}</div>}
    {/* Two-column body: the left column is Lamina's own continuous clinical
     * record -- a boxed demo-style history timeline leads it, then the
     * overview and everything else continue directly beneath in the same
     * column. The right column is the sticky action box, top-aligned with
     * that leading box. DOM order keeps the action box first so mobile
     * (single column) still surfaces it before the clinical record;
     * grid-column flips the visual order on desktop. */}
    <div className="patient-detail-grid">
      <aside ref={nextStepRef} className={`patient-next-step patient-top-card ${nextStepPinned ? 'pinned' : ''}`}>
        <h2>Next step</h2>
        <p className="page-intro">Your agent helps with the follow-through.</p>
        {nextStepState === 'consulting' && <div className="next-step-card consulting">
          <span className="status-label pulse"><span className="spark-icon lead" aria-hidden="true">✧</span>Consulting the network</span>
          <h3>Your agent is finding a match.</h3>
          <p>Comparing clinical fit, referral requirements, access, and your practice preferences…</p>
        </div>}
        {nextStepState === 'ready' && consultation && <>
          <div className="next-step-card ready">
            <span className="status-label resolved"><span className="spark-icon lead" aria-hidden="true">✓</span>Your agent got back to you</span>
            <h3>A specialist is ready for your review.</h3>
            <p>Review the match below, then choose how to move care forward.</p>
          </div>
          <RecommendationView consultation={consultation} navigate={navigate} recordId={recordId} />
        </>}
        {nextStepState === 'idle-prior' && <div className="next-step-card idle">
          <h3>Previous network consultation available.</h3>
          <p><strong>{cleanName(activity?.latest_recommended_physician || '')}</strong>{activity?.latest_recommended_specialty ? <><br />{activity.latest_recommended_specialty}</> : null}</p>
          <small>{activity?.latest_consulted_at ? formatTime(activity.latest_consulted_at) : ''}</small>
          <button className="button-primary" onClick={() => navigate(consultationPath(activity?.latest_consultation_id as number))}>View consultation <span>→</span></button>
          {reconsulting
            ? <>{optionalGuidance('Add what changed, if anything, since the last consultation.')}<button className="consult-button" disabled={consulting} onClick={runConsult}><span>{consulting ? 'Consulting…' : 'Consult network for referral'}</span><span>→</span></button></>
            : <button className="text-button" onClick={() => setReconsulting(true)}>Re-consult the network →</button>}
        </div>}
        {nextStepState === 'idle' && <div className="next-step-card idle">
          <span className="status-label warning">Referral needed</span>
          <h3>Find a specialist</h3>
          <p>Let your agent consult the network and bring back referral options that fit this patient's needs.</p>
          <button className="consult-button" disabled={consulting} onClick={runConsult}>Find specialist <span className="spark-icon" aria-hidden="true">✧</span></button>
          {optionalGuidance('Add context only if you want to guide the network consultation.')}
        </div>}
        <p className="bottom-note">Simulated workflow · No referral is sent</p>
      </aside>
      <div className="patient-clinical-main">
        {(consultation || currentIssue) && <section className="patient-history-section patient-top-card" aria-labelledby="patient-history-heading">
          <h2 id="patient-history-heading">Patient history</h2>
          <div className="clinical-timeline">
            {consultation && <div className="timeline-event">
              {activity?.latest_consulted_at && <time>{formatTime(activity.latest_consulted_at)}</time>}
              <h4>Agent returned a specialist recommendation</h4>
              <p>{cleanName(consultation.recommended_physician.physician_name)} · {consultation.recommended_physician.specialty}</p>
            </div>}
            {currentIssue && <div className="timeline-event">
              <h4>{currentIssue}</h4>
              <p>Reason for this referral workflow, as recorded in the patient's chart.</p>
            </div>}
          </div>
        </section>}
        <section className="clinical-overview" aria-labelledby="clinical-overview-heading">
          <header className="clinical-overview-head"><h2 id="clinical-overview-heading">Clinical overview</h2><p>Bounded synthetic context available to your agent. Not a complete medical record.</p></header>
          <div className="clinical-columns">
            <section><h3>Problems</h3><ul className="clinical-list">{patient.diagnoses.map((item) => <li key={item}>{item}</li>)}</ul></section>
            <section><h3>Current medications</h3><ul className="clinical-list">{patient.medications.map((item) => <li key={item}>{item}</li>)}</ul></section>
          </div>
          {trends.domain && trends.series.length > 0 && <section className="clinical-block">
            <h3>Clinical trajectory</h3>
            <div className={`trend-chart-stack ${trends.series.length > 1 ? 'paired' : 'single'}`}>{trends.series.map((series, index) => <TrendChart key={series.test} series={series} domain={trends.domain as [number, number]} tone={index === 0 ? 'accent' : 'clinical'} />)}</div>
          </section>}
          {trends.latest.length > 0 && <section className="clinical-block">
            <h3>Latest relevant results{sharedResultDate && <em>{labDate(sharedResultDate)}</em>}</h3>
            <div className="result-grid">{trends.latest.map((item) => <div key={item.test}>
              <strong>{item.value} <i>{labUnit(item.unit)}</i></strong>
              <span>{item.label}</span>
              {!sharedResultDate && <small>{labDate(item.date)}</small>}
            </div>)}</div>
          </section>}
          {patient.clinical_notes.length > 0 && <section className="clinical-block">
            <h3>Recent relevant context</h3>
            <ul className="clinical-list">{patient.clinical_notes.map((note) => <li key={note}>{note}</li>)}</ul>
          </section>}
          <section className="clinical-block care-context">
            <h3>Care context</h3>
            <dl>{careContext.map((item) => <div key={item.label}><dt>{item.label}</dt><dd>{item.value}</dd></div>)}</dl>
          </section>
        </section>
        <details className="source-record"><summary>View source clinical data <span>Problems, medications, full laboratory history and provenance</span></summary>
          <div className="source-record-body">
            <section><h3>Problems</h3><ul className="record-rows">{patient.diagnoses.map((item) => <li key={item}>{item}</li>)}</ul></section>
            <section><h3>Medications</h3><ul className="record-rows">{patient.medications.map((item) => <li key={item}>{item}</li>)}</ul></section>
            <section><h3>Laboratory history</h3>
              <div className="record-table-scroll">
                <table className="record-table">
                  <caption>Every recorded synthetic result, oldest first. A dash means no result was recorded on that date.</caption>
                  <thead><tr><th scope="col">Date</th>{flowsheet.columns.map((column) => <th key={column.test} scope="col">{column.label}<small>{labUnit(column.unit)}</small></th>)}</tr></thead>
                  <tbody>{flowsheet.rows.map((row) => <tr key={row.date}><th scope="row">{labDate(row.date)}</th>{row.cells.map((cell, index) => <td key={flowsheet.columns[index].test}>{cell === null ? <span aria-label="No result recorded">—</span> : cell}</td>)}</tr>)}</tbody>
                </table>
              </div>
            </section>
            {patient.clinical_notes.length > 0 && <section><h3>Clinical notes</h3><ul className="record-rows">{patient.clinical_notes.map((note) => <li key={note}>{note}</li>)}</ul></section>}
            <section><h3>Care context</h3>
              <dl className="record-context">{[...careContext, { label: 'Provenance', value: 'Synthetic demo record · no PHI' }].map((item) => <div key={item.label}><dt>{item.label}</dt><dd>{item.value}</dd></div>)}</dl>
            </section>
          </div>
        </details>
      </div>
    </div>
  </main></ProductShell>
}

export default function App() {
  const [location, setLocation] = useState(() => `${window.location.pathname}${window.location.search}`)
  useEffect(() => {
    const onPop = () => setLocation(`${window.location.pathname}${window.location.search}`)
    window.addEventListener('popstate', onPop)
    return () => window.removeEventListener('popstate', onPop)
  }, [])
  const navigate = (next: string) => {
    window.history.pushState({}, '', next)
    const target = new URL(next, window.location.origin)
    setLocation(`${target.pathname}${target.search}`)
    window.scrollTo({ top: 0, behavior: 'smooth' })
  }
  const current = new URL(location, window.location.origin)
  const path = current.pathname
  const params = current.searchParams
  if (path === '/') return <LandingPage navigate={navigate} />
  if (path === '/me' || path === '/me/home') return <OwnerHomePage navigate={navigate} />
  if (path === '/me/profile') return <OwnerProfilePage navigate={navigate} params={params} />
  if (path === '/me/agent') return <OwnerAgentPage navigate={navigate} params={params} />
  if (path === '/me/agent/train') return <OwnerTrainingPage navigate={navigate} params={params} />
  if (path === '/home') return <HomePage navigate={navigate} />
  if (path === '/patients') return <PatientSelector navigate={navigate} />
  if (path === '/consultations') return <ConsultationsPage navigate={navigate} />
  if (path === '/agent') return <MyAgentPage navigate={navigate} params={params} />
  if (path === '/agent/train') return <ProductShell navigate={navigate} section="agent"><TrainingPage personaId="lucy" agentName={PCP_AGENT_NAME} navigate={navigate} exitPath="/agent?tab=train" params={params} /></ProductShell>
  if (path === '/profile' || path === '/profile/professional') return <ProductShell navigate={navigate} section="profile"><ProfessionalProfilePage personaId="lucy" navigate={navigate} params={params} /></ProductShell>
  if (path === '/settings') return <SettingsPage navigate={navigate} />
  if (path === '/network/updates') return <ProductShell navigate={navigate} section="network"><LucyNetworkPage navigate={navigate} params={new URLSearchParams('tab=feed')} /></ProductShell>
  const networkProfileControlledId = path.match(/^\/network\/profile\/([^/]+)$/)?.[1]
  if (networkProfileControlledId) return <ProductShell navigate={navigate} section="network"><NetworkPhysicianProfilePage controlledId={networkProfileControlledId} navigate={navigate} backPath="/home" /></ProductShell>
  const historyPatientId = path.match(/^\/consultations\/patient\/([^/]+)$/)?.[1]
  if (historyPatientId) return <PatientConsultationsPage patientId={historyPatientId} navigate={navigate} />
  const recordId = path.match(/^\/consultations\/(\d+)$/)?.[1]
  if (recordId) return <ConsultationRecordPage id={Number(recordId)} focusEventId={params.get('event')} navigate={navigate} />
  if (path === '/claim') return <PhysicianIdentitySearchPage navigate={navigate} />
  if (path === '/claim/my-identities') return <MyIdentitiesPage navigate={navigate} />
  if (path === '/claim/sign-in') return <SignInPage navigate={navigate} params={params} />
  if (path === '/claim/sign-up') return <SignUpPage navigate={navigate} params={params} />
  const claimNpi = path.match(/^\/claim\/provider\/([^/]+)$/)?.[1]
  if (claimNpi) return <ProviderIdentityPage npi={claimNpi} navigate={navigate} params={params} />
  if (path === '/specialist' || path === '/specialist/home') return <ProductShell navigate={navigate} section="specialist-home" perspective="specialist"><SpecialistHomePage navigate={navigate} /></ProductShell>
  if (path === '/specialist/cases') return <ProductShell navigate={navigate} section="specialist-patients" perspective="specialist"><SpecialistCasesPage navigate={navigate} /></ProductShell>
  const specialistRecordId = path.match(/^\/specialist\/cases\/(\d+)$/)?.[1]
  if (specialistRecordId) return <ProductShell navigate={navigate} section="specialist-patients" perspective="specialist"><SpecialistCaseDetailPage recordId={Number(specialistRecordId)} navigate={navigate} /></ProductShell>
  if (path === '/specialist/agent') return <ProductShell navigate={navigate} section="specialist-agent" perspective="specialist"><SpecialistAgentPage navigate={navigate} params={params} /></ProductShell>
  if (path === '/specialist/agent/train') return <ProductShell navigate={navigate} section="specialist-agent" perspective="specialist"><TrainingPage personaId="iain" agentName={SPECIALIST_AGENT_NAME} navigate={navigate} exitPath="/specialist/agent?tab=train" params={params} /></ProductShell>
  if (path === '/specialist/profile') return <ProductShell navigate={navigate} section="specialist-agent" perspective="specialist"><ProfessionalProfilePage personaId="iain" navigate={navigate} params={params} /></ProductShell>
  if (path === '/specialist/patients') return <ProductShell navigate={navigate} section="specialist-patients" perspective="specialist"><SpecialistPatientsPage navigate={navigate} /></ProductShell>
  if (path === '/specialist/network') return <ProductShell navigate={navigate} section="specialist-network" perspective="specialist"><SpecialistNetworkPage navigate={navigate} params={params} /></ProductShell>
  if (path === '/specialist/network/updates') return <ProductShell navigate={navigate} section="specialist-network" perspective="specialist"><SpecialistNetworkPage navigate={navigate} params={new URLSearchParams('tab=feed')} /></ProductShell>
  const specialistNetworkProfileId = path.match(/^\/specialist\/network\/profile\/([^/]+)$/)?.[1]
  if (specialistNetworkProfileId) return <ProductShell navigate={navigate} section="specialist-network" perspective="specialist"><NetworkPhysicianProfilePage controlledId={specialistNetworkProfileId} navigate={navigate} backPath="/specialist/home" /></ProductShell>
  if (path === '/network') return <ProductShell navigate={navigate} section="network"><LucyNetworkPage navigate={navigate} params={params} /></ProductShell>
  const networkNpi = path.match(/^\/network\/([^/]+)$/)?.[1]
  if (networkNpi) return <ProductShell navigate={navigate} section="network"><PhysicianProfilePage npi={networkNpi} navigate={navigate} /></ProductShell>
  const patientId = path.match(/^\/patients\/([^/]+)$/)?.[1]
  if (patientId === JORDAN_ID || patientId === MARIA_ID) return <PatientWorkspace patientId={patientId} navigate={navigate} />
  const demoPatient = DEMO_PATIENTS.find((patient) => patient.id === patientId)
  if (demoPatient) return <UnfinishedPatient patient={demoPatient} navigate={navigate} />
  return <LandingPage navigate={navigate} />
}
