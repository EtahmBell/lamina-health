import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'
import { test } from 'node:test'
import { formatSetupKey, idleState, invitationCopy, invitationLink, normalizeTotpInput, pilotErrorCopy, resolvePilotRoute } from '../src/pilotState.ts'

/* Accounts and access (go-live prep, run 1): invite-only sign-up, invitations by email, two-step
 * sign-in, deactivation, session safety, and the dev-only test sign-in gate. */

const source = (name) => readFileSync(new URL(`../src/${name}`, import.meta.url), 'utf8').replace(/\r\n/g, '\n')
const slice = (text, from, to) => text.slice(text.indexOf(from), to ? text.indexOf(to, text.indexOf(from)) : undefined)
const access = source('PilotAccess.tsx')
const pilot = source('Pilot.tsx')
const auth = source('authClient.ts')
const api = source('pilotApi.ts')

test('helpers: setup key, code input, invitation link and the idle clock', () => {
  assert.equal(formatSetupKey('jbsw y3dp ehpk3pxp'), 'JBSW Y3DP EHPK 3PXP')
  assert.equal(normalizeTotpInput('12 34-567'), '123456')
  assert.equal(invitationLink('https://app.example', 'a/b c'), 'https://app.example/me/join?invite=a%2Fb%20c')
  const start = 0
  assert.equal(idleState(start, start + 27 * 60_000), 'active')
  assert.equal(idleState(start, start + 28 * 60_000), 'warning')
  assert.equal(idleState(start, start + 30 * 60_000), 'expired')
})

test('invitation copy says what accepting means, by role', () => {
  assert.match(invitationCopy({ kind: 'practice', role: 'staff', practice_name: 'Northfield' }).body, /join as staff/)
  const physician = invitationCopy({ kind: 'practice', role: 'physician', practice_name: 'Northfield' })
  assert.equal(physician.title, 'Join Northfield')
  assert.match(physician.body, /confirm your own professional profile \(NPI\) — only you can/)
  assert.match(physician.body, /won’t be a practice admin unless an admin makes you one/)
  assert.match(invitationCopy({ kind: 'new_practice', role: 'physician', practice_name: null }).title, /Set up your practice/)
})

test('the gate routes MFA and ended access before anything about the practice', () => {
  const gate = slice(pilot, 'function PilotGate', 'function PracticeFieldsForm')
  assert.match(gate, /case 'mfa': return <MfaPage status=\{status\} navigate=\{navigate\} onVerified=\{reload\} \/>/)
  assert.match(gate, /case 'access_ended': return <AccessEndedPage/)
  assert.match(gate, /status\.invitation \? <p className="pilot-access-note" role="note">You’re joining/)
  // A session revoked elsewhere gets a plain "signed out" screen, not a generic error.
  assert.match(gate, /err\.status === 401\) setSignedOut\(true\)/)
  assert.match(gate, /signInWithReason\('revoked'\)/)
})

test('invite-only: no open "Create account" on the pilot landing page', () => {
  const landing = slice(pilot, "if (!user) return <ClaimShell navigate={navigate}><div className=\"onboarding-panel\">", "if (error) return")
  assert.match(landing, /Lamina pilot · invite-only/)
  assert.match(landing, /className="button-primary" onClick=\{\(\) => navigate\(signInPath\(pilotPaths\.home\)\)\}>Sign in/)
  assert.match(landing, />Request pilot access</)
  assert.doesNotMatch(landing, />Create account/)
  const signUp = slice(access, 'export function PilotSignUpPage', '/* ------')
  assert.match(signUp, /invited \? 'Create your account' : 'Request pilot access'/)
  assert.match(signUp, /the Lamina team reviews each request/)
  assert.match(pilot, /case 'auth': return route\.page === 'sign-in' \? <PilotSignInPage/)
  assert.deepEqual(resolvePilotRoute('/claim/sign-up'), { kind: 'auth', page: 'sign-up' })
})

