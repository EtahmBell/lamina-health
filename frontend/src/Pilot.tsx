import { useCallback, useEffect, useState, type FormEvent, type ReactNode } from 'react'
import { useAuth } from './AuthProvider.tsx'
import { ApiError } from './api.ts'
import { ClaimShell, signInPath, signUpPath, SignInPage, SignUpPage } from './Claim.tsx'
import { greetingPrefix, timeAwareGreeting } from './greeting.ts'
import { LaminaMark } from './LaminaMark.tsx'
import { PhysicianOnboardingPage } from './Onboarding.tsx'
import { AgentPage, MetricsPage, PublicSettingsPage } from './PilotAgent.tsx'
import { NetworkPage } from './PilotNetwork.tsx'
import { AccountMenu, AgentDock, AgentNavIcon, AgentOrb, ForYouNavIcon, HomeNavIcon, LaminaShell, NetworkNavIcon, type DockCard, type DockReply, type NavEntry } from './pilotUi.tsx'
import { useOnPilotDataChange, usePilotDataVersion } from './pilotSync.ts'
import { PublicProfilePage, PublicReferralPage, SenderStatusPage } from './PublicPages.tsx'
import {
  acceptInvitation, approveTriage, createPractice, createReferral, decideReferral,
  editTriage, escalateReferral, getPilotStatus, getPracticeMembers, getPracticeRules, getReferral,
  inviteStaff, listReferrals, openReferralDocument, previewInvitation, recordReferralItem, rejectTriage,
  removeStaffMember, requestInformation, retriageReferral, revokeInvitation, updatePractice, uploadReferralDocument,
  type EffectiveTriage, type Fit, type Modality, type NextStep, type PilotStatus, type PracticeFields,
  type PracticeInvitation, type PracticeMember, type PracticeRule, type Priority, type ReferralDetail,
  type ReferralSummary, type RequirementAssessment, getHome, teachAgent, editInformationRequest,
  sendInformationRequest, cancelInformationRequest, resolveInformationRequest,
  type HomeItem, type HomeProjection, type InformationRequest,
  getAssistant, sendAssistantMessage, type AgentCardExecute, type AgentReplyBody,
} from './pilotApi.ts'
import {
  accountIdentity, canUse, countWord, emptyReferralForm, itemLabel, FIT_LABELS, historyLabel, isClosed,
  MODALITY_LABELS, NEXT_STEP_LABELS, patientInitials, patientWorkSections, pilotErrorCopy, pilotPaths, PRIORITY_LABELS, proposalLines,
  receivedReferralWorkItem, REQUIREMENT_STATE_LABELS, referralFormErrors, referralPayload, resolveAgentTab,
  resolvePilotRoute, STATUS_LABELS,
  dockMessagesFrom, setReferralPrefill, takeReferralPrefill,
  type PatientWorkItem, type ReferralForm,
} from './pilotState.ts'

type Navigate = (path: string) => void

const errorText = (err: unknown, fallback: string) =>
  pilotErrorCopy(err instanceof ApiError ? err.code : null, err instanceof Error ? err.message : fallback)
const formatDate = (iso: string | null | undefined) => iso ? new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' }) : '—'
const formatDateTime = (iso: string) => new Date(iso).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })
const logTime = (iso: string | undefined) => {
  if (!iso) return 'Earlier'
  const date = new Date(iso)
  return date.toDateString() === new Date().toDateString()
    ? date.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })
    : date.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
}

/* ------------------------------------------------------------------- app */

/** The entire pilot-mode frontend. Only onboarding, join, sign-in, and /me/* pilot
 * routes resolve; every synthetic demo path redirects to the pilot home. */
export function PilotApp({ path, params, navigate }: { path: string; params: URLSearchParams; navigate: Navigate }) {
  const route = resolvePilotRoute(path)
  useEffect(() => { if (route.kind === 'redirect') navigate(route.to) }, [route.kind]) // eslint-disable-line react-hooks/exhaustive-deps
  switch (route.kind) {
    case 'redirect': return <main className="page-shell owner-gate"><p className="muted-note">Opening Lamina…</p></main>
    case 'auth': return route.page === 'sign-in' ? <SignInPage navigate={navigate} params={params} /> : <SignUpPage navigate={navigate} params={params} />
    case 'join': return <JoinPracticePage navigate={navigate} params={params} />
    case 'onboarding':
    case 'home': return <PilotGate navigate={navigate} params={params}>{(status) => <PilotShell status={status} navigate={navigate} section="home" agentDock><PilotHomePage status={status} navigate={navigate} /></PilotShell>}</PilotGate>
    case 'for_you': return <PilotGate navigate={navigate} params={params}>{(status) => <PilotShell status={status} navigate={navigate} section="for-you" agentDock><ForYouPage status={status} navigate={navigate} /></PilotShell>}</PilotGate>
    case 'patients': return <PilotGate navigate={navigate} params={params}>{(status) => <PilotShell status={status} navigate={navigate} section="patients"><PatientsPage navigate={navigate} /></PilotShell>}</PilotGate>
    case 'network': return <PilotGate navigate={navigate} params={params}>{(status) => <PilotShell status={status} navigate={navigate} section="network"><NetworkPage status={status} navigate={navigate} /></PilotShell>}</PilotGate>
    case 'new_referral': return <PilotGate navigate={navigate} params={params}>{(status) => <PilotShell status={status} navigate={navigate} section="patients"><NewReferralPage navigate={navigate} /></PilotShell>}</PilotGate>
    case 'referral': return <PilotGate navigate={navigate} params={params}>{(status) => <PilotShell status={status} navigate={navigate} section="patients" agentDock><ReferralDetailPage id={route.id} status={status} navigate={navigate} /></PilotShell>}</PilotGate>
    case 'practice': return <PilotGate navigate={navigate} params={params}>{(status, reload) => <PilotShell status={status} navigate={navigate} section="profile"><ProfilePage status={status} reload={reload} navigate={navigate} /></PilotShell>}</PilotGate>
    case 'agent': return <PilotGate navigate={navigate} params={params}>{(status) => <PilotShell status={status} navigate={navigate} section="agent"><AgentPage status={status} navigate={navigate} tab={resolveAgentTab(params.get('tab'))} /></PilotShell>}</PilotGate>
    case 'rules': return <PilotGate navigate={navigate} params={params}>{(status) => <PilotShell status={status} navigate={navigate} section="agent"><AgentPage status={status} navigate={navigate} tab="rules" /></PilotShell>}</PilotGate>
    case 'public_settings': return <PilotGate navigate={navigate} params={params}>{(status) => <PilotShell status={status} navigate={navigate} section="profile"><PublicSettingsPage status={status} navigate={navigate} /></PilotShell>}</PilotGate>
    case 'metrics': return <PilotGate navigate={navigate} params={params}>{(status) => <PilotShell status={status} navigate={navigate} section="profile"><MetricsPage navigate={navigate} /></PilotShell>}</PilotGate>
    case 'public_profile': return <PublicProfilePage slug={route.slug} navigate={navigate} />
    case 'public_refer': return <PublicReferralPage slug={route.slug} navigate={navigate} />
    case 'sender': return <SenderStatusPage token={route.token} />
  }
}

/* ------------------------------------------------------------------ gate */

/** Server-derived gate: sign in → confirm profile → practice setup → approval → workspace. */
function PilotGate({ navigate, params, children }: { navigate: Navigate; params: URLSearchParams; children: (status: PilotStatus, reload: () => void) => ReactNode }) {
  const { configured, loading, user } = useAuth()
  const [status, setStatus] = useState<PilotStatus | null>(null)
  const [error, setError] = useState('')
  const reload = useCallback(() => {
    getPilotStatus().then((next) => { setStatus(next); setError('') }).catch((err) => setError(errorText(err, 'Could not open your workspace')))
  }, [])
  useEffect(() => { setStatus(null); if (user) reload() }, [user, reload])

  if (!configured) return <ClaimShell navigate={navigate}><div className="onboarding-panel"><p className="muted-note">Authentication is not configured in this environment.</p></div></ClaimShell>
  if (loading) return <ClaimShell navigate={navigate}><div className="onboarding-panel"><p className="muted-note">Checking your session…</p></div></ClaimShell>
  if (!user) return <ClaimShell navigate={navigate}><div className="onboarding-panel">
    <p className="eyebrow">Lamina pilot</p>
    <h1>Your physician agent</h1>
    <p>Lamina works alongside you and your practice. It learns how you work, prepares what it can (today, starting with incoming referrals), and brings you only the decisions that need you.</p>
    <div className="onboarding-actions">
      <button className="button-primary" onClick={() => navigate(signUpPath(pilotPaths.home))}>Create account <span>→</span></button>
      <button className="text-button" onClick={() => navigate(signInPath(pilotPaths.home))}>Sign in</button>
    </div>
    <p className="muted-note">Joining a practice as staff? Open the invitation link your physician sent you.</p>
  </div></ClaimShell>
  if (error) return <ClaimShell navigate={navigate}><div className="onboarding-panel"><div className="error-banner" role="alert">{error}</div><button className="text-button" onClick={reload}>Try again</button></div></ClaimShell>
  if (!status) return <ClaimShell navigate={navigate}><div className="onboarding-panel"><p className="muted-note">Opening your workspace…</p></div></ClaimShell>

  switch (status.next_step) {
    case 'physician_onboarding': return <PhysicianOnboardingPage navigate={navigate} params={params} onConfirmed={reload} />
    case 'practice_setup': return <PracticeSetupPage status={status} navigate={navigate} onCreated={reload} />
    case 'pilot_pending':
    case 'practice_pending': return <PendingPage status={status} navigate={navigate} reload={reload} />
    case 'unavailable': return <ClaimShell navigate={navigate}><div className="onboarding-panel"><p className="eyebrow">Lamina pilot</p><h1>Workspace unavailable</h1><p>This account can’t open a pilot workspace right now. Contact the Lamina team if you believe this is a mistake.</p></div></ClaimShell>
    case 'workspace': return <>{children(status, reload)}</>
  }
}

