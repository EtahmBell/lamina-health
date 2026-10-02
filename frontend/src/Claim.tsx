import { useEffect, useState, type FormEvent } from 'react'
import laminaLogo from './assets/lamina-logo-source.png'
import { useAuth } from './AuthProvider.tsx'
import { safeReturnPath } from './safeReturn.ts'
import { cleanName } from './demoIdentity.ts'
import {
  ApiError,
  activateProviderClaim,
  createProviderClaim,
  disableProviderClaim,
  getMyProviderClaims,
  getProvider,
  searchProviders,
  submitProviderVerification,
  verifySyntheticDemoClaim,
  type AgentStatus,
  type PhysicianNetworkProfile,
  type ProviderClaim,
  type ProviderSearchResponse,
} from './api.ts'
import {
  LIFECYCLE_COPY,
  canDemoVerify,
  lifecycleChip,
  lifecycleSteps,
  type LifecycleStepId,
} from './claimLifecycle.ts'
import { LaminaMark } from './LaminaMark.tsx'
import { physicianDisplayName } from './networkRoster.ts'

type Navigate = (path: string) => void

/**
 * The one canonical physician-identity discovery, claim, verification and
 * activation pathway. Physician Network links into this instead of running a
 * second claim UX (see PhysicianNetwork.tsx). This flow is deliberately
 * separate from the public, unauthenticated Lucy clinical demo.
 */

/** Title-cased NPPES names, with the demo-only "(synthetic)" suffix stripped
 * from headings, confirmations and success copy — it belongs in the eyebrow
 * label, not repeated through every piece of identity text. */
const displayName = (value: string) => cleanName(physicianDisplayName(value))
const initials = (name: string) => name.replace(/Dr\.\s*/i, '').split(/[\s,]+/).filter(Boolean).slice(0, 2).map((part) => part[0]).join('')
const location = (profile: PhysicianNetworkProfile) => `${profile.city || 'Location not listed'}${profile.state ? `, ${profile.state}` : ''}`
export const providerPath = (npi: string) => `/claim/provider/${encodeURIComponent(npi)}`
export const signInPath = (returnTo: string) => `/claim/sign-in?return=${encodeURIComponent(returnTo)}`
export const signUpPath = (returnTo: string) => `/claim/sign-up?return=${encodeURIComponent(returnTo)}`
/** A /claim/provider/:npi path embedded in a return target, so the sign-up
 * screen can show what identity is being claimed without a second query param. */
const providerNpiFromReturn = (returnTo: string) => returnTo.match(/^\/claim\/provider\/([^/?]+)/)?.[1] ?? null

/** A claim/verification/activation action failed. Session expiry gets its own
 * calm recovery path instead of a raw error string. */
type ActionError = { message: string; sessionExpired: boolean }

function describeActionError(err: unknown, fallback: string): ActionError {
  if (err instanceof ApiError) {
    if (err.status === 401) return { message: 'Your session has ended.', sessionExpired: true }
    if (err.status === 409) {
      return { message: 'This identity already has an active claim.\n\nIf you believe this is an error, contact Lamina.', sessionExpired: false }
    }
  }
  return { message: err instanceof Error ? err.message : fallback, sessionExpired: false }
}

function ClaimBrand() {
  return <div className="brand" aria-label="Lamina"><span className="brand-symbol" aria-hidden="true"><img src={laminaLogo} alt="" /></span><span className="wordmark">LAMINA</span></div>
}

/** A lightweight header distinct from Lucy's clinical-workspace sidebar. The
 * authenticated-account control lives only here — never inside the Lucy demo. */
function ClaimShell({ children, navigate }: { children: React.ReactNode; navigate: Navigate }) {
  const { configured, loading, user, signOut } = useAuth()
  const handleSignOut = async () => { await signOut(); navigate('/claim') }
  return <div className="claim-shell">
    <header className="claim-header">
      <button className="brand-button" onClick={() => navigate('/')} aria-label="Return to Lamina portal"><ClaimBrand /></button>
      <nav className="claim-header-actions" aria-label="Physician account">
        {!configured && <span className="claim-auth-status">Authentication not configured</span>}
        {configured && !loading && user && <>
          <button className="text-button" onClick={() => navigate('/claim/my-identities')}>My physician identities</button>
          <span className="claim-account-chip" title={user.email ?? undefined}>{user.email ?? 'Account'}</span>
          <button className="text-button" onClick={() => void handleSignOut()}>Sign out</button>
        </>}
        {configured && !loading && !user && <button className="text-button" onClick={() => navigate(signInPath('/claim/my-identities'))}>Sign in</button>}
      </nav>
    </header>
    <main className="claim-main page-shell">{children}</main>
  </div>
}

