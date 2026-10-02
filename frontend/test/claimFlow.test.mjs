import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'

const claim = readFileSync(new URL('../src/Claim.tsx', import.meta.url), 'utf8')
const app = readFileSync(new URL('../src/App.tsx', import.meta.url), 'utf8')
const network = readFileSync(new URL('../src/PhysicianNetwork.tsx', import.meta.url), 'utf8')
const api = readFileSync(new URL('../src/api.ts', import.meta.url), 'utf8')
const styles = readFileSync(new URL('../src/styles.css', import.meta.url), 'utf8')
const safeReturn = readFileSync(new URL('../src/safeReturn.ts', import.meta.url), 'utf8')
const slice = (source, from, to) => source.slice(source.indexOf(from), source.indexOf(to))

const portal = () => slice(app, 'function LandingPage', 'function formatTime')
const search = () => slice(claim, 'function IdentityResultRow', 'export function ProviderIdentityPage')
const identity = () => slice(claim, 'export function ProviderIdentityPage', 'function AuthCard')
const authForms = () => slice(claim, 'function AuthCard', 'type OwnedClaim')
const myIdentities = () => slice(claim, 'export function MyIdentitiesPage', claim.length)
const providerProfile = () => slice(network, 'export function PhysicianProfilePage', network.length)

/* -------------------------------------------------------------- entry */

test('the Portal keeps Enter workspace primary and adds a secondary physician entry', () => {
  assert.match(portal(), /onClick=\{\(\) => navigate\('\/home'\)\}/, 'Lucy demo entry unchanged')
  assert.match(portal(), /aria-label="Enter workspace"/)
  assert.match(portal(), /onClick=\{\(\) => navigate\('\/claim'\)\}/)
  assert.match(portal(), /Are you a physician\?/)
  assert.match(portal(), /Find your Lamina identity/)
  assert.doesNotMatch(portal(), /Find your AI agent/i)
})

test('the Portal offers a quiet top-right Sign in for returning account holders', () => {
  assert.match(app, /function PortalAccountControl/)
  assert.match(app, /<PortalAccountControl navigate=\{navigate\} \/><SyntheticStatus \/><ProfileControl navigate=\{navigate\} \/>/, 'it sits in the existing top-right utility row, not competing with Enter workspace')
  const control = slice(app, 'function PortalAccountControl', 'function ProductShell')
  assert.match(control, /if \(!configured \|\| loading\) return null/, 'nothing renders while auth is unconfigured or still resolving')
  assert.match(control, />Sign in</)
})

test('general sign-in (not from a specific claim) defaults to My physician identities', () => {
  const control = slice(app, 'function PortalAccountControl', 'function ProductShell')
  assert.match(control, /navigate\(signInPath\('\/claim\/my-identities'\)\)/)
  const shellSignIn = slice(claim, 'function ClaimShell', 'function LifecycleStepper')
  assert.match(shellSignIn, /navigate\(signInPath\('\/claim\/my-identities'\)\)/)
})

test('an authenticated visitor sees account access instead of Sign in, on the Portal and in the claim shell alike', () => {
  const control = slice(app, 'function PortalAccountControl', 'function ProductShell')
  assert.match(control, /user\s*\n?\s*\? <button className="text-button portal-account-link" onClick=\{\(\) => navigate\('\/claim\/my-identities'\)\}>My physician identities</)
  assert.doesNotMatch(control, /PCP_NAME|Dr\. Lucy Saru/, 'the physician account is never rendered as Dr. Lucy Saru')
})

test('the Lucy demo route table is untouched', () => {
  assert.match(app, /if \(path === '\/home'\) return <HomePage/)
  assert.match(app, /if \(path === '\/patients'\) return <PatientSelector/)
  assert.match(app, /if \(path === '\/agent'\) return <MyAgentPage/)
})

/* ------------------------------------------------------------- search */