function PracticeFieldsForm({ initial, submitLabel, busyLabel, onSubmit, onCancel }: { initial: Partial<PracticeFields>; submitLabel: string; busyLabel: string; onSubmit: (fields: PracticeFields) => Promise<void>; onCancel?: () => void }) {
  const [fields, setFields] = useState<PracticeFields>({ name: initial.name ?? '', specialty: initial.specialty ?? '', website: initial.website ?? '', address: initial.address ?? '', phone: initial.phone ?? '', contact_email: initial.contact_email ?? '' })
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const set = (key: keyof PracticeFields) => (event: React.ChangeEvent<HTMLInputElement>) => setFields((current) => ({ ...current, [key]: event.target.value }))
  const submit = async (event: FormEvent) => {
    event.preventDefault()
    if (!fields.name?.trim()) { setError('Enter the practice name.'); return }
    setBusy(true); setError('')
    try { await onSubmit(fields) } catch (err) { setError(errorText(err, 'Could not save the practice.')) } finally { setBusy(false) }
  }
  return <form className="auth-form pilot-form" onSubmit={(event) => void submit(event)} aria-busy={busy}>
    <label><span>Practice name</span><input value={fields.name ?? ''} onChange={set('name')} required disabled={busy} /></label>
    <label><span>Specialty</span><input value={fields.specialty ?? ''} onChange={set('specialty')} disabled={busy} /></label>
    <label><span>Address</span><input value={fields.address ?? ''} onChange={set('address')} disabled={busy} /></label>
    <div className="pilot-form-row">
      <label><span>Phone</span><input value={fields.phone ?? ''} onChange={set('phone')} disabled={busy} /></label>
      <label><span>Referral contact email</span><input type="email" value={fields.contact_email ?? ''} onChange={set('contact_email')} disabled={busy} /></label>
    </div>
    <label><span>Website</span><input value={fields.website ?? ''} onChange={set('website')} disabled={busy} /></label>
    {error && <p className="error-banner" role="alert">{error}</p>}
    <div className="onboarding-actions">
      <button className="button-primary" type="submit" disabled={busy}>{busy ? busyLabel : submitLabel} <span>→</span></button>
      {onCancel && <button className="text-button" type="button" onClick={onCancel} disabled={busy}>Cancel</button>}
    </div>
  </form>
}

function PracticeSetupPage({ status, navigate, onCreated }: { status: PilotStatus; navigate: Navigate; onCreated: () => void }) {
  const defaults = status.practice_defaults
  const identity = status.physician_onboarding.confirmed_identity?.identity
  return <ClaimShell navigate={navigate}><div className="onboarding-panel">
    <p className="eyebrow">Step 3 · Your practice</p>
    <h1>Set up your practice</h1>
    <p>Referrals, rules, and your team belong to the practice. {identity ? `We prefilled what NPPES lists for ${identity.display_name}.` : ''} Confirm or edit it — nothing here is published.</p>
    {defaults?.source && <p className="muted-note">{defaults.source}</p>}
    <PracticeFieldsForm initial={defaults ?? {}} submitLabel="Create practice" busyLabel="Creating…" onSubmit={async (fields) => { await createPractice(fields); onCreated() }} />
    <p className="muted-note">You can invite staff after the practice is created.</p>
  </div></ClaimShell>
}

function PendingPage({ status, navigate, reload }: { status: PilotStatus; navigate: Navigate; reload: () => void }) {
  const staff = status.next_step === 'practice_pending'
  return <ClaimShell navigate={navigate}><div className="onboarding-panel">
    <p className="eyebrow">Pilot approval</p>
    <h1>{status.practice?.name ?? 'Your practice'} is awaiting approval</h1>
    <p>{staff
      ? 'You’ve joined this practice. Its workspace opens once Lamina approves the practice’s physician.'
      : 'Your professional profile is confirmed and your practice is set up. Lamina is onboarding a small number of pilot practices; your workspace opens here once the team approves your account.'}</p>
    <p className="muted-note">No referral or patient information is available until approval.</p>
    <button className="text-button" onClick={reload}>Check status again</button>
  </div></ClaimShell>
}

function JoinPracticePage({ navigate, params }: { navigate: Navigate; params: URLSearchParams }) {
  const { configured, loading, user } = useAuth()
  const [token] = useState(() => params.get('invite') ?? '')
  const [preview, setPreview] = useState<Awaited<ReturnType<typeof previewInvitation>> | null>(null)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const returnHere = `${pilotPaths.join}?invite=${encodeURIComponent(token)}`
  useEffect(() => {
    if (!user || !token) return
    previewInvitation(token).then(setPreview).catch((err) => setError(errorText(err, 'This invitation could not be opened.')))
  }, [user, token])
  if (!configured || loading) return <ClaimShell navigate={navigate}><div className="onboarding-panel"><p className="muted-note">Checking your session…</p></div></ClaimShell>
  if (!token) return <ClaimShell navigate={navigate}><div className="onboarding-panel"><h1>Invitation link missing</h1><p>Open the full invitation link your physician sent you.</p></div></ClaimShell>
  if (!user) return <ClaimShell navigate={navigate}><div className="onboarding-panel">
    <p className="eyebrow">Practice invitation</p><h1>Join your practice on Lamina</h1>
    <p>Create an account or sign in to accept this staff invitation.</p>
    <div className="onboarding-actions">
      <button className="button-primary" onClick={() => navigate(signUpPath(returnHere))}>Create account <span>→</span></button>
      <button className="text-button" onClick={() => navigate(signInPath(returnHere))}>I already have an account</button>
    </div>
  </div></ClaimShell>
  const accept = async () => {
    setBusy(true); setError('')
    try { await acceptInvitation(token); navigate(pilotPaths.home) } catch (err) { setError(errorText(err, 'Could not accept this invitation.')) } finally { setBusy(false) }
  }
  return <ClaimShell navigate={navigate}><div className="onboarding-panel">
    <p className="eyebrow">Practice invitation</p>
    <h1>{preview?.practice_name ? `Join ${preview.practice_name}` : 'Join a practice'}</h1>
    {preview && <p>You’ll join as staff{preview.practice_specialty ? ` · ${preview.practice_specialty}` : ''}. Staff can enter and review referrals; physicians make the final decisions.</p>}
    {error && <p className="error-banner" role="alert">{error}</p>}
    {preview && <button className="button-primary" disabled={busy} onClick={() => void accept()}>{busy ? 'Joining…' : 'Accept invitation'} <span>→</span></button>}
  </div></ClaimShell>
}

/* ----------------------------------------------------------------- shell */

/** The demo's five general physician destinations, in the demo's order. Patients is the
 * clinical workspace (today: received referrals as patient work items); Network is the
 * pilot's own page and shows only real relationships — never the demo roster. */
const NAV: NavEntry[] = [
  { id: 'home', title: 'Home', icon: <HomeNavIcon />, path: pilotPaths.home },
  { id: 'for-you', title: 'For you', icon: <ForYouNavIcon />, path: pilotPaths.forYou },
  { id: 'patients', title: 'Patients', icon: '✦', path: pilotPaths.patients },
  { id: 'network', title: 'Network', icon: <NetworkNavIcon />, path: pilotPaths.network },
  { id: 'agent', title: 'Your Agent', icon: <AgentNavIcon />, path: pilotPaths.agent },
]

/** The demo's agent-first physician shell around real pilot pages. Physician-only
 * destinations (public page, metrics) are hidden for staff, never shown disabled. */
function PilotShell({ status, navigate, section, agentDock = false, children }: { status: PilotStatus; navigate: Navigate; section: string; agentDock?: boolean; children: ReactNode }) {
  const { user, signOut } = useAuth()
  const me = accountIdentity(status, user?.email)
  const physician = status.role === 'physician'
  const account = <AccountMenu initials={me.initials} name={me.name} items={[
    { label: 'Profile & practice', onSelect: () => navigate(pilotPaths.practice) },
    ...(physician ? [{ label: 'Public physician profile', onSelect: () => navigate(pilotPaths.publicProfile) }, { label: 'Pilot metrics', onSelect: () => navigate(pilotPaths.metrics) }] : []),
    'divider',
    { note: `${status.practice?.name ?? 'Your practice'} · ${me.role}` },
    ...(user?.email ? [{ note: user.email }] : []),
    { label: 'Sign out', onSelect: () => void signOut().then(() => navigate(pilotPaths.home)) },
  ]} />
  return <LaminaShell items={NAV} section={section} navigate={navigate} homePath={pilotPaths.home} account={account} status={`Pilot · ${me.role}`} agentDock={agentDock}>{children}</LaminaShell>
}

