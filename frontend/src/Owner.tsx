import { useEffect, useRef, useState } from 'react'
import laminaLogo from './assets/lamina-logo-source.png'
import { useAuth } from './AuthProvider.tsx'
import { displayName, initials, signInPath } from './Claim.tsx'
import { LaminaMark } from './LaminaMark.tsx'
import {
  getAgentOverview,
  getMyProviderClaims,
  getPhysicianSandboxStatus,
  getPracticeRepresentation,
  getProvider,
  getTrainingHistory,
  selectPhysicianSandbox,
  type AgentOverview,
  type PhysicianNetworkProfile,
  type PhysicianSandboxStatus,
  type PracticeRepresentation,
  type ProviderClaim,
  type TrainProjection,
} from './api.ts'
import {
  AgentOverviewPanel,
  ChatTab,
  ProfessionalProfilePage,
  TrainTab,
  TrainingPage,
  trainingPath,
} from './Engagement.tsx'
import { ownerAgentPath, ownerHomePath, ownerProfilePath, ownerTrainPath } from './ownerPaths.ts'

type Navigate = (path: string) => void

/* ------------------------------------------------------------------- shell */

function OwnerBrand() {
  return <div className="brand" aria-label="Lamina"><span className="brand-symbol" aria-hidden="true"><img src={laminaLogo} alt="" /></span><span className="wordmark">LAMINA</span></div>
}

/** Dashboard is the only top-level destination for the owner shell — there is no
 * Patients/Network capability yet. My Agent lives as a persistent sidebar object
 * (see .sidebar-clinician below); Profile moved to the avatar menu, matching the
 * synthetic demo shell's nav pattern. */
const OWNER_NAV_ITEMS = [
  { id: 'home', title: 'Dashboard', icon: '⌂', path: ownerHomePath },
] as const

/** The top-right avatar/account menu: profile access, sign out, and — only when a
 * physician has more than one eligible claim — explicit identity switching through the
 * real selection endpoint. The client never infers or remembers a selection on its own. */
function AccountMenu({ claims, current, onSwitch, navigate, onSignOut, email }: {
  claims: Array<ProviderClaim & { profile: PhysicianNetworkProfile | null }> | null
  current: PhysicianSandboxStatus['provider_identity']
  onSwitch: (claimId: number) => void
  navigate: Navigate; onSignOut: () => void; email: string | null
}) {
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
  const switchableClaims = (claims ?? []).filter((claim) => claim.npi !== current?.npi)
  return <div className="owner-identity-switcher" ref={containerRef}>
    <button className="profile-control avatar-control" onClick={() => setOpen((value) => !value)} aria-haspopup="menu" aria-expanded={open} aria-label="Account menu">
      <span>{current ? initials(displayName(current.display_name)) : '··'}</span><strong>{current ? displayName(current.display_name) : email ?? 'Account'}</strong>
    </button>
    {open && <div className="perspective-menu" role="menu" aria-label="Account menu">
      <button role="menuitem" className="perspective-option" onClick={() => { setOpen(false); navigate(ownerProfilePath) }}>Profile</button>
      <div className="perspective-menu-divider" role="separator" /><button role="menuitem" className="perspective-option" onClick={() => { setOpen(false); onSignOut() }}>Sign out</button>
      {switchableClaims.length > 0 && <><div className="perspective-menu-divider" role="separator" /><p className="perspective-menu-label">Your other claimed identities</p>
        {switchableClaims.map((claim) => <button key={claim.id} role="menuitem" className="perspective-option" onClick={() => { setOpen(false); onSwitch(claim.id) }}>
          <span><strong>{claim.profile ? displayName(claim.profile.display_name) : `NPI ${claim.npi}`}</strong><small>{claim.profile?.specialty ?? ''}</small></span>
        </button>)}
      </>}
    </div>}
  </div>
}

/** The authenticated private workspace shell. Deliberately limited to Home / Profile / My
 * Agent for Pass 8B — no Patients, Consultations, Network, or Feed, because those
 * capabilities do not exist for the owner sandbox yet. Gates on auth + claim selection
 * before rendering any owner-scoped content. */
