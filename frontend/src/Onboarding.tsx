import { useEffect, useState, type FormEvent } from 'react'
import { useAuth } from './AuthProvider.tsx'
import { ClaimShell, initials, signInPath, signUpPath } from './Claim.tsx'
import {
  ApiError,
  clearOnboardingSelection,
  confirmOnboardingIdentity,
  getOnboardingStatus,
  lookupOnboardingNpi,
  type OnboardingIdentity,
  type OnboardingStatus,
} from './api.ts'
import {
  errorRequiresStatusRefresh,
  identityFacts,
  normalizeNpiInput,
  npiFormatHint,
  onboardingCompletePath,
  onboardingErrorCopy,
  onboardingScreen,
} from './onboardingState.ts'
import { ownerOnboardingPath } from './ownerPaths.ts'
import { searchPhysicianByName, type NameSearchResult } from './pilotApi.ts'

type Navigate = (path: string) => void
type Busy = null | 'lookup' | 'confirm' | 'clear' | 'search'

/** Shown wherever Lamina asks for an NPI. Deliberately no endorsement or credentialing claim. */
export const NPI_PURPOSE_COPY = 'Lamina uses your NPI to find your public NPPES physician record and connect your account to the correct physician profile. This does not replace medical credentialing or licensure verification.'
export const PILOT_PENDING_COPY = 'Your physician identity has been confirmed. Lamina is currently onboarding a small number of pilot physicians. Your account is awaiting approval.'

function IdentityCard({ identity, eyebrow }: { identity: OnboardingIdentity; eyebrow: string }) {
  const facts = identityFacts(identity)
  return <section className="onboarding-identity-card" aria-label="Physician record from NPPES">
    <header>
      <span className="directory-avatar large">{initials(facts.name)}</span>
      <div><p className="eyebrow">{eyebrow}</p><h2>{facts.name}</h2><p>{facts.specialty}</p></div>
    </header>
    <dl>
      <div><dt>NPI</dt><dd className="onboarding-npi">{facts.npi}</dd></div>
      <div><dt>Primary taxonomy</dt><dd>{facts.specialty}</dd></div>
      {facts.otherTaxonomies.length > 0 && <div><dt>Other taxonomies</dt><dd>{facts.otherTaxonomies.join(' · ')}</dd></div>}
      <div><dt>Practice {facts.locations.length === 1 ? 'location' : 'locations'}</dt><dd>{facts.locations.length ? <ul>{facts.locations.map((value) => <li key={value}>{value}</li>)}</ul> : 'No practice location listed in NPPES'}</dd></div>
      <div><dt>Source</dt><dd>NPPES public registry{identity.fetched_at ? ` · retrieved ${new Date(identity.fetched_at).toLocaleDateString()}` : ''}</dd></div>
    </dl>
  </section>
}

/** The authenticated physician onboarding flow: NPI lookup → "Is this you?" → pilot approval.
 * Every screen is a projection of the backend's `/api/me/onboarding/status`. The client
 * never stores or asserts confirmation/approval state of its own. */