/* ------------------------------------------------------------------ home */

function PilotHomePage({ status, navigate }: { status: PilotStatus; navigate: Navigate }) {
  const { user } = useAuth()
  const { home, needs, error, loading } = useHomeData(status)
  const me = accountIdentity(status, user?.email)
  const physician = status.role === 'physician'
  const top = needs.slice(0, 3)
  const hidden = needs.length - top.length
  const prepared = home?.prepared ?? []
  const waiting = home?.waiting ?? []
  return <main className="agent-home" aria-label="Home">
    <h1 className="agent-home-greeting">{me.firstName ? timeAwareGreeting(me.firstName) : `${greetingPrefix(new Date().getHours())}.`}</h1>
    <div className="agent-status" role="status"><AgentOrb /><span>{loading ? 'Reviewing what’s come in for your practice…' : needs.length ? 'I’ve prepared what I can. The rest needs you.' : 'All caught up. I’ll keep watching.'}</span></div>
    {error && <p className="agent-home-error" role="alert">{error}</p>}
    {home && <>
      <p className="agent-brief">{home.briefing.lead}{home.briefing.detail && <> {home.briefing.detail}</>}{home.briefing.tail && <>{' '}<span className="agent-brief-quiet">{home.briefing.tail}</span></>}</p>
      {top.length > 0 && <section className="agent-needs for-you-section" aria-label="Needs you">
        <h2 className="agent-label">Needs you</h2>
        <div className="agent-list">{top.map((item, index) => <NeedRow key={`${item.kind}-${item.referral_id ?? item.proposal_id ?? item.question_id ?? index}`} item={item} navigate={navigate} />)}</div>
        {hidden > 0 && <button className="agent-link" onClick={() => navigate(pilotPaths.forYou)}>See {hidden} more in For you →</button>}
      </section>}
      {prepared.length > 0 && <section className="for-you-section" aria-label="Prepared for you">
        <h2 className="agent-label">Prepared for you</h2>
        <div className="agent-list">{prepared.slice(0, 3).map((item, index) => <QuietRow key={`${item.kind}-${item.referral_id ?? index}`} item={item} navigate={navigate} />)}</div>
      </section>}
      {waiting.length > 0 && <section className="for-you-section" aria-label="Waiting on others">
        <h2 className="agent-label">Waiting on others</h2>
        <div className="agent-list">{waiting.slice(0, 3).map((item, index) => <QuietRow key={`${item.kind}-${item.referral_id ?? index}`} item={item} navigate={navigate} />)}</div>
        {(waiting.length > 3 || prepared.length > 3) && <button className="agent-link" onClick={() => navigate(pilotPaths.forYou)}>See everything in For you →</button>}
      </section>}
      <AwayLog done={home.done} navigate={navigate} />
    </>}
    {/* The docked conversation: the practice agent for everyone; teaching stays physician-only server-side. */}
    <PracticeAgentDock status={status} navigate={navigate} />
  </main>
}

/** For you: the full queue — everything the agent can't or shouldn't finish alone. */
function ForYouPage({ status, navigate }: { status: PilotStatus; navigate: Navigate }) {
  const { home, needs, error, loading } = useHomeData(status)
  const prepared = home?.prepared ?? []
  const waiting = home?.waiting ?? []
  const done = home?.done ?? []
  const statusLine = needs.length
    ? `${countWord(needs.length)} ${needs.length === 1 ? 'thing needs' : 'things need'} you${waiting.length ? ` · ${waiting.length} waiting on others` : ''}`
    : 'You’re all caught up.'
  return <main className="agent-home for-you" aria-label="For you">
    <h1 className="agent-home-greeting">For you</h1>
    <div className="agent-status muted">{loading ? 'Gathering everything that needs you…' : statusLine}</div>
    <p className="for-you-intro">Everything I can’t or shouldn’t finish without your team. I prepare what I can and bring the rest here.</p>
    {error && <p className="agent-home-error" role="alert">{error}</p>}
    {home && <>
      {needs.length > 0 && <section className="for-you-section" aria-label="Needs you"><h2 className="agent-label">Needs you</h2>
        <div className="agent-list">{needs.map((item, index) => <NeedRow key={`${item.kind}-${item.referral_id ?? item.proposal_id ?? item.question_id ?? index}`} item={item} navigate={navigate} />)}</div>
      </section>}
      {prepared.length > 0 && <section className="for-you-section" aria-label="Prepared for you"><h2 className="agent-label">Prepared for you</h2>
        <div className="agent-list">{prepared.map((item, index) => <QuietRow key={`${item.kind}-${item.referral_id ?? index}`} item={item} navigate={navigate} />)}</div>
      </section>}
      {waiting.length > 0 && <section className="for-you-section" aria-label="Waiting on others"><h2 className="agent-label">Waiting on others</h2>
        <div className="agent-list">{waiting.map((item, index) => <QuietRow key={`${item.kind}-${item.referral_id ?? index}`} item={item} navigate={navigate} />)}</div>
      </section>}
      {done.length > 0 && <section className="for-you-section" aria-label="Done recently"><h2 className="agent-label">Done recently</h2>
        <div className="agent-list">{done.map((item, index) => <button className="agent-item quiet done" key={`${item.kind}-${index}`} onClick={() => navigate(item.path)}>
          <div className="agent-item-text"><div className="agent-item-title">{item.title}</div>{item.detail && <div className="agent-item-sub">{item.detail}</div>}</div>
          <span className="agent-item-when">{logTime(item.at)}</span>
        </button>)}</div>
      </section>}
    </>}
    <PracticeAgentDock status={status} navigate={navigate} />
  </main>
}

/** Needs-you entries, plus the one setup step Lamina can't work without (rules). */
function useHomeData(status: PilotStatus) {
  const [home, setHome] = useState<HomeProjection | null>(null)
  const [rules, setRules] = useState<PracticeRule[] | null>(null)
  const [error, setError] = useState('')
  const load = useCallback(() => {
    getHome().then(setHome).catch((err) => setError(errorText(err, 'Could not load your day')))
    getPracticeRules().then(setRules).catch(() => setRules([]))
  }, [])
  useEffect(() => { load() }, [load])
  useOnPilotDataChange(load) // agent drafts/proposals and any other write show up without a reload
  const physician = status.role === 'physician'
  const setup: HomeItem[] = rules && rules.length === 0 ? [{
    kind: 'setup_rules', title: 'Teach Lamina your referral criteria', path: pilotPaths.agentTab('rules'), action: physician ? 'Add rules' : 'View',
    detail: physician ? 'Until you add a rule I can record referrals but can’t judge fit or completeness.' : 'The physician hasn’t added referral rules yet, so I can record referrals but can’t judge fit or completeness.',
  }] : []
  const needs = [...setup, ...(home?.needs_you ?? [])]
  return { home, needs, error, loading: !home && !error }
}

function NeedRow({ item, navigate }: { item: HomeItem; navigate: Navigate }) {
  return <div className="agent-item" data-kind={item.kind}>
    <div className="agent-item-text"><div className="agent-item-title">{item.title}</div>{item.detail && <div className="agent-item-sub">{item.detail}</div>}</div>
    <button className="agent-btn primary" onClick={() => navigate(item.path)} aria-label={`${item.action ?? 'Open'} ${item.title}`}>{item.action ?? 'Open'}</button>
  </div>
}

function QuietRow({ item, navigate }: { item: HomeItem; navigate: Navigate }) {
  return <div className="agent-item quiet" data-kind={item.kind}>
    <div className="agent-item-text"><div className="agent-item-title">{item.title}</div>{item.detail && <div className="agent-item-sub">{item.detail}</div>}</div>
    <button className="agent-btn" onClick={() => navigate(item.path)} aria-label={`${item.action ?? 'Open'} ${item.title}`}>{item.action ?? 'Open'}</button>
  </div>
}

/** "While you were away": a quiet line that opens the log of what happened. */
function AwayLog({ done, navigate }: { done: HomeItem[]; navigate: Navigate }) {
  const [open, setOpen] = useState(false)
  const byAgent = done.filter((item) => item.by_agent).length
  const line = byAgent
    ? `While you were away I handled ${countWord(byAgent).toLowerCase()} thing${byAgent === 1 ? '' : 's'} on my own.`
    : done.length ? `While you were away there ${done.length === 1 ? 'was one update' : `were ${countWord(done.length).toLowerCase()} updates`}.` : 'While you were away nothing new needed handling.'
  return <section className="agent-away" aria-label="While you were away">
    <p className="agent-away-line"><span>{line}</span>
      {done.length > 0 && <button className="agent-link" aria-expanded={open} onClick={() => setOpen((value) => !value)}>{open ? 'Hide' : byAgent ? 'See what I did' : 'See what changed'}</button>}
    </p>
    {open && <div className="agent-log">{done.slice(0, 10).map((entry, index) => <button key={`${entry.kind}-${index}`} className="agent-log-row" onClick={() => navigate(entry.path)}>
      <span className="agent-log-time">{logTime(entry.at)}</span><span>{entry.title}</span>
    </button>)}</div>}
  </section>
}