function LifecycleStepper({ status }: { status: AgentStatus }) {
  const steps = lifecycleSteps(status)
  const stepIcon: Record<LifecycleStepId, string> = { identity: '1', claim: '2', verification: '3', agent: '4' }
  return <ol className="activation-steps" aria-label="Identity lifecycle">
    {steps.map((step) => <li key={step.id} className={step.state === 'complete' ? 'complete' : step.state === 'current' ? 'current' : ''}>
      <span aria-hidden="true">{step.state === 'complete' ? '✓' : stepIcon[step.id]}</span>
      <div><strong>{step.label}</strong><small>{step.state === 'complete' ? 'Complete' : step.state === 'current' ? 'Current' : 'Locked'}</small></div>
    </li>)}
  </ol>
}

function LifecycleChip({ status, claimedByMe }: { status: AgentStatus; claimedByMe: boolean }) {
  return <span className={`agent-status-badge ${status}`}><i />{lifecycleChip(status, claimedByMe)}</span>
}

/* ----------------------------------------------------------------- search */

function IdentityResultRow({ profile, navigate }: { profile: PhysicianNetworkProfile; navigate: Navigate }) {
  const name = displayName(profile.display_name)
  return <button className="lam-row" onClick={() => navigate(providerPath(profile.npi))}>
    <span className="lam-row-mark directory-avatar">{initials(name)}</span>
    <span className="lam-row-main"><strong>{name}</strong><span>{profile.specialty}</span><small>{location(profile)} · NPI {profile.npi}</small></span>
    <LifecycleChip status={profile.lifecycle_status} claimedByMe={profile.claimed_by_me} />
    <span className="lam-row-action">View identity <b>→</b></span>
  </button>
}

export function PhysicianIdentitySearchPage({ navigate }: { navigate: Navigate }) {
  const [filters, setFilters] = useState({ q: '', specialty: '', location: '' })
  const [response, setResponse] = useState<ProviderSearchResponse | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  const runSearch = async (event?: FormEvent) => {
    event?.preventDefault(); setLoading(true); setError(null)
    try { setResponse(await searchProviders(filters)) }
    catch (searchError) { setError(searchError instanceof Error ? searchError.message : 'Directory search failed') }
    finally { setLoading(false) }
  }
  useEffect(() => { void runSearch() }, []) // eslint-disable-line react-hooks/exhaustive-deps

  const results = response?.results || []
  return <ClaimShell navigate={navigate}>
    <header className="directory-hero"><div><p className="eyebrow">Physician identity</p><h1>Find your Lamina identity</h1><p>Search the national physician directory to find the identity reserved for your practice.</p></div></header>
    <form className="directory-search-panel" onSubmit={runSearch}>
      <label className="directory-search-main"><span>Physician name</span><input value={filters.q} onChange={(event) => setFilters({ ...filters, q: event.target.value })} placeholder="e.g. Jane Smith" /></label>
      <label><span>Specialty</span><input value={filters.specialty} onChange={(event) => setFilters({ ...filters, specialty: event.target.value })} placeholder="e.g. Cardiology" /></label>
      <label><span>Location</span><input value={filters.location} onChange={(event) => setFilters({ ...filters, location: event.target.value })} placeholder="City or state" /></label>
      <button className="button-primary" type="submit" disabled={loading}>{loading ? 'Searching…' : 'Search'}</button>
    </form>
    {error && <div className="error-banner" role="alert">{error}</div>}
    <div className="directory-results-heading"><h2>{filters.q || filters.specialty || filters.location ? 'Matching physicians' : 'Physician identities'}</h2><span>{response?.count ?? 0} shown{response?.directory_available ? ` · ${response.directory_records.toLocaleString()} directory records` : ''}</span></div>
    {loading
      ? <div className="directory-loading"><p>Searching physician identities…</p></div>
      : <div className="lam-list">
        {results.map((profile) => <IdentityResultRow key={profile.npi} profile={profile} navigate={navigate} />)}
        {!results.length && <div className="empty-state"><h2>No physicians found</h2><p>Try fewer terms or search by a city, state, or specialty.</p></div>}
      </div>}
  </ClaimShell>
}