export function PhysicianOnboardingPage({ navigate, params, onConfirmed }: { navigate: Navigate; params: URLSearchParams; onConfirmed?: () => void }) {
  const { configured, loading: authLoading, user } = useAuth()
  const [status, setStatus] = useState<OnboardingStatus | null>(null)
  const [loadError, setLoadError] = useState('')
  const [npi, setNpi] = useState(() => normalizeNpiInput(params.get('npi') ?? ''))
  const [busy, setBusy] = useState<Busy>(null)
  const [error, setError] = useState('')
  const [sessionExpired, setSessionExpired] = useState(false)
  const [searchName, setSearchName] = useState('')
  const [searchLocation, setSearchLocation] = useState('')
  const [searchResults, setSearchResults] = useState<NameSearchResult[] | null>(null)
  const returnHere = npi ? `${ownerOnboardingPath}?npi=${encodeURIComponent(npi)}` : ownerOnboardingPath

  const load = () => getOnboardingStatus()
    .then((next) => { setStatus(next); setLoadError('') })
    .catch((err) => {
      if (err instanceof ApiError && err.status === 401) { setSessionExpired(true); return }
      setLoadError(err instanceof Error ? err.message : 'Could not load your onboarding status')
    })
  useEffect(() => { setStatus(null); if (user) void load() }, [user]) // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { if (status && onboardingScreen(status) === 'active') navigate(onboardingCompletePath) }, [status]) // eslint-disable-line react-hooks/exhaustive-deps
  /* Pilot mode: once the profile is confirmed, practice setup continues while approval is pending. */
  useEffect(() => { if (onConfirmed && status && onboardingScreen(status) === 'pending') onConfirmed() }, [status]) // eslint-disable-line react-hooks/exhaustive-deps

  const run = async (kind: Exclude<Busy, null>, action: () => Promise<OnboardingStatus>, fallback: string) => {
    setBusy(kind); setError('')
    try { setStatus(await action()) }
    catch (err) {
      if (err instanceof ApiError && err.status === 401) setSessionExpired(true)
      else {
        const code = err instanceof ApiError ? err.code : null
        setError(onboardingErrorCopy(code, err instanceof Error ? err.message : fallback))
        if (errorRequiresStatusRefresh(code)) void load()
      }
    }
    finally { setBusy(null) }
  }

  const submitLookup = (event: FormEvent) => {
    event.preventDefault()
    const hint = npiFormatHint(npi)
    if (hint || !npi) { setError(hint ?? 'Enter your 10-digit NPI.'); return }
    void run('lookup', () => lookupOnboardingNpi(npi), 'Could not look up this NPI.')
  }

  const submitSearch = async (event: FormEvent) => {
    event.preventDefault()
    if (searchName.trim().length < 2) { setError('Enter at least two letters of your name.'); return }
    setBusy('search'); setError(''); setSearchResults(null)
    try { setSearchResults((await searchPhysicianByName(searchName.trim(), searchLocation.trim())).results) }
    catch (err) {
      if (err instanceof ApiError && err.status === 401) setSessionExpired(true)
      else setError(onboardingErrorCopy(err instanceof ApiError ? err.code : null, err instanceof Error ? err.message : 'Could not search NPPES.'))
    }
    finally { setBusy(null) }
  }

  if (!configured) return <ClaimShell navigate={navigate}><div className="onboarding-panel"><p className="muted-note">Authentication is not configured in this environment.</p></div></ClaimShell>
  if (authLoading) return <ClaimShell navigate={navigate}><div className="onboarding-panel"><p className="muted-note">Checking your session…</p></div></ClaimShell>
  if (!user || sessionExpired) return <ClaimShell navigate={navigate}><div className="onboarding-panel">
    <p className="eyebrow">Physician pilot</p><h1>{sessionExpired ? 'Sign in again to continue' : 'Create your Lamina physician account'}</h1>
    <p>Create an account or sign in, then confirm your professional profile from the public NPI registry.</p>
    <div className="onboarding-actions">
      <button className="button-primary" onClick={() => navigate(signUpPath(returnHere))}>Create account <span>→</span></button>
      <button className="text-button" onClick={() => navigate(signInPath(returnHere))}>I already have an account</button>
    </div>
  </div></ClaimShell>
  if (loadError) return <ClaimShell navigate={navigate}><div className="onboarding-panel"><div className="error-banner" role="alert">{loadError}</div><button className="text-button" onClick={() => void load()}>Try again</button></div></ClaimShell>
  if (!status) return <ClaimShell navigate={navigate}><div className="onboarding-panel"><p className="muted-note">Checking your physician onboarding status…</p></div></ClaimShell>

  const screen = onboardingScreen(status)
  const errorBanner = error ? <p className="error-banner" role="alert">{error}</p> : null

  if (screen === 'active') return <ClaimShell navigate={navigate}><div className="onboarding-panel"><p className="muted-note">Opening your private workspace…</p></div></ClaimShell>

  if (screen === 'lookup') return <ClaimShell navigate={navigate}><div className="onboarding-panel">
    <p className="eyebrow">Step 1 · Professional profile</p>
    <h1>Confirm your professional profile</h1>
    <p>{NPI_PURPOSE_COPY}</p>
    <form className="auth-form onboarding-form" onSubmit={submitLookup} aria-busy={busy === 'lookup'}>
      <label><span>Your individual NPI</span><input inputMode="numeric" autoComplete="off" maxLength={14} placeholder="10-digit NPI" value={npi} onChange={(event) => { setNpi(normalizeNpiInput(event.target.value)); setError('') }} disabled={busy !== null} /></label>
      {errorBanner}
      <button className="button-primary" type="submit" disabled={busy !== null}>{busy === 'lookup' ? 'Looking up NPPES…' : 'Find my record'} <span>→</span></button>
    </form>
    <form className="auth-form onboarding-form" onSubmit={(event) => void submitSearch(event)} aria-busy={busy === 'search'}>
      <p className="eyebrow">Don’t have your NPI handy? Search by name</p>
      <label><span>Your name</span><input autoComplete="name" placeholder="First and last name" value={searchName} onChange={(event) => { setSearchName(event.target.value); setError('') }} disabled={busy !== null} /></label>
      <label><span>City, state (optional)</span><input placeholder="e.g. Palo Alto, CA" value={searchLocation} onChange={(event) => setSearchLocation(event.target.value)} disabled={busy !== null} /></label>
      <button className="button-secondary" type="submit" disabled={busy !== null}>{busy === 'search' ? 'Searching NPPES…' : 'Search by name'}</button>
    </form>
    {searchResults && (searchResults.length === 0
      ? <p className="muted-note">No individual physician records matched. Check the spelling, add a city and state, or use your NPI.</p>
      : <div className="lam-list pilot-search-results" aria-label="NPPES search results">{searchResults.map((result) => {
        const facts = identityFacts(result.identity)
        return <div key={facts.npi} className="lam-row">
          <span className="lam-row-mark directory-avatar">{initials(facts.name)}</span>
          <span className="lam-row-main"><strong>{facts.name}</strong><span>{facts.specialty} · NPI {facts.npi}{facts.locations[0] ? ` · ${facts.locations[0]}` : ''}</span></span>
          {result.claim_available
            ? <button className="button-primary" disabled={busy !== null} onClick={() => void run('lookup', () => lookupOnboardingNpi(facts.npi), 'Could not open this record.')}>This is me <span>→</span></button>
            : <span className="muted-note">Already linked to an account</span>}
        </div>
      })}</div>)}
    <p className="muted-note">Searching or selecting does not link your account to anyone. Nothing is linked until you confirm the record is you on the next screen.</p>
  </div></ClaimShell>

  if (screen === 'confirm' && status.selection) {
    const selection = status.selection
    const canClear = status.allowed_actions.includes('clear_selection')
    return <ClaimShell navigate={navigate}><div className="onboarding-panel">
      <p className="eyebrow">Step 2 · Confirm</p>
      <h1>Is this you?</h1>
      <p>Check the name, NPI, specialty, and practice location carefully. If any of it is wrong, choose “Not me”.</p>
      <IdentityCard identity={selection.identity} eyebrow="NPPES public record" />
      {errorBanner}
      {!selection.claim_available
        ? <div className="production-verification" role="status"><strong>This NPI is already linked to a Lamina account</strong><p>{onboardingErrorCopy('npi_already_claimed', '')}</p></div>
        : <div className="onboarding-confirm" role="group" aria-label="Confirm physician identity">
          <p>By confirming, you state that you are this physician. Lamina records this confirmation and reviews it before opening your private workspace.</p>
          <div className="onboarding-actions">
            <button className="button-primary" disabled={busy !== null} onClick={() => void run('confirm', () => confirmOnboardingIdentity(selection.identity.npi), 'Could not confirm this identity.')}>{busy === 'confirm' ? 'Confirming…' : 'Yes, this is me'} <span>→</span></button>
            {canClear && <button className="text-button" disabled={busy !== null} onClick={() => void run('clear', clearOnboardingSelection, 'Could not clear this selection.')}>Not me — search again</button>}
          </div>
        </div>}
      {!selection.claim_available && canClear && <button className="text-button" disabled={busy !== null} onClick={() => void run('clear', clearOnboardingSelection, 'Could not clear this selection.')}>Search a different NPI</button>}
      {!canClear && <p className="muted-note">This account already holds this identity. If it is not you, contact the Lamina team.</p>}
    </div></ClaimShell>
  }

  if (screen === 'pending') return <ClaimShell navigate={navigate}><div className="onboarding-panel">
    <p className="eyebrow">Pilot approval</p>
    <h1>Awaiting pilot approval</h1>
    <p>{PILOT_PENDING_COPY}</p>
    {status.confirmed_identity && <IdentityCard identity={status.confirmed_identity.identity} eyebrow="Confirmed physician identity" />}
    {errorBanner}
    <p className="muted-note">You don’t need to do anything else. Your private workspace opens here once the Lamina team approves your account.</p>
    <button className="text-button" onClick={() => void load()}>Check status again</button>
  </div></ClaimShell>

  return <ClaimShell navigate={navigate}><div className="onboarding-panel">
    <p className="eyebrow">Physician pilot</p>
    <h1>{screen === 'disabled' ? 'Workspace disabled' : 'Onboarding unavailable'}</h1>
    <p>{screen === 'disabled'
      ? 'This physician workspace is currently disabled. Contact the Lamina team if you believe this is a mistake.'
      : 'This account cannot continue physician onboarding. Contact the Lamina team for help.'}</p>
  </div></ClaimShell>
}