/** The practice's conversational agent in the demo's docked conversation, for every
 * member of the practice. It answers, explains, and PREPARES; the backend decides what
 * each role may do (staff can't teach), and any card that changes state runs an
 * existing endpoint only when the person clicks it. */
/** Structured screen context for the dock: the referral EPISODE on screen (not a patient
 * identity). The backend re-validates it against the signed-in user's own practice. */
type DockContext = { referralId: string; patientName: string; referralType: string }

function PracticeAgentDock({ status, navigate, context }: { status: PilotStatus; navigate: Navigate; context?: DockContext }) {
  const { user } = useAuth()
  const me = accountIdentity(status, user?.email)
  const physician = status.role === 'physician'
  const dataVersion = usePilotDataVersion()
  const toReply = (body: AgentReplyBody | null, text: string): DockReply => body ?? { paragraphs: [text] }
  const onSend = async (text: string): Promise<DockReply> => {
    try {
      const { reply } = await sendAssistantMessage(text, context?.referralId)
      return toReply(reply.reply, reply.text)
    } catch (err) { throw new Error(errorText(err, 'I couldn’t take that in just now. Try again in a moment.')) }
  }
  // Only ever runs on a human click on a card; each branch is an existing endpoint.
  const onCard = async (card: DockCard) => {
    const action = card.execute as AgentCardExecute | undefined
    if (!action) return
    try {
      // Stay in place: the write notifies the app, every view re-reads the backend, and the
      // card itself turns into "Draft created · View draft" / "Flagged for physician review".
      if (action.type === 'create_information_request') await requestInformation(action.referral_id, action.items, '')
      else if (action.type === 'escalate') await escalateReferral(action.referral_id, '')
      else if (action.type === 'open_referral_draft') { setReferralPrefill(action.draft); navigate(pilotPaths.newReferral) }
    } catch (err) { throw new Error(errorText(err, 'That didn’t work. Open the referral to try again.')) }
  }
  const shared = { title: 'Your agent', placeholder: 'Ask or teach your agent…', onSend, navigate, onCard, refreshKey: dataVersion,
    loadHistory: () => getAssistant().then((data) => dockMessagesFrom(data.messages)) }
  if (context) return <AgentDock {...shared} greetingAfterHistory
    subtitle={`${context.patientName} · ${context.referralType}`}
    greeting={`I’m looking at ${context.patientName}’s ${context.referralType} referral with you. Ask why I recommended what I did, what’s missing, or what has happened so far, or have me prepare the next step.`}
    suggestions={['Why did you recommend this?', 'What’s missing?', 'Prepare a request for the missing information.', 'Summarize what happened.']} />
  return <AgentDock {...shared}
    subtitle={`${status.practice?.name ?? 'Your practice'} · prepares, you decide`}
    greeting={`Hi${me.firstName ? ` ${me.firstName}` : ''}. Ask me what needs attention, why I recommended something, or to prepare a request or referral draft.${physician ? ' You can also teach me how you like to work; I’ll draft it for you to confirm.' : ''}`}
    suggestions={physician
      ? ['What needs my attention today?', 'Which referrals are waiting on information?', 'I prefer eConsult for stable medication questions.']
      : ['What needs attention today?', 'Which referrals are waiting on information?', 'What can you help with?']} />
}

/* ------------------------------------------------------------- referrals */
/* Patients: the general clinical workspace. Rows are patient work items (today only
 * received referrals); the row component knows nothing referral-specific. */

/** Patient work items in the demo Patients worklist treatment. */
function PatientWorkRows({ items, navigate }: { items: PatientWorkItem[]; navigate: Navigate }) {
  return <div className="lam-list patient-worklist">{items.map((item) => <button key={item.key} className="lam-row worklist-row pilot-patient-row" onClick={() => navigate(item.path)}>
    <span className="lam-row-mark patient-row-avatar">{item.patient.initials}</span>
    <span className="lam-row-main"><strong>{item.patient.name}</strong><small>{item.episode.title} · {item.episode.summary}</small><small>{item.episode.source} · {formatDate(item.episode.at)}</small></span>
    <span className={`worklist-status ${item.status.tone}`}>{item.status.label}</span>
    <span className="worklist-next-step">{item.nextStep}</span>
    <span className="worklist-updated">{item.flag}</span>
  </button>)}</div>
}

function PatientsPage({ navigate }: { navigate: Navigate }) {
  const [items, setItems] = useState<PatientWorkItem[] | null>(null)
  const [query, setQuery] = useState('')
  const [error, setError] = useState('')
  const load = () => { listReferrals().then((rows) => setItems(rows.map(receivedReferralWorkItem))).catch((err) => setError(errorText(err, 'Could not load patients'))) }
  useEffect(load, [])
  useOnPilotDataChange(load)
  const { active, previous } = patientWorkSections(items ?? [], query)
  return <main className="page-shell selector-page">
    <header className="selector-header">
      <div><p className="eyebrow">Your patients</p><h1>Patients</h1><p>Patients with active work in your practice, including new referrals awaiting review.</p></div>
      <button className="button-primary" onClick={() => navigate(pilotPaths.newReferral)}>New referral <span>+</span></button>
    </header>
    <label className="patient-search"><svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="11" cy="11" r="6" /><path d="m16 16 4 4" /></svg><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search patients, clinical problem, or referring clinician…" aria-label="Search patients" /></label>
    {error && <div className="error-banner" role="alert">{error}</div>}
    {!items && !error && <div className="page-state embedded"><div className="loading-line" /><p>Opening patients…</p></div>}
    {active.length > 0 && <section className="patient-worklist-section">
      <div className="home-section-heading"><h2>Active patients</h2><span>{active.length}</span></div>
      <PatientWorkRows items={active} navigate={navigate} />
    </section>}
    {previous.length > 0 && <section className="patient-worklist-section">
      <div className="home-section-heading"><h2>Previous care</h2><span>{previous.length}</span></div>
      <PatientWorkRows items={previous} navigate={navigate} />
    </section>}
    {items && active.length + previous.length === 0 && <div className="empty-state specialist-empty">
      <LaminaMark />
      <h2>{items.length ? 'No patients found' : 'No patients yet'}</h2>
      <p>{items.length ? 'Try a different name, clinical problem, or clinician.' : 'Patients appear here as work arrives. Enter the first referral your practice receives and Lamina will triage it against your rules.'}</p>
      {!items.length && <button className="button-primary" onClick={() => navigate(pilotPaths.newReferral)}>New referral <span>+</span></button>}
    </div>}
    {items && items.length > 0 && <p className="network-roster-note">Each row is one piece of patient work, such as a received referral. In the pilot, Lamina doesn’t combine rows into a single patient record.</p>}
  </main>
}