test('search reuses the existing provider search API and shows lifecycle, not inferred state', () => {
  assert.match(search(), /searchProviders\(filters\)/)
  assert.match(search(), /<LifecycleChip status=\{profile\.lifecycle_status\} claimedByMe=\{profile\.claimed_by_me\} \/>/)
  assert.doesNotMatch(search(), /profile\.agent\.status/, 'search results read the canonical lifecycle_status field')
})

test('a search result never exposes another claimant\'s identity', () => {
  const row = slice(claim, 'function IdentityResultRow', 'export function PhysicianIdentitySearchPage')
  assert.doesNotMatch(row, /auth_user_id|claimant|my_claim_id/i)
  assert.match(row, /profile\.claimed_by_me/, 'only the backend-safe owned flag is used')
})

/* --------------------------------------------------------- identity page */

test('claiming while unauthenticated routes to sign-up by default, never pre-creates a claim', () => {
  const reservedBlock = identity().slice(identity().indexOf("status === 'reserved'"), identity().indexOf("status === 'claimed'"))
  assert.match(reservedBlock, /user\s*\n?\s*\? <button className="button-primary" disabled=\{busy\} onClick=\{\(\) => void claim\(\)\}/)
  assert.match(reservedBlock, /navigate\(signUpPath\(returnHere\)\)/, 'a new visitor is assumed to need an account, not assumed to have one')
  assert.doesNotMatch(reservedBlock, /navigate\(signInPath\(returnHere\)\)/, 'Claim this identity must not default to sign-in')
  assert.match(claim, /export const signUpPath = \(returnTo: string\) => `\/claim\/sign-up\?return=\$\{encodeURIComponent\(returnTo\)\}`/)
  assert.doesNotMatch(reservedBlock.slice(0, reservedBlock.indexOf('user\n')), /createProviderClaim/)
})