export function OwnerShell({ children, navigate, section }: { children: React.ReactNode; navigate: Navigate; section: string }) {
  const { configured, loading: authLoading, user, signOut } = useAuth()
  const [status, setStatus] = useState<PhysicianSandboxStatus | null>(null)
  const [statusError, setStatusError] = useState('')
  const [claims, setClaims] = useState<Array<ProviderClaim & { profile: PhysicianNetworkProfile | null }> | null>(null)
  const [switching, setSwitching] = useState(false)

  const loadStatus = () => {
    setStatusError('')
    getPhysicianSandboxStatus().then(setStatus).catch((err) => setStatusError(err instanceof Error ? err.message : 'Could not open your private workspace'))
  }
  useEffect(() => { if (user) loadStatus() }, [user]) // eslint-disable-line react-hooks/exhaustive-deps

  const loadClaims = () => {
    getMyProviderClaims().then(async (list) => {
      const eligible = list.filter((claim) => claim.status === 'claimed' || claim.status === 'verification_pending' || claim.status === 'verified')
      const withProfiles = await Promise.all(eligible.map(async (claim): Promise<ProviderClaim & { profile: PhysicianNetworkProfile | null }> => {
        try { return { ...claim, profile: await getProvider(claim.npi) } } catch { return { ...claim, profile: null } }
      }))
      setClaims(withProfiles)
    }).catch(() => setClaims([]))
  }
  useEffect(() => { if (user && status) loadClaims() }, [user, status]) // eslint-disable-line react-hooks/exhaustive-deps

  const switchTo = async (claimId: number) => {
    setSwitching(true)
    try { await selectPhysicianSandbox(claimId); loadStatus() }
    catch (err) { setStatusError(err instanceof Error ? err.message : 'Could not switch identity') }
    finally { setSwitching(false) }
  }

  const handleSignOut = async () => { await signOut(); navigate('/claim') }

  if (!configured) return <main className="page-shell owner-gate"><p className="muted-note">Authentication is not configured in this environment.</p></main>
  if (authLoading) return <main className="page-shell owner-gate"><p className="muted-note">Checking your session…</p></main>
  if (!user) return <main className="page-shell owner-gate">
    <p className="eyebrow">Physician account</p><h1>Sign in to open your workspace</h1>
    <p className="muted-note">Your private Lamina workspace is available once you sign in and have a claimed physician identity.</p>
    <button className="button-primary" onClick={() => navigate(signInPath(ownerHomePath))}>Sign in <span>→</span></button>
  </main>
  if (statusError) return <main className="page-shell owner-gate"><div className="error-banner" role="alert">{statusError}</div></main>
  if (!status) return <main className="page-shell owner-gate"><p className="muted-note">Opening your private workspace…</p></main>

  if (!status.has_claim) return <main className="page-shell owner-gate">
    <p className="eyebrow">Physician account</p><h1>Select a physician identity</h1>
    <p className="muted-note">Open the private workspace for one of your claimed physician identities.</p>
    {!claims && <p className="muted-note">Loading your claimed identities…</p>}
    {claims && claims.length === 0 && <div className="empty-state"><h2>No eligible claimed identities yet</h2><p>Find and claim your Lamina identity to start building your private agent.</p><button className="button-primary" onClick={() => navigate('/claim')}>Find your Lamina identity →</button></div>}
    {claims && claims.length > 0 && <div className="lam-list">{claims.map((claim) => <button key={claim.id} className="lam-row" onClick={() => void switchTo(claim.id)} disabled={switching}>
      <span className="lam-row-mark directory-avatar">{claim.profile ? initials(displayName(claim.profile.display_name)) : '··'}</span>
      <span className="lam-row-main"><strong>{claim.profile ? displayName(claim.profile.display_name) : `NPI ${claim.npi}`}</strong><span>{claim.profile?.specialty ?? ''}</span></span>
      <span className="lam-row-action">{switching ? 'Opening…' : 'Open private workspace'} <b>→</b></span>
    </button>)}</div>}
  </main>

  const identity = status.provider_identity
  return <div className="app-shell owner-shell" key={identity?.npi ?? 'owner'}>
    <aside className="sidebar">
      <div><button className="brand-button" onClick={() => navigate('/')} aria-label="Return to Lamina portal"><OwnerBrand /></button><p className="brand-subtitle">Private physician workspace</p>
        <nav aria-label="Primary navigation">
          {OWNER_NAV_ITEMS.map((item) => <button key={item.id} className={`nav-item ${section === item.id ? 'active' : ''}`} onClick={() => navigate(item.path)}><span className="nav-icon">{item.icon}</span><span><b>{item.title}</b></span></button>)}
        </nav>
      </div>
      <button className={`sidebar-clinician ${section === 'agent' ? 'active' : ''}`} aria-current={section === 'agent' ? 'page' : undefined} onClick={() => navigate(ownerAgentPath)} aria-label="Open your agent overview">
        <LaminaMark active={status.initialized} />
        <div><span>Your agent</span><strong>{identity ? `${displayName(identity.display_name)}'s Agent` : 'Your Agent'}</strong><small>{status.initialized ? 'Private · initialized' : 'Private · not yet initialized'}</small></div>
      </button>
    </aside>
    <div className="workspace">
      <header className="workspace-bar">
        <div className="workspace-bar-actions">
          <div className="synthetic-status owner-status"><span />Private workspace · not public</div>
          <AccountMenu claims={claims} current={identity} onSwitch={(id) => void switchTo(id)} navigate={navigate} onSignOut={() => void handleSignOut()} email={user.email ?? null} />
        </div>
      </header>
      {children}
    </div>
  </div>
}