function NewReferralPage({ navigate }: { navigate: Navigate }) {
  // An agent-prepared draft (if any) prefills the form once; nothing is saved until submit.
  const [form, setForm] = useState<ReferralForm>(() => ({ ...emptyReferralForm(), ...(takeReferralPrefill() ?? {}) }))
  const [file, setFile] = useState<File | null>(null)
  const [rules, setRules] = useState<PracticeRule[]>([])
  const [errors, setErrors] = useState<string[]>([])
  const [busy, setBusy] = useState(false)
  useEffect(() => { getPracticeRules().then(setRules).catch(() => setRules([])) }, [])
  const set = (key: keyof ReferralForm) => (event: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>) => setForm((current) => ({ ...current, [key]: event.target.value }))
  const matching = rules.filter((rule) => rule.referral_type.toLowerCase() === form.referralType.trim().toLowerCase())
  const requirementOptions = matching.flatMap((rule) => [...rule.content.required, ...rule.content.helpful])
  const submit = async (event: FormEvent) => {
    event.preventDefault()
    const problems = referralFormErrors(form)
    setErrors(problems)
    if (problems.length) return
    setBusy(true)
    try {
      const created = await createReferral(referralPayload(form, Boolean(file)))
      if (file) {
        try { await uploadReferralDocument(created.referral.id, file) }
        catch (err) { setErrors([`The referral was saved, but the document upload failed: ${errorText(err, 'upload failed')}. Add it from the referral page.`]); navigate(pilotPaths.referral(created.referral.id)); return }
      }
      navigate(pilotPaths.referral(created.referral.id))
    } catch (err) { setErrors([errorText(err, 'Could not save the referral.')]) } finally { setBusy(false) }
  }
  return <main className="page-shell selector-page pilot-form-page">
    <button className="text-button back-link" onClick={() => navigate(pilotPaths.patients)}>← All patients</button>
    <header className="selector-header"><div><p className="eyebrow">Referral intake</p><h1>New referral</h1><p>Enter what the referring office sent. Lamina never looks the patient up elsewhere — it works only from what you enter and attach.</p></div></header>
    <form className="auth-form pilot-form" onSubmit={(event) => void submit(event)} aria-busy={busy}>
      <fieldset><legend>Referring clinician</legend>
        <label><span>Name</span><input value={form.senderName} onChange={set('senderName')} disabled={busy} /></label>
        <div className="pilot-form-row">
          <label><span>Practice</span><input value={form.senderPractice} onChange={set('senderPractice')} disabled={busy} /></label>
          <label><span>Contact (fax, phone, or email)</span><input value={form.senderContact} onChange={set('senderContact')} disabled={busy} /></label>
        </div>
        <label><span>NPI (optional)</span><input inputMode="numeric" value={form.senderNpi} onChange={set('senderNpi')} disabled={busy} /></label>
      </fieldset>
      <fieldset><legend>Patient</legend>
        <div className="pilot-form-row">
          <label><span>Name</span><input value={form.patientName} onChange={set('patientName')} disabled={busy} /></label>
          <label><span>Date of birth</span><input type="date" value={form.patientDob} onChange={set('patientDob')} disabled={busy} /></label>
        </div>
        <div className="pilot-form-row">
          <label><span>Phone</span><input value={form.patientPhone} onChange={set('patientPhone')} disabled={busy} /></label>
          <label><span>Insurance</span><input value={form.patientInsurance} onChange={set('patientInsurance')} disabled={busy} /></label>
        </div>
        <label><span>Chart / MRN (optional)</span><input value={form.patientExternalId} onChange={set('patientExternalId')} disabled={busy} /></label>
      </fieldset>
      <fieldset><legend>Referral</legend>
        <label><span>Referral type</span><input list="pilot-referral-types" value={form.referralType} onChange={set('referralType')} disabled={busy} placeholder={rules.length ? 'Choose one of your rule types or enter another' : 'e.g. Diabetes management'} /></label>
        <datalist id="pilot-referral-types">{[...new Set(rules.map((rule) => rule.referral_type))].map((type) => <option key={type} value={type} />)}</datalist>
        <label><span>Reason for referral</span><textarea rows={3} value={form.reason} onChange={set('reason')} disabled={busy} /></label>
        <label><span>Clinical context (optional)</span><textarea rows={4} value={form.clinicalContext} onChange={set('clinicalContext')} disabled={busy} /></label>
        <div className="pilot-form-row">
          <label><span>Priority marked by sender</span><select value={form.senderPriority} onChange={set('senderPriority')} disabled={busy}><option value="">Not marked</option><option value="routine">Routine</option><option value="soon">Soon</option><option value="urgent">Urgent</option></select></label>
          <label><span>Date received</span><input type="datetime-local" value={form.receivedAt} onChange={set('receivedAt')} disabled={busy} /></label>
        </div>
      </fieldset>
      {requirementOptions.length > 0 && <fieldset><legend>Information included with the referral</legend>
        <p className="muted-note">Record what the referral already contains so Lamina can check completeness. Leave anything not provided blank.</p>
        {requirementOptions.map((requirement) => {
          const item = form.items.find((entry) => entry.key === requirement.key) ?? { key: requirement.key, value: '', observedDate: '' }
          const update = (patch: Partial<typeof item>) => setForm((current) => ({ ...current, items: [...current.items.filter((entry) => entry.key !== requirement.key), { ...item, ...patch }] }))
          return <div className="pilot-form-row" key={requirement.key}>
            <label><span>{requirement.label}{requirement.required ? '' : ' (helpful)'}</span><input value={item.value} onChange={(event) => update({ value: event.target.value })} disabled={busy} placeholder="Value or summary" /></label>
            <label><span>Date{requirement.freshness_days ? ` (needed within ${requirement.freshness_days} days)` : ''}</span><input type="date" value={item.observedDate} onChange={(event) => update({ observedDate: event.target.value })} disabled={busy} /></label>
          </div>
        })}
      </fieldset>}
      <fieldset><legend>Referral document (optional)</legend>
        <label><span>PDF, image, or text file · 15 MB max</span><input type="file" accept="application/pdf,image/png,image/jpeg,image/tiff,text/plain" onChange={(event) => setFile(event.target.files?.[0] ?? null)} disabled={busy} /></label>
        <p className="muted-note">Stored privately for your practice. Text in PDFs and images isn’t read automatically yet — record key facts above.</p>
      </fieldset>
      {errors.length > 0 && <div className="error-banner" role="alert">{errors.map((message) => <p key={message}>{message}</p>)}</div>}
      <button className="button-primary" type="submit" disabled={busy}>{busy ? 'Saving and triaging…' : 'Save and triage'} <span>→</span></button>
    </form>
  </main>
}

/* -------------------------------------------------------------- detail */

function RequirementRow({ requirement, referralId, canRecord, onDetail }: { requirement: RequirementAssessment; referralId: string; canRecord: boolean; onDetail: (detail: ReferralDetail) => void }) {
  const [open, setOpen] = useState(false)
  const [value, setValue] = useState(requirement.evidence?.quote ?? '')
  const [date, setDate] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const fromDocument = requirement.state === 'proposed_from_document' && requirement.evidence?.document_id
  const save = async () => {
    if (!value.trim()) { setError('Enter the value or a short summary.'); return }
    setBusy(true); setError('')
    try {
      onDetail(await recordReferralItem(referralId, {
        key: requirement.key, value: value.trim(), observed_date: date || null,
        document_id: fromDocument ? requirement.evidence?.document_id : null, page: fromDocument ? requirement.evidence?.page : null,
      }))
      setOpen(false)
    } catch (err) { setError(errorText(err, 'Could not record this item.')) } finally { setBusy(false) }
  }
  return <li className={`pilot-requirement state-${requirement.state}`}>
    <div className="pilot-requirement-main">
      <strong>{requirement.label}{requirement.required ? '' : ' (helpful)'}</strong>
      <span className="pilot-requirement-state">{REQUIREMENT_STATE_LABELS[requirement.state]}</span>
      <span className="muted-note">{requirement.detail}{requirement.freshness_days ? ` · needed within ${requirement.freshness_days} days` : ''}</span>
      {requirement.evidence?.quote && <blockquote>“{requirement.evidence.quote}”{requirement.evidence.page ? ` — page ${requirement.evidence.page}` : ''}</blockquote>}
    </div>
    {canRecord && requirement.state !== 'satisfied' && !open && <button className="text-button" onClick={() => setOpen(true)}>{fromDocument ? 'Confirm from document' : 'Record received'}</button>}
    {open && <div className="pilot-inline-form">
      <label><span>Value</span><input value={value} onChange={(event) => setValue(event.target.value)} disabled={busy} /></label>
      <label><span>Date of result</span><input type="date" value={date} onChange={(event) => setDate(event.target.value)} disabled={busy} /></label>
      {error && <p className="error-banner" role="alert">{error}</p>}
      <div className="onboarding-actions"><button className="button-primary" disabled={busy} onClick={() => void save()}>{busy ? 'Saving…' : 'Save'}</button><button className="text-button" onClick={() => setOpen(false)}>Cancel</button></div>
    </div>}
  </li>
}

const REQUEST_STATUS: Record<InformationRequest['status'], string> = {
  draft: 'Draft — needs your approval', approved: 'Approved', sent: 'Sent — waiting on the referring office',
  partially_resolved: 'Partly answered', resolved: 'Resolved', cancelled: 'Cancelled',
}

/** Approval-gated missing-information request. Nothing leaves Lamina until a person
 * clicks "Approve & email" (dev outbox / configured adapter) or "Mark as sent". */
