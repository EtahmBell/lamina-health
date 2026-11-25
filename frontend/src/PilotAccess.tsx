import { useCallback, useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react'
import { useAuth } from './AuthProvider.tsx'
import { ApiError } from './api.ts'
import { enrollTotp, mfaState, signOutEverywhere, verifyTotp, type MfaState, type TotpEnrollment } from './authClient.ts'
import { ClaimShell, signInPath, signUpPath } from './Claim.tsx'
import { acceptInvitation, previewInvitation, requestMfaRecovery, revokeAllSessions, updateIdleTimeout, type InvitationPreview, type PilotStatus } from './pilotApi.ts'
import {
  formatSetupKey, IDLE_TIMEOUT_CHOICES, IDLE_TIMEOUT_MINUTES, IDLE_WARNING_MINUTES, idleState, invitationCopy, normalizeTotpInput, pilotErrorCopy, pilotPaths,
} from './pilotState.ts'
import { safeReturnPath } from './safeReturn.ts'

/* Accounts and access for the pilot (go-live prep, run 1): sign in, request access (invite-only),
 * joining by invitation, two-step sign-in (TOTP) at first sign-in and every sign-in after, the
 * lost-authenticator request, access ended, idle sign-out and "sign out everywhere".
 * Nothing here prints or stores a token, an invitation link or a credential. */

type Navigate = (path: string) => void

const errorText = (err: unknown, fallback: string) =>
  pilotErrorCopy(err instanceof ApiError ? err.code : null, err instanceof Error ? err.message : fallback)
const formatDate = (iso: string | null | undefined) => iso ? new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' }) : '—'

function Panel({ navigate, children }: { navigate: Navigate; children: ReactNode }) {
  return <ClaimShell navigate={navigate} physicianLinks={false}><div className="onboarding-panel pilot-access">{children}</div></ClaimShell>
}

/* ---------------------------------------------------------------- sign in */

/** The pilot sign-in page with a short, truthful note about why the person is there. */
export const signInWithReason = (reason: 'idle' | 'everywhere' | 'revoked', minutes?: number) =>
  `/claim/sign-in?reason=${reason}${minutes ? `&minutes=${minutes}` : ''}&return=${encodeURIComponent(pilotPaths.home)}`

const SIGN_IN_NOTES: Record<string, string> = {
  idle: 'You were signed out after {minutes} minutes without activity.',
  everywhere: 'You signed out on every device. Sign in again to continue.',
  revoked: 'This session was signed out. Sign in again to continue.',
}

export function PilotSignInPage({ navigate, params }: { navigate: Navigate; params: URLSearchParams }) {
  const { configured, user, signIn } = useAuth()
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const target = safeReturnPath(params.get('return'), pilotPaths.home)
  const idleMinutes = Math.min(60, Math.max(15, Number(params.get('minutes')) || IDLE_TIMEOUT_MINUTES))
  const note = SIGN_IN_NOTES[params.get('reason') ?? '']?.replace('{minutes}', String(idleMinutes))
  useEffect(() => { if (user) navigate(target) }, [user]) // eslint-disable-line react-hooks/exhaustive-deps
  const submit = async (event: FormEvent) => {
    event.preventDefault(); setBusy(true); setError('')
    try { await signIn(email, password); markActivity(); navigate(target) } catch (err) { setError(err instanceof Error ? err.message : 'Sign in failed') } finally { setBusy(false) }
  }
  return <Panel navigate={navigate}>
    <p className="eyebrow">Lamina pilot</p>
    <h1>Sign in</h1>
    {note && <p className="pilot-access-note" role="status">{note}</p>}
    {!configured && <p className="muted-note">Authentication is not configured in this environment.</p>}
    {configured && <form className="auth-form" onSubmit={(event) => void submit(event)} aria-busy={busy}>
      <label><span>Email</span><input type="email" autoComplete="email" required value={email} onChange={(event) => setEmail(event.target.value)} disabled={busy} /></label>
      <label><span>Password</span><input type="password" autoComplete="current-password" required value={password} onChange={(event) => setPassword(event.target.value)} disabled={busy} /></label>
      {error && <p className="error-banner" role="alert">{error}</p>}
      <button className="button-primary" type="submit" disabled={busy}>{busy ? 'Signing in…' : 'Sign in'} <span>→</span></button>
      <p className="muted-note">Next, you’ll enter the 6-digit code from your authenticator app.</p>
    </form>}
    <div className="pilot-access-footer">
      <p>Joining a practice? Open the invitation link you were sent.</p>
      <p>Setting up a new practice? Lamina is invite-only. <button className="text-button" onClick={() => navigate(signUpPath(target))}>Request pilot access →</button></p>
    </div>
  </Panel>
}

/** Account creation in the pilot is never open self-service: it either accepts an invitation (the
 * return path is the invitation) or starts a request the Lamina team reviews. */
export function PilotSignUpPage({ navigate, params }: { navigate: Navigate; params: URLSearchParams }) {
  const { configured, user, signUp } = useAuth()
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [confirmPassword, setConfirmPassword] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [info, setInfo] = useState('')
  const target = safeReturnPath(params.get('return'), pilotPaths.home)
  const invited = target.startsWith(pilotPaths.join)
  useEffect(() => { if (user) navigate(target) }, [user]) // eslint-disable-line react-hooks/exhaustive-deps
  const submit = async (event: FormEvent) => {
    event.preventDefault(); setError(''); setInfo('')
    if (password !== confirmPassword) { setError('Passwords do not match.'); return }
    setBusy(true)
    try {
      const result = await signUp(email, password)
      if (result.session) navigate(target)
      else setInfo('Account created. Check your email to confirm your address, then sign in.')
    } catch (err) { setError(err instanceof Error ? err.message : 'Account creation failed') } finally { setBusy(false) }
  }
  return <Panel navigate={navigate}>
    <p className="eyebrow">{invited ? 'Practice invitation' : 'Lamina pilot · invite-only'}</p>
    <h1>{invited ? 'Create your account' : 'Request pilot access'}</h1>
    <p>{invited
      ? 'Use the email address the invitation was sent to. Your account is yours alone — never shared. Next you’ll set up two-step sign-in.'
      : 'Lamina opens new practices by invitation. Create your account, set up two-step sign-in and confirm your professional profile; the Lamina team reviews each request before a practice can be set up. Invited? Open your invitation link instead.'}</p>
    {!configured && <p className="muted-note">Authentication is not configured in this environment.</p>}
    {configured && <form className="auth-form" onSubmit={(event) => void submit(event)} aria-busy={busy}>
      <label><span>Email</span><input type="email" autoComplete="email" required value={email} onChange={(event) => setEmail(event.target.value)} disabled={busy} /></label>
      <label><span>Password</span><input type="password" autoComplete="new-password" required minLength={12} value={password} onChange={(event) => setPassword(event.target.value)} disabled={busy} /></label>
      <label><span>Confirm password</span><input type="password" autoComplete="new-password" required minLength={12} value={confirmPassword} onChange={(event) => setConfirmPassword(event.target.value)} disabled={busy} /></label>
      <p className="muted-note">At least 12 characters.</p>
      {error && <p className="error-banner" role="alert">{error}</p>}
      {info && <p className="muted-note" role="status">{info}</p>}
      <button className="button-primary" type="submit" disabled={busy}>{busy ? 'Creating account…' : invited ? 'Create account' : 'Create account and continue'} <span>→</span></button>
    </form>}
    <p className="auth-switch">Already have an account? <button className="text-button" onClick={() => navigate(signInPath(target))}>Sign in →</button></p>
  </Panel>
}

/* ------------------------------------------------------- two-step sign-in */

/** First sign-in: set up an authenticator app (QR code or key) and enter its code. Every later
 * sign-in: enter the current code. Lost the device: ask the Lamina team (never a practice admin). */
export function MfaPage({ status, navigate, onVerified }: { status: PilotStatus; navigate: Navigate; onVerified: () => void }) {
  const { user, signOut } = useAuth()
  const [state, setState] = useState<MfaState | null>(null)
  const [loadError, setLoadError] = useState('')
  const [enrollment, setEnrollment] = useState<TotpEnrollment | null>(null)
  const [code, setCode] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [recoveryOpen, setRecoveryOpen] = useState(false)
  const load = useCallback(() => { setLoadError(''); mfaState().then(setState).catch((err) => setLoadError(errorText(err, 'Could not check two-step sign-in.'))) }, [])
  useEffect(() => { load() }, [load])
  const verified = state?.factors.find((factor) => factor.status === 'verified') ?? null
  const start = async () => {
    setBusy(true); setError('')
    try { setEnrollment(await enrollTotp()) } catch (err) { setError(errorText(err, 'Could not start the setup. Try again.')) } finally { setBusy(false) }
  }
  const submit = async (event: FormEvent) => {
    event.preventDefault()
    const factorId = verified?.id ?? enrollment?.factorId
    if (!factorId || code.length !== 6) { setError('Enter the 6-digit code from your authenticator app.'); return }
    setBusy(true); setError('')
    try { await verifyTotp(factorId, code); markActivity(); onVerified() } catch (err) { setCode(''); setError(errorText(err, 'That code didn’t match. Enter the current code.')) } finally { setBusy(false) }
  }
  const codeForm = <form className="auth-form pilot-mfa-code" onSubmit={(event) => void submit(event)} aria-busy={busy}>
    <label><span>6-digit code</span><input inputMode="numeric" autoComplete="one-time-code" pattern="[0-9]{6}" maxLength={6} required value={code} onChange={(event) => { setCode(normalizeTotpInput(event.target.value)); setError('') }} disabled={busy} /></label>
    {error && <p className="error-banner" role="alert">{error}</p>}
    <button className="button-primary" type="submit" disabled={busy || code.length !== 6}>{busy ? 'Checking…' : 'Verify'} <span>→</span></button>
  </form>
  const footer = <div className="pilot-access-footer">
    {user?.email && <p className="muted-note">Signed in as {user.email}.</p>}
    <button className="text-button" onClick={() => void signOut().then(() => navigate(signInPath(pilotPaths.home)))}>Sign out</button>
  </div>
  if (loadError) return <Panel navigate={navigate}><p className="eyebrow">Two-step sign-in</p><h1>Couldn’t check two-step sign-in</h1><div className="error-banner" role="alert">{loadError}</div><button className="text-button" onClick={load}>Try again</button>{footer}</Panel>
  if (!state) return <Panel navigate={navigate}><p className="muted-note" role="status">Checking two-step sign-in…</p></Panel>
  if (verified) return <Panel navigate={navigate}>
    <p className="eyebrow">Two-step sign-in</p>
    <h1>Enter your code</h1>
    <p>Open your authenticator app and enter the current 6-digit code for Lamina.</p>
    {codeForm}
    <RecoveryRequest status={status} open={recoveryOpen} onOpen={() => setRecoveryOpen(true)} />
    {footer}
  </Panel>
  return <Panel navigate={navigate}>
    <p className="eyebrow">Two-step sign-in · required</p>
    <h1>Set up two-step sign-in</h1>
    <p>Every Lamina pilot account uses an authenticator app (for example 1Password, Google Authenticator or Microsoft Authenticator) in addition to your password. You’ll enter a code from it each time you sign in.</p>
    {!enrollment && <>
      {error && <p className="error-banner" role="alert">{error}</p>}
      <button className="button-primary" disabled={busy} onClick={() => void start()}>{busy ? 'Starting…' : 'Set up my authenticator'} <span>→</span></button>
    </>}
    {enrollment && <div className="pilot-mfa-setup">
      <ol className="pilot-mfa-steps">
        <li><strong>Add Lamina to your authenticator app.</strong> Scan the QR code, or type the setup key.
          <div className="pilot-mfa-secret">
            {enrollment.qrCode && <img src={enrollment.qrCode} alt="QR code to add Lamina to your authenticator app" width={176} height={176} />}
            <div><span className="muted-note">Setup key</span><code className="pilot-setup-key" aria-label="Setup key">{formatSetupKey(enrollment.secret)}</code></div>
          </div>
        </li>
        <li><strong>Enter the 6-digit code it shows.</strong>{codeForm}</li>
      </ol>
      <p className="muted-note">Keep this account in your authenticator app. If you lose it, you’ll need the Lamina team to reset two-step sign-in — your practice admin can’t.</p>
    </div>}
    {footer}
  </Panel>
}

function RecoveryRequest({ status, open, onOpen }: { status: PilotStatus; open: boolean; onOpen: () => void }) {
  const [reason, setReason] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [sent, setSent] = useState(status.mfa_recovery?.status === 'open' ? status.mfa_recovery.created_at : '')
  if (sent) return <div className="pilot-panel pilot-recovery" role="status">
    <p><strong>Reset requested · {formatDate(sent)}.</strong> The Lamina team will confirm it’s you through a separate channel before resetting two-step sign-in. Your practice admin can’t do this, and can’t see your codes.</p>
  </div>
  if (!open) return <button className="text-button" onClick={onOpen}>Lost your authenticator?</button>
  const send = async (event: FormEvent) => {
    event.preventDefault(); setBusy(true); setError('')
    try { setSent((await requestMfaRecovery(reason.trim())).created_at) } catch (err) { setError(errorText(err, 'Could not send the request.')) } finally { setBusy(false) }
  }
  return <form className="pilot-panel pilot-recovery" onSubmit={(event) => void send(event)} aria-label="Ask the Lamina team to reset two-step sign-in">
    <p><strong>Ask the Lamina team to reset two-step sign-in.</strong> Only the Lamina team can reset it — never a practice admin. They’ll confirm it’s you through a separate channel first; then you sign in again and set up a new authenticator.</p>
    <label><span>What happened? (optional)</span><textarea rows={2} maxLength={500} value={reason} onChange={(event) => setReason(event.target.value)} disabled={busy} /></label>
    {error && <p className="error-banner" role="alert">{error}</p>}
    <button className="button-secondary" type="submit" disabled={busy}>{busy ? 'Sending…' : 'Request a reset'}</button>
  </form>
}

/* ------------------------------------------------------------ invitations */

export function JoinPracticePage({ navigate, params }: { navigate: Navigate; params: URLSearchParams }) {
  const { configured, loading, user, signOut } = useAuth()
  const [token] = useState(() => params.get('invite') ?? '')
  const [preview, setPreview] = useState<InvitationPreview | null>(null)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const returnHere = `${pilotPaths.join}?invite=${encodeURIComponent(token)}`
  useEffect(() => {
    if (!user || !token) return
    setPreview(null); setError('')
    previewInvitation(token).then(setPreview).catch((err) => setError(errorText(err, 'This invitation could not be opened.')))
  }, [user, token])
  if (!configured || loading) return <Panel navigate={navigate}><p className="muted-note" role="status">Checking your session…</p></Panel>
  if (!token) return <Panel navigate={navigate}><h1>Invitation link missing</h1><p>Open the full invitation link you were sent.</p></Panel>
  if (!user) return <Panel navigate={navigate}>
    <p className="eyebrow">Invitation</p><h1>You’ve been invited to Lamina</h1>
    <p>Create an account with the email address this invitation was sent to, or sign in if you already have one. Your account and password are yours alone.</p>
    <div className="onboarding-actions">
      <button className="button-primary" onClick={() => navigate(`/claim/sign-up?return=${encodeURIComponent(returnHere)}`)}>Create account <span>→</span></button>
      <button className="text-button" onClick={() => navigate(signInPath(returnHere))}>I already have an account</button>
    </div>
  </Panel>
  if (error) return <Panel navigate={navigate}><p className="eyebrow">Invitation</p><h1>This invitation can’t be used</h1><div className="error-banner" role="alert">{error}</div></Panel>
  if (!preview) return <Panel navigate={navigate}><p className="muted-note" role="status">Opening the invitation…</p></Panel>
  const copy = invitationCopy(preview)
  const accept = async () => {
    setBusy(true); setError('')
    try { await acceptInvitation(token); navigate(pilotPaths.home) } catch (err) { setError(errorText(err, 'Could not accept this invitation.')) } finally { setBusy(false) }
  }
  return <Panel navigate={navigate}>
    <p className="eyebrow">{preview.kind === 'new_practice' ? 'Invitation from the Lamina team' : 'Practice invitation'}</p>
    <h1>{copy.title}</h1>
    <p>{copy.body}</p>
    <p className="muted-note">Expires {formatDate(preview.expires_at)}.</p>
    {preview.email_matches
      ? <button className="button-primary" disabled={busy} onClick={() => void accept()}>{busy ? 'Accepting…' : 'Accept invitation'} <span>→</span></button>
      : <div className="pilot-panel" role="alert">
        <p><strong>This invitation was sent to a different email address.</strong> You’re signed in as {user.email ?? 'another account'}. Sign out, then create an account or sign in with the address the invitation was sent to.</p>
        <button className="button-secondary" onClick={() => void signOut().then(() => navigate(returnHere))}>Sign out</button>
      </div>}
  </Panel>
}

export function AccessEndedPage({ status, navigate }: { status: PilotStatus; navigate: Navigate }) {
  const { signOut } = useAuth()
  const ended = status.access_ended
  return <Panel navigate={navigate}>
    <p className="eyebrow">Lamina pilot</p>
    <h1>Your access to {ended?.practice_name ?? 'the practice'} has ended</h1>
    <p>A practice admin deactivated your account{ended?.at ? ` on ${formatDate(ended.at)}` : ''}. Your earlier work stays in the practice’s history under your name. If this is a mistake, ask a practice admin to invite you again.</p>
    <button className="text-button" onClick={() => void signOut().then(() => navigate(signInPath(pilotPaths.home)))}>Sign out</button>
  </Panel>
}

/* --------------------------------------------------------- session safety */

const ACTIVITY_KEY = 'lamina.lastActivity'
// Module level, so it survives re-renders and remounts (a token refresh must never count as activity).
let lastActivityAt = Date.now()

/** Fresh activity: on sign-in and after two-step sign-in, and on user input. */
export function markActivity() {
  lastActivityAt = Date.now()
  try { window.localStorage.setItem(ACTIVITY_KEY, String(lastActivityAt)) } catch { /* per-tab only */ }
}

/** Idle timeout: after IDLE_TIMEOUT_MINUTES with no activity in any Lamina tab, sign out on this
 * device. A warning shows IDLE_WARNING_MINUTES before. */
/** `minutes`: the practice's idle timeout (15-60, set by an admin; default 30). */
export function useIdleSignOut(onExpire: () => void, minutes: number = IDLE_TIMEOUT_MINUTES): { warning: boolean; stay: () => void } {
  const [warning, setWarning] = useState(false)
  const expired = useRef(false)
  const touch = useCallback(() => { markActivity(); setWarning(false) }, [])
  useEffect(() => {
    // User input only: the page also scrolls itself (e.g. the agent dock), which must not count.
    const events = ['pointerdown', 'keydown', 'wheel', 'touchstart'] as const
    let lastWrite = 0
    const onActivity = () => { const now = Date.now(); if (now - lastWrite > 15_000) { lastWrite = now; touch() } else lastActivityAt = now }
    for (const name of events) window.addEventListener(name, onActivity, { passive: true })
    const timer = window.setInterval(() => {
      let shared = lastActivityAt
      try { shared = Math.max(shared, Number(window.localStorage.getItem(ACTIVITY_KEY) ?? 0)) } catch { /* ignore */ }
      const state = idleState(shared, Date.now(), minutes)
      setWarning(state === 'warning')
      if (state === 'expired' && !expired.current) { expired.current = true; onExpire() }
    }, 10_000)
    return () => { for (const name of events) window.removeEventListener(name, onActivity); window.clearInterval(timer) }
  }, [onExpire, touch, minutes])
  return { warning, stay: touch }
}

export function IdleWarning({ onStay }: { onStay: () => void }) {
  return <div className="pilot-idle-warning" role="alertdialog" aria-label="You’re about to be signed out">
    <p>You’ll be signed out in {IDLE_WARNING_MINUTES} minutes because there’s been no activity.</p>
    <button className="button-primary" onClick={onStay}>Stay signed in</button>
  </div>
}

/** Profile → Sign-in & security: two-step sign-in status, recovery, sign out everywhere. */
export function SecuritySection({ status, navigate, onSettingsChanged }: { status: PilotStatus; navigate: Navigate; onSettingsChanged?: () => void }) {
  const { user } = useAuth()
  const [confirming, setConfirming] = useState(false)
  const idleMinutes = status.practice?.idle_timeout_minutes ?? IDLE_TIMEOUT_MINUTES
  const [draftMinutes, setDraftMinutes] = useState(idleMinutes)
  const [saving, setSaving] = useState(false)
  const [saved, setSaved] = useState('')
  const saveIdle = async (event: FormEvent) => {
    event.preventDefault(); setSaving(true); setError(''); setSaved('')
    try { await updateIdleTimeout(draftMinutes); setSaved(`Saved: everyone in the practice is signed out after ${draftMinutes} minutes without activity.`); onSettingsChanged?.() }
    catch (err) { setError(errorText(err, 'Could not save the setting.')) } finally { setSaving(false) }
  }
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const everywhere = async () => {
    setBusy(true); setError('')
    try {
      await revokeAllSessions() // the server refuses every session issued up to now
      await signOutEverywhere().catch(() => undefined) // and the identity provider revokes refresh tokens
      navigate(signInWithReason('everywhere'))
    } catch (err) { setError(errorText(err, 'Could not sign out everywhere.')); setBusy(false) }
  }
  return <section className="profile-section-v2" aria-labelledby="security-heading">
    <div className="profile-section-heading"><h2 id="security-heading">Sign-in &amp; security</h2></div>
    <dl className="pilot-facts">
      <div><dt>Account</dt><dd>{user?.email ?? status.account?.email ?? '—'}</dd></div>
      <div><dt>Two-step sign-in</dt><dd>{status.account?.mfa_verified === false ? 'Not completed for this session' : 'On · authenticator app'}</dd></div>
      <div><dt>Inactivity</dt><dd>Signed out after {idleMinutes} minutes without activity{status.is_admin ? '' : ' (set by a practice admin)'}</dd></div>
    </dl>
    {status.is_admin && <form className="pilot-idle-setting" onSubmit={(event) => void saveIdle(event)} aria-label="Idle sign-out for the practice">
      <label><span>Sign everyone out after (minutes without activity)</span>
        <select value={draftMinutes} onChange={(event) => { setDraftMinutes(Number(event.target.value)); setSaved('') }} disabled={saving}>
          {IDLE_TIMEOUT_CHOICES.map((value) => <option key={value} value={value}>{value} minutes{value === IDLE_TIMEOUT_MINUTES ? ' (default)' : ''}</option>)}
        </select></label>
      <button className="button-secondary" type="submit" disabled={saving || draftMinutes === idleMinutes}>{saving ? 'Saving…' : 'Save'}</button>
      {saved && <p className="muted-note" role="status">{saved}</p>}
    </form>}
    <p className="profile-section-explainer">Lost your authenticator? Use “Lost your authenticator?” on the sign-in code screen. Only the Lamina team can reset two-step sign-in — a practice admin can’t.</p>
    {error && <div className="error-banner" role="alert">{error}</div>}
    {!confirming && <button className="button-secondary" onClick={() => setConfirming(true)}>Sign out everywhere</button>}
    {confirming && <div className="pilot-panel" role="group" aria-label="Sign out everywhere">
      <p><strong>Sign out on every device?</strong> Every session of this account ends now, including this one. You’ll sign in again with your password and a code.</p>
      <div className="pilot-actions"><button className="button-primary" disabled={busy} onClick={() => void everywhere()}>{busy ? 'Signing out…' : 'Sign out everywhere'}</button><button className="text-button" disabled={busy} onClick={() => setConfirming(false)}>Cancel</button></div>
    </div>}
  </section>
}
