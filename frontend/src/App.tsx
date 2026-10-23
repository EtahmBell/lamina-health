import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react'
import laminaLogo from './assets/lamina-logo-source.png'
import { useAuth } from './AuthProvider.tsx'
import { consultNetwork, createAgentCorrection, getActiveReferral, getAgentOverview, getConsultationHistory, getConsultationRecord, getEncounter, getEvalCases, getEvalPhysicians, getHandoff, getMyAgent, getPatient, getPatientActivity, getNetworkFeed, getPracticeRepresentation, getTrainingHistory, ingestConsultationEncounter, resetJordanDemo, resetTonjitDemo, runEvalCaseRepeated, runEvalSuite, updateAgentLearning, type AgentLearning, type AgentOverview, type CandidateFitLabel, type CandidateRoute, type CareModality, type Consultation, type ConsultationEncounter, type ConsultationMessage, type ConsultationRecord, type EconsultSuitability, type EvalPhysicianSummary, type Evaluation, type EvidenceConfidence, type HandoffSummary, type MyAgent, type NetworkFeed, type NetworkParticipation, type Patient, type PatientActivity, type PhysicianAgentEvalCase, type PhysicianAgentEvalRun, type PhysicianAgentEvalSuiteResult, type PracticeRepresentation, type Referral, type ReferralPriority, type ReferralStatus, type TrainProjection } from './api.ts'
import { MyIdentitiesPage, PhysicianIdentitySearchPage, ProviderIdentityPage, SignInPage, signInPath, SignUpPage } from './Claim.tsx'
import { OwnerAgentPage, OwnerHomePage, OwnerProfilePage, OwnerTrainingPage } from './Owner.tsx'
import { LaminaMark } from './LaminaMark.tsx'
import { AgentAvatar, agentTone } from './AgentAvatar.tsx'
import { activityPath, agentActivity, consultationPath, eventDomId } from './agentActivity.ts'
import { clinicalTrends, labDate, labFlowsheet, labUnit } from './clinicalTrends.ts'
import { groupConsultationsByPatient } from './consultationGrouping.ts'
import { accessSuggestions, specialtySuggestion } from './contextSuggestions.ts'
import { groupConsultationMessages } from './consultationPresentation.ts'
import { CHEN_AGENT_NAME, CHEN_ID, CHEN_NAME, JORDAN_ID, MARIA_ID, PCP_AGENT_ID, PCP_AGENT_NAME, PCP_NAME, SPECIALIST_AGENT_NAME, SPECIALIST_NAME, SPECIALIST_SPECIALTY, TONJIT_ID, cleanName, patientName } from './demoIdentity.ts'
import { CHEN_PATIENT_IDS, DEMO_PATIENTS, type DemoPatientSummary, type PatientStage } from './demoPatients.ts'
import { AgentOverviewPanel, ChatTab, HomeAgentCard, NetworkFeedTab, NetworkHighlights, NetworkPhysicianProfilePage, NetworkTabs, ProfessionalProfilePage, TrainingPage, TrainTab, networkProfilePath, networkUpdatesPath, settingsPath, trainingPath, WorklistRows, type NetworkTab } from './Engagement.tsx'
import { timeAwareGreeting } from './greeting.ts'
import { MyNetworkTab, PhysicianProfilePage, type DirectoryOnlyProfile } from './PhysicianNetwork.tsx'
import { SpecialistAgentPage, SpecialistCaseDetailPage, SpecialistCasesPage, SpecialistHomePage, SpecialistNetworkPage, SpecialistPatientsPage } from './Specialist.tsx'
import { TrendChart } from './TrendChart.tsx'
import { ACCEPTED_OR_LATER_STATUSES, ChenAgentPage, ChenDownstreamCard, ChenHomePage, ChenNetworkPage, ChenPatientsPage, consumeMedicationHighlightFlag, CoordinationChatCard, lucySuggestedPrompts, PriorityChip, PriorityChipRow, priorityLabel, ReferralCoordinationSurface } from './Referral.tsx'
import { restorePhase } from './referralPhases.ts'
import { EVIDENCE_CATEGORY_LABELS, matchEvidence, whyThisMatch } from './matchExplanation.ts'
import { ModalPortal } from './ModalPortal.tsx'

type Navigate = (path: string) => void

function Brand() {
  return <div className="brand" aria-label="Lamina"><span className="brand-symbol" aria-hidden="true"><img src={laminaLogo} alt="" /></span><span className="wordmark">LAMINA</span></div>
}

function NetworkMark({ active = false, resolved = false }: { active?: boolean; resolved?: boolean }) {
  return <LaminaMark active={active} resolved={resolved} />
}

/** A simple thin-line people/group mark for the Network sidebar item -- replaces
 * the old lightning-bolt glyph, which read as "activity" rather than "the
 * physician network." Two circular heads + shoulder arcs, not a node/graph
 * diagram. Uses currentColor so it inherits .nav-icon's existing copper tint. */
function NetworkNavIcon() {
  return <svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <circle cx="8" cy="7.5" r="3" />
    <path d="M2 19c0-3.3 2.7-6 6-6s6 2.7 6 6" />
    <circle cx="16.5" cy="9" r="2.3" />
    <path d="M14.3 13.1c.7-.26 1.5-.4 2.2-.4 2.8 0 5 2.1 5 5.3" />
  </svg>
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
  { id: 'network', title: 'Network', icon: <NetworkNavIcon />, path: '/network' },
]

const SPECIALIST_NAV_ITEMS = [
  { id: 'specialist-home', title: 'Dashboard', icon: '⌂', path: '/specialist/home' },
  { id: 'specialist-patients', title: 'Patients', icon: '✦', path: '/specialist/patients' },
  { id: 'specialist-network', title: 'Network', icon: <NetworkNavIcon />, path: '/specialist/network' },
]

/** Chen now gets the full standard physician workspace navigation (Part A,
 * closed-loop referral pass 2) -- same three top-level destinations as
 * Lucy's own navItems, same shape, just routed under /chen. My Agent remains
 * the persistent sidebar object (not a navItems entry) and Profile remains
 * reached via the avatar menu's profilePath, exactly like Lucy's and Iain's
 * own workspace -- "using the existing product navigation convention," not a
 * new navigation system. */
const CHEN_NAV_ITEMS = [
  { id: 'chen-home', title: 'Dashboard', icon: '⌂', path: '/chen/home' },
  { id: 'chen-patients', title: 'Patients', icon: '✦', path: '/chen/patients' },
  { id: 'chen-network', title: 'Network', icon: <NetworkNavIcon />, path: '/chen/network' },
]

/** Every demo perspective that actually exists as a real page, used to
 * resolve the avatar pill's current name/initials correctly no matter which
 * one is open right now -- including Iain, whose pages are still fully
 * functional (Part A: "do not delete Iain Jung from... any other synthetic
 * data"), just no longer offered in the switcher below. */
const DEMO_PERSPECTIVES = [
  { id: 'pcp' as const, name: PCP_NAME, role: 'Referring physician', initials: 'LS', path: '/home', profilePath: '/profile' },
  { id: 'specialist' as const, name: SPECIALIST_NAME, role: 'Specialist', initials: 'IJ', path: '/specialist/home', profilePath: '/specialist/profile' },
  { id: 'chen' as const, name: CHEN_NAME, role: 'Receiving specialist', initials: 'NC', path: '/chen/home', profilePath: '/chen/profile' },
]

/** The convenient secondary demo persona for the switcher dropdown (Part A):
 * Dr. Noah Chen -- the receiving specialist in the main closed-loop referral
 * demo -- replaces Dr. Iain Jung here. This changes only which physician is
 * one click away; it is not a change to the referral/network/clinical
 * domain, and Iain's own pages remain directly reachable and unchanged. */
const SWITCHABLE_DEMO_PERSPECTIVES = DEMO_PERSPECTIVES.filter((item) => item.id !== 'specialist')

/** The top-right avatar/account control. Combines the demo perspective switch with
 * profile and settings access, now that Profile is no longer a primary-nav item. */
function PerspectiveSwitch({ navigate, perspective }: { navigate: Navigate; perspective: 'pcp' | 'specialist' | 'chen' }) {
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
      {SWITCHABLE_DEMO_PERSPECTIVES.map((item) => <button key={item.id} role="menuitemradio" aria-checked={item.id === perspective} className={`perspective-option ${item.id === perspective ? 'active' : ''}`} onClick={() => switchTo(item.path)}>
        <span className="perspective-option-check" aria-hidden="true">{item.id === perspective ? '✓' : ''}</span>
        <span><strong>{item.name}</strong><small>{item.role}</small></span>
      </button>)}
    </div>}
  </div>
}

/** My Agent is a persistent object pinned to the bottom of the sidebar — not a
 * top-level nav item — so the agent stays visible from every workspace screen. It
 * is a real nav target (keyboard-reachable button) and picks up an active state
 * on any agent-related route. */
function ProductShell({ children, navigate, section, perspective = 'pcp' }: { children: React.ReactNode; navigate: Navigate; section: string; perspective?: 'pcp' | 'specialist' | 'chen' }) {
  const items = perspective === 'specialist' ? SPECIALIST_NAV_ITEMS : perspective === 'chen' ? CHEN_NAV_ITEMS : navItems
  const onAgent = section === 'agent' || section === 'specialist-agent' || section === 'chen-agent'
  return <div className="app-shell">
    <aside className="sidebar">
      <div><button className="brand-button" onClick={() => navigate('/')} aria-label="Return to Lamina portal"><Brand /></button><p className="brand-subtitle">Specialty Care Network</p>
        <nav aria-label="Primary navigation">
          {items.map((item) => <button key={item.id} className={`nav-item ${section === item.id ? 'active' : ''}`} onClick={() => navigate(item.path)}><span className="nav-icon">{item.icon}</span><span className="nav-item-label">{item.title}</span></button>)}
        </nav>
      </div>
      {perspective === 'specialist'
        ? <button className={`sidebar-clinician ${onAgent ? 'active' : ''}`} aria-current={onAgent ? 'page' : undefined} onClick={() => navigate('/specialist/agent')} aria-label={`Open ${SPECIALIST_AGENT_NAME} overview`}><AgentAvatar tone={agentTone('iain')} /><div><strong>{SPECIALIST_AGENT_NAME}</strong></div></button>
        : perspective === 'chen'
          ? <button className={`sidebar-clinician ${onAgent ? 'active' : ''}`} aria-current={onAgent ? 'page' : undefined} onClick={() => navigate('/chen/agent')} aria-label={`Open ${CHEN_AGENT_NAME} overview`}><AgentAvatar tone={agentTone('chen')} /><div><strong>{CHEN_AGENT_NAME}</strong></div></button>
          : <button className={`sidebar-clinician ${onAgent ? 'active' : ''}`} aria-current={onAgent ? 'page' : undefined} onClick={() => navigate('/agent?tab=overview')} aria-label={`Open ${PCP_AGENT_NAME} overview`}><AgentAvatar /><div><strong>{PCP_AGENT_NAME}</strong></div></button>}
    </aside>
    <div className="workspace"><header className="workspace-bar"><div className="workspace-bar-actions"><SyntheticStatus /><PerspectiveSwitch navigate={navigate} perspective={perspective} /></div></header>{children}</div>
  </div>
}

/**
 * The entry gateway (replaces the old spinning-orbit "Enter workspace" portal):
 * a quiet role picker, not a marketing site. Physician uses the existing
 * claim/sign-in flow; Explore the demo drops straight into the existing
 * synthetic Dr. Lucy Saruhashi workspace at /home (the same destination the
 * old orbit button used); Patient is a real, visibly disabled future state,
 * never fake functionality.
 */
function LandingPage({ navigate }: { navigate: Navigate }) {
  const { configured, loading, user } = useAuth()
  const physicianAuthed = configured && !loading && !!user
  const physicianPath = physicianAuthed ? '/claim/my-identities' : signInPath('/claim/my-identities')
  return <main className="landing-page">
    <header className="landing-header"><Brand /><div className="landing-header-actions"><SyntheticStatus /></div></header>
    <section className="gateway-content">
      <p className="eyebrow">Specialty care, connected.</p>
      <h1>Lamina</h1>
      <p className="gateway-statement">A specialty-care network for physicians and their agents.</p>
      <div className="gateway-roles">
        <button className="gateway-role-card primary" onClick={() => navigate(physicianPath)}>
          <span className="gateway-role-label">Physician</span>
          <p>{physicianAuthed ? 'Open your physician workspace.' : 'Sign in to your physician workspace.'}</p>
          <strong>{physicianAuthed ? 'Continue' : 'Sign in'} <b>→</b></strong>
        </button>
        <button className="gateway-role-card" onClick={() => navigate('/home')}>
          <span className="gateway-role-label">Explore the demo</span>
          <p>Explore Lamina using synthetic clinical data.</p>
          <strong>Enter demo <b>→</b></strong>
        </button>
        <button className="gateway-role-card disabled" disabled aria-label="Patient -- a patient experience is coming later">
          <span className="gateway-role-label">Patient</span>
          <p>A patient experience is coming later.</p>
          <strong>Coming later</strong>
        </button>
      </div>
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
  // Demo coherence pass, Part S: a fresh main-nav Network entry (no ?tab=)
  // lands on Colleagues by default -- Feed is only shown when explicitly
  // requested (?tab=feed, including the legacy /network/updates alias).
  const [tab, setTab] = useState<NetworkTab>(tabParam === 'feed' ? 'feed' : 'my-network')
  const [focusPostId, setFocusPostId] = useState<string | null>(null)
  useEffect(() => { setTab(tabParam === 'feed' ? 'feed' : 'my-network') }, [tabParam])
  const selectTab = (next: NetworkTab) => { setTab(next); window.history.replaceState({}, '', next === 'feed' ? '/network?tab=feed' : '/network?tab=my-network') }
  // Active-network pass, Part M: a relevant-broadcast result's "View in Feed"
  // switches tabs and focuses the referenced post, never a separate detail route.
  const viewInFeed = (postId: string) => { setFocusPostId(postId); selectTab('feed') }
  return <main className="page-shell physician-directory-page">
    <header className="directory-hero"><div><p className="eyebrow">Physician-agent network</p><h1>Network</h1><p>The physicians, practices, and professional updates connected through your Lamina network.</p></div></header>
    <NetworkTabs tab={tab} onSelect={selectTab} />
    {tab === 'my-network'
      ? <MyNetworkTab navigate={navigate} onViewInFeed={viewInFeed} />
      : <NetworkFeedTab personaId="lucy" navigate={navigate} focusPostId={focusPostId} onFocused={() => setFocusPostId(null)} />}
  </main>
}