function InformationRequestPanel({ request, senderName, onChanged }: { request: InformationRequest; senderName: string; onChanged: () => void }) {
  const [editing, setEditing] = useState(false)
  const [message, setMessage] = useState(request.draft_message)
  const [recipient, setRecipient] = useState(request.recipient ?? '')
  const [link, setLink] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const run = async (action: () => Promise<InformationRequest>, keepLink = false) => {
    setBusy(true); setError('')
    try { const result = await action(); if (keepLink && result.status_link) setLink(result.status_link); setEditing(false); onChanged() }
    catch (err) { setError(errorText(err, 'That didn’t work.')) } finally { setBusy(false) }
  }
  const draft = request.status === 'draft'
  return <div className={`pilot-panel pilot-request status-${request.status}`}>
    <div className="pilot-section-head"><h3>Information request</h3><span className={`pilot-status-pill request-${request.status}`}>{REQUEST_STATUS[request.status]}</span></div>
    <p className="muted-note">Asks {senderName} for: {request.items.map((item) => item.label).join(', ')}{request.sent_at ? ` · sent ${formatDateTime(request.sent_at)} via ${request.sent_via === 'manual' ? 'your own fax/email' : request.sent_via}` : ''}</p>
    {editing ? <div className="pilot-inline-form">
      <label><span>Recipient email (leave blank to send it yourself)</span><input value={recipient} onChange={(event) => setRecipient(event.target.value)} disabled={busy} /></label>
      <label><span>Message — keep {'{status_link}'} where the secure link should go</span><textarea rows={8} value={message} onChange={(event) => setMessage(event.target.value)} disabled={busy} /></label>
      <div className="onboarding-actions"><button className="button-primary" disabled={busy} onClick={() => void run(() => editInformationRequest(request.id, { message, recipient }))}>Save draft</button><button className="text-button" onClick={() => setEditing(false)}>Cancel</button></div>
    </div> : <pre className="pilot-message">{request.draft_message}</pre>}
    {link && <div className="pilot-panel"><p><strong>Secure link for the referring office</strong> — included in the message. Shown once.</p><code className="pilot-link">{link}</code><button className="text-button" onClick={() => void navigator.clipboard?.writeText(link)}>Copy link</button></div>}
    {error && <p className="error-banner" role="alert">{error}</p>}
    <div className="pilot-actions">
      {draft && !editing && <button className="button-secondary" disabled={busy} onClick={() => setEditing(true)}>Edit</button>}
      {draft && request.channel === 'email' && request.recipient && <button className="button-primary" disabled={busy} onClick={() => void run(() => sendInformationRequest(request.id, 'send'), true)}>Approve &amp; email {request.recipient}</button>}
      {draft && <button className={request.channel === 'email' ? 'text-button' : 'button-primary'} disabled={busy} onClick={() => void run(() => sendInformationRequest(request.id, 'mark_sent'), true)}>{request.channel === 'email' ? 'I’ll send it myself' : 'Approve — I’ll fax/send it'}</button>}
      {(request.status === 'sent' || request.status === 'partially_resolved') && <button className="text-button" disabled={busy} onClick={() => void run(() => resolveInformationRequest(request.id))}>Mark resolved</button>}
      {request.status !== 'resolved' && <button className="text-button" disabled={busy} onClick={() => void run(() => cancelInformationRequest(request.id))}>Cancel request</button>}
    </div>
  </div>
}

type Panel = null | 'edit' | 'reject' | 'request' | 'escalate' | 'accept' | 'redirect' | 'decline'

const statusLabelTone = (status: ReferralDetail['referral']['status']) =>
  status === 'accepted' ? 'resolved' : status === 'redirected' || status === 'declined' ? '' : 'warning'

/** Referral detail in the demo's Patient Detail structure: identity header, a prominent
 * next-step box (right), and the referral history + triage evidence (left). */