/* ----------------------------------------------------------- identity page */

export function ProviderIdentityPage({ npi, navigate, params }: { npi: string; navigate: Navigate; params: URLSearchParams }) {
  const { configured, loading: authLoading, user } = useAuth()
  const [profile, setProfile] = useState<PhysicianNetworkProfile | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [actionError, setActionError] = useState<ActionError | null>(null)
  const [confirmingActivate, setConfirmingActivate] = useState(false)
  const [confirmingDisable, setConfirmingDisable] = useState(false)
  const requestedBackTo = params.get('return')
  const backTo = safeReturnPath(requestedBackTo, '/claim')
  const hasSafeBackTo = Boolean(requestedBackTo && requestedBackTo === backTo)

  const load = () => getProvider(npi).then((result) => { setProfile(result); setLoadError(null) }).catch((err) => setLoadError(err instanceof Error ? err.message : 'Could not load this identity'))
  useEffect(() => { void load() }, [npi, user]) // eslint-disable-line react-hooks/exhaustive-deps

  const act = async (action: () => Promise<PhysicianNetworkProfile>, fallback: string) => {
    setBusy(true); setActionError(null)
    try { setProfile(await action()) }
    catch (err) { setActionError(describeActionError(err, fallback)) }
    finally { setBusy(false) }
  }

  if (loadError) return <ClaimShell navigate={navigate}><div className="error-banner" role="alert">{loadError}</div></ClaimShell>
  if (!profile) return <ClaimShell navigate={navigate}><div className="directory-loading"><p>Opening physician identity…</p></div></ClaimShell>

  const name = displayName(profile.display_name)
  const status = profile.lifecycle_status
  const copy = LIFECYCLE_COPY[status]
  const returnHere = providerPath(npi)

  const claim = () => act(() => createProviderClaim(npi).then(() => getProvider(npi)), 'Could not claim this identity.')
  const submitVerification = () => profile.my_claim_id !== null && act(
    () => submitProviderVerification(profile.my_claim_id as number).then(() => getProvider(npi)),
    'Could not submit verification.',
  )
  const demoVerify = () => profile.my_claim_id !== null && act(async () => {
    try { await verifySyntheticDemoClaim(profile.my_claim_id as number) }
    catch (err) {
      if (err instanceof ApiError && err.status === 403) throw new Error('Demo verification is unavailable in this environment.')
      throw err
    }
    return getProvider(npi)
  }, 'Could not verify this identity.')
  const activate = () => { setConfirmingActivate(false); if (profile.my_claim_id !== null) void act(() => activateProviderClaim(profile.my_claim_id as number), 'Could not activate this agent.') }
  const disable = () => { setConfirmingDisable(false); if (profile.my_claim_id !== null) void act(() => disableProviderClaim(profile.my_claim_id as number), 'Could not disable this agent.') }

  const SessionNotice = () => actionError?.sessionExpired
    ? <div className="error-banner" role="alert">Sign in again to continue. <button className="text-button" onClick={() => navigate(signInPath(returnHere))}>Sign in →</button></div>
    : actionError ? <div className="error-banner" role="alert" style={{ whiteSpace: 'pre-line' }}>{actionError.message}</div> : null

  return <ClaimShell navigate={navigate}>
    <button className="text-button back-link" onClick={() => navigate(backTo)}>← {hasSafeBackTo ? 'Back' : 'Find your Lamina identity'}</button>
    <section className="provider-identity-hero">
      <span className="directory-avatar large">{initials(name)}</span>
      <div><p className="eyebrow">{profile.synthetic ? 'Controlled synthetic physician' : 'NPPES physician profile'}</p><h1>{name}</h1><p>{profile.specialty}</p><p className="muted-note">{location(profile)} · NPI {profile.npi}</p></div>
    </section>

    <section className="lamina-identity-card">
      <header><div><p className="eyebrow">Lamina identity</p><h2>{copy.label}</h2><p>{copy.detail}</p></div><LifecycleChip status={status} claimedByMe={profile.claimed_by_me} /></header>
      <LifecycleStepper status={status} />
      <SessionNotice />

      {status === 'reserved' && profile.claimable && (
        user
          ? <button className="button-primary" disabled={busy} onClick={() => void claim()}>{busy ? 'Claiming…' : 'Claim this identity'} <span>→</span></button>
          : authLoading
            ? <p className="muted-note">Checking your session…</p>
            : configured
              /* A new visitor clicking Claim is assumed to be a new Lamina user by
               * default — route to account creation, not sign-in. Someone who
               * already has an account can say so from that screen. */
              ? <button className="button-primary" onClick={() => navigate(signUpPath(returnHere))}>Claim this identity <span>→</span></button>
              : <p className="muted-note">Authentication is not configured in this environment, so identities cannot be claimed yet.</p>
      )}

      {status === 'claimed' && profile.claimed_by_me && <div className="verify-identity-step">
        <h3>Verify your physician identity</h3>
        <p>Before a physician agent can be activated, Lamina must confirm that the person claiming this NPI is the physician associated with it.</p>
        <button className="button-primary" disabled={busy} onClick={() => void submitVerification()}>{busy ? 'Submitting…' : 'Submit for verification'} <span>→</span></button>
      </div>}
      {status === 'claimed' && !profile.claimed_by_me && <p className="muted-note">This identity has an active claim in progress.</p>}

      {status === 'verification_pending' && profile.claimed_by_me && (
        canDemoVerify(profile.synthetic, status)
          ? <div className="demo-verification">
            <p><strong>Demo verification.</strong> This synthetic identity can use the demo verification path to show the complete Lamina activation flow. No credentialing or real identity check is performed.</p>
            <button className="button-primary" disabled={busy} onClick={() => void demoVerify()}>{busy ? 'Verifying…' : 'Verify demo identity'} <span>→</span></button>
          </div>
          : <div className="production-verification">
            <strong>Verification pending</strong>
            <p>We're confirming your identity against professional provider information before your physician agent can be activated. You can return here at any time.</p>
            <p>Real physician verification is not yet connected in this demonstration.</p>
          </div>
      )}
      {status === 'verification_pending' && !profile.claimed_by_me && <p className="muted-note">Verification is in progress for this identity.</p>}

      {status === 'verified' && !profile.claimed_by_me && <p className="muted-note">This identity is verified.</p>}
      {status === 'verified' && profile.claimed_by_me && <section className="agent-review">
        <h3>Your physician identity</h3>
        <dl><div><dt>Name</dt><dd>{name}</dd></div><div><dt>Specialty</dt><dd>{profile.specialty}</dd></div><div><dt>Location</dt><dd>{location(profile)}</dd></div></dl>
        <h3>Your Lamina agent</h3>
        <div className="agent-review-mark"><LaminaMark /><div><strong>{name}'s Agent</strong><span>Verified · inactive</span></div></div>
        <h3>What Lamina knows</h3>
        <ul><li>Identity source: {profile.synthetic ? 'Controlled synthetic demo roster' : 'NPPES national provider directory'}</li><li>Specialty: {profile.specialty}</li><li>Location: {location(profile)}</li></ul>
        {!confirmingActivate && <button className="button-primary" onClick={() => setConfirmingActivate(true)}>Activate agent <span>→</span></button>}
        {confirmingActivate && <div className="demo-reset-confirm" role="group" aria-label="Confirm activation">
          <strong>Activate {name}'s Agent?</strong>
          <p>Activation makes this verified Lamina agent active in the network.</p>
          <div><button className="text-button" onClick={() => setConfirmingActivate(false)}>Cancel</button><button className="button-primary" disabled={busy} onClick={activate}>{busy ? 'Activating…' : 'Activate agent'}</button></div>
        </div>}
      </section>}

      {status === 'active' && <div className="activation-success"><span>✓</span><div><strong>{name}'s Agent is active</strong><p>Your physician agent is active.{profile.synthetic ? ' Synthetic demo agent.' : ''}</p></div></div>}
      {status === 'active' && profile.claimed_by_me && <div className="agent-account-action">
        {!confirmingDisable && <button className="text-button quiet-remove" onClick={() => setConfirmingDisable(true)}>Disable agent</button>}
        {confirmingDisable && <div className="demo-reset-confirm" role="group" aria-label="Confirm disable">
          <strong>Disable {name}'s Agent?</strong>
          <p>Identity remains verified. You can reactivate at any time.</p>
          <div><button className="text-button" onClick={() => setConfirmingDisable(false)}>Cancel</button><button className="button-primary" disabled={busy} onClick={disable}>{busy ? 'Disabling…' : 'Disable agent'}</button></div>
        </div>}
      </div>}

      {status === 'disabled' && <p className="muted-note">Agent disabled. Identity remains verified.</p>}
      {status === 'disabled' && profile.claimed_by_me && <button className="button-primary" disabled={busy} onClick={() => void act(() => activateProviderClaim(profile.my_claim_id as number), 'Could not reactivate this agent.')}>{busy ? 'Reactivating…' : 'Reactivate agent'} <span>→</span></button>}
    </section>
  </ClaimShell>
}

/* ------------------------------------------------------------------- auth */

function AuthCard({ navigate, eyebrow, title, children, footer }: { navigate: Navigate; eyebrow: string; title: string; children: React.ReactNode; footer?: React.ReactNode }) {
  return <ClaimShell navigate={navigate}>
    <div className="auth-card">
      <p className="eyebrow">{eyebrow}</p><h1>{title}</h1>
      {children}
      {footer}
    </div>
  </ClaimShell>
}

export function SignInPage({ navigate, params }: { navigate: Navigate; params: URLSearchParams }) {
  const { configured, user, signIn } = useAuth()
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const target = safeReturnPath(params.get('return'), '/claim/my-identities')
  useEffect(() => { if (user) navigate(target) }, [user]) // eslint-disable-line react-hooks/exhaustive-deps

  const submit = async (event: FormEvent) => {
    event.preventDefault(); setBusy(true); setError('')
    try { await signIn(email, password); navigate(target) }
    catch (err) { setError(err instanceof Error ? err.message : 'Sign in failed') }
    finally { setBusy(false) }
  }

  return <AuthCard navigate={navigate} eyebrow="Physician account" title="Sign in" footer={
    <p className="auth-switch">New to Lamina? <button className="text-button" onClick={() => navigate(signUpPath(target))}>Create account →</button></p>
  }>
    {!configured && <p className="muted-note">Authentication is not configured in this environment.</p>}
    {configured && <form className="auth-form" onSubmit={submit}>
      <label><span>Email</span><input type="email" autoComplete="email" required value={email} onChange={(event) => setEmail(event.target.value)} /></label>
      <label><span>Password</span><input type="password" autoComplete="current-password" required value={password} onChange={(event) => setPassword(event.target.value)} /></label>
      {error && <p className="error-banner" role="alert">{error}</p>}
      <button className="button-primary" type="submit" disabled={busy}>{busy ? 'Signing in…' : 'Sign in'} <span>→</span></button>
    </form>}
  </AuthCard>
}

export function SignUpPage({ navigate, params }: { navigate: Navigate; params: URLSearchParams }) {
  const { configured, user, signUp } = useAuth()
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [confirmPassword, setConfirmPassword] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [info, setInfo] = useState('')
  const target = safeReturnPath(params.get('return'), '/claim/my-identities')
  const claimingNpi = providerNpiFromReturn(target)
  const [claimingProfile, setClaimingProfile] = useState<PhysicianNetworkProfile | null>(null)
  useEffect(() => { if (user) navigate(target) }, [user]) // eslint-disable-line react-hooks/exhaustive-deps
  /** Purely contextual — shows the real physician identity being claimed. A
   * failed lookup just omits the context block; it never blocks sign-up. */
  useEffect(() => { if (claimingNpi) getProvider(claimingNpi).then(setClaimingProfile).catch(() => setClaimingProfile(null)) }, [claimingNpi])

  const submit = async (event: FormEvent) => {
    event.preventDefault(); setError(''); setInfo('')
    if (password !== confirmPassword) { setError('Passwords do not match.'); return }
    setBusy(true)
    try {
      const result = await signUp(email, password)
      /* Email confirmation proves ownership of this login email only — it is
       * never physician verification, and that distinction stays explicit. */
      if (result.session) navigate(target)
      else setInfo('Account created. Check your email to confirm your account, then sign in.')
    }
    catch (err) { setError(err instanceof Error ? err.message : 'Account creation failed') }
    finally { setBusy(false) }
  }

  return <AuthCard navigate={navigate} eyebrow="Physician account" title={claimingNpi ? 'Create your Lamina account' : 'Create account'} footer={
    <p className="auth-switch">Already have a Lamina account? <button className="text-button" onClick={() => navigate(signInPath(target))}>Sign in →</button></p>
  }>
    {claimingProfile && <div className="claim-context" aria-label="Physician identity being claimed">
      <p className="eyebrow">You're claiming</p>
      <strong>{displayName(claimingProfile.display_name)}</strong>
      <span>{claimingProfile.specialty} · {location(claimingProfile)}</span>
      <small>NPI {claimingProfile.npi}</small>
    </div>}
    {!configured && <p className="muted-note">Authentication is not configured in this environment.</p>}
    {configured && <form className="auth-form" onSubmit={submit}>
      <label><span>Email</span><input type="email" autoComplete="email" required value={email} onChange={(event) => setEmail(event.target.value)} /></label>
      <label><span>Password</span><input type="password" autoComplete="new-password" required minLength={6} value={password} onChange={(event) => setPassword(event.target.value)} /></label>
      <label><span>Confirm password</span><input type="password" autoComplete="new-password" required minLength={6} value={confirmPassword} onChange={(event) => setConfirmPassword(event.target.value)} /></label>
      {error && <p className="error-banner" role="alert">{error}</p>}
      {info && <p className="muted-note" role="status">{info}</p>}
      <button className="button-primary" type="submit" disabled={busy}>{busy ? 'Creating account…' : 'Create account'} <span>→</span></button>
    </form>}
  </AuthCard>
}

/* ------------------------------------------------------------- my claims */

type OwnedClaim = ProviderClaim & { profile: PhysicianNetworkProfile | null }

export function MyIdentitiesPage({ navigate }: { navigate: Navigate }) {
  const { configured, loading: authLoading, user } = useAuth()
  const [claims, setClaims] = useState<OwnedClaim[] | null>(null)
  const [error, setError] = useState('')

  useEffect(() => {
    if (!user) return
    getMyProviderClaims()
      .then(async (list) => {
        const withProfiles = await Promise.all(list.map(async (claim): Promise<OwnedClaim> => {
          try { return { ...claim, profile: await getProvider(claim.npi) } }
          catch { return { ...claim, profile: null } }
        }))
        setClaims(withProfiles)
      })
      .catch((err) => setError(err instanceof Error ? err.message : 'Could not load your physician identities'))
  }, [user])

  if (authLoading) return <ClaimShell navigate={navigate}><p className="muted-note">Checking your session…</p></ClaimShell>
  if (!configured) return <ClaimShell navigate={navigate}><p className="muted-note">Authentication is not configured in this environment.</p></ClaimShell>
  if (!user) return <AuthCard navigate={navigate} eyebrow="Physician account" title="Sign in to continue">
    <p className="muted-note">Sign in to see the physician identities you have claimed.</p>
    <button className="button-primary" onClick={() => navigate(signInPath('/claim/my-identities'))}>Sign in <span>→</span></button>
  </AuthCard>

  return <ClaimShell navigate={navigate}>
    <header className="directory-hero"><div><p className="eyebrow">Physician account</p><h1>My physician identities</h1><p>Physician identities you have claimed in Lamina.</p></div></header>
    {error && <div className="error-banner" role="alert">{error}</div>}
    {!claims && !error && <p className="muted-note">Loading your physician identities…</p>}
    {claims && !claims.length && <div className="empty-state"><h2>No claimed identities yet</h2><p>Find your Lamina identity to get started.</p><button className="button-primary" onClick={() => navigate('/claim')}>Find your Lamina identity →</button></div>}
    {claims && claims.length > 0 && <div className="lam-list">{claims.map((claim) => {
      const status = claim.profile?.lifecycle_status ?? (claim.status as AgentStatus)
      const label = LIFECYCLE_COPY[status]?.label ?? claim.status
      return <button key={claim.id} className="lam-row" onClick={() => navigate(providerPath(claim.npi))}>
        <span className="lam-row-mark directory-avatar">{claim.profile ? initials(displayName(claim.profile.display_name)) : '··'}</span>
        <span className="lam-row-main"><strong>{claim.profile ? displayName(claim.profile.display_name) : `NPI ${claim.npi}`}</strong><span>{claim.profile?.specialty ?? ''}</span><small>{claim.profile ? location(claim.profile) : ''}</small></span>
        <span className={`agent-status-badge ${status}`}><i />{label}</span>
        <span className="lam-row-action">Continue <b>→</b></span>
      </button>
    })}</div>}
  </ClaimShell>
}