/** Dashboard-scoped patient row. Deliberately built from `records` (already fetched
 * for currentWork), never `getPatientActivity` — Home stays on canonical consultation
 * state, matching the rest of the page, and never introduces a second data source.
 * Only patients with a real, actionable next step are included here — this is a
 * focused worklist, not a miniature Patients directory (see buildWatchRows' filter). */
type PatientWatchRow = { patient: DemoPatientSummary; status: WorklistStatus; detail: string; nextStep: string; action: string }

const WORKLIST_ACTION: Record<WorklistStatus, string> = {
  'Ready for your review': 'Review', 'Not yet consulted': 'View patient info',
  'Awaiting specialist review': 'View patient info', 'Referral accepted': 'View patient info',
  'Consultation scheduled': 'View patient info', 'Handoff received': 'Review handoff',
}

function buildWatchRows(records: ConsultationRecord[], referralsByPatient: Map<string, Referral | null>): PatientWatchRow[] {
  return DEMO_PATIENTS.filter((patient) => patient.implemented && patient.owner !== 'chen').map((patient): PatientWatchRow => {
    const record = records.find((item) => item.patient_id === patient.id)
    const status = referralWorklistStatus(referralsByPatient.get(patient.id), Boolean(record))
    const detail = record ? `${record.result.recommended_physician.specialty} · ${cleanName(record.result.recommended_physician.physician_name)}` : patient.reason
    return {
      patient, status, detail,
      nextStep: status === 'Ready for your review' ? 'Review referral options' : WORKLIST_NEXT_STEP[status],
      action: WORKLIST_ACTION[status],
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

/* TODO (not yet designed): a lightweight "Share something your agent should
 * know" CTA -- e.g. "Share a paper" / "Share research" -- feeding agent
 * knowledge, post drafts, and profile/interests. Dashboard is the right home
 * for it (not Network): this is "tell your agent something," closer in spirit
 * to HomeAgentCard than to Network's discovery/posting surfaces. Likely a
 * quiet secondary link near HomeAgentCard, reusing PostButton's existing
 * compose -> draft-with-agent pipeline rather than a new posting path. */
function HomePage({ navigate }: { navigate: Navigate }) {
  const [records, setRecords] = useState<ConsultationRecord[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(false)
  const [feed, setFeed] = useState<NetworkFeed | null>(null)
  const [overview, setOverview] = useState<AgentOverview | null>(null)
  const [referralsByPatient, setReferralsByPatient] = useState<Map<string, Referral | null>>(new Map())
  useEffect(() => {
    getConsultationHistory()
      .then(setRecords)
      .catch(() => setError(true)).finally(() => setLoading(false))
    getNetworkFeed('lucy').then(setFeed).catch(() => {})
    getAgentOverview('lucy').then(setOverview).catch(() => {})
    fetchReferralsByPatient().then(setReferralsByPatient).catch(() => {})
  }, [])
  const ordered = [...records].sort((a, b) => b.completed_at.localeCompare(a.completed_at))
  const latestByPatient = ordered.filter((record, index) => ordered.findIndex((item) => item.patient_id === record.patient_id) === index)
  const activity = agentActivity(ordered).slice(0, 3)
  const watchRows = buildWatchRows(latestByPatient, referralsByPatient)
  const greetingName = `Dr. ${PCP_NAME.split(' ').at(-1)}`
  return <ProductShell navigate={navigate} section="home"><main className="page-shell home-page dashboard-page">
    <header className="dashboard-greeting"><p className="eyebrow">Dashboard</p><h1>{timeAwareGreeting(greetingName)}</h1><p className="dashboard-situation">Here's what needs your attention today.</p></header>
    {loading && <div className="home-loading"><div className="loading-line" /><p>Reviewing recent workspace activity…</p></div>}
    {error && <div className="error-banner" role="alert">Recent workspace activity is temporarily unavailable. Patient records remain accessible.</div>}
    {!loading && !error && <>
      <HomeAgentCard overview={overview} navigate={navigate} trainPath={trainingPath('lucy')} viewAgentPath="/agent?tab=overview" records={records} />
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
 * below, which is honest cosmetic detail, not a claimed agent interaction.
 *
 * Once a referral actually exists, its real persisted status always wins over
 * "has_consultation" -- a completed network consultation stays a true historical
 * fact forever, but that must never keep claiming "Ready for your review" once
 * the physician has already acted on it and the workflow has moved on (to the
 * receiving specialist's queue, then scheduling, then the returned handoff). */
type WorklistStatus =
  | 'Ready for your review' | 'Not yet consulted'
  | 'Awaiting specialist review' | 'Referral accepted' | 'Consultation scheduled' | 'Handoff received'
const WORKLIST_STATUS_PRIORITY: Record<WorklistStatus, number> = {
  'Handoff received': -2, 'Consultation scheduled': -2, 'Referral accepted': -1,
  'Awaiting specialist review': 0, 'Ready for your review': 0, 'Not yet consulted': 1,
}
const WORKLIST_NEXT_STEP: Record<WorklistStatus, string> = {
  'Ready for your review': 'Review options', 'Not yet consulted': 'Consult network',
  'Awaiting specialist review': 'Awaiting specialist review', 'Referral accepted': 'Awaiting scheduling',
  'Consultation scheduled': 'Awaiting consultation', 'Handoff received': 'Consultation complete',
}
const WORKLIST_STATUS_TONE: Record<WorklistStatus, string> = {
  'Ready for your review': 'copper', 'Not yet consulted': 'slate',
  'Awaiting specialist review': 'slate', 'Referral accepted': 'success',
  'Consultation scheduled': 'success', 'Handoff received': 'success',
}

/** The one place that decides "what does Lucy's worklist say about this
 * patient" -- real referral state always takes precedence over the
 * historical has_consultation fact, never the other way around. */
function referralWorklistStatus(referral: Referral | null | undefined, hasConsultation: boolean): WorklistStatus {
  if (referral) {
    switch (referral.status) {
      case 'consult_returned': return 'Handoff received'
      case 'scheduled': return 'Consultation scheduled'
      case 'accepted': return 'Referral accepted'
      case 'submitted': return 'Awaiting specialist review'
    }
  }
  return hasConsultation ? 'Ready for your review' : 'Not yet consulted'
}

const PCP_IMPLEMENTED_PATIENT_IDS = DEMO_PATIENTS.filter((patient) => patient.implemented && patient.owner !== 'chen').map((patient) => patient.id)

/** The same real per-patient referral lookup already used elsewhere
 * (RecommendationView's hydration, Chen's downstream card) -- never a
 * frontend-only guess at referral state. Small, fixed patient set in this
 * demo, so one call per patient is cheap; a null entry just means "no
 * referral exists yet for this patient." */
function fetchReferralsByPatient(): Promise<Map<string, Referral | null>> {
  return Promise.all(PCP_IMPLEMENTED_PATIENT_IDS.map((id) => getActiveReferral(id).catch(() => null)))
    .then((referrals) => new Map(PCP_IMPLEMENTED_PATIENT_IDS.map((id, index) => [id, referrals[index]])))
}

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
  const [referralsByPatient, setReferralsByPatient] = useState<Map<string, Referral | null>>(new Map())
  useEffect(() => { getPatientActivity().then(setActivity).catch(() => setActivityError(true)) }, [])
  useEffect(() => { fetchReferralsByPatient().then(setReferralsByPatient).catch(() => {}) }, [])
  const activityFor = (id: string) => activity.find((item) => item.patient_id === id)
  const visible = DEMO_PATIENTS.filter((patient) => patient.owner !== 'chen' && `${patient.name} ${patient.reason} ${patient.location}`.toLowerCase().includes(query.toLowerCase()))
  const rows = visible.map((patient) => {
    const record = activityFor(patient.id)
    const implementedStatus: WorklistStatus | null = record?.has_consultation || patient.implemented
      ? referralWorklistStatus(referralsByPatient.get(patient.id), Boolean(record?.has_consultation))
      : null
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
    <header className="selector-header"><div><h1>Patients</h1><p>Your active referral worklist.</p></div><span>{DEMO_PATIENTS.filter((patient) => patient.owner !== 'chen').length} synthetic patients</span></header>
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
      {tab === 'train' && <TrainTab trainProjection={trainProjection} navigate={navigate} trainPath={trainingPath('lucy')} personaId="lucy" learningOpportunities={overview?.learning_opportunities ?? []} focusId={params.get('focus')} onLearningChanged={refreshOverview} />}
      {tab === 'test' && <ChatTab personaId="lucy" agentName={PCP_AGENT_NAME} navigate={navigate} trainPath={trainingPath('lucy')} />}
    </>}
  </main></ProductShell>
}

/** Demo-only control. Clears one demo case's Lamina workflow history, never clinical data. */
function DemoResetControl({ patient }: { patient: 'jordan' | 'tonjit' }) {
  const [stage, setStage] = useState<'idle' | 'confirming' | 'working' | 'done'>('idle')
  const [removed, setRemoved] = useState(0)
  const [error, setError] = useState('')
  const copy = patient === 'tonjit' ? {
    title: 'Tonjit Askarov demo case',
    description: 'Reset Tonjit to pre-consult state so the closed-loop referral demo can be replayed.',
    buttonLabel: 'Reset Tonjit referral demo',
    confirmHeading: 'Reset Tonjit referral demo?',
    confirmBody: "This removes Tonjit's Lamina consultation and referral history and returns the case to its pre-consult demo state. Synthetic patient data is unchanged.",
    doneLabel: 'Tonjit referral demo reset.',
  } : {
    title: 'Jordan Lee demo case',
    description: 'Reset Jordan to pre-consult state.',
    buttonLabel: 'Reset Jordan case',
    confirmHeading: 'Reset Jordan demo case?',
    confirmBody: "This removes Jordan's Lamina consultation history and returns the case to its pre-consult demo state. Synthetic patient data is unchanged.",
    doneLabel: 'Jordan demo case reset.',
  }
  const reset = async () => {
    setStage('working'); setError('')
    try {
      const result = await (patient === 'tonjit' ? resetTonjitDemo() : resetJordanDemo())
      setRemoved(result.removed_consultations)
      setStage('done')
    } catch (resetError) {
      setError(resetError instanceof Error ? resetError.message : 'Could not reset the demo case')
      setStage('confirming')
    }
  }
  return <div className="demo-reset-block">
    <div className="demo-reset">
      <div><strong>{copy.title}</strong><p>{copy.description}</p></div>
      {stage !== 'confirming' && <button className="button-secondary" onClick={() => { setStage('confirming'); setError('') }}>{copy.buttonLabel}</button>}
    </div>
    {stage === 'confirming' && <div className="demo-reset-confirm" role="group" aria-label="Confirm demo reset">
      <strong>{copy.confirmHeading}</strong>
      <p>{copy.confirmBody}</p>
      {error && <p className="demo-reset-error" role="alert">{error}</p>}
      <div><button className="text-button" onClick={() => setStage('idle')}>Cancel</button><button className="button-primary" onClick={reset}>Reset case</button></div>
    </div>}
    {stage === 'working' && <p className="muted-note">Resetting…</p>}
    {stage === 'done' && <p className="demo-reset-result" role="status"><b>✓</b>{copy.doneLabel}{removed > 0 ? ` ${removed} consultation${removed === 1 ? '' : 's'} removed.` : ''}</p>}
  </div>
}

/** Demo-only control (Settings & Demo). Clinical encounter completion is
 * never a normal physician workflow decision inside the referral itself --
 * it is represented as an INGESTED CLINICAL FACT arriving from the EHR/
 * Medplum, simulated only from here, and only once there is something real
 * to ingest (Tonjit's consultation has been scheduled) and nothing already
 * on record (no completed encounter exists yet). */
function TonjitEncounterSimulationControl() {
  const [referral, setReferral] = useState<Referral | null | undefined>(undefined)
  const [encounter, setEncounter] = useState<ConsultationEncounter | null | undefined>(undefined)
  const [stage, setStage] = useState<'idle' | 'working' | 'done'>('idle')
  const [error, setError] = useState('')
  useEffect(() => {
    let cancelled = false
    getActiveReferral(TONJIT_ID).then((result) => {
      if (cancelled) return
      setReferral(result)
      if (result?.id != null) getEncounter(result.id).then((found) => { if (!cancelled) setEncounter(found) }).catch(() => { if (!cancelled) setEncounter(null) })
      else setEncounter(null)
    }).catch(() => { if (!cancelled) { setReferral(null); setEncounter(null) } })
    return () => { cancelled = true }
  }, [])
  if (referral === undefined || encounter === undefined) return null
  if (!referral || referral.id == null || referral.status !== 'scheduled' || encounter) return null
  const referralId = referral.id
  const simulate = async () => {
    setStage('working'); setError('')
    try {
      const result = await ingestConsultationEncounter(referralId, CHEN_ID)
      setEncounter(result.encounter)
      setStage('done')
    } catch (ingestError) {
      setError(ingestError instanceof Error ? ingestError.message : 'Could not simulate the consultation encounter')
      setStage('idle')
    }
  }
  return <div className="demo-reset-block">
    <div className="demo-reset">
      <div><strong>Tonjit Askarov consultation</strong><p>Simulate the completed specialist consultation as if ingested from the EHR/Medplum, so Dr. Chen's Agent can draft the handoff.</p></div>
      {stage !== 'done' && <button className="button-secondary" disabled={stage === 'working'} onClick={simulate}>{stage === 'working' ? 'Simulating…' : 'Simulate completed Tonjit consultation'}</button>}
    </div>
    {error && <p className="demo-reset-error" role="alert">{error}</p>}
    {stage === 'done' && <p className="demo-reset-result" role="status"><b>✓</b>Consultation encounter documented in Tonjit's record.</p>}
  </div>
}

/** Account/privacy/demo surface — deliberately separate from the Professional
 * Profile, which is now the primary-nav "Profile" destination. */
/** Physician-agent evaluation harness (pre-NLP foundational pass, Part S/T)
 * -- a restrained developer/demo inspection surface reached from Settings
 * & demo, never a new top-level product navigation item and never patient-
 * facing. Shows whichever eval fact is actually present for a given case
 * (expected_behavior/structured_output shapes vary by task_type), never a
 * raw JSON dump and never one aggregate "agent score". */
function evalFactEntries(source: Record<string, unknown>): [string, string][] {
  return Object.entries(source)
    .filter(([, value]) => value !== null && value !== undefined && value !== '' && !(Array.isArray(value) && value.length === 0))
    .map(([key, value]): [string, string] => [key.replaceAll('_', ' '), Array.isArray(value) ? (value.length ? value.join(', ') : 'None') : String(value)])
}

const EVAL_CATEGORY_LABELS: Record<PhysicianAgentEvalCase['eval_category'], string> = {
  representation_system: 'Representation / system evaluation',
  agent_behavior: 'Agent behavior evaluation (model-dependent)',
}

/** Evaluation visibility pass, Part D: execution mode is always shown
 * explicitly, never implied -- a deterministic fallback is never rendered
 * as though a model-backed agent passed the case. */
function ExecutionModeBadge({ run }: { run: PhysicianAgentEvalRun }) {
  return run.execution_mode === 'model'
    ? <span className="eval-execution-mode model">Model: {run.model_id}</span>
    : <span className="eval-execution-mode deterministic">Deterministic fallback</span>
}

function EvalCaseDetailModal({ evalCase, run, onClose }: { evalCase: PhysicianAgentEvalCase; run: PhysicianAgentEvalRun; onClose: () => void }) {
  return <ModalPortal><div className="post-flow-overlay" role="presentation" onClick={(event) => { if (event.target === event.currentTarget) onClose() }}>
    <div className="post-flow-dialog eval-case-detail-dialog" role="dialog" aria-modal="true" aria-label={evalCase.name}>
      <button className="text-button post-flow-close" onClick={onClose} aria-label="Close">×</button>
      <p className={`eyebrow eval-status-${run.status}`}>{run.status.replaceAll('_', ' ')}</p>
      <h2>{evalCase.name}</h2>
      <p className="page-intro">{evalCase.description}</p>
      <div className="eval-case-meta-row">
        <span className={`eval-category-badge ${evalCase.eval_category}`}>{EVAL_CATEGORY_LABELS[evalCase.eval_category]}</span>
        <ExecutionModeBadge run={run} />
        <span className="eval-snapshot-badge">Representation: {run.representation_snapshot_id}</span>
      </div>
      <div className="eval-case-detail-grid">
        <div className="match-details-group"><p className="section-label">Expected</p><dl className="route-fact-list">{evalFactEntries(evalCase.expected_behavior)}</dl></div>
        <div className="match-details-group"><p className="section-label">Actual</p><dl className="route-fact-list">{evalFactEntries(run.structured_output)}</dl></div>
      </div>
      <p className="section-label">Assertions</p>
      <ul className="eval-assertion-list">{run.assertion_results.map((assertion, index) => <li key={index} className={assertion.passed ? 'passed' : 'failed'}>
        <span aria-hidden="true">{assertion.passed ? '✓' : '✗'}</span>
        <div>
          <strong>{assertion.assertion_type.replaceAll('_', ' ')}</strong>
          <small>Expected: {assertion.expected} · Actual: {assertion.actual}</small>
          {assertion.evidence.length > 0 && <small className="eval-assertion-evidence">Grounded in: {assertion.evidence.join('; ')}</small>}
        </div>
      </li>)}</ul>
      {run.error_message && <p className="demo-reset-error" role="alert">{run.error_message}</p>}
    </div>
  </div></ModalPortal>
}

/** Part F: restrained repeated-run inspection for one model-dependent case
 * -- "5/5 structural assertions passed", never a fabricated aggregate
 * "Agent Score". */
function RepeatedRunControl({ physicianId, evalCase }: { physicianId: string; evalCase: PhysicianAgentEvalCase }) {
  const [runs, setRuns] = useState<PhysicianAgentEvalRun[] | null>(null)
  const [busy, setBusy] = useState(false)
  const repeat = async (times: number) => {
    setBusy(true)
    try { setRuns(await runEvalCaseRepeated(physicianId, evalCase.id, times)) }
    finally { setBusy(false) }
  }
  const passed = runs?.filter((item) => item.status === 'pass').length ?? 0
  return <span className="eval-repeat-control" onClick={(event) => event.stopPropagation()}>
    <button type="button" className="text-button" disabled={busy} onClick={() => void repeat(1)}>Run once</button>
    <button type="button" className="text-button" disabled={busy} onClick={() => void repeat(5)}>Run 5 times</button>
    {runs && <small className="eval-repeat-summary">{passed} / {runs.length} structural assertions passed</small>}
  </span>
}

function AgentEvaluationsPage({ navigate }: { navigate: Navigate }) {
  const [physicians, setPhysicians] = useState<EvalPhysicianSummary[] | null>(null)
  const [cases, setCases] = useState<Record<string, PhysicianAgentEvalCase[]>>({})
  const [results, setResults] = useState<Record<string, PhysicianAgentEvalSuiteResult>>({})
  const [running, setRunning] = useState<string | null>(null)
  const [error, setError] = useState('')
  const [detail, setDetail] = useState<{ evalCase: PhysicianAgentEvalCase; run: PhysicianAgentEvalRun } | null>(null)

  useEffect(() => {
    getEvalPhysicians().then((list) => {
      setPhysicians(list)
      list.forEach((item) => {
        getEvalCases(item.physician_id).then((loaded) => setCases((prev) => ({ ...prev, [item.physician_id]: loaded }))).catch(() => {})
      })
    }).catch((err: Error) => setError(err.message))
  }, [])

  const run = async (physicianId: string) => {
    setRunning(physicianId); setError('')
    try {
      const result = await runEvalSuite(physicianId)
      setResults((prev) => ({ ...prev, [physicianId]: result }))
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not run evaluations')
    } finally {
      setRunning(null)
    }
  }

  return <ProductShell navigate={navigate} section="settings"><main className="page-shell eval-harness-page">
    <button className="text-button back-link" onClick={() => navigate('/settings')}>← Settings &amp; demo</button>
    <p className="eyebrow">Internal / developer surface</p>
    <h1>Physician agent evaluations</h1>
    <p className="page-intro">Tests whether a physician's reconstructed agent behaves consistently with that physician's confirmed Lamina representation, on previously unseen synthetic cases. Structural checks only, never exact prose -- and never a physician score.</p>
    {error && <div className="error-banner" role="alert">{error}</div>}
    {!physicians && !error && <p className="muted-note">Opening evaluations…</p>}
    {physicians?.map((physician) => {
      const physicianCases = cases[physician.physician_id] ?? []
      const result = results[physician.physician_id]
      const representationCases = physicianCases.filter((item) => item.eval_category === 'representation_system')
      const agentBehaviorCases = physicianCases.filter((item) => item.eval_category === 'agent_behavior')
      const renderCaseRow = (evalCase: PhysicianAgentEvalCase) => {
        const matchingRun = result?.runs.find((item) => item.eval_case_id === evalCase.id)
        return <li key={evalCase.id}>
          <button type="button" className="eval-case-row" disabled={!matchingRun} onClick={() => matchingRun && setDetail({ evalCase, run: matchingRun })}>
            <span className={`eval-case-status ${matchingRun?.status ?? 'pending'}`} aria-hidden="true">{matchingRun ? (matchingRun.status === 'pass' ? '✓' : matchingRun.status === 'error' ? '!' : '✗') : '·'}</span>
            <span>{evalCase.name}</span>
            {matchingRun && <ExecutionModeBadge run={matchingRun} />}
          </button>
          {evalCase.eval_category === 'agent_behavior' && <RepeatedRunControl physicianId={physician.physician_id} evalCase={evalCase} />}
        </li>
      }
      return <section className="eval-physician-card" key={physician.physician_id}>
        <div className="eval-physician-header">
          <div><h2>{physician.name}</h2><p className="eval-physician-meta">{physician.specialty} · Representation: {result?.representation_snapshot_id ?? physician.representation_snapshot_id}</p></div>
          <button className="button-primary" disabled={running === physician.physician_id} onClick={() => void run(physician.physician_id)}>{running === physician.physician_id ? 'Running…' : 'Run evaluations'} <span>→</span></button>
        </div>
        <p className="eval-case-count">{physicianCases.length} case{physicianCases.length === 1 ? '' : 's'}</p>
        {representationCases.length > 0 && <div className="eval-category-group">
          <p className="section-label">Representation / system evaluation</p>
          <ul className="eval-case-list">{representationCases.map(renderCaseRow)}</ul>
        </div>}
        {agentBehaviorCases.length > 0 && <div className="eval-category-group">
          <p className="section-label">Agent behavior evaluation (model-dependent)</p>
          <ul className="eval-case-list">{agentBehaviorCases.map(renderCaseRow)}</ul>
        </div>}
        {result && <p className="eval-metrics-line">Pass rate {Math.round(result.metrics.overall_assertion_pass_rate * 100)}% · Grounding {Math.round(result.metrics.grounding_correctness * 100)}% · Correct abstention {Math.round(result.metrics.correct_abstention * 100)}%</p>}
      </section>
    })}
    {detail && <EvalCaseDetailModal evalCase={detail.evalCase} run={detail.run} onClose={() => setDetail(null)} />}
  </main></ProductShell>
}

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
        <DemoResetControl patient="jordan" />
        <DemoResetControl patient="tonjit" />
        <TonjitEncounterSimulationControl />
      </section>
      <section className="profile-section">
        <h2>Internal / developer</h2>
        <p className="muted-note">Tests whether a physician's reconstructed agent behaves consistently with their confirmed Lamina representation -- not a patient-facing feature.</p>
        <button type="button" className="text-button" onClick={() => navigate('/settings/agent-evaluations')}>Physician agent evaluations →</button>
      </section>
      {user && <p className="muted-note profile-identity-link">This workspace's Dr. Lucy Saruhashi is a separate concept from your signed-in physician account. <button className="text-button" onClick={() => navigate('/claim/my-identities')}>My physician identities →</button></p>}
      <p className="muted-note">Read-only for this demonstration. Account settings, credentialing, and production practice verification are not implemented.</p>
    </>}
  </main></ProductShell>
}

function UnfinishedPatient({ patient, navigate }: { patient: DemoPatientSummary; navigate: Navigate }) {
  return <ProductShell navigate={navigate} section="patients"><main className="page-shell unfinished-page"><button className="text-button back-link" onClick={() => navigate('/patients')}>← All patients</button><div className="unfinished-card"><p className="eyebrow">Synthetic patient</p><h1>{patient.name}</h1><p className="unfinished-meta">{patient.age} years · {patient.location}</p><div className="unfinished-reason"><span>Reason for consult</span><strong>{patient.reason}</strong></div><p className="unfinished-stage-note">{patient.stageNote}</p><NetworkMark /><h2>This demo does not simulate a live agent consultation for {patient.name}.</h2><p>Choose Jordan Lee, Maria Santos, or Tonjit Askarov for a grounded physician-agent consultation. No recommendation has been fabricated for this patient.</p><button className="button-secondary" onClick={() => navigate(`/patients/${JORDAN_ID}`)}>Open Jordan Lee demo</button></div></main></ProductShell>
}

const physicianInitials = (name: string) => name.replace('Dr. ', '').replace(' (synthetic)', '').split(/\s+/).map((part) => part[0]).slice(0, 2).join('')
const evidenceFor = (evaluation: Evaluation, kind: string) => evaluation.evidence.find((item) => item.kind === kind)?.detail
const insuranceLabel = (status: string) => status.startsWith('In network') ? 'In-network' : 'Network unknown'

/** Care-routing demo pass, Part M/W: explainable categories, never a
 * numeric score -- Strong/High/Preferred etc., not "92% match". */
const fitLabelText = (fit: CandidateFitLabel) => fit === 'strong' ? 'Strong' : fit === 'moderate' ? 'Moderate' : fit === 'poor' ? 'Limited' : 'Potential'
const confidenceLabelText = (confidence: EvidenceConfidence) => confidence === 'high' ? 'High' : confidence === 'medium' ? 'Medium' : confidence === 'low' ? 'Low' : 'Unverified'
/** Evidence-confidence/connectivity, never a physician-quality tier (Part J). */
const networkParticipationLabel = (participation: NetworkParticipation) => participation === 'integrated_network' ? 'Integrated network' : participation === 'lamina_physician' ? 'Lamina physician' : 'External directory'
const econsultSuitabilityLabel = (suitability: EconsultSuitability) => suitability === 'suitable' ? 'Suitable' : suitability === 'possible_not_preferred' ? 'Possible, not preferred' : 'Not suitable'
const messageSender = (message: ConsultationMessage) => message.sender_agent_id === PCP_AGENT_ID ? `${PCP_NAME} Agent` : message.sender_name

/** Pre-NLP cleanup pass, Part A/B: a durable audit-event taxonomy -- every
 * entry reads as a typed record (Clarification requested/resolved,
 * Requirement identified, Route recommended, ...), never as a labeled
 * turn in a back-and-forth exchange. `fit_response` keeps its own
 * sharper "{fit} fit" conclusion label (already audit-style, more
 * specific than a generic "Fit conclusion returned" would be). */
const MESSAGE_TYPE_LABELS: Record<ConsultationMessage['message_type'], string> = {
  consult_request: 'Consult requested',
  fit_response: 'Fit conclusion returned',
  redirect: 'Redirect returned',
  follow_up_question: 'Clarification requested',
  follow_up_answer: 'Clarification resolved',
  referral_requirement: 'Requirement identified',
  access_update: 'Access update',
  synthesis: 'Route recommended',
}
const messageLabel = (message: ConsultationMessage) => {
  if (message.message_type === 'fit_response') return `${String(message.metadata.clinical_fit || 'fit')} fit`
  return MESSAGE_TYPE_LABELS[message.message_type]
}

/** UX polish pass, Part 3B (follow-up pass, Part A/B): every physician shown
 * in routing/options should feel inspectable by clicking their avatar or
 * name. Lamina/integrated physicians reuse their existing profile surfaces
 * -- Chen and Maya both already have a full engagement-persona profile
 * (see PERSONAS in backend/engagement.py), and Dr. Okonkwo is a real
 * synthetic physician with an NPI directory entry even though she has no
 * engagement persona. The external-directory candidate (Okafor) has no
 * real Lamina identity at all -- she opens the SAME PhysicianProfilePage
 * shell as Okonkwo, via a local directory lookup instead of a backend NPI
 * fetch, never a separate one-off modal (Part B: "one shared physician-
 * profile architecture with state-driven differences"). This is a small,
 * closed, known set of physicians (this demo's routing surface), so it is
 * mapped directly rather than threading a new lookup through the backend. */
const ROUTING_PHYSICIAN_PERSONA: Record<string, string> = { [CHEN_ID]: 'chen', 'physician-ramanathan': 'maya' }
const ROUTING_PHYSICIAN_NPI: Record<string, string> = { 'physician-okonkwo': '9900000029' }
const ROUTING_DIRECTORY_PHYSICIANS: Record<string, DirectoryOnlyProfile> = {
  'external-directory-endocrinology-1': { physicianId: 'external-directory-endocrinology-1', name: 'Dr. Renata Okafor', specialty: 'Endocrinology' },
}

function PhysicianProfileLink({ physicianId, navigate, children, className }: {
  physicianId: string; navigate: Navigate; children: ReactNode; className?: string
}) {
  const persona = ROUTING_PHYSICIAN_PERSONA[physicianId]
  const npi = ROUTING_PHYSICIAN_NPI[physicianId]
  const directoryId = ROUTING_DIRECTORY_PHYSICIANS[physicianId]?.physicianId
  return <button
    type="button"
    className={`physician-profile-link ${className ?? ''}`}
    onClick={() => { if (persona) navigate(networkProfilePath('lucy', persona)); else if (npi) navigate(`/network/${npi}`); else if (directoryId) navigate(`/network/directory/${directoryId}`) }}
  >{children}</button>
}

function ConsultationLog({ messages, focusEventId, highlight }: { messages: ConsultationMessage[]; focusEventId?: string | null; highlight?: boolean }) {
  const stages = groupConsultationMessages(messages)
  // Pre-NLP cleanup pass, Part A/D: the event TYPE leads each row (an
  // audit-log pattern -- "what kind of record is this"), then who
  // returned it, then the fact itself -- never a bold speaker name
  // followed by quoted-sounding content, which is what made this read
  // like a chat turn even though the underlying data was always
  // structured. Same three pieces of text as before, just reordered and
  // relabeled; no fact/content was altered.
  return <div className="consult-record-stages"><header><strong>Structured consultation record</strong><small>{messages.length} backend events · original sequence preserved</small></header>{stages.map((stage) => <section className={`consult-record-stage ${stage.kind}`} key={stage.id}><div className="consult-record-stage-heading"><span>{stage.title}</span><small>{stage.messages.length} event{stage.messages.length === 1 ? '' : 's'}</small></div><div className="consult-record-events">{stage.messages.map((message) => <details className={`consult-record-event ${message.id === focusEventId ? 'targeted' : ''} ${message.id === focusEventId && highlight ? 'event-focus' : ''}`} id={eventDomId(message.id)} open={message.id === focusEventId} key={message.id}><summary><span>{message.sequence.toString().padStart(2, '0')}</span><div><em>{messageLabel(message)}</em><strong>{messageSender(message)}</strong><small>{message.summary}</small></div></summary><div className="consult-record-evidence"><p>{message.sender_role} → {message.recipient_agent_id === PCP_AGENT_ID ? PCP_AGENT_NAME : message.recipient_agent_id === 'network' ? 'Physician network' : 'Specialist agent'}</p>{message.related_patient_facts.map((fact) => <p key={fact}><b>Patient fact</b>{fact}</p>)}{message.evidence.map((item, index) => <p key={`${index}-${item.kind}`}><b>{item.kind.replaceAll('_', ' ')}</b>{item.detail}</p>)}{!message.evidence.length && !message.related_patient_facts.length && <p>No additional structured evidence on this event.</p>}</div></details>)}</div></section>)}</div>
}

function RecommendationView({
  consultation, navigate, focusEventId = null, recordId, referralQuestion = null, justConsulted = false, onReconsult,
}: {
  consultation: Consultation; navigate: Navigate; focusEventId?: string | null; recordId?: number; referralQuestion?: string | null
  /** Demo-consolidation pass, Part 6: true only for the single mount right
   * after an explicit "Consult network" re-run produced THIS consultation
   * -- read once via lazy useState init below (mirrors restoredReferral's
   * own pattern), so a later reload of the same page never re-suppresses
   * hydration's normal "restore the existing episode" behavior. */
  justConsulted?: boolean
  onReconsult?: () => void
}) {
  const [networkOpen, setNetworkOpen] = useState(Boolean(focusEventId))
  const [highlight, setHighlight] = useState(Boolean(focusEventId))
  const [detailsOpen, setDetailsOpen] = useState(false)
  const [alternativesOpen, setAlternativesOpen] = useState(false)
  const [referralStarted, setReferralStarted] = useState(false)
  const [affirmed, setAffirmed] = useState(false)
  // Match-recommendation feedback (demo-consolidation pass, Part 29) -- a
  // compact inline surface, not a navigation away to the older calibration
  // flow. Saved as an AgentCorrection (pending_training), never applied to
  // the agent immediately.
  const [feedbackOpen, setFeedbackOpen] = useState(false)
  const [feedbackReason, setFeedbackReason] = useState<string | null>(null)
  const [feedbackText, setFeedbackText] = useState('')
  const [feedbackSaving, setFeedbackSaving] = useState(false)
  const [feedbackSaved, setFeedbackSaved] = useState(false)
  const [selectedId, setSelectedId] = useState(consultation.recommended_physician.physician_id)
  // UX polish pass, Part 3A: Dr. Chen's e-consult route is now a real
  // selectable alternative, kept orthogonal to `selectedId` (he's the same
  // physician either way) rather than encoded into a synthetic second id --
  // resets to 'in_person' whenever a different route is picked.
  const [selectedModality, setSelectedModality] = useState<CareModality>('in_person')
  const [swapping, setSwapping] = useState(false)
  // Care-routing demo pass, Part E: physician-confirmable, agent-suggested
  // priority. Defaults to the agent's own suggestion when a CareRoutingAssessment
  // exists (e.g. "soon" for Tonjit); otherwise "routine", matching the
  // backend's own pre-existing default -- a patient with no routing data
  // behaves exactly as before this pass. Edited here, then sent once at
  // referral-creation time; never silently upgraded afterward.
  const [priority, setPriority] = useState<ReferralPriority>(consultation.care_routing?.suggested_priority ?? 'routine')
  // Mirrors ReferralCoordinationSurface's brief live completion moment -- the
  // wash background lives on this card (see .handoff-wash in styles.css), not
  // on a separately-shaped overlay, so it can never mismatch the card's own
  // border-radius (Part H). Only ever true during a live Start-referral run.
  const [washActive, setWashActive] = useState(false)
  // Reported up from ReferralCoordinationSurface the moment Lucy has
  // actually reviewed the returned handoff (demo-consolidation pass, Part
  // 7-10) -- once true, the specialty episode recedes and this component
  // renders a generic current-care-state card instead of "Referral to Dr.
  // X". Never decided here directly; always the child's own real fact.
  // `null` means "not yet known" (bug-fix pass, Part Q) -- on a restored
  // consult_returned referral, the child withholds its report until the
  // real handoff has loaded, so this must NOT default to `false` (which
  // would render the "Referral to Dr. X" framing immediately, then flash
  // to the generic state once the real answer arrives a moment later).
  const [episodeReviewed, setEpisodeReviewed] = useState<boolean | null>(null)
  // Discovery vs. Referral are frontend presentation modes only -- never a
  // backend referral status, and never persisted client-side either. See
  // Part B. `activeReferral` is populated purely by asking the backend
  // (hydration effect below); there is no local fabrication of referral state.
  const [viewMode, setViewMode] = useState<'discovery' | 'referral'>('discovery')
  const [activeReferral, setActiveReferral] = useState<Referral | null>(null)
  // Hydration-flash fix (polish pass, Part D): `viewMode` defaults to
  // 'discovery' and only flips to 'referral' once the hydration fetch below
  // resolves -- without this flag, a patient who already has a referral
  // briefly rendered in Discovery mode (or replayed the live phase-reveal
  // animation) on every reload, before snapping to the real persisted state.
  // Starts `true` when there's no referral question at all (nothing to
  // hydrate), so patients who never have referrals render exactly as before.
  const [referralHydrated, setReferralHydrated] = useState(!referralQuestion)
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
  useEffect(() => {
    if (!networkOpen) return
    const onKey = (event: KeyboardEvent) => { if (event.key === 'Escape') setNetworkOpen(false) }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [networkOpen])
  /**
   * Hydration: on mount, ask the backend whether this patient already has a
   * referral -- e.g. from before a page reload -- rather than assuming none
   * exists. A persisted referral with a real (non-draft) status always wins
   * over whatever the user was doing before the reload (Part L): the right
   * rail defaults to Referral mode, never back to Discovery, when one exists.
   */
  useEffect(() => {
    if (!referralQuestion) return
    let ignore = false
    setReferralHydrated(false)
    getActiveReferral(consultation.patient_id).then((existing) => {
      if (ignore || !existing) return
      setActiveReferral(existing)
      // Part 6: right after an explicit re-consult, stay in Discovery mode
      // showing the NEW recommendation -- still track the prior episode (for
      // the "already referred"/duplicate-guard notices) but don't snap back
      // into it. `justConsulted` is intentionally NOT in this effect's own
      // dependency array (see the prop's own doc comment): it is read once,
      // from the closure captured at mount.
      if (justConsulted) return
      const phase = restorePhase(existing)
      if (phase) {
        setSelectedId(existing.receiving_physician_id)
        setViewMode('referral')
      }
    }).catch(() => {}).finally(() => { if (!ignore) setReferralHydrated(true) })
    return () => { ignore = true }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [consultation.patient_id, referralQuestion])
  const primary = consultation.recommended_physician
  const historical = evidenceFor(primary, 'historical_practice_similarity')
  const operational = evidenceFor(primary, 'operational')
  // Agent recommendation vs. physician selection are deliberately never
  // conflated: `selected` drives every visible field, but `primary` (the
  // agent's own top pick) is always known separately -- see isAgentPick.
  /** Routing/triage UX pass, Part K: a route presented only via the new
   * routing model (never the real evaluate_physician pipeline) is made
   * genuinely selectable -- never a fake dead CTA -- by synthesizing a
   * minimal, compatible Evaluation so the EXACT SAME selectCandidate/
   * candidates mechanism Dr. Okonkwo already uses just works for it too.
   * Only in-person, non-external-directory routes qualify here: this
   * mechanism is for a DIFFERENT physician being added to `candidates` --
   * Chen's own e-consult route (UX polish pass, Part 3A) doesn't need it at
   * all, since it's the same physician/Evaluation already in `candidates`,
   * just a different `selectedModality` (see below); an external-directory
   * candidate was never actually verified to exist in Lamina's own systems
   * (Part I) -- selecting her via THIS path would be unsafe/broken. */
  const routeToEvaluation = (route: CandidateRoute): Evaluation => ({
    physician_id: route.physician_id,
    physician_name: route.physician_name,
    specialty: route.specialty,
    clinical_fit: route.fit_label === 'strong' ? 'strong' : route.fit_label === 'moderate' ? 'moderate' : 'poor',
    accepts_case: true,
    reason: route.rationale ?? '',
    evidence: [],
    required_workup: [],
    urgency: '',
    availability: route.access.in_person_wait_label,
    insurance_status: 'Not independently verified for this option (synthetic demo).',
    confidence: route.evidence_confidence === 'unverified' ? 'low' : route.evidence_confidence,
  })
  const selectableRoutes = consultation.candidate_routes.filter((route) => !route.recommended && route.modality === 'in_person' && route.network_participation !== 'external_directory')
  const candidates = [primary, ...consultation.alternatives, ...selectableRoutes.map(routeToEvaluation)]
  const selected = candidates.find((item) => item.physician_id === selectedId) ?? primary
  // UX polish pass, Part 3A: when the physician actually selected Dr.
  // Chen's e-consult route, the e-consult-specific access fact (not his
  // in-person wait label) is what should display -- `selected` itself
  // stays the same Evaluation either way (same physician).
  const selectedEconsultRoute = selectedModality === 'econsult'
    ? consultation.candidate_routes.find((route) => route.physician_id === selectedId && route.modality === 'econsult')
    : undefined
  /** Routing consolidation pass, Part D/E: physician-case fit and the
   * selected route are separate backend computations; "Why Dr. X" reads
   * both, never a single opaque value. Absent for unrouted cases. */
  const selectedFit = consultation.physician_fits?.find((fit) => fit.physician_id === selectedId)
  const selectedRoute = consultation.candidate_routes.find((route) => route.physician_id === selectedId && route.modality === selectedModality)
  const patientFirstName = patientName(consultation.patient_id).split(' ')[0]
  const whyLines = selectedFit ? whyThisMatch(selectedFit, selectedRoute, patientFirstName) : []
  /** Routing/triage UX pass, Part J/K (polish pass, Part 1): ONE canonical
   * "Other options" list, merging the pre-existing real alternatives
   * (Okonkwo, via consultation.alternatives) with the new routing model's
   * non-recommended routes (Maya, Chen's e-consult route, the
   * external-directory candidate) -- never two out-of-sync surfaces. Empty
   * when there's no routing data, since that case keeps the pre-existing
   * "Other referral options" disclosure entirely unchanged. */
  const routeRow = (route: CandidateRoute) => ({
    key: `${route.physician_id}-${route.modality}`,
    physicianId: route.physician_id,
    name: cleanName(route.physician_name),
    specialty: route.specialty,
    modality: route.modality,
    fitText: `${fitLabelText(route.fit_label)} fit`,
    networkText: networkParticipationLabel(route.network_participation) as string | null,
    accessText: (route.modality === 'in_person' ? route.access.in_person_wait_label : (route.access.econsult_response_label ?? 'Unverified')).replace('Approximately ', '~'),
    rationale: route.rationale,
    // UX polish pass, Part 3A: Chen's e-consult route is now a real
    // selectable alternative too -- only the external-directory candidate
    // (no verified Lamina identity to refer to) stays informational-only.
    selectable: route.network_participation !== 'external_directory',
    isAgentPick: false,
  })
  const alternativeRow = (option: Evaluation) => ({
    key: option.physician_id,
    physicianId: option.physician_id,
    name: cleanName(option.physician_name),
    specialty: option.specialty,
    modality: 'in_person' as const,
    fitText: `${option.clinical_fit === 'strong' ? 'Strong' : option.clinical_fit === 'moderate' ? 'Moderate' : 'Limited'} fit`,
    networkText: null as string | null,
    accessText: option.availability.replace('Approximately ', '~'),
    rationale: option.reason as string | null,
    selectable: true,
    isAgentPick: option.physician_id === primary.physician_id,
  })
  /** UX polish pass, Part 1: an explicit, deliberate order -- Dr. Chen's own
   * in-person route first (the recommended route -- always shown here
   * when it isn't the current selection, Follow-up pass Part A/B/D), then
   * Maya (the stronger alternative to Chen), then Chen's own e-consult
   * route (a real alternative route to the SAME strong-fit physician, not
   * a competing physician), then Dr. Okonkwo (clinically appropriate but
   * materially worse access, so ranked below the Lamina-network options
   * rather than beside them), then the external-directory candidate last
   * (unverified). Never left to incidental concatenation order, which
   * previously let Okonkwo's ~30-day access read as competitively placed
   * against Chen/Maya. Any future route/alternative this demo doesn't
   * explicitly name still appears, appended after -- never silently
   * dropped. */
  const chenInPersonRoute = consultation.candidate_routes.find((route) => route.recommended)
  const mayaRoute = consultation.candidate_routes.find((route) => route.physician_id === 'physician-ramanathan')
  const chenEconsultRoute = consultation.candidate_routes.find((route) => route.physician_id === CHEN_ID && route.modality === 'econsult')
  const okonkwoAlternative = consultation.alternatives.find((option) => option.physician_id === 'physician-okonkwo')
  const externalDirectoryRoute = consultation.candidate_routes.find((route) => route.network_participation === 'external_directory')
  const namedRouteKeys = new Set([chenInPersonRoute, mayaRoute, chenEconsultRoute, externalDirectoryRoute].filter((route): route is CandidateRoute => Boolean(route)).map((route) => `${route.physician_id}-${route.modality}`))
  /** Follow-up pass, Part A-D: ONE canonical route list, unfiltered, used
   * both for the consultation-details "routes considered" accounting
   * (Part J) and -- filtered down to whichever route ISN'T the current
   * selection -- for "Other options" below. This is what makes Chen
   * in-person/e-consult switching reversible: Chen's in-person route is
   * just another row in this same list, never special-cased, so whichever
   * route (physician + modality) isn't currently selected simply reappears
   * here as a normal selectable option -- physician selection and modality
   * selection stay orthogonal, never a one-way trap. */
  const allOptionRows = consultation.care_routing ? [
    ...(chenInPersonRoute ? [{ ...routeRow(chenInPersonRoute), isAgentPick: true }] : []),
    ...(mayaRoute ? [routeRow(mayaRoute)] : []),
    ...(chenEconsultRoute ? [routeRow(chenEconsultRoute)] : []),
    ...(okonkwoAlternative ? [alternativeRow(okonkwoAlternative)] : []),
    ...(externalDirectoryRoute ? [routeRow(externalDirectoryRoute)] : []),
    ...consultation.alternatives.filter((option) => option.physician_id !== 'physician-okonkwo').map(alternativeRow),
    ...consultation.candidate_routes.filter((route) => !namedRouteKeys.has(`${route.physician_id}-${route.modality}`)).map(routeRow),
  ] : []
  const otherOptionRows = allOptionRows.filter((row) => !(row.physicianId === selectedId && row.modality === selectedModality))
  /** Follow-up pass, Part G-K: "physician agents consulted" must count
   * unique PHYSICIANS, never routes -- Chen's in-person and e-consult
   * routes are the same agent, counted once (Part H). Merges the real
   * evaluate_physician responses (consultation.consultation -- Chen/
   * Okonkwo/Torres for Tonjit) with whichever additional physician the
   * newer routing model itself evaluated that isn't already in that list
   * (Maya) -- her CandidateRoute already carries a real structured
   * rationale/fit (never fabricated). The external-directory candidate is
   * deliberately excluded: no Lamina agent ever evaluated her (Part K). */
  const routingOnlyAgents = consultation.candidate_routes
    .filter((route) => route.network_participation !== 'external_directory')
    .filter((route) => !consultation.consultation.some((agent) => agent.physician_id === route.physician_id))
    .reduce<{ physician_id: string; physician_name: string; reason: string }[]>((unique, route) => {
      if (unique.some((item) => item.physician_id === route.physician_id)) return unique
      unique.push({ physician_id: route.physician_id, physician_name: route.physician_name, reason: route.rationale ?? '' })
      return unique
    }, [])
  const consultedPhysicianCount = new Set([
    ...consultation.consultation.map((agent) => agent.physician_id),
    ...routingOnlyAgents.map((agent) => agent.physician_id),
  ]).size
  // Follow-up pass, Part D: the RECOMMENDED route (Chen, in-person) never
  // changes just because Lucy is trying out a different one -- these two
  // booleans separately track "different physician than recommended" and
  // "same physician, different modality than recommended", so the kicker/
  // provenance copy below can say something true in either case, without
  // ever rewriting consultation.care_routing itself.
  const physicianDiffersFromRecommendation = selected.physician_id !== primary.physician_id
  const modalityDiffersFromRecommendation = !physicianDiffersFromRecommendation && selectedModality !== 'in_person'
  const isAgentPick = !physicianDiffersFromRecommendation && !modalityDiffersFromRecommendation
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
  const selectCandidate = (physicianId: string, modality: CareModality = 'in_person') => {
    if (physicianId === selectedId && modality === selectedModality) return
    if (swapping) return
    if (prefersReducedMotion()) { setSelectedId(physicianId); setSelectedModality(modality); setReferralStarted(false); return }
    setSwapping(true)
    window.setTimeout(() => {
      setSelectedId(physicianId); setSelectedModality(modality); setReferralStarted(false)
      requestAnimationFrame(() => requestAnimationFrame(() => setSwapping(false)))
    }, 150)
  }
  /**
   * Once the physician clicks Start referral, the referral workflow object
   * replaces the recommendation as the primary thing on screen (Part A) --
   * a frontend view-mode switch only, reusing the exact same restrained
   * fade the candidate-switcher above already uses (one stable surface
   * morphing, never a hard remount flash). Respects reduced motion.
   */
  const startReferral = () => {
    if (prefersReducedMotion()) { setViewMode('referral'); return }
    setSwapping(true)
    window.setTimeout(() => {
      setViewMode('referral')
      requestAnimationFrame(() => requestAnimationFrame(() => setSwapping(false)))
    }, 150)
  }
  const activeReferralPhysician = activeReferral ? candidates.find((item) => item.physician_id === activeReferral.receiving_physician_id) : undefined
  const activeReferralPhysicianLabel = activeReferralPhysician ? cleanName(activeReferralPhysician.physician_name) : 'another specialist'

  /**
   * Save match-recommendation feedback as an AgentCorrection (Part 29) --
   * a physician-owned, pending_training artifact, never applied to the
   * agent immediately. Self-correction (no referral exists yet at this
   * point), so physician_id is the physician's own agent id.
   */
  const saveRecommendationFeedback = async () => {
    const reasonPrefix = feedbackReason ? `${feedbackReason}. ` : ''
    const correctionText = `${reasonPrefix}${feedbackText}`.trim()
    if (!correctionText) return
    setFeedbackSaving(true)
    try {
      await createAgentCorrection(consultation.patient_id, PCP_AGENT_ID, correctionText)
      setFeedbackSaved(true)
    } finally {
      setFeedbackSaving(false)
    }
  }

  // Hydration gate (Part D): render NEITHER Discovery's "best fit" framing
  // NOR a live phase-reveal animation until we authoritatively know whether
  // a referral already exists. A quiet neutral placeholder only -- never a
  // guessed historical state -- using the same card shell either real
  // outcome will use, so there is no layout jump once hydration resolves.
  if (referralQuestion && !referralHydrated) {
    return <section className="recommendations referral-mode" aria-label="Referral status" tabIndex={-1}>
      <article className="best-fit-card compact referral-card">
        <div className="next-step-card idle"><p className="muted-note">Opening referral…</p></div>
      </article>
    </section>
  }

  // REFERRAL MODE -- "what is happening with this referral?" replaces
  // "who should I refer this patient to?" as the primary surface (Part A/B).
  // Discovery-only content (fit rationale, feedback, match details,
  // alternatives, consult detail) is not rendered at all here, not merely
  // hidden (Part F/M/N).
  if (referralQuestion && viewMode === 'referral') {
    const coordinationSurface = <ReferralCoordinationSurface
      key={selected.physician_id}
      patientId={consultation.patient_id}
      patientLabel={patientName(consultation.patient_id)}
      receivingPhysicianId={selected.physician_id}
      receivingPhysicianName={cleanName(selected.physician_name)}
      onWashChange={setWashActive}
      onReferralChange={setActiveReferral}
      onReviewedChange={setEpisodeReviewed}
      restoredReferral={activeReferral}
      priority={priority}
      modality={selectedModality}
    />
    // Reload-flash fix (bug-fix pass, Part Q/O): on a restored consult_returned
    // referral, the child withholds onReviewedChange until the real handoff
    // has loaded, so `episodeReviewed` stays `null` ("not yet known") for a
    // moment. Rendering NEITHER branch during that window -- just a neutral
    // placeholder, reusing the same "Opening referral…" idle-card pattern as
    // the outer hydration gate above -- is what actually prevents the
    // "Referral to Dr. X" / "Specialist follow-up received" flash before
    // snapping to the generic post-episode state.
    if (activeReferral?.status === 'consult_returned' && episodeReviewed === null) {
      return <section className="recommendations referral-mode" aria-label="Referral status" tabIndex={-1}>
        <h2>Current care state</h2>
        <article className="best-fit-card compact referral-card">
          {coordinationSurface}
        </article>
      </section>
    }
    // Once Lucy has reviewed the returned handoff, Chen stops dominating the
    // primary current-care state (demo-consolidation pass, Part 7C/9) --
    // the episode itself (artifact links, chat, "View handoff") recedes
    // into ReferralCoordinationSurface's own collapsed rendering below;
    // this generic card is the only thing that was EVER Chen-specific here.
    if (episodeReviewed) {
      return <section className="recommendations referral-mode" aria-label="Referral status" tabIndex={-1}>
        <h2>Current care state</h2>
        <p className="page-intro">Your agent helps with the follow-through.</p>
        <article className="best-fit-card compact referral-card">
          {/* Bug-fix pass, Part J: no status pill here -- the previous
           * resolved-status badge made this card feel overly
           * state-machine-like. A plain, calm headline + one action is the
           * whole card now; Chen's identity/referral framing stays gone. */}
          <div className="next-step-card idle">
            <h3>{cleanName(selected.physician_name)}'s consultation has been reviewed.</h3>
            <p>{patientName(consultation.patient_id)} is ready for whatever care need comes next.</p>
            <button type="button" className="consult-button" onClick={onReconsult}>Consult network <span className="spark-icon" aria-hidden="true">✧</span></button>
          </div>
        </article>
        {coordinationSurface}
        <p className="disclaimer">{consultation.disclaimer}</p>
      </section>
    }
    // Chat is a sibling CARD of the "Referral to Dr. X" card, never nested
    // inside its border (bug-fix pass, Part C) -- both belong to "Current
    // care state", but neither contains the other. Gated on the same real
    // backend fact (ACCEPTED_OR_LATER_STATUSES) ReferralCoordinationSurface
    // used to gate this internally, now read directly from activeReferral
    // (kept live via onReferralChange) rather than duplicated child state.
    const activeEpisodeChat = activeReferral && activeReferral.id && ACCEPTED_OR_LATER_STATUSES.includes(activeReferral.status) && <CoordinationChatCard
      referral={activeReferral}
      patientLabel={patientName(consultation.patient_id)}
      requestingPhysicianId={activeReferral.referring_physician_id}
      representedPhysicianId={activeReferral.receiving_physician_id}
      representedPhysicianName={cleanName(selected.physician_name)}
      representedTone="copper"
      suggestedPrompts={lucySuggestedPrompts(patientName(consultation.patient_id), cleanName(selected.physician_name), selected.specialty)}
    />
    return <section className="recommendations referral-mode" aria-label="Referral status" tabIndex={-1}>
      <h2>Current care state</h2>
      <p className="page-intro">Your agent helps with the follow-through.</p>
      <article className={`best-fit-card compact referral-card ${swapping ? 'swapping' : ''} ${washActive ? 'handoff-wash' : ''}`}>
        <button type="button" className="text-button back-to-match" onClick={() => setViewMode('discovery')}>← Back to match options</button>
        <p className="best-fit-kicker">Referral to</p>
        <div className="best-fit-physician"><span className="physician-avatar">{physicianInitials(selected.physician_name)}</span><div><h2>{cleanName(selected.physician_name)}</h2><p>{selected.specialty}</p></div></div>
        {coordinationSurface}
      </article>
      {activeEpisodeChat}
      <p className="disclaimer">{consultation.disclaimer}</p>
    </section>
  }

  // DISCOVERY MODE -- the original "who should I refer this patient to?"
  // experience, unchanged, plus a quiet notice when a referral already
  // exists so the physician never loses track of it while browsing options.
  return <section className="recommendations" aria-label="Specialist recommendations" tabIndex={-1}>
    {activeReferral && <div className="referral-active-notice">
      <div><strong>{activeReferral.status === 'accepted' ? `Referral accepted by ${activeReferralPhysicianLabel}` : `Referral active with ${activeReferralPhysicianLabel}`}</strong><span>{activeReferral.status === 'accepted' ? 'Added to their care' : 'Awaiting specialist review'}</span></div>
      <button type="button" className="text-button" onClick={() => setViewMode('referral')}>Return to active referral →</button>
    </div>}
    <div className={`next-step-card ready ${swapping ? 'swapping' : ''}`}>
      <span className="status-label resolved"><span className="spark-icon lead" aria-hidden="true">✓</span>Your agent got back to you</span>
      <h3>A specialist is ready for your review.</h3>
      <p>Review the match below, then choose how to move care forward.</p>
    </div>
    {/* Routing/triage UX pass, Part A-D: renamed from "Care routing" (too
     * abstract/internal-sounding) to "Recommended care path" -- the compact
     * block above the physician match where Lamina decides the appropriate
     * specialty-care ROUTE (specialty + modality + priority) before merely
     * ranking doctors. Specialty and modality are deliberately two separate
     * lines, never combined into one opaque phrase. Priority is ALWAYS the
     * directly-editable chip row -- there is no separate edit-mode/Edit
     * button (Part C). Absent entirely for any case this pass doesn't
     * populate (care_routing === null), so every other patient's Discovery
     * mode renders exactly as before. */}
    {consultation.care_routing && <section className="care-routing-block">
      <p className="section-label">Recommended care path</p>
      <h3>{consultation.care_routing.specialty}</h3>
      <p className="care-routing-modality">{consultation.care_routing.recommended_modality === 'in_person' ? 'In-person is appropriate for this presentation' : 'E-consult recommended'}</p>
      <div className="care-routing-priority">
        <span className="section-label">Priority</span>
        <PriorityChipRow priority={priority} onChange={setPriority} />
        {priority === consultation.care_routing.suggested_priority && <small className="care-routing-priority-note">Suggested by your agent</small>}
      </div>
      <p className="care-routing-rationale">{consultation.care_routing.rationale}</p>
      <p className="care-routing-footnote">{consultation.care_routing.recommended_modality === 'in_person' && consultation.care_routing.modality_viability?.econsult !== 'not_viable'
        ? 'E-consult remains an alternative modality for other appropriate cases. Access and alternative routes considered.'
        : 'Access and alternative care routes considered.'}</p>
    </section>}
    {/* Compact by default (see design_references/) -- only name, specialty, one fit
     * indicator, one metadata line, one rationale sentence, and the primary action.
     * Everything denser lives behind "Review match details" below. */}
    <article className={`best-fit-card compact ${swapping ? 'swapping' : ''}`}>
      {/* Follow-up pass, Part D: the kicker distinguishes all three real
       * states -- the exact recommended route, a different physician than
       * recommended, or the SAME recommended physician on a different
       * route (e-consult) -- never conflating "different route" with
       * "different physician". */}
      <p className="best-fit-kicker">{isAgentPick ? 'Recommended physician' : physicianDiffersFromRecommendation ? 'Selected specialist' : 'Selected route'}</p>
      {/* UX polish pass, Part 3B: the avatar and name are both clickable --
       * every physician shown here should feel inspectable. */}
      <div className="best-fit-physician">
        <PhysicianProfileLink physicianId={selected.physician_id} navigate={navigate} className="physician-avatar-link">
          <span className="physician-avatar">{physicianInitials(selected.physician_name)}</span>
        </PhysicianProfileLink>
        <div><h2><PhysicianProfileLink physicianId={selected.physician_id} navigate={navigate}>{cleanName(selected.physician_name)}</PhysicianProfileLink></h2><p>{selected.specialty}</p></div>
      </div>
      {physicianDiffersFromRecommendation && <p className="selection-provenance">Selected by you</p>}
      {modalityDiffersFromRecommendation && <p className="selection-provenance">E-consult request — selected by you</p>}
      {whyLines.length > 0
        ? <section className="why-this-match" aria-label="Why this match">
          <p className="section-label">Why this match</p>
          <ul className="why-this-match-list">{whyLines.map((line) => <li key={line.key}><strong>{line.label}</strong><span>{line.detail}</span></li>)}</ul>
        </section>
        : <>
          <p className="fit-indicator">{selected.clinical_fit === 'strong' ? 'Strong clinical fit' : selected.clinical_fit === 'moderate' ? 'Moderate clinical fit' : 'Limited clinical fit'}</p>
          <p className="fit-meta">{insuranceLabel(selected.insurance_status)} · {selectedEconsultRoute ? (selectedEconsultRoute.access.econsult_response_label ?? 'Response time unverified') : selected.availability}</p>
          <p className="fit-rationale">{selected.reason}</p>
        </>}
      {/* Backend/view-mode navigation can never bypass real workflow state
       * (demo-consolidation pass, Part 3): once a real referral already
       * exists to THIS physician, "Start referral" never renders again here
       * -- regardless of whether the physician reached this card by
       * reloading, or by live-navigating "Back to match options" after just
       * creating it this same session (see ReferralCoordinationSurface's
       * onReferralChange, which keeps activeReferral from ever going stale
       * mid-session). The backend's own duplicate-referral guard is a second,
       * independent line of defense, not the only one. */}
      <div className="best-fit-actions">{referralQuestion
        ? activeReferral && activeReferral.receiving_physician_id === selected.physician_id
          ? <div className="referral-episode-status" role="status">
              <span><span aria-hidden="true">✓</span> {activeReferral.status === 'consult_returned' ? 'Referral completed' : 'Referral active'}</span>
              <button type="button" className="button-primary" onClick={() => setViewMode('referral')}>
                {activeReferral.status === 'consult_returned' ? 'View specialty-care episode →' : 'Return to current referral →'}
              </button>
            </div>
          : activeReferral
            ? <p className="referral-locked-note">A referral is already active with {activeReferralPhysicianLabel}.</p>
            : <button className="button-primary" onClick={startReferral}>{selectedModality === 'econsult' ? 'Start e-consult request' : 'Start referral'} <span>→</span></button>
        : <><button className="button-primary" onClick={() => setReferralStarted(true)}>Start referral <span>→</span></button>{referralStarted && <div className="referral-prepared" role="status"><strong>Referral prepared for demo</strong><span>Destination: {cleanName(selected.physician_name)} · {selected.specialty}</span><span>Workup: {selected.required_workup.join(' · ') || 'None specified'}</span><span>No referral was transmitted.</span></div>}</>}</div>
    </article>

    {/* Part 29: a compact inline feedback surface, not a navigation away to
     * the older calibration flow -- "Not quite" opens reason chips + a free-
     * text note right here, saved as an AgentCorrection (pending_training),
     * never immediately applied to the agent. */}
    <div className="recommendation-feedback">
      <span>Was this recommendation right?</span>
      {affirmed
        ? <em role="status">Noted. Nothing was changed on your agent.</em>
        : feedbackSaved
          ? <em role="status">Noted. Saved as feedback for your agent to review.</em>
          : feedbackOpen
            ? null
            : <><button className="text-button" onClick={() => setAffirmed(true)}>Yes</button><button className="text-button" onClick={() => setFeedbackOpen(true)}>Not quite <b>→</b></button></>}
    </div>
    {!affirmed && !feedbackSaved && feedbackOpen && <div className="recommendation-feedback-panel">
      <p className="section-label">What should your agent have considered?</p>
      <div className="feedback-reason-chips">{['Wrong specialty', 'Wrong physician fit', 'Missed an important constraint', 'Rationale is wrong', 'Other'].map((reason) => <button
        key={reason} type="button"
        className={`feedback-reason-chip ${feedbackReason === reason ? 'selected' : ''}`}
        onClick={() => setFeedbackReason(reason === feedbackReason ? null : reason)}
      >{reason}</button>)}</div>
      <textarea
        className="feedback-reason-text"
        placeholder="What should your agent have considered?"
        value={feedbackText}
        onChange={(event) => setFeedbackText(event.target.value)}
      />
      <div className="feedback-reason-actions">
        <button type="button" className="text-button" onClick={() => setFeedbackOpen(false)}>Cancel</button>
        <button type="button" className="button-secondary" disabled={feedbackSaving || (!feedbackReason && !feedbackText.trim())} onClick={() => void saveRecommendationFeedback()}>{feedbackSaving ? 'Saving…' : 'Save feedback'}</button>
      </div>
    </div>}

    {/* One open surface -- whitespace and hairline rules separate groups,
     * never a bordered/shaded box nested inside the already-boxed card. */}
    <section className="options-section"><button className="options-toggle" aria-expanded={detailsOpen} onClick={() => setDetailsOpen(!detailsOpen)}>Review match details <span>{detailsOpen ? '−' : '+'}</span></button>
      {/* Routing/triage UX pass, Part F-M: reduced to THREE primary
       * sections -- Why this care path / Why Dr. X / Other options -- never
       * one opaque score, and never a separately-standing "Other referral
       * options" disclosure (merged below, Part J). The oversized "Why this
       * option won" block is gone; a small supporting line ("Why
       * recommended: ...") replaces it, visually subordinate to the
       * structured facts above it. Every other patient (no care_routing)
       * keeps the pre-existing structure, unchanged. */}
      {detailsOpen && <div className="match-details">{consultation.care_routing ? <>
        <div className="match-details-group">
          <p className="section-label">Why this care path</p>
          <dl className="route-fact-list">
            <div><dt>Specialty</dt><dd>{consultation.care_routing.specialty}</dd></div>
            <div><dt>Modality</dt><dd>{consultation.care_routing.recommended_modality === 'in_person' ? 'In-person evaluation' : 'E-consult'}</dd></div>
            <div><dt>Priority</dt><dd><PriorityChip priority={consultation.care_routing.suggested_priority} /></dd></div>
            <div><dt>E-consult</dt><dd>{econsultSuitabilityLabel(consultation.care_routing.econsult_suitability)}</dd></div>
            {consultation.care_routing.modality_viability && <div><dt>Clinically viable</dt><dd>Visit: {consultation.care_routing.modality_viability.visit === 'viable' ? 'yes' : 'no'} · E-consult: {consultation.care_routing.modality_viability.econsult === 'viable' ? 'yes' : consultation.care_routing.modality_viability.econsult === 'conditional' ? "only if the receiving physician's policy supports it" : 'no'}</dd></div>}
            {consultation.care_routing.priority_basis && <div><dt>Priority basis</dt><dd>{consultation.care_routing.priority_basis}</dd></div>}
          </dl>
        </div>
        {(() => {
          const recommendedRoute = consultation.candidate_routes.find((route) => route.recommended)
          if (!recommendedRoute) return null
          /** Routing consolidation pass, Part E: when structured fit
           * evidence exists, show every reason WITH where it came from
           * (similar-case history, confirmed preference, modality policy,
           * access, network) -- evidence, never model scratchpad. */
          const detailRoute = selectedRoute ?? recommendedRoute
          const detailFit = consultation.physician_fits?.find((fit) => fit.physician_id === detailRoute.physician_id)
          if (detailFit) {
            return <div className="match-details-group">
              <p className="section-label">Why {cleanName(detailRoute.physician_name)}</p>
              <ul className="match-evidence-list">{matchEvidence(detailFit, detailRoute).map((item, index) => <li key={`${item.category}-${index}`}>
                <span className="match-evidence-category">{EVIDENCE_CATEGORY_LABELS[item.category]}</span>
                <span className="match-evidence-summary">{item.summary}</span>
                <small className="match-evidence-source">Source: {item.source}</small>
              </li>)}</ul>
              {detailRoute.rationale && <p className="route-why-recommended"><span className="route-why-recommended-label">{detailRoute.recommended ? 'Why recommended:' : 'Route note:'}</span> {detailRoute.rationale}</p>}
            </div>
          }
          return <div className="match-details-group">
            <p className="section-label">Why {cleanName(recommendedRoute.physician_name)}</p>
            <dl className="route-fact-list">
              <div><dt>Practice fit</dt><dd>{fitLabelText(recommendedRoute.fit_label)}</dd></div>
              <div><dt>Network</dt><dd>{networkParticipationLabel(recommendedRoute.network_participation)}</dd></div>
              <div><dt>Evidence confidence</dt><dd>{confidenceLabelText(recommendedRoute.evidence_confidence)}</dd></div>
              <div><dt>In-person access</dt><dd>{recommendedRoute.access.in_person_wait_label}</dd></div>
              {recommendedRoute.access.econsult_response_label && <div><dt>E-consult response</dt><dd>{recommendedRoute.access.econsult_response_label}</dd></div>}
            </dl>
            {recommendedRoute.rationale && <p className="route-why-recommended"><span className="route-why-recommended-label">Why recommended:</span> {recommendedRoute.rationale}</p>}
          </div>
        })()}
        <div className="match-details-group">
          <p className="section-label">Other options</p>
          <ul className="other-options-list">{otherOptionRows.map((row) => <li key={row.key}>
            <div className="other-option-head">
              <strong><PhysicianProfileLink physicianId={row.physicianId} navigate={navigate}>{row.name}</PhysicianProfileLink>{row.modality === 'econsult' ? ' — E-consult' : ''}</strong>
              {row.isAgentPick && <span className="agent-pick-tag">Agent's top recommendation</span>}
            </div>
            <span className="other-option-specialty">{row.specialty}</span>
            <div className="other-option-facts">
              <span>{row.fitText}</span>
              {row.networkText && <span>{row.networkText}</span>}
              <span>{row.accessText}</span>
            </div>
            {row.rationale && <p className="other-option-rationale">{row.rationale}</p>}
            {/* UX polish pass, Part 3A: Chen's e-consult route is a real
             * selectable alternative now, reusing the same destination-
             * selection mechanism as every other selectable row here --
             * it just also carries its own modality, since it's the same
             * physician as the in-person recommendation above. */}
            {row.selectable && <button type="button" className="text-button" onClick={() => selectCandidate(row.physicianId, row.modality)}>{row.modality === 'econsult' ? 'Request e-consult' : 'Select this specialist'} <span>→</span></button>}
          </li>)}</ul>
        </div>
      </> : <>
        {reasons.length > 0 && <div className="match-details-group"><p className="section-label">Why this match</p><ul className="reason-list">{reasons.map((reason) => <li key={reason}><span>✓</span>{reason}</li>)}</ul>{selectedClarificationAnswer && <p className="clarification-note">Clarified before referral: {selectedClarificationAnswer.summary}</p>}</div>}
        <div className="match-details-group"><p className="section-label">Before referral</p><p className="before-visit-plain">{selected.required_workup.length > 0 ? selected.required_workup.map((item) => item.includes('(') ? item.match(/\(([^)]+)\)/)?.[1] : item).join('   ') : 'None specified'}</p></div>
        <div className="match-details-group"><p className="section-label">Access &amp; coverage</p><p className="access-coverage-line">{insuranceLabel(selected.insurance_status)} · {selected.availability}</p></div>
      </>}</div>}
    </section>

    {/* Routing/triage UX pass, Part J: the standalone "Other referral
     * options" disclosure is gone when routing data exists -- its content
     * now lives inside Review match details' unified "Other options"
     * group above. Every other patient (no care_routing) keeps this
     * disclosure exactly as before. */}
    {!consultation.care_routing && <section className="options-section"><button className="options-toggle" aria-expanded={alternativesOpen} onClick={() => setAlternativesOpen(!alternativesOpen)}>Other referral options <span>{alternativesOpen ? '−' : '+'}</span></button>
      {alternativesOpen && <div className="alternatives-list">{candidates.filter((item) => item.physician_id !== selectedId).map((option) => <div className="alternative-row" key={option.physician_id}>
        <div><strong>{cleanName(option.physician_name)}</strong><span>{option.specialty}</span>{option.physician_id === primary.physician_id && <span className="agent-pick-tag">Agent's top recommendation</span>}</div>
        <p>{option.reason}{option.availability ? ` · ${option.availability.replace('Approximately ', '~')}` : ''}</p>
        <button type="button" className="text-button" onClick={() => selectCandidate(option.physician_id)}>Select this specialist <span>→</span></button>
      </div>)}</div>}
    </section>}

    {/* Follow-up polish pass, Part F: the "⌄" glyph's own font metrics carry
     * visual ink below its line-box center, so no amount of flex/line-height
     * tuning on the character itself ever actually centers it -- replaced
     * with a small inline SVG chevron instead, which (as a replaced element)
     * centers reliably via the parent's flex alignment. */}
    <section className="network-transparency"><button className="network-transparency-toggle" onClick={() => setNetworkOpen(true)} aria-expanded={networkOpen}><span><b>How your agent handled this</b></span><em>View consultation details <svg className="disclosure-chevron" viewBox="0 0 12 8" width="10" height="7" aria-hidden="true"><path d="M1 1.5 6 6.5 11 1.5" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" /></svg></em></button></section>
    <p className="disclaimer">{consultation.disclaimer}</p>
    {networkOpen && <ModalPortal><div className="post-flow-overlay" role="presentation" onClick={(event) => { if (event.target === event.currentTarget) setNetworkOpen(false) }}>
      <div className="post-flow-dialog consult-detail-dialog" role="dialog" aria-modal="true" aria-label="Consultation details">
        <button className="text-button post-flow-close" onClick={() => setNetworkOpen(false)} aria-label="Close">×</button>
        <p className="eyebrow">Consultation details</p>
        <h2>How your agent handled this</h2>
        <div className="network-record">
          <p className="agent-consult-count">{consultedPhysicianCount} physician agent{consultedPhysicianCount === 1 ? '' : 's'} consulted</p>
          <div className="agent-handling"><div><span>Patient facts</span><ul>{consultation.patient_facts_used.map((fact) => <li key={fact}>{fact}</li>)}</ul></div>{explicitRule && <div><span>Physician rule</span><p>{explicitRule}</p></div>}<div><span>Specialist-agent responses</span><ul>{consultation.consultation.map((agent) => <li key={agent.physician_id}><b>{cleanName(agent.physician_name)}:</b> {agent.reason}</li>)}{routingOnlyAgents.map((agent) => <li key={agent.physician_id}><b>{cleanName(agent.physician_name)}:</b> {agent.reason}</li>)}</ul></div>{historical && <div><span>Practice footprint · fit signal, not quality</span><p>{historical}</p></div>}{operational && <div><span>Access consideration</span><p>{operational}</p></div>}</div>
          <ConsultationLog messages={consultation.messages} focusEventId={focusEventId} highlight={highlight} />
          <div className="evaluation-record-heading">Physician evaluation records</div>{consultation.consultation.map((agent) => { const rule = evidenceFor(agent, 'explicit_physician_rule'); const history = evidenceFor(agent, 'historical_practice_similarity'); return <details key={agent.physician_id} open={agent.physician_id === primary.physician_id}><summary><span className="mini-avatar">{physicianInitials(agent.physician_name)}</span><span className="agent-name"><b>{cleanName(agent.physician_name)}</b><small>{agent.specialty}</small></span><span className={`decision-badge ${agent.clinical_fit}`}>{agent.accepts_case ? agent.clinical_fit === 'strong' ? 'Strong fit' : 'Accepts' : 'Redirect'}</span><span className="chevron">⌄</span></summary><div className="structured-evidence"><p>{agent.reason}</p><div className="evidence-grid"><div><span>Decision</span><strong>{agent.accepts_case ? 'Accepts case' : 'Redirects / does not accept'}</strong></div><div><span>Availability</span><strong>{agent.availability}</strong></div><div><span>Insurance</span><strong>{insuranceLabel(agent.insurance_status)}</strong></div><div><span>Required workup</span><strong>{agent.required_workup.join(' · ')}</strong></div>{rule && <div className="wide"><span>Relevant physician rule</span><strong>{rule}</strong></div>}{history && <div className="wide"><span>Historical-practice signal</span><strong>{history}</strong></div>}</div></div></details> })}
          {/* Follow-up pass, Part C/D/N: whichever additional physician the
           * routing model itself evaluated (Maya, for Tonjit) gets its own
           * evaluation record here too, so "N physician agents consulted"
           * always matches the number of records actually shown -- built
           * from her real structured CandidateRoute facts (fit/network/
           * evidence confidence/access), never a fabricated Evaluation
           * shape she was never actually given. Collapsed by default. */}
          {routingOnlyAgents.map((agent) => {
            const route = consultation.candidate_routes.find((item) => item.physician_id === agent.physician_id && item.modality === 'in_person')
              ?? consultation.candidate_routes.find((item) => item.physician_id === agent.physician_id)
            if (!route) return null
            return <details key={agent.physician_id}><summary><span className="mini-avatar">{physicianInitials(agent.physician_name)}</span><span className="agent-name"><b>{cleanName(agent.physician_name)}</b><small>{route.specialty}</small></span><span className={`decision-badge ${route.fit_label}`}>{fitLabelText(route.fit_label)} fit</span><span className="chevron">⌄</span></summary><div className="structured-evidence"><p>{route.rationale}</p><div className="evidence-grid"><div><span>Decision</span><strong>Accepts case</strong></div><div><span>Availability</span><strong>{route.access.in_person_wait_label}</strong></div><div><span>Network</span><strong>{networkParticipationLabel(route.network_participation)}</strong></div><div><span>Evidence confidence</span><strong>{confidenceLabelText(route.evidence_confidence)}</strong></div></div></div></details>
          })}
          {/* Follow-up pass, Part E/N: its own clearly separated heading --
           * ROUTES considered is a distinct count/concept from PHYSICIANS
           * consulted (one physician, Chen, carries two routes), and
           * keeping this visually apart from the evaluation records above
           * keeps that one giant dense card from forming. Uses
           * `allOptionRows` (unfiltered by current selection) so this is a
           * stable, complete record of what was evaluated, not a
           * reflection of whatever Lucy currently has selected. Okafor
           * (external directory) appears here, never above as an agent. */}
          {consultation.care_routing && <>
            <div className="evaluation-record-heading">Routes &amp; access considered</div>
            <div className="routes-considered-block">
              <p>{allOptionRows.length} route{allOptionRows.length === 1 ? '' : 's'} considered across {consultedPhysicianCount} physician agent{consultedPhysicianCount === 1 ? '' : 's'} — {consultation.care_routing.recommended_modality === 'in_person' ? 'in-person evaluation' : 'e-consult'} was recommended for this presentation; expected access and e-consult suitability were weighed for every route alongside clinical fit, not fit alone.</p>
              <ul>{allOptionRows.map((row) => <li key={row.key}><b>{row.name}{row.modality === 'econsult' ? ' — E-consult' : ''}:</b> {row.fitText}{row.networkText ? ` · ${row.networkText}` : ''} · {row.accessText}</li>)}</ul>
            </div>
          </>}
          {/* Follow-up pass, Part K: replaces the old defensive-sounding
           * "not private model reasoning" line with product-specific
           * language -- what's inspectable (shared inputs + returned
           * conclusions) and what isn't (temporary agent working context).
           * The underlying architectural inspiration for this boundary is
           * never named as product branding here. */}
          <div className="evaluation-record-heading">About this consultation</div>
          <p className="record-note">This record shows the information shared for this task and the conclusions returned by participating physician agents. Temporary agent working context is not retained.</p>
        </div>
      </div>
    </div></ModalPortal>}
  </section>
}

/**
 * Dr. Chen's "Next step" rail content in receiving mode (Part Q/G). Three
 * real states, never a stuck loading spinner:
 * - `undefined` -- the active-referral lookup hasn't resolved yet.
 * - a real `Referral` -- an accepted referral exists (Tonjit): "a simple
 *   appropriate accepted state is enough"; specialist treatment workflow is
 *   future work. Never "Find a specialist" -- Chen is the specialist who was
 *   found.
 * - `null` -- no referral exists at all, because this is one of Chen's own
 *   pre-existing synthetic patients (Part G), not someone referred to him.
 *   Intentionally lightweight: a plain, honest "in your care" status card
 *   built from the same real stage data the Patients worklist already uses,
 *   never a fabricated specialist-treatment workflow.
 */
function ReceivingReferralCard({ referral, patientLabel, demoPatient }: { referral: Referral | null | undefined; patientLabel: string; demoPatient: DemoPatientSummary | undefined }) {
  if (referral === undefined) return <div className="next-step-card idle"><p className="muted-note">Opening patient…</p></div>
  if (referral) return <ChenDownstreamCard referral={referral} patientLabel={patientLabel} />
  return <div className="next-step-card idle">
    <span className="status-label resolved">In your care</span>
    <h3>{demoPatient?.reason ?? 'Established patient'}</h3>
    <p>{demoPatient?.stageNote ?? 'Continue care as appropriate.'}</p>
  </div>
}

function PatientWorkspace({ patientId, navigate, perspective = 'pcp' }: { patientId: string; navigate: Navigate; perspective?: 'pcp' | 'receiving' }) {
  const [patient, setPatient] = useState<Patient | null>(null)
  const [consultation, setConsultation] = useState<Consultation | null>(null)
  const [recordId, setRecordId] = useState<number | undefined>(undefined)
  const [loading, setLoading] = useState(true)
  const [consulting, setConsulting] = useState(false)
  const [context, setContext] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [activity, setActivity] = useState<PatientActivity | null>(null)
  const [reconsulting, setReconsulting] = useState(false)
  const [justConsulted, setJustConsulted] = useState(false)
  const [nextStepPinned, setNextStepPinned] = useState(false)
  // Dr. Chen's side of an accepted referral (Part Q) -- the same persisted
  // referral object Lucy sees, just a different viewer. Fetched only in
  // 'receiving' mode; the PCP consult-network machinery below is entirely
  // unused on this path.
  const [receivingReferral, setReceivingReferral] = useState<Referral | null | undefined>(undefined)
  // The documented consultation encounter, as if ingested from the EHR/
  // Medplum (Part U/AF) -- the same persisted artifact either physician
  // reads, never a per-perspective copy or a mutation of clinical_notes.
  const [recordEncounter, setRecordEncounter] = useState<ConsultationEncounter | null>(null)
  // Lucy's own view of the same handoff ReferralCoordinationSurface tracks
  // internally (demo-story pass, Part J) -- used only to know whether she
  // has reviewed it yet, to bound the post-consult medication-change
  // highlight window; never fetched/used on the receiving (Chen) side.
  const [recordHandoff, setRecordHandoff] = useState<HandoffSummary | null>(null)
  // Plays exactly once per newly-documented encounter, only while Lucy has
  // not yet reviewed the returned handoff (Part J/M) -- consumeMedication-
  // HighlightFlag (same established one-shot-per-session pattern as
  // markReferralJustAccepted, see Referral.tsx) decides whether to ANIMATE,
  // never what the clinical data itself is.
  const [medicationHighlight, setMedicationHighlight] = useState(false)
  const demoPatient = DEMO_PATIENTS.find((item) => item.id === patientId)
  const backPath = perspective === 'receiving' ? '/chen/patients' : '/patients'
  const refreshActivity = () => getPatientActivity()
    .then((records) => setActivity(records.find((item) => item.patient_id === patientId) ?? null))
    .catch(() => {})
  useEffect(() => { setLoading(true); getPatient(patientId, perspective === 'receiving' ? CHEN_ID : undefined).then(setPatient).catch((loadError: Error) => setError(loadError.message)).finally(() => setLoading(false)) }, [patientId, perspective])
  useEffect(() => {
    if (perspective !== 'receiving') return
    let cancelled = false
    setReceivingReferral(undefined)
    getActiveReferral(patientId).then((referral) => { if (!cancelled) setReceivingReferral(referral) }).catch(() => { if (!cancelled) setReceivingReferral(null) })
    return () => { cancelled = true }
  }, [patientId, perspective])
  useEffect(() => {
    let cancelled = false
    setRecordEncounter(null)
    setRecordHandoff(null)
    const referral$ = perspective === 'receiving' ? Promise.resolve(receivingReferral ?? null) : getActiveReferral(patientId).catch(() => null)
    referral$.then((referral) => {
      if (cancelled || !referral?.id) return
      getEncounter(referral.id).then((found) => { if (!cancelled) setRecordEncounter(found) }).catch(() => {})
      if (perspective !== 'receiving') {
        getHandoff(referral.id).then((found) => { if (!cancelled) setRecordHandoff(found) }).catch(() => {})
      }
    })
    return () => { cancelled = true }
  }, [patientId, perspective, receivingReferral])
  /**
   * Post-consult medication-change highlight (demo-story pass, Part J-M) --
   * plays once, only in the meaningful live/demo window: a documented
   * encounter changed something, AND Lucy has not yet reviewed the handoff
   * that will supersede this moment. Reduced motion skips the animation
   * entirely (the updated state is already visible immediately,
   * unconditionally, via patient.medications itself); the one-shot flag
   * only ever decides whether to animate, never what the clinical record
   * says.
   */
  useEffect(() => {
    if (perspective === 'receiving' || prefersReducedMotion()) return
    if (!patient || patient.recent_medication_changes.length === 0) return
    if (!recordHandoff || recordHandoff.viewed_by_referring_physician_at) return
    if (!consumeMedicationHighlightFlag(recordHandoff.encounter_id)) return
    setMedicationHighlight(true)
    const timer = window.setTimeout(() => setMedicationHighlight(false), 2500)
    return () => window.clearTimeout(timer)
  }, [perspective, patient, recordHandoff])
  /**
   * On open, a patient who already has a completed consultation gets that
   * recommendation loaded directly -- the page reflects current care state, not
   * merely "a consultation exists somewhere" (see the idle-prior fallback below,
   * used only if this fetch fails). Entirely a PCP-side concern -- Chen's
   * perspective never runs the consult-network workflow.
   *
   * `consultHydrated` (Part D hydration-flash fix) stays false across BOTH
   * awaited steps -- `activity` resolves first, consultation potentially a
   * moment later -- so the Next step rail never commits to a nextStepState
   * derived from only half of this chain (e.g. flashing "Previous
   * consultation available" for the instant between the two).
   */
  const [consultHydrated, setConsultHydrated] = useState(perspective !== 'pcp')
  useEffect(() => {
    if (perspective !== 'pcp') return
    let cancelled = false
    setReconsulting(false); setActivity(null); setConsultation(null); setRecordId(undefined); setConsultHydrated(false)
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
    }).catch(() => { if (!cancelled) setActivity(null) }).finally(() => { if (!cancelled) setConsultHydrated(true) })
    return () => { cancelled = true }
  }, [patientId, perspective])
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
      // Demo-consolidation pass, Part 6: a fresh network consultation, once
      // it exists, must show its OWN new recommendation -- never snap back
      // into whatever prior (possibly completed) referral episode this
      // patient already has. RecommendationView fully unmounts/remounts
      // between `consulting` states (see nextStepState), so this flag,
      // consumed once at that next mount, reliably distinguishes "just
      // re-consulted this session" from an ordinary reload.
      setJustConsulted(true)
      void refreshActivity()
    } catch (consultError) {
      setError(consultError instanceof Error ? consultError.message : 'Consultation failed')
    } finally {
      setConsulting(false)
    }
  }
  const shellSection = perspective === 'receiving' ? 'chen-patients' : 'patients'
  const shellPerspective = perspective === 'receiving' ? 'chen' : 'pcp'
  if (loading) return <ProductShell navigate={navigate} section={shellSection} perspective={shellPerspective}><div className="page-state embedded"><div className="loading-line" /><p>Opening patient workspace…</p></div></ProductShell>
  if (!patient) return <ProductShell navigate={navigate} section={shellSection} perspective={shellPerspective}><div className="page-state embedded error"><p>{error || 'Patient unavailable'}</p></div></ProductShell>
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
  // 'hydrating' (Part D) always wins -- never derive idle/idle-prior/ready
  // from a half-resolved activity/consultation chain (see consultHydrated above).
  const nextStepState: 'hydrating' | 'idle' | 'idle-prior' | 'consulting' | 'ready' =
    !consultHydrated ? 'hydrating' : consulting ? 'consulting' : consultation ? 'ready' : priorConsultation ? 'idle-prior' : 'idle'
  const currentIssue = demoPatient?.reason ?? patient.diagnoses[0] ?? null
  const patientDisplayName = demoPatient?.name ?? cleanName(patient.display_name)
  const patientInitials = patientDisplayName.split(/\s+/).map((part) => part[0]).slice(0, 2).join('')
  return <ProductShell navigate={navigate} section={shellSection} perspective={shellPerspective}><main className="page-shell patient-page">
    <button className="text-button back-link" onClick={() => navigate(backPath)}>← All patients</button>
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
        {perspective === 'receiving'
          ? <ReceivingReferralCard referral={receivingReferral} patientLabel={patientName(patientId)} demoPatient={demoPatient} />
          : <>
            {/* The heading itself is state-aware (ongoing-coordination pass,
             * Part B) -- RecommendationView renders its own heading once it
             * mounts (Discovery: "Next step"; Referral: "Current care
             * state"), so this generic one only covers the states where that
             * component isn't mounted yet. */}
            {nextStepState !== 'ready' && <><h2>Next step</h2><p className="page-intro">Your agent helps with the follow-through.</p></>}
            {nextStepState === 'hydrating' && <div className="next-step-card idle"><p className="muted-note">Checking patient status…</p></div>}
            {nextStepState === 'consulting' && <div className="next-step-card consulting">
              <span className="status-label pulse"><span className="spark-icon lead" aria-hidden="true">✧</span>Consulting the network</span>
              <h3>Your agent is finding a match.</h3>
              <p>Comparing clinical fit, referral requirements, access, and your practice preferences…</p>
            </div>}
            {nextStepState === 'ready' && consultation && <>
              <RecommendationView consultation={consultation} navigate={navigate} recordId={recordId} referralQuestion={patient.referral_question} justConsulted={justConsulted} onReconsult={runConsult} />
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
            {nextStepState !== 'ready' && <p className="bottom-note">Simulated workflow · No referral is sent</p>}
          </>}
      </aside>
      <div className="patient-clinical-main">
        {(consultation || currentIssue || recordEncounter) && <section className="patient-history-section patient-top-card" aria-labelledby="patient-history-heading">
          <h2 id="patient-history-heading">Patient history</h2>
          <div className="clinical-timeline">
            {recordEncounter && <div className="timeline-event">
              <time>{formatTime(recordEncounter.occurred_at)}</time>
              <h4>{recordEncounter.specialty} consultation</h4>
              {recordEncounter.physician_id === CHEN_ID && <p className="timeline-event-clinician">{CHEN_NAME}</p>}
              <p>{recordEncounter.assessment}</p>
              {recordEncounter.key_findings.length > 0 && <ul className="clinical-list">{recordEncounter.key_findings.map((item) => <li key={item}>{item}</li>)}</ul>}
              {/* Concise, structured -- never the full handoff re-rendered
               * here (Part P): just the treatment-change facts, read
               * straight from medication_changes, never parsed from `plan`. */}
              {recordEncounter.medication_changes.length > 0 && <p className="timeline-event-medication-change">
                Treatment intensified: {recordEncounter.medication_changes
                  .filter((change) => change.action !== 'continue')
                  .map((change) => `${change.medication} ${change.action === 'start' ? 'started' : 'discontinued'}`)
                  .join(' · ')}
              </p>}
              <small className="packet-item-provenance">{recordEncounter.source === 'medplum' ? 'Synthetic FHIR via Medplum' : 'Synthetic demo encounter'}</small>
            </div>}
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
            {/* patient.medications is already the derived CURRENT list,
             * already gated server-side to what THIS physician is allowed
             * to see (bug-fix pass, Part A/B) -- discontinued items are
             * never in it, and Lucy never receives a started item at all
             * before Chen sends the handoff. This section only adds
             * provenance/highlight presentation on top of that real
             * clinical-record fact, never a second source of truth. Only
             * the specific row for a newly-started medication animates
             * (Part E) -- never the whole section, never Metformin. */}
            <section>
              <h3>Current medications</h3>
              <ul className="clinical-list">{patient.medications.map((item) => {
                const change = patient.recent_medication_changes.find((entry) => entry.medication === item && entry.action === 'start')
                return <li key={item} className={change && medicationHighlight ? 'medication-row-highlight' : ''}>
                  {item}
                  {change?.medication_class && <small className="medication-class"> · {change.medication_class}</small>}
                  {change && <small className={`medication-provenance ${medicationHighlight ? 'medication-provenance-enter' : ''}`}>Started by {change.specialty}</small>}
                </li>
              })}</ul>
              {/* A discontinuation never appears in the list above at all
               * (it's simply absent from the derived current-medication
               * list), so this one quiet line is the only place it's
               * surfaced -- deliberately not repeating "Endocrinology"
               * again, since the row above already carries that
               * provenance (Part D). */}
              {patient.recent_medication_changes.some((entry) => entry.action === 'discontinue') && <p className="medication-change-note">
                {patient.recent_medication_changes.filter((entry) => entry.action === 'discontinue').map((entry) => entry.medication).join(', ')} discontinued
              </p>}
            </section>
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
  if (path === '/settings/agent-evaluations') return <AgentEvaluationsPage navigate={navigate} />
  if (path === '/network/updates') return <ProductShell navigate={navigate} section="network"><LucyNetworkPage navigate={navigate} params={new URLSearchParams('tab=feed')} /></ProductShell>
  const networkProfileControlledId = path.match(/^\/network\/profile\/([^/]+)$/)?.[1]
  if (networkProfileControlledId) return <ProductShell navigate={navigate} section="network"><NetworkPhysicianProfilePage controlledId={networkProfileControlledId} navigate={navigate} backPath="/home" perspective="lucy" params={params} /></ProductShell>
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
  if (specialistNetworkProfileId) return <ProductShell navigate={navigate} section="specialist-network" perspective="specialist"><NetworkPhysicianProfilePage controlledId={specialistNetworkProfileId} navigate={navigate} backPath="/specialist/home" perspective="iain" params={params} /></ProductShell>
  if (path === '/chen' || path === '/chen/home') return <ProductShell navigate={navigate} section="chen-home" perspective="chen"><ChenHomePage navigate={navigate} /></ProductShell>
  if (path === '/chen/patients') return <ProductShell navigate={navigate} section="chen-patients" perspective="chen"><ChenPatientsPage navigate={navigate} params={params} /></ProductShell>
  const chenPatientId = path.match(/^\/chen\/patients\/([^/]+)$/)?.[1]
  if (chenPatientId === TONJIT_ID || (chenPatientId && CHEN_PATIENT_IDS.includes(chenPatientId))) return <PatientWorkspace patientId={chenPatientId} navigate={navigate} perspective="receiving" />
  if (path === '/chen/profile') return <ProductShell navigate={navigate} section="chen-profile" perspective="chen"><ProfessionalProfilePage personaId="chen" navigate={navigate} params={params} /></ProductShell>
  if (path === '/chen/agent') return <ProductShell navigate={navigate} section="chen-agent" perspective="chen"><ChenAgentPage navigate={navigate} params={params} /></ProductShell>
  if (path === '/chen/agent/train') return <ProductShell navigate={navigate} section="chen-agent" perspective="chen"><TrainingPage personaId="chen" agentName={CHEN_AGENT_NAME} navigate={navigate} exitPath="/chen/agent?tab=train" params={params} /></ProductShell>
  if (path === '/chen/network') return <ProductShell navigate={navigate} section="chen-network" perspective="chen"><ChenNetworkPage navigate={navigate} params={params} /></ProductShell>
  if (path === '/chen/network/updates') return <ProductShell navigate={navigate} section="chen-network" perspective="chen"><ChenNetworkPage navigate={navigate} params={new URLSearchParams('tab=feed')} /></ProductShell>
  const chenNetworkProfileId = path.match(/^\/chen\/network\/profile\/([^/]+)$/)?.[1]
  if (chenNetworkProfileId) return <ProductShell navigate={navigate} section="chen-network" perspective="chen"><NetworkPhysicianProfilePage controlledId={chenNetworkProfileId} navigate={navigate} backPath="/chen/patients" perspective="chen" params={params} /></ProductShell>
  if (path === '/network') return <ProductShell navigate={navigate} section="network"><LucyNetworkPage navigate={navigate} params={params} /></ProductShell>
  // UX polish pass, Part A/B: an unclaimed external-directory physician (no
  // real NPI/backend record) opens the SAME PhysicianProfilePage shell as a
  // real claimable NPI identity -- just via a local lookup instead of a
  // backend fetch, since there is nothing real to fetch.
  const networkDirectoryId = path.match(/^\/network\/directory\/([^/]+)$/)?.[1]
  if (networkDirectoryId) return <ProductShell navigate={navigate} section="network">{ROUTING_DIRECTORY_PHYSICIANS[networkDirectoryId] ? <PhysicianProfilePage directoryProfile={ROUTING_DIRECTORY_PHYSICIANS[networkDirectoryId]} navigate={navigate} /> : <main className="page-shell"><button className="text-button back-link" onClick={() => navigate('/network')}>← Network</button><div className="error-banner" role="alert">Directory physician not found</div></main>}</ProductShell>
  const networkNpi = path.match(/^\/network\/([^/]+)$/)?.[1]
  if (networkNpi) return <ProductShell navigate={navigate} section="network"><PhysicianProfilePage npi={networkNpi} navigate={navigate} /></ProductShell>
  const patientId = path.match(/^\/patients\/([^/]+)$/)?.[1]
  if (patientId === JORDAN_ID || patientId === MARIA_ID || patientId === TONJIT_ID) return <PatientWorkspace patientId={patientId} navigate={navigate} />
  const demoPatient = DEMO_PATIENTS.find((patient) => patient.id === patientId)
  if (demoPatient) return <UnfinishedPatient patient={demoPatient} navigate={navigate} />
  return <LandingPage navigate={navigate} />
}