function ReferralDetailPage({ id, status, navigate }: { id: string; status: PilotStatus; navigate: Navigate }) {
  const [detail, setDetail] = useState<ReferralDetail | null>(null)
  const [error, setError] = useState('')
  const [panel, setPanel] = useState<Panel>(null)
  const [busy, setBusy] = useState(false)
  const [note, setNote] = useState('')
  const [redirectTo, setRedirectTo] = useState('')
  const [edit, setEdit] = useState<Partial<EffectiveTriage>>({})
  const [requestItems, setRequestItems] = useState<string[]>([])
  const load = useCallback(() => getReferral(id).then((next) => { setDetail(next); setError('') }).catch((err) => setError(errorText(err, 'Could not load this referral'))), [id])
  useEffect(() => { void load() }, [load])
  useOnPilotDataChange(() => void load())

  const act = async (action: () => Promise<ReferralDetail>) => {
    setBusy(true); setError('')
    try { setDetail(await action()); setPanel(null); setNote(''); setRedirectTo(''); setEdit({}) }
    catch (err) {
      setError(errorText(err, 'That action could not be completed.'))
      if (err instanceof ApiError && (err.code === 'stale_referral' || err.code === 'already_decided')) void load()
    } finally { setBusy(false) }
  }
  const back = <button className="text-button back-link" onClick={() => navigate(pilotPaths.patients)}>← All patients</button>
  if (error && !detail) return <main className="page-shell patient-page">{back}<div className="error-banner" role="alert">{error}</div></main>
  if (!detail) return <main className="page-shell patient-page">{back}<div className="page-state embedded"><div className="loading-line" /><p>Opening referral…</p></div></main>

  const { referral, recommendation, effective_triage: triage, decision, allowed_actions: actions } = detail
  const openPanel = (next: Panel) => { setPanel(next); setNote(''); setEdit({}); if (next === 'request') setRequestItems(recommendation?.missing_items ?? []) }
  const physician = status.role === 'physician'
  const closed = isClosed(referral.status)
  const readiness = !recommendation ? null : recommendation.readiness === 'ready' ? 'Complete per your rule' : recommendation.readiness === 'unknown' ? 'Unknown — no rule for this type' : `Missing ${recommendation.missing_items.join(', ')}`
  const timeline = [...detail.history].reverse()
  const careContext = [
    { label: 'Referring clinician', value: `${referral.sender.name}${referral.sender.practice ? ` · ${referral.sender.practice}` : ''}` },
    referral.sender.contact && { label: 'Contact', value: referral.sender.contact },
    referral.sender.npi && { label: 'Referring NPI', value: referral.sender.npi },
    referral.patient.insurance && { label: 'Insurance', value: referral.patient.insurance },
    referral.patient.phone && { label: 'Patient phone', value: referral.patient.phone },
    referral.sender_priority && { label: 'Sender priority', value: PRIORITY_LABELS[referral.sender_priority] },
    { label: 'Received', value: formatDateTime(referral.received_at) },
    { label: 'Entered', value: `${formatDateTime(referral.entered_at)} · ${referral.source === 'public_form' ? 'public referral form' : referral.source === 'upload' ? 'with document' : 'manual entry'}` },
    referral.patient.external_id && { label: 'Chart / MRN', value: referral.patient.external_id },
  ].filter((item): item is { label: string; value: string } => Boolean(item))

  return <main className="page-shell patient-page pilot-referral-page">
    {back}
    <header className="patient-identity"><span className="patient-row-avatar large">{patientInitials(referral.patient.name)}</span><div><h1>{referral.patient.name}</h1>
      <p>{[referral.referral_type, referral.patient.date_of_birth && `DOB ${referral.patient.date_of_birth}`, `received ${formatDate(referral.received_at)}`].filter(Boolean).join(' · ')}</p>
      {/* Honest scope: the pilot stores patient details per referral, not a chart. */}
      <p className="pilot-episode-note">Received referral · patient details as recorded on this referral, not a full patient record</p></div></header>
    <p className="patient-current-issue"><span className="section-label">Reason for referral</span>{referral.reason}</p>
    <hr className="patient-header-divider" />
    {error && <div className="error-banner" role="alert">{error}</div>}

    <div className="patient-detail-grid">
      <aside className="patient-next-step patient-top-card">
        <h2>Next step</h2>
        <p className="page-intro">{closed ? 'This referral is closed.' : 'Lamina prepared this. Your team decides.'}</p>
        <div className={`next-step-card ${closed ? 'idle' : 'ready'}`}>
          <span className={`status-label ${statusLabelTone(referral.status)}`}>{STATUS_LABELS[referral.status]}</span>
          <h3>{closed ? (referral.disposition?.decision === 'redirect' ? `Redirected to ${referral.disposition.redirect_to}` : STATUS_LABELS[referral.status]) : triage ? NEXT_STEP_LABELS[triage.next_step] : 'Waiting for triage'}</h3>
          {triage && <p>{FIT_LABELS[triage.fit]}{readiness ? ` · ${readiness}` : ''} · {PRIORITY_LABELS[triage.suggested_priority].toLowerCase()} priority · {MODALITY_LABELS[triage.suggested_modality]}{triage.requires_physician ? ' · needs physician judgment' : ''}</p>}
          {!triage && !closed && <p>Lamina hasn’t triaged this referral yet{recommendation ? '' : ' — add a referral rule for this type, then re-run triage'}.</p>}
          {referral.disposition && <p>{referral.disposition.decision === 'accept' ? 'Accepted' : referral.disposition.decision === 'redirect' ? `Redirected to ${referral.disposition.redirect_to}` : 'Declined'} · {formatDateTime(referral.disposition.at)}{referral.disposition.reason ? ` — “${referral.disposition.reason}”` : ''}</p>}
          {decision && <p className="pilot-decision">Triage {decision.decision === 'accepted' ? 'approved' : decision.decision} by {decision.actor_role} · {formatDateTime(decision.created_at)}{decision.reason ? ` — “${decision.reason}”` : ''}</p>}
          {referral.escalated_at && <p className="pilot-decision">Flagged for physician review{referral.escalation_note ? ` — “${referral.escalation_note}”` : ''}</p>}

          {actions.length > 0 && <div className="pilot-actions" role="group" aria-label="Referral actions">
            {canUse(actions, 'approve') && <button className="button-primary" disabled={busy} onClick={() => void act(() => approveTriage(referral.id))}>Approve triage</button>}
            {canUse(actions, 'edit') && <button className="button-secondary" disabled={busy} onClick={() => openPanel('edit')}>Edit</button>}
            {canUse(actions, 'request_information') && <button className="button-secondary" disabled={busy} onClick={() => openPanel('request')}>Request information</button>}
            {canUse(actions, 'escalate') && <button className="button-secondary" disabled={busy} onClick={() => openPanel('escalate')}>Needs physician review</button>}
            {canUse(actions, 'reject') && <button className="text-button" disabled={busy} onClick={() => openPanel('reject')}>Triage is wrong</button>}
            {canUse(actions, 'retriage') && <button className="text-button" disabled={busy} onClick={() => void act(() => retriageReferral(referral.id))}>Re-run triage</button>}
          </div>}

          {panel === 'edit' && triage && <div className="pilot-panel">
            <h3>Edit triage</h3>
            <div className="pilot-form-row">
              <label><span>Fit</span><select value={edit.fit ?? triage.fit} onChange={(event) => setEdit({ ...edit, fit: event.target.value as Fit })}>{(Object.keys(FIT_LABELS) as Fit[]).map((value) => <option key={value} value={value}>{FIT_LABELS[value]}</option>)}</select></label>
              <label><span>Priority</span><select value={edit.suggested_priority ?? triage.suggested_priority} onChange={(event) => setEdit({ ...edit, suggested_priority: event.target.value as Priority })}>{(Object.keys(PRIORITY_LABELS) as Priority[]).map((value) => <option key={value} value={value}>{PRIORITY_LABELS[value]}</option>)}</select></label>
            </div>
            <div className="pilot-form-row">
              <label><span>Modality</span><select value={edit.suggested_modality ?? triage.suggested_modality} onChange={(event) => setEdit({ ...edit, suggested_modality: event.target.value as Modality })}>{(Object.keys(MODALITY_LABELS) as Modality[]).map((value) => <option key={value} value={value}>{MODALITY_LABELS[value]}</option>)}</select></label>
              <label><span>Next step</span><select value={edit.next_step ?? triage.next_step} onChange={(event) => setEdit({ ...edit, next_step: event.target.value as NextStep })}>{(Object.keys(NEXT_STEP_LABELS) as NextStep[]).map((value) => <option key={value} value={value}>{NEXT_STEP_LABELS[value]}</option>)}</select></label>
            </div>
            <label className="pilot-check"><input type="checkbox" checked={edit.requires_physician ?? triage.requires_physician} onChange={(event) => setEdit({ ...edit, requires_physician: event.target.checked })} /> Needs physician judgment</label>
            <label><span>Why (helps Lamina learn)</span><textarea rows={2} value={note} onChange={(event) => setNote(event.target.value)} /></label>
            <div className="onboarding-actions"><button className="button-primary" disabled={busy} onClick={() => void act(() => editTriage(referral.id, { ...edit, reason: note || null }))}>Save edits</button><button className="text-button" onClick={() => setPanel(null)}>Cancel</button></div>
          </div>}
          {panel === 'reject' && <div className="pilot-panel">
            <h3>What’s wrong with this triage?</h3>
            <textarea rows={3} value={note} onChange={(event) => setNote(event.target.value)} placeholder="e.g. This belongs with a different service" />
            <div className="onboarding-actions"><button className="button-primary" disabled={busy || !note.trim()} onClick={() => void act(() => rejectTriage(referral.id, note))}>Reject and send to physician</button><button className="text-button" onClick={() => setPanel(null)}>Cancel</button></div>
          </div>}
          {panel === 'request' && <div className="pilot-panel">
            <h3>Request information</h3>
            <p className="muted-note">Lamina drafts the request; nothing is sent until you review and approve it.</p>
            {(recommendation?.missing_items ?? []).map((item) => <label key={item} className="pilot-check"><input type="checkbox" checked={requestItems.includes(item)} onChange={(event) => setRequestItems(event.target.checked ? [...requestItems, item] : requestItems.filter((value) => value !== item))} /> {item}</label>)}
            <label><span>Other item or note</span><textarea rows={2} value={note} onChange={(event) => setNote(event.target.value)} /></label>
            <div className="onboarding-actions"><button className="button-primary" disabled={busy} onClick={() => void act(() => requestInformation(referral.id, requestItems, note))}>Prepare request</button><button className="text-button" onClick={() => setPanel(null)}>Cancel</button></div>
          </div>}
          {panel === 'escalate' && <div className="pilot-panel">
            <h3>Flag for physician review</h3>
            <textarea rows={2} value={note} onChange={(event) => setNote(event.target.value)} placeholder="Optional note for the physician" />
            <div className="onboarding-actions"><button className="button-primary" disabled={busy} onClick={() => void act(() => escalateReferral(referral.id, note))}>Flag</button><button className="text-button" onClick={() => setPanel(null)}>Cancel</button></div>
          </div>}

          {physician && canUse(actions, 'accept') && <div className="pilot-disposition">
            <h3>Physician decision</h3>
            <div className="pilot-actions">
              <button className="button-primary" disabled={busy} onClick={() => openPanel('accept')}>Accept referral</button>
              <button className="button-secondary" disabled={busy} onClick={() => openPanel('redirect')}>Redirect</button>
              <button className="button-secondary" disabled={busy} onClick={() => openPanel('decline')}>Decline</button>
            </div>
            {(panel === 'accept' || panel === 'redirect' || panel === 'decline') && <div className="pilot-panel">
              {panel === 'redirect' && <label><span>Redirect to</span><input value={redirectTo} onChange={(event) => setRedirectTo(event.target.value)} placeholder="e.g. Nephrology — Dr. Lee" /></label>}
              <label><span>{panel === 'accept' ? 'Note (optional)' : 'Reason'}</span><textarea rows={2} value={note} onChange={(event) => setNote(event.target.value)} /></label>
              <div className="onboarding-actions"><button className="button-primary" disabled={busy || (panel !== 'accept' && !note.trim()) || (panel === 'redirect' && !redirectTo.trim())} onClick={() => void act(() => decideReferral(referral.id, panel, note, redirectTo))}>Confirm {panel}</button><button className="text-button" onClick={() => setPanel(null)}>Cancel</button></div>
            </div>}
          </div>}
          {!physician && !closed && <p className="muted-note">The physician makes the final accept, redirect, or decline decision.</p>}
        </div>

        {(detail.information_requests ?? []).filter((request) => request.status !== 'cancelled').map((request) => <InformationRequestPanel key={request.id} request={request} senderName={referral.sender.name} onChanged={() => void load()} />)}
        {(detail.sender_responses ?? []).length > 0 && <div className="pilot-panel"><h3>Replies from the referring office</h3><ul className="pilot-documents">{(detail.sender_responses ?? []).map((response) => <li key={response.id}><span>{response.message ?? 'Provided requested values'}</span><span className="muted-note">{response.items.map((item) => `${itemLabel(item.key, detail, item.label)}: ${item.value}${item.observed_date ? ` (${item.observed_date})` : ''}`).join('; ')} · {formatDateTime(response.created_at)}</span></li>)}</ul></div>}
      </aside>

      <div className="patient-clinical-main">
        <section className="patient-history-section patient-top-card" aria-labelledby="referral-history-heading">
          <h2 id="referral-history-heading">Referral history</h2>
          <div className="clinical-timeline">
            {timeline.slice(0, 6).map((event, index) => <div className="timeline-event" key={`${event.event_type}-${index}`}>
              <time>{formatDateTime(event.created_at)}</time>
              <h4>{historyLabel(event.event_type)}</h4>
              <p>{event.autonomy === 'automatic' ? 'By Lamina' : 'By your team'}</p>
            </div>)}
            {timeline.length === 0 && <div className="timeline-event"><h4>Referral received</h4><p>From {referral.sender.name} · {formatDateTime(referral.received_at)}</p></div>}
          </div>
        </section>

        <section className="clinical-overview" aria-labelledby="triage-overview-heading">
          <header className="clinical-overview-head"><h2 id="triage-overview-heading">Triage overview</h2><p>Lamina’s recommendation from your practice rules and what the referral contains. Inspect the evidence before acting.</p></header>
          {recommendation && triage ? <>
            <div className="clinical-columns">
              <section><h3>Recommendation</h3><ul className="clinical-list">
                <li>{FIT_LABELS[triage.fit]}</li>
                <li>{PRIORITY_LABELS[triage.suggested_priority]} priority</li>
                <li>{MODALITY_LABELS[triage.suggested_modality]}</li>
              </ul></section>
              <section><h3>Readiness</h3><ul className="clinical-list">
                <li>{readiness}</li>
                <li>{triage.requires_physician ? 'Needs physician judgment' : 'No physician judgment flagged'}</li>
                <li>Suggested next step: {NEXT_STEP_LABELS[triage.next_step]}</li>
              </ul></section>
            </div>
            <section className="clinical-block">
              <h3>Required information<em>{formatDateTime(recommendation.created_at)}</em></h3>
              {recommendation.requirements.length === 0 && <p className="muted-note">No requirements recorded for this referral type.</p>}
              <ul className="pilot-requirements">{recommendation.requirements.map((requirement) => <RequirementRow key={requirement.key} requirement={requirement} referralId={referral.id} canRecord={canUse(actions, 'record_item')} onDetail={setDetail} />)}</ul>
            </section>
            <details className="clinical-block pilot-why" open>
              <summary>Why</summary>
              <ul className="clinical-list">{recommendation.rationale.map((item, index) => <li key={index}>{item.statement} <small className="muted-note">{
                item.source.kind === 'practice_rule' || item.source.kind === 'requirement_logic' ? `Rule v${item.source.rule_version ?? '?'}`
                  : item.source.kind === 'document' ? `Document, page ${item.source.page ?? '?'}`
                  : item.source.kind === 'submitted_item' ? 'Submitted with referral' : 'No rule'
              }</small></li>)}</ul>
              <p className="muted-note">Rules snapshot {recommendation.rules_snapshot_id} · {recommendation.generator === 'deterministic' ? 'deterministic rule checks' : `rule checks + model-proposed evidence (${recommendation.model_id})`}</p>
            </details>
          </> : <p className="muted-note">Not triaged yet.</p>}
          {referral.clinical_context && <section className="clinical-block"><h3>Clinical context</h3><p className="pilot-pre">{referral.clinical_context}</p></section>}
          <section className="clinical-block">
            <h3>Documents</h3>
            {referral.documents.length === 0 && <p className="muted-note">No documents attached.</p>}
            <ul className="pilot-documents">{referral.documents.map((document) => <li key={document.id}>
              <button className="text-button" onClick={() => void openReferralDocument(document.id).catch((err) => setError(errorText(err, 'Could not open the document.')))}>{document.filename}</button>
              <span className="muted-note">{Math.max(1, Math.round(document.size_bytes / 1024))} KB · {document.extraction_status === 'extracted' ? `text read (${document.page_count ?? 1} page${document.page_count === 1 ? '' : 's'})` : 'not read automatically — review manually'}</span>
            </li>)}</ul>
            {canUse(actions, 'upload_document') && <label className="pilot-upload"><span>Attach a document</span><input type="file" accept="application/pdf,image/png,image/jpeg,image/tiff,text/plain" disabled={busy} onChange={(event) => { const file = event.target.files?.[0]; if (file) void act(() => uploadReferralDocument(referral.id, file)); event.target.value = '' }} /></label>}
          </section>
          <section className="clinical-block care-context">
            <h3>Referral context</h3>
            <dl>{careContext.map((item) => <div key={item.label}><dt>{item.label}</dt><dd>{item.value}</dd></div>)}</dl>
          </section>
        </section>
        <details className="source-record"><summary>Full activity log <span>Every recorded event for this referral, newest first</span></summary>
          <div className="source-record-body"><section><ul className="record-rows">{timeline.map((event, index) => <li key={index}>{formatDateTime(event.created_at)} · {historyLabel(event.event_type)} · {event.autonomy === 'automatic' ? 'by Lamina' : 'by your team'}</li>)}</ul></section></div>
        </details>
      </div>
    </div>
    {/* The same practice agent, told explicitly which referral is on screen. Keyed by the
      * referral so moving between patients never carries one patient's framing into another. */}
    <PracticeAgentDock key={referral.id} status={status} navigate={navigate}
      context={{ referralId: referral.id, patientName: referral.patient.name, referralType: referral.referral_type }} />
  </main>
}