/* -------------------------------------------------------------------- Home */

function CapabilityNote({ status }: { status: PhysicianSandboxStatus }) {
  return <section className="owner-capability-note">
    <p className="eyebrow">Where this stands today</p>
    <ul className="owner-capability-list">
      <li><strong>Verification:</strong> {status.verification_status === 'verified' ? 'Verified' : 'Not yet verified'}</li>
      <li><strong>Public profile:</strong> {status.publication_status === 'published' ? 'Published' : 'Private — not visible to the network'}</li>
      <li><strong>Network participation:</strong> Not yet available</li>
      <li><strong>Patient / clinical access:</strong> {status.clinical_access_status === 'enabled' ? 'Enabled' : 'Not available'}</li>
    </ul>
    <p className="muted-note">Verification, publication, network participation, and clinical access are independent steps. Building your profile and agent here does not make any of them active on its own.</p>
  </section>
}

export function OwnerHomePage({ navigate }: { navigate: Navigate }) {
  const [status, setStatus] = useState<PhysicianSandboxStatus | null>(null)
  const [overview, setOverview] = useState<AgentOverview | null>(null)
  useEffect(() => {
    getPhysicianSandboxStatus().then(setStatus).catch(() => {})
    getAgentOverview('owner').then(setOverview).catch(() => {})
  }, [])
  const identity = status?.provider_identity
  return <OwnerShell navigate={navigate} section="home"><main className="page-shell home-page owner-home-page">
    <header className="home-header"><div><h1>Home</h1><p>{identity ? `${displayName(identity.display_name)} · ${identity.specialty}` : 'Your private Lamina workspace.'}</p></div></header>
    {!overview && <div className="home-loading"><div className="loading-line" /><p>Opening your agent…</p></div>}
    {overview && <>
      <section className="owner-identity-card">
        <span className="directory-avatar large">{identity ? initials(displayName(identity.display_name)) : '··'}</span>
        <div><p className="eyebrow">Lamina thinks you are</p><h2>{overview.physician.name}</h2><p>{overview.physician.specialty}{overview.physician.location ? ` · ${overview.physician.location}` : ''}</p></div>
      </section>
      <section className="owner-stats-row">
        <div><em>{overview.stats.questions_answered_total}</em><span>Questions answered</span></div>
        <div><em>{overview.stats.confirmed_practice_learnings}</em><span>Confirmed practice {overview.stats.confirmed_practice_learnings === 1 ? 'learning' : 'learnings'}</span></div>
        <div><em>{overview.stats.case_interests_count}</em><span>Case interests</span></div>
      </section>
      {overview.next_action !== 'none' && <button className="button-primary" onClick={() => navigate(overview.next_action === 'review_training' ? `${ownerTrainPath}?review=${overview.training.review_session_id}` : overview.next_action === 'continue_setup' ? `${ownerTrainPath}?mode=initialization` : `${ownerTrainPath}${overview.training.active_session_id ? `?resume=${overview.training.active_session_id}` : ''}`)}>
        {overview.next_action === 'continue_setup' ? 'Continue setup' : overview.next_action === 'review_training' ? 'Review what your agent learned' : overview.next_action === 'resume_training' ? 'Resume training' : 'Start training'} <span>→</span>
      </button>}
      <div className="owner-home-shortcuts">
        <button className="text-button" onClick={() => navigate(ownerProfilePath)}>Build your professional profile →</button>
        <button className="text-button" onClick={() => navigate(ownerAgentPath)}>Open My Agent →</button>
      </div>
      {status && <CapabilityNote status={status} />}
    </>}
  </main></OwnerShell>
}