test('two-step sign-in: setup at first sign-in, a code every time, recovery never through an admin', () => {
  const mfa = slice(access, 'export function MfaPage', 'function RecoveryRequest')
  assert.match(mfa, /autoComplete="one-time-code"/)
  assert.match(mfa, /Set up two-step sign-in/)
  assert.match(mfa, /Enter your code/)
  assert.match(mfa, /aria-label="Setup key"/)
  assert.match(mfa, /Checking two-step sign-in…/, 'truthful loading state')
  assert.match(mfa, /Couldn’t check two-step sign-in/, 'truthful error state')
  const recovery = slice(access, 'function RecoveryRequest', '/* ------')
  assert.match(recovery, /Only the Lamina team can reset it — never a practice admin/)
  assert.match(recovery, /requestMfaRecovery\(reason\.trim\(\)\)/)
  assert.match(api, /requestMfaRecovery = \(reason: string\) => apiRequest<[^>]+>\('\/api\/me\/practice\/mfa\/recovery-request'/)
})

test('joining by invitation is bound to the invited email', () => {
  const join = slice(access, 'export function JoinPracticePage', 'export function AccessEndedPage')
  assert.match(join, /\{preview\.email_matches\n\s+\? <button className="button-primary"/)
  assert.match(join, /This invitation was sent to a different email address/)
  assert.equal(pilotErrorCopy('invitation_email_mismatch', 'x'), 'This invitation was sent to a different email address. Sign in with that address, or ask for a new invitation.')
  assert.match(pilotErrorCopy('staff_account', 'x'), /can’t claim a physician identity/)
})

test('the team: invite by email and role, revoke, deactivate with a confirmation', () => {
  const profile = slice(pilot, 'function ProfilePage')
  assert.match(profile, /inviteMember\(role, email\.trim\(\), label\.trim\(\)\)/)
  assert.match(profile, /<legend>Invite as<\/legend>/)
  assert.match(profile, /Only that email address can use it, once, until/)
  assert.match(profile, /It won’t be shown again/)
  assert.match(profile, /Deactivate \{member\.label \?\? 'this member'\}\?<\/strong> Their access ends now, on every device\. Their past work stays in the history under their name\./)
  assert.match(profile, /Invited as \{item\.role === 'physician' \? 'a physician' : 'staff'\}/)
  assert.match(profile, /<SecuritySection status=\{status\} navigate=\{navigate\} onSettingsChanged=\{reload\} \/>/)
  // The link lives only in component state: never stored, never logged.
  assert.doesNotMatch(profile, /localStorage|sessionStorage|console\./)
})

test('session safety: idle sign-out with a warning, and sign out everywhere', () => {
  assert.match(pilot, /const idle = useIdleSignOut\(onIdle, idleMinutes\)/)
  assert.match(pilot, /\{idle\.warning && <IdleWarning onStay=\{idle\.stay\} \/>\}/)
  const security = slice(access, 'export function SecuritySection')
  assert.match(security, /await revokeAllSessions\(\)/)
  assert.match(security, /await signOutEverywhere\(\)/)
  assert.match(security, /Every session of this account ends now, including this one/)
  assert.match(auth, /export async function signOutEverywhere/)
})

test('the dev-only test sign-in can never be part of a real build', () => {
  assert.match(auth, /const DEV_TEST_AUTH_BUILD = typeof import\.meta\.env !== 'undefined' && import\.meta\.env\.VITE_LAMINA_DEV_TEST_AUTH === '1'/)
  assert.match(auth, /DEV_TEST_AUTH_BUILD && devTestAuthRequested\(\)\n\s+\? import\('\.\/devTestAuth\.ts'\)/)
  assert.match(auth, /\['127\.0\.0\.1', 'localhost', '\[::1\]'\]\.includes\(window\.location\.hostname\)/)
  // Only authClient loads it, and only dynamically.
  for (const file of readdirSync(new URL('../src/', import.meta.url)).filter((name) => /\.tsx?$/.test(name) && name !== 'authClient.ts')) {
    assert.doesNotMatch(source(file), /from '\.\/devTestAuth/, file)
  }
  const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
  assert.match(pkg.scripts.build, /vite build && node scripts\/check-bundle\.mjs$/, 'every build refuses a bundle with the dev sign-in')
  for (const file of ['PilotAccess.tsx', 'authClient.ts', 'devTestAuth.ts']) assert.doesNotMatch(source(file), /console\.(log|info|debug)/, file)
})

/* Run 2 fixes. */

test('the idle timeout is the practice setting, chosen by an admin from 15 to 60 minutes', () => {
  assert.equal(idleState(0, 42 * 60_000, 45), 'active')
  assert.equal(idleState(0, 43 * 60_000 + 1, 45), 'warning')
  assert.equal(idleState(0, 45 * 60_000, 45), 'expired')
  assert.match(pilot, /const idleMinutes = status\.practice\?\.idle_timeout_minutes \?\? 30/)
  assert.match(pilot, /useIdleSignOut\(onIdle, idleMinutes\)/)
  const security = slice(access, 'export function SecuritySection')
  assert.match(security, /\{status\.is_admin && <form className="pilot-idle-setting"/)
  assert.match(security, /IDLE_TIMEOUT_CHOICES\.map/)
  assert.match(api, /updateIdleTimeout = \(minutes: number\) => apiRequest<Practice>\('\/api\/me\/practice\/security-settings'/)
})

test('the pilot header never shows the demo-only identities link; read-only learnings say why', () => {
  assert.match(source('Claim.tsx'), /\{physicianLinks && productMode !== 'pilot' && <button.*>My physician identities/)
  const agent = source('PilotAgent.tsx')
  assert.match(agent, /physician && proposal\.can_confirm !== false\n\s+\? <ProposalCard/)
  assert.match(agent, /an admin physician confirms practice-wide statements/)
})

test('run 2: a non-admin physician sees practice-wide learnings read-only on Train, not counted as their own', () => {
  const agent = readFileSync(new URL('../src/PilotAgent.tsx', import.meta.url), 'utf8')
  assert.match(agent, /readOnlyPracticeWide = \(proposal: Proposal\) => physician && proposal\.can_confirm === false && proposal\.layer !== 'physician'/)
  assert.match(agent, /pendingIds\.has\(proposal\.id\) \|\| readOnlyPracticeWide\(proposal\)/)
  assert.match(agent, /an admin physician confirms practice-wide statements/)
})

test('run 2: a conflict is worded for the reader -- "your" only for their own correction or rule', async () => {
  const { conflictWording } = await import('../src/pilotState.ts')
  const own = conflictWording({ corrected_by_name: 'Dr. A', rule_by_name: 'Dr. A', corrected_by_you: true, rule_by_you: true }, true, 'Dr. A')
  assert.deepEqual([own.title, own.keep], ['Your correction differs from your newer rule', 'Keep my correction'])
  const other = conflictWording({ corrected_by_name: 'Dr. A', rule_by_name: 'Dr. A', corrected_by_you: false, rule_by_you: false }, true, 'Dr. A')
  assert.equal(other.title, 'Dr. A’s correction differs from Dr. A’s newer rule')
  assert.equal(other.keep, 'Keep Dr. A’s correction')
  assert.doesNotMatch(other.caution, /\byour\b/)
  const staff = conflictWording({ corrected_by_name: 'Dr. B', rule_by_name: null, corrected_by_you: false, rule_by_you: false }, false, 'Dr. A')
  assert.equal(staff.title, 'Dr. B’s correction differs from the newer practice rule')
  const agent = readFileSync(new URL('../src/PilotAgent.tsx', import.meta.url), 'utf8')
  assert.match(agent, /'Learned from repeated corrections in the practice'/)
  assert.match(agent, /not active until an admin physician confirms/)
})