/* -------------------------------------------------------------- profile */

/** Profile & practice in the demo's professional-profile layout: identity hero, header
 * actions, then quiet sections. Practice edits and team management are physician-only. */
function ProfilePage({ status, reload, navigate }: { status: PilotStatus; reload: () => void; navigate: Navigate }) {
  const { user } = useAuth()
  const [members, setMembers] = useState<PracticeMember[] | null>(null)
  const [invitations, setInvitations] = useState<PracticeInvitation[]>([])
  const [label, setLabel] = useState('')
  const [link, setLink] = useState('')
  const [error, setError] = useState('')
  const [editing, setEditing] = useState(false)
  const physician = status.role === 'physician'
  const me = accountIdentity(status, user?.email)
  const identity = status.physician_onboarding.confirmed_identity
  const load = () => getPracticeMembers().then((result) => { setMembers(result.members); setInvitations(result.invitations) }).catch((err) => setError(errorText(err, 'Could not load members')))
  useEffect(() => { void load() }, [])
  useOnPilotDataChange(() => void load())
  const invite = async (event: FormEvent) => {
    event.preventDefault(); setError('')
    try {
      const created = await inviteStaff(label.trim())
      setLink(`${window.location.origin}${pilotPaths.join}?invite=${encodeURIComponent(created.token)}`)
      setLabel(''); void load()
    } catch (err) { setError(errorText(err, 'Could not create the invitation.')) }
  }
  const practice = status.practice
  const pending = invitations.filter((item) => item.state === 'pending')
  return <main className="page-shell profile-page professional-profile-page">
    <header className="profile-hero">
      <span className="clinician-avatar large">{me.initials}</span>
      <div>
        <h1>{me.name}</h1>
        <p className="profile-role">{physician ? (identity?.identity.primary_specialty ?? practice?.specialty ?? 'Physician') : `Staff · ${practice?.name ?? 'your practice'}`}</p>
        <p className="profile-location">{practice?.name}{practice?.address ? ` · ${practice.address}` : ''}</p>
      </div>
    </header>
    <div className="profile-header-actions">
      {physician && !editing && <button className="button-primary" onClick={() => setEditing(true)}>Edit practice</button>}
      {physician && <button className="text-button" onClick={() => navigate(pilotPaths.publicProfile)}>View your public physician profile →</button>}
      <button className="text-button" onClick={() => navigate(pilotPaths.agent)}>View how my agent represents the practice →</button>
    </div>
    {error && <div className="error-banner" role="alert">{error}</div>}

    <section className="profile-section-v2">
      <div className="profile-section-heading"><h2>Practice</h2></div>
      {editing && practice
        ? <PracticeFieldsForm initial={practice} submitLabel="Save" busyLabel="Saving…" onCancel={() => setEditing(false)} onSubmit={async (fields) => { await updatePractice(fields); setEditing(false); reload() }} />
        : practice && <dl className="pilot-facts">
          <div><dt>Name</dt><dd>{practice.name}</dd></div>
          <div><dt>Specialty</dt><dd>{practice.specialty ?? '—'}</dd></div>
          <div><dt>Address</dt><dd>{practice.address ?? '—'}</dd></div>
          <div><dt>Phone</dt><dd>{practice.phone ?? '—'}</dd></div>
          <div><dt>Referral contact</dt><dd>{practice.contact_email ?? '—'}</dd></div>
          <div><dt>Website</dt><dd>{practice.website ?? '—'}</dd></div>
        </dl>}
    </section>

    {physician && identity && <section className="profile-section-v2">
      <div className="profile-section-heading"><h2>Professional profile</h2></div>
      <dl className="pilot-facts">
        <div><dt>Name in NPPES</dt><dd>{identity.identity.display_name}</dd></div>
        <div><dt>NPI</dt><dd>{identity.npi}</dd></div>
        <div><dt>Confirmed</dt><dd>{formatDate(identity.confirmed_at)} · self-attested from the public NPPES record</dd></div>
      </dl>
    </section>}

    <section className="profile-section-v2">
      <div className="profile-section-heading"><h2>Team</h2></div>
      {!members && <p className="profile-section-empty">Loading…</p>}
      {members && <div className="profile-item-list">{members.map((member) => <div className="profile-item-row" key={member.id}>
        <div><strong>{member.label ?? (member.role === 'physician' ? 'Physician' : 'Staff member')}</strong><p>{member.role === 'physician' ? 'Physician' : 'Staff'}{member.is_you ? ' · you' : ''}</p><small>Joined {formatDate(member.joined_at)}</small></div>
        {physician && member.role === 'staff' && <button className="text-button" onClick={() => void removeStaffMember(member.id).then(load).catch((err) => setError(errorText(err, 'Could not remove member.')))}>Remove</button>}
      </div>)}
      {physician && pending.map((item) => <div className="profile-item-row" key={item.id}>
        <div><strong>{item.label ?? 'Staff invitation'}</strong><p>Invitation pending</p><small>Expires {formatDate(item.expires_at)}</small></div>
        <button className="text-button" onClick={() => void revokeInvitation(item.id).then(load).catch((err) => setError(errorText(err, 'Could not revoke.')))}>Revoke</button>
      </div>)}</div>}
    </section>

    {physician && <section className="profile-section-v2">
      <div className="profile-section-heading"><h2>Invite staff</h2></div>
      <p className="profile-section-explainer">Staff can enter referrals, attach documents, and review triage. Only physicians accept, redirect, or decline referrals and change referral rules.</p>
      <form className="auth-form pilot-form pilot-invite" onSubmit={(event) => void invite(event)}>
        <label><span>Name or role (for your reference)</span><input value={label} onChange={(event) => setLabel(event.target.value)} placeholder="e.g. Maria — front desk" /></label>
        <button className="button-primary" type="submit">Create invitation link</button>
      </form>
      {link && <div className="pilot-panel"><p><strong>Share this link with your staff member.</strong> It works once and expires in 14 days. It won’t be shown again.</p><code className="pilot-link">{link}</code><button className="text-button" onClick={() => void navigator.clipboard?.writeText(link)}>Copy link</button></div>}
    </section>}
  </main>
}