/* ---------------------------------------------------------------- My Agent */

/** Overview absorbed the old separate Practice tab (post-8B consolidation). */
const OWNER_AGENT_TABS = ['overview', 'train', 'test'] as const
type OwnerAgentTab = typeof OWNER_AGENT_TABS[number]
const LEGACY_OWNER_AGENT_TAB_ALIASES: Record<string, OwnerAgentTab> = { practice: 'overview', chat: 'test' }
const resolveOwnerAgentTab = (value: string | null): OwnerAgentTab => {
  if (value && (OWNER_AGENT_TABS as readonly string[]).includes(value)) return value as OwnerAgentTab
  if (value && value in LEGACY_OWNER_AGENT_TAB_ALIASES) return LEGACY_OWNER_AGENT_TAB_ALIASES[value]
  return 'overview'
}

export function OwnerAgentPage({ navigate, params }: { navigate: Navigate; params: URLSearchParams }) {
  const tabParam = params.get('tab')
  const [tab, setTab] = useState<OwnerAgentTab>(() => resolveOwnerAgentTab(tabParam))
  const [overview, setOverview] = useState<AgentOverview | null>(null)
  const [representation, setRepresentation] = useState<PracticeRepresentation | null>(null)
  const [trainProjection, setTrainProjection] = useState<TrainProjection | null>(null)
  const refreshOverview = () => getAgentOverview('owner').then(setOverview).catch(() => {})
  const refreshRepresentation = () => getPracticeRepresentation('owner').then(setRepresentation).catch(() => {})
  const refreshTraining = () => getTrainingHistory('owner').then(setTrainProjection).catch(() => {})
  useEffect(() => { refreshOverview(); refreshRepresentation(); refreshTraining() }, []) // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { setTab(resolveOwnerAgentTab(tabParam)) }, [tabParam])
  const selectTab = (next: OwnerAgentTab) => { setTab(next); window.history.replaceState({}, '', `${ownerAgentPath}?tab=${next}`) }
  return <OwnerShell navigate={navigate} section="agent"><main className="page-shell agent-page">
    <section className="agent-hero"><div className="agent-hero-mark"><LaminaMark active={overview?.training.initialized ?? false} /></div><div><p className="eyebrow">Your physician agent</p><h1>{overview?.physician.agent_name ?? 'Your Agent'}</h1><p>Private · represents how you practice. Not visible to the network.</p></div></section>
    <nav className="agent-tabs" aria-label="My Agent sections">{OWNER_AGENT_TABS.map((item) => <button key={item} className={tab === item ? 'active' : ''} aria-current={tab === item ? 'page' : undefined} onClick={() => selectTab(item)}>{item[0].toUpperCase() + item.slice(1)}</button>)}</nav>
    {tab === 'overview' && <AgentOverviewPanel overview={overview} representation={representation} navigate={navigate} trainPath={trainingPath('owner')} />}
    {tab === 'train' && <TrainTab trainProjection={trainProjection} navigate={navigate} trainPath={ownerTrainPath} />}
    {tab === 'test' && <ChatTab personaId="owner" agentName={overview?.physician.agent_name ?? 'Your Agent'} navigate={navigate} trainPath={ownerTrainPath} />}
  </main></OwnerShell>
}

/* ----------------------------------------------------------------- Profile */

export function OwnerProfilePage({ navigate, params }: { navigate: Navigate; params: URLSearchParams }) {
  return <OwnerShell navigate={navigate} section="profile"><ProfessionalProfilePage personaId="owner" navigate={navigate} params={params} /></OwnerShell>
}

/* ------------------------------------------------------------------ Train */

export function OwnerTrainingPage({ navigate, params }: { navigate: Navigate; params: URLSearchParams }) {
  return <OwnerShell navigate={navigate} section="agent"><TrainingPage personaId="owner" agentName="Your Agent" navigate={navigate} exitPath={`${ownerAgentPath}?tab=train`} params={params} /></OwnerShell>
}