test('claim signup shows the real physician identity being claimed', () => {
  const signUp = slice(claim, 'export function SignUpPage', 'type OwnedClaim')
  assert.match(signUp, /const claimingNpi = providerNpiFromReturn\(target\)/)
  assert.match(signUp, /getProvider\(claimingNpi\)\.then\(setClaimingProfile\)/)
  assert.match(signUp, /You're claiming/)
  assert.match(signUp, /displayName\(claimingProfile\.display_name\)/)
  assert.match(signUp, /claimingProfile\.specialty.*location\(claimingProfile\)/)
  assert.match(signUp, /NPI \{claimingProfile\.npi\}/)
  assert.match(signUp, /title=\{claimingNpi \? 'Create your Lamina account' : 'Create account'\}/)
})

test('a failed provider-context lookup never blocks account creation', () => {
  const signUp = slice(claim, 'export function SignUpPage', 'type OwnedClaim')
  assert.match(signUp, /\.catch\(\(\) => setClaimingProfile\(null\)\)/)
})

test('claim signup offers "Already have a Lamina account? Sign in" back to sign-in, preserving the return target', () => {
  const signUp = slice(claim, 'export function SignUpPage', 'type OwnedClaim')
  assert.match(signUp, /Already have a Lamina account\?/)
  assert.match(signUp, /navigate\(signInPath\(target\)\)/)
})

test('a safe return target survives both the sign-up and sign-in round trip', () => {
  const signIn = slice(claim, 'export function SignInPage', 'export function SignUpPage')
  const signUp = slice(claim, 'export function SignUpPage', 'type OwnedClaim')
  for (const page of [signIn, signUp]) {
    assert.match(page, /const target = safeReturnPath\(params\.get\('return'\), '\/claim\/my-identities'\)/)
    assert.match(page, /useEffect\(\(\) => \{ if \(user\) navigate\(target\) \}, \[user\]\)/)
  }
  /* sign-up's own "Sign in" link and sign-in's own "Create account" link both
     carry the same target forward, so the identity is never dropped mid-flow */
  assert.match(signUp, /navigate\(signInPath\(target\)\)/)
  assert.match(signIn, /navigate\(signUpPath\(target\)\)/)
})

test('an authenticated owner can claim; the action calls the real claim endpoint', () => {
  assert.match(claim, /const claim = \(\) => act\(\(\) => createProviderClaim\(npi\)\.then\(\(\) => getProvider\(npi\)\), 'Could not claim this identity\.'\)/)
})

test('a claim the user does not own shows no action, never ownership metadata', () => {
  const claimedBlock = identity().slice(identity().indexOf("status === 'claimed'"), identity().indexOf("status === 'verification_pending'"))
  assert.match(claimedBlock, /This identity has an active claim in progress\./)
  assert.doesNotMatch(claimedBlock, /auth_user_id|email|claimant/i)
})

test('submit verification is reachable only for the owner while claimed, with an explicit "Verify your physician identity" step', () => {
  assert.match(identity(), /status === 'claimed' && profile\.claimed_by_me/)
  assert.match(identity(), /void submitVerification\(\)/)
  assert.match(claim, /submitProviderVerification\(profile\.my_claim_id as number\)/)
  const claimedBlock = identity().slice(identity().indexOf("status === 'claimed' && profile.claimed_by_me"), identity().indexOf("status === 'claimed' && !profile.claimed_by_me"))
  assert.match(claimedBlock, /Verify your physician identity/)
  assert.match(claimedBlock, /Lamina must confirm that the person claiming this NPI is the physician associated with it\./)
})

test('email confirmation never implies physician verification; the two concepts stay visually distinct', () => {
  const signUp = slice(claim, 'export function SignUpPage', 'type OwnedClaim')
  assert.match(signUp, /Account created\. Check your email to confirm your account, then sign in\./)
  assert.doesNotMatch(signUp, /physician.?(is )?verified/i, 'account/email copy must never claim physician verification')
  const pendingBlock = identity().slice(identity().indexOf("status === 'verification_pending'"), identity().indexOf("status === 'verified'"))
  assert.match(pendingBlock, /We're confirming your identity against professional provider information/)
  assert.match(pendingBlock, /You can return here at any time\./)
  /* the only path to an actually-verified lifecycle state is backend-driven:
     real submission (NPPES, blocked) or the explicitly labelled demo path */
  assert.doesNotMatch(claim, /signUp\([^)]*\)[\s\S]{0,200}verified/i)
})

test('a real NPPES identity has no demo-verify, activate, or skip control at verification_pending', () => {
  const pendingBlock = identity().slice(identity().indexOf("status === 'verification_pending'"), identity().indexOf("status === 'verified'"))
  const realBranch = pendingBlock.slice(pendingBlock.indexOf(': <div className="production-verification">'))
  assert.match(realBranch, /Real physician verification is not yet connected in this demonstration\./)
  assert.doesNotMatch(realBranch, /Verify demo identity|Activate agent|Skip verification|Verify now|Demo verify/i)
  assert.match(pendingBlock, /canDemoVerify\(profile\.synthetic, status\)/)
})

test('a synthetic identity awaiting verification shows a clearly labeled demo-only path', () => {
  const pendingBlock = identity().slice(identity().indexOf("status === 'verification_pending'"), identity().indexOf("status === 'verified'"))
  assert.match(pendingBlock, /Demo verification\./)
  assert.match(pendingBlock, /This synthetic identity can use the demo verification path/)
  assert.match(pendingBlock, /No credentialing or real identity check is performed\./)
  assert.match(pendingBlock, /void demoVerify\(\)/)
})

test('a disabled demo-verification environment is handled calmly without another bypass attempt', () => {
  const demoVerify = slice(claim, 'const demoVerify =', 'const activate =')
  assert.match(demoVerify, /err\.status === 403/)
  assert.match(demoVerify, /Demo verification is unavailable in this environment\./)
  assert.doesNotMatch(demoVerify, /force|bypass|skip/i)
})

test('verified-and-owned renders a review surface before any activation control', () => {
  const verifiedBlock = identity().slice(identity().indexOf("status === 'verified' && profile.claimed_by_me"), identity().indexOf("status === 'active'"))
  const reviewIndex = verifiedBlock.indexOf('Your physician identity')
  const agentIndex = verifiedBlock.indexOf('Your Lamina agent')
  const activateIndex = verifiedBlock.indexOf('Activate agent')
  assert.ok(reviewIndex >= 0 && agentIndex > reviewIndex && activateIndex > agentIndex, 'identity → agent → activate, in that order')
  assert.match(verifiedBlock, /Verified · inactive/)
  assert.match(verifiedBlock, /What Lamina knows/)
})

test('activation is confirmed before it mutates anything', () => {
  const verifiedBlock = identity().slice(identity().indexOf("status === 'verified' && profile.claimed_by_me"), identity().indexOf("status === 'active'"))
  assert.match(verifiedBlock, /setConfirmingActivate\(true\)/)
  assert.match(verifiedBlock, /Activate \{name\}'s Agent\?/)
  assert.match(verifiedBlock, /Activation makes this verified Lamina agent active in the network\./)
  assert.match(verifiedBlock, /<button className="text-button" onClick=\{\(\) => setConfirmingActivate\(false\)\}>Cancel<\/button>/)
})

test('unverified states can never render the activation control', () => {
  for (const guard of ['claimed', 'verification_pending']) {
    const section = identity().slice(identity().indexOf(`status === '${guard}'`), identity().indexOf(`status === '${guard}'`) + 900)
    assert.doesNotMatch(section, /Activate agent/)
  }
})

test('the active state is distinct and restrained, with disable as a quiet secondary action', () => {
  const activeBlock = identity().slice(identity().indexOf("status === 'active'"), identity().indexOf("status === 'disabled'"))
  assert.match(activeBlock, /Your physician agent is active\./)
  assert.match(activeBlock, /profile\.synthetic \? ' Synthetic demo agent\.' : ''/)
  assert.match(activeBlock, /className="text-button quiet-remove" onClick=\{\(\) => setConfirmingDisable\(true\)\}>Disable agent/)
  assert.doesNotMatch(activeBlock.slice(0, activeBlock.indexOf('quiet-remove')), /button-primary/, 'disable is not the primary action')
})

test('disabling requires confirmation and keeps the claim; reactivation reuses the real activation endpoint', () => {
  const activeBlock = identity().slice(identity().indexOf("status === 'active'"), identity().indexOf("status === 'disabled'"))
  assert.match(activeBlock, /Disable \{name\}'s Agent\?/)
  assert.match(activeBlock, /Identity remains verified\. You can reactivate at any time\./)
  const disabledBlock = identity().slice(identity().indexOf("status === 'disabled'"), identity().length)
  assert.match(disabledBlock, /Agent disabled\. Identity remains verified\./)
  assert.match(disabledBlock, /Reactivate agent/)
  assert.match(disabledBlock, /activateProviderClaim\(profile\.my_claim_id as number\)/, 'reactivation calls the same activation endpoint')
})

test('a 409 conflict is generic and discloses nothing about the other claimant', () => {
  assert.match(claim, /This identity already has an active claim\.\\n\\nIf you believe this is an error, contact Lamina\./)
  assert.doesNotMatch(claim, /claimant|owner.?s email|claimed by [a-z]/i)
})

test('a session-expired action offers a calm return-to-sign-in path instead of a raw error', () => {
  assert.match(claim, /err\.status === 401.*sessionExpired: true/s)
  assert.match(claim, /Sign in again to continue\./)
  assert.match(claim, /navigate\(signInPath\(returnHere\)\)/)
})

/* --------------------------------------------------------------- auth */

test('sign-in and sign-up use only the existing authClient primitives', () => {
  assert.match(authForms(), /const \{ configured, user, signIn \} = useAuth\(\)/)
  assert.match(authForms(), /const \{ configured, user, signUp \} = useAuth\(\)/)
  assert.doesNotMatch(authForms(), /signInWithOAuth|provider: 'google'|provider: 'github'|institutional|SSO/i)
  assert.doesNotMatch(authForms(), /resetPasswordForEmail|forgot.?password/i)
})

test('both forms use real email/password fields with correct input semantics', () => {
  for (const type of ['email', 'current-password', 'new-password']) assert.match(authForms(), new RegExp(`autoComplete="${type}"`))
  assert.match(authForms(), /type="email"/)
  assert.equal((authForms().match(/type="password"/g) || []).length, 3, 'sign-in password + sign-up password + confirm')
})

test('sign-up validates password confirmation on the frontend before calling signUp', () => {
  assert.match(claim, /if \(password !== confirmPassword\) \{ setError\('Passwords do not match\.'\); return \}/)
})

test('an unconfigured auth environment shows a calm notice instead of a broken form', () => {
  assert.match(authForms(), /!configured && <p className="muted-note">Authentication is not configured in this environment\.<\/p>/)
})

test('successful auth navigates to the preserved return target, defaulting to My physician identities', () => {
  assert.match(claim, /const target = safeReturnPath\(params\.get\('return'\), '\/claim\/my-identities'\)/g)
  assert.match(claim, /useEffect\(\(\) => \{ if \(user\) navigate\(target\) \}, \[user\]\)/)
})

test('auth return targets are restricted to local absolute paths', () => {
  assert.match(claim, /safeReturnPath\(params\.get\('return'\)/)
  assert.match(safeReturn, /!value\.startsWith\('\/'\)/)
  assert.match(safeReturn, /value\.startsWith\('\/\/'\)/)
  assert.match(safeReturn, /value\.includes\('\\\\'\)/)
  assert.match(safeReturn, /parsed\.origin === 'https:\/\/lamina\.invalid'/)
})

test('sign out clears the session and returns to a public claim route', () => {
  assert.match(claim, /const handleSignOut = async \(\) => \{ await signOut\(\); navigate\('\/claim'\) \}/)
})

/* -------------------------------------------------------- my identities */

test('My physician identities loads the real owned-claims endpoint and requires sign-in', () => {
  assert.match(myIdentities(), /getMyProviderClaims\(\)/)
  assert.match(myIdentities(), /if \(!user\) return <AuthCard/)
  assert.match(myIdentities(), /signInPath\('\/claim\/my-identities'\)/)
})

test('My physician identities shows physician, specialty, location and lifecycle per claim', () => {
  assert.match(myIdentities(), /displayName\(claim\.profile\.display_name\)/)
  assert.match(myIdentities(), /claim\.profile\?\.specialty/)
  assert.match(myIdentities(), /location\(claim\.profile\)/)
  assert.match(myIdentities(), /LIFECYCLE_COPY\[status\]/)
})

/* -------------------------------------------------------------- routing */

test('every claim route is wired through the existing manual router, no new routing dependency', () => {
  assert.match(app, /if \(path === '\/claim'\) return <PhysicianIdentitySearchPage navigate=\{navigate\} \/>/)
  assert.match(app, /if \(path === '\/claim\/my-identities'\) return <MyIdentitiesPage navigate=\{navigate\} \/>/)
  assert.match(app, /if \(path === '\/claim\/sign-in'\) return <SignInPage navigate=\{navigate\} params=\{params\} \/>/)
  assert.match(app, /if \(path === '\/claim\/sign-up'\) return <SignUpPage navigate=\{navigate\} params=\{params\} \/>/)
  assert.match(app, /const claimNpi = path\.match\(\/\^\\\/claim\\\/provider\\\/\(\[\^\/\]\+\)\$\/\)\?\.\[1\]/)
  assert.doesNotMatch(app, /react-router/)
})

test('refreshing at /claim/provider/:npi re-derives state from the backend, not from component memory', () => {
  assert.match(identity(), /const load = \(\) => getProvider\(npi\)\.then/)
  assert.match(identity(), /useEffect\(\(\) => \{ void load\(\) \}, \[npi, user\]\)/)
})

test('the Physician Network claim link routes into the one canonical claim route', () => {
  assert.match(network, /navigate\(claimPath\)/)
  assert.match(network, /const claimPath = `\/claim\/provider\/\$\{encodeURIComponent\(profile\.npi\)\}`/)
  assert.match(network, /claim this identity →/i)
})

test('Physician Network no longer runs a second claim/verify/activate UX', () => {
  assert.doesNotMatch(providerProfile(), /createProviderClaim|submitProviderVerification|verifySyntheticDemoClaim|activateProviderClaim|disableProviderClaim/)
  assert.doesNotMatch(providerProfile(), /preferences-form|Configure physician preferences/)
})

test('Add to my network and Claim this identity stay separate actions in search results', () => {
  const result = slice(network, 'function DirectoryResult', 'function NetworkRelationshipRow')
  assert.match(result, /Add to my network/)
  assert.match(result, /Claim this identity/)
  const addIndex = result.indexOf('Add to my network')
  const claimIndex = result.indexOf('Claim this identity')
  assert.notEqual(addIndex, -1)
  assert.notEqual(claimIndex, -1)
  assert.match(result, /onClick=\{onAdd\}/)
  assert.match(result, /onClick=\{\(\) => navigate\(`\/claim\/provider\/\$\{encodeURIComponent\(profile\.npi\)\}`\)\}/)
})

test('Profile links to My physician identities only when a real account session exists, and never represents Lucy as that account', () => {
  const profileFn = slice(app, 'function ProfilePage', 'function UnfinishedPatient')
  assert.match(profileFn, /const \{ user \} = useAuth\(\)/)
  assert.match(profileFn, /\{user && <p className="muted-note profile-identity-link">/)
  assert.match(profileFn, /separate concept from your signed-in physician account/)
  assert.match(profileFn, /navigate\('\/claim\/my-identities'\)/)
})

/* ------------------------------------------------------------- security */

test('no frontend code sends auth_user_id or any client-asserted identity field', () => {
  for (const source of [claim, app, network]) {
    assert.doesNotMatch(source, /auth_user_id|authUserId/)
  }
})

test('claim functions still derive identity server-side via the bearer token only', () => {
  assert.match(api, /createProviderClaim = \(npi: string\) => request<ProviderClaim>\(`\/api\/providers\/\$\{encodeURIComponent\(npi\)\}\/claim`, \{ method: 'POST' \}\)/)
  assert.doesNotMatch(api, /body: JSON\.stringify\(\{[^}]*auth_user_id/i)
})

test('the frontend uses only the Supabase session mechanism, never a manual token store', () => {
  assert.doesNotMatch(claim, /localStorage\.setItem.*token|sessionStorage\.setItem.*token/i)
})

test('all API requests include the anonymous demo workspace cookie', () => {
  assert.match(api, /credentials: 'include'/)
})

test('no fake auth bypass or shortcut from login success to physician verification exists', () => {
  assert.doesNotMatch(claim, /autoVerify|skipVerification|bypassAuth|fakeToken/i)
  assert.doesNotMatch(claim, /signIn\(\).*verif/is)
})

/* ---------------------------------------------------------------- scope */

test('the clinical demo, recommendation logic and specialist-mode boundary are untouched', () => {
  assert.doesNotMatch(claim, /patient-ckd-htn-001|patient-ida-002|recommended_physician/)
  for (const source of [claim, app, network]) {
    assert.doesNotMatch(source, /specialist mode|role selector|Cases nav|specialist Home/i)
  }
})

test('the synthetic "(synthetic)" suffix never leaks into claim headings or confirmations', () => {
  assert.match(claim, /const displayName = \(value: string\) => cleanName\(physicianDisplayName\(value\)\)/)
  assert.equal((claim.match(/physicianDisplayName\(profile\.display_name\)/g) || []).length, 0, 'every call site uses the cleaned displayName helper, not the raw title-caser')
  assert.match(claim, /const name = displayName\(profile\.display_name\)/)
})

test('styles follow the existing Lamina system, not a generic auth template', () => {
  assert.match(styles, /\.claim-shell/)
  assert.match(styles, /\.auth-form input \{[^}]*border: 1px solid var\(--border\)/)
  assert.doesNotMatch(styles, /\.claim-shell[\s\S]{0,400}linear-gradient/)
})
