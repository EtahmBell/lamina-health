import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { parseErrorDetail } from '../src/apiErrors.ts'
import {
  errorRequiresStatusRefresh,
  identityFacts,
  normalizeNpiInput,
  npiFormatHint,
  onboardingCompletePath,
  onboardingErrorCopy,
  onboardingScreen,
  workspaceGateRedirect,
} from '../src/onboardingState.ts'

const onboarding = readFileSync(new URL('../src/Onboarding.tsx', import.meta.url), 'utf8')
const owner = readFileSync(new URL('../src/Owner.tsx', import.meta.url), 'utf8')
const api = readFileSync(new URL('../src/api.ts', import.meta.url), 'utf8')
const app = readFileSync(new URL('../src/App.tsx', import.meta.url), 'utf8')
const claim = readFileSync(new URL('../src/Claim.tsx', import.meta.url), 'utf8')
const slice = (source, from, to) => source.slice(source.indexOf(from), source.indexOf(to))
const shell = () => slice(owner, 'export function OwnerShell', 'function CapabilityNote')

const identity = {
  npi: '1234567893', first_name: 'Jane', middle_name: 'Q', last_name: 'Smith', credential: 'M.D.',
  display_name: 'Jane Q Smith, M.D.',
  taxonomies: [
    { code: '207RN0300X', description: 'Nephrology', primary: true, state: 'CA' },
    { code: '208D00000X', description: 'General Practice', primary: false, state: 'CA' },
  ],
  primary_specialty: 'Nephrology',
  practice_locations: [{ address_line: '100 Main St', city: 'Palo Alto', state: 'CA', postal_code: '94301', phone: null }],
  enumeration_status: 'active', enumeration_date: null, last_updated: null, source: 'NPPES', fetched_at: '2026-11-01T00:00:00+00:00',
}
const status = (value, extra = {}) => ({
  status: value, selection: null, confirmed_identity: null, pilot_access: null,
  workspace_available: value === 'active', allowed_actions: [], ...extra,
})

/* ------------------------------------------------------------- state model */

test('each backend onboarding status maps to exactly one screen', () => {
  assert.equal(onboardingScreen(status('account_created')), 'lookup')
  assert.equal(onboardingScreen(status('identity_selected', { selection: { identity, selected_at: 'x', claim_available: true } })), 'confirm')
  assert.equal(onboardingScreen(status('identity_selected')), 'lookup', 'no selection payload means search again, never a blank confirm')
  assert.equal(onboardingScreen(status('pilot_approval_pending')), 'pending')
  assert.equal(onboardingScreen(status('active')), 'active')
  assert.equal(onboardingScreen(status('rejected')), 'rejected')
  assert.equal(onboardingScreen(status('disabled')), 'disabled')
})

test('the private workspace gate opens only for a backend-active account', () => {
  for (const value of ['account_created', 'identity_selected', 'pilot_approval_pending', 'rejected', 'disabled']) {
    assert.equal(workspaceGateRedirect(status(value)), '/me/onboarding', value)
  }
  assert.equal(workspaceGateRedirect(status('active')), null)
  assert.equal(workspaceGateRedirect({ ...status('active'), workspace_available: false }), '/me/onboarding', 'both fields must agree')
  assert.equal(onboardingCompletePath, '/me/home')
})

test('NPI input hints are UX only and mirror the 10-digit format', () => {
  assert.equal(normalizeNpiInput(' 123 456 7893 '), '1234567893')
  assert.equal(npiFormatHint(''), null)
  assert.match(npiFormatHint('12345'), /exactly 10 digits/)
  assert.match(npiFormatHint('12345abcde'), /digits only/)
  assert.equal(npiFormatHint('1234567893'), null)
})

test('lookup and conflict errors have safe, specific copy', () => {
  assert.match(onboardingErrorCopy('nppes_unavailable', 'x'), /Nothing was saved/)
  assert.match(onboardingErrorCopy('npi_already_claimed', 'x'), /will not be changed automatically/)
  assert.doesNotMatch(onboardingErrorCopy('npi_already_claimed', 'x'), /@|user-|account id/i, 'never reveals the other account')
  assert.match(onboardingErrorCopy('npi_not_eligible', 'x'), /individual/)
  assert.equal(onboardingErrorCopy('unknown_code', 'Fallback'), 'Fallback')
  assert.equal(onboardingErrorCopy(null, 'Fallback'), 'Fallback')
  assert.equal(errorRequiresStatusRefresh('invalid_onboarding_transition'), true)
  assert.equal(errorRequiresStatusRefresh('npi_not_found'), false)
})

test('structured API errors keep their code; plain and validation errors still read cleanly', () => {
  assert.deepEqual(parseErrorDetail({ code: 'pilot_approval_pending', message: 'Awaiting approval' }, 403), { message: 'Awaiting approval', code: 'pilot_approval_pending' })
  assert.deepEqual(parseErrorDetail('Plain detail', 409), { message: 'Plain detail', code: null })
  assert.deepEqual(parseErrorDetail([{ loc: ['body', 'npi'] }], 422), { message: 'Request failed (422)', code: null })
  assert.deepEqual(parseErrorDetail(undefined, 500), { message: 'Request failed (500)', code: null })
})

test('identity facts put the NPI, specialty, and practice context in front of the physician', () => {
  const facts = identityFacts(identity)
  assert.equal(facts.npi, '1234567893')
  assert.equal(facts.specialty, 'Nephrology')
  assert.deepEqual(facts.otherTaxonomies, ['General Practice'])
  assert.deepEqual(facts.locations, ['100 Main St · Palo Alto, CA 94301'])
  const legacy = identityFacts({ npi: '1234567893', display_name: 'JANE SMITH, MD', specialty: 'Nephrology', city: 'Palo Alto', state: 'CA' })
  assert.equal(legacy.specialty, 'Nephrology')
  assert.deepEqual(legacy.locations, ['Palo Alto, CA'])
})

/* ------------------------------------------------------------- onboarding UI */

test('onboarding explains the NPI without implying endorsement or credentialing', () => {
  assert.match(onboarding, /This does not replace medical credentialing or licensure verification\./)
  assert.doesNotMatch(onboarding, /government[- ]verified|CMS[- ]endorsed|credentialed by|license verified|fully verified/i)
  // Pilot-foundation copy: NPPES lookup is profile confirmation, not identity proofing.
  assert.match(onboarding, /Confirm your professional profile/)
  assert.doesNotMatch(onboarding, /Verify your physician identity/)
})

test('the confirmation screen shows the NPI and offers "Is this you?" with a Not me path', () => {
  const card = slice(onboarding, 'function IdentityCard', 'export function PhysicianOnboardingPage')
  assert.match(card, /<dt>NPI<\/dt><dd className="onboarding-npi">\{facts\.npi\}<\/dd>/)
  assert.match(card, /Practice/)
  assert.match(onboarding, /<h1>Is this you\?<\/h1>/)
  assert.match(onboarding, /Yes, this is me/)
  assert.match(onboarding, /Not me — search again/)
  assert.match(onboarding, /clearOnboardingSelection/)
  assert.match(onboarding, /selection\.claim_available/, 'an already-claimed NPI shows a conflict instead of a confirm button')
})

test('confirmation sends only the NPI from the server-provided selection', () => {
  assert.match(onboarding, /confirmOnboardingIdentity\(selection\.identity\.npi\)/)
  assert.match(api, /'\/api\/me\/onboarding\/identity\/confirm', \{\s*method: 'POST', headers: \{ 'Content-Type': 'application\/json' \}, body: JSON\.stringify\(\{ npi \}\),/)
  assert.match(api, /'\/api\/me\/onboarding\/npi\/lookup', \{\s*method: 'POST', headers: \{ 'Content-Type': 'application\/json' \}, body: JSON\.stringify\(\{ npi \}\),/)
  const onboardingApi = slice(api, 'pilot onboarding', 'export const getOwnedPhysicianProfile')
  assert.doesNotMatch(onboardingApi, /physician_id|owner_scope_id|storage_scope_id|pilot_access_status:|approved: true/, 'the client never asserts scope or approval')
})

test('pending approval shows the pilot copy and no workspace entry point', () => {
  const pending = slice(onboarding, "if (screen === 'pending')", "'Workspace disabled'")
  assert.match(onboarding, /Your physician identity has been confirmed\. Lamina is currently onboarding a small number of pilot physicians\. Your account is awaiting approval\./)
  assert.match(pending, /PILOT_PENDING_COPY/)
  assert.doesNotMatch(pending, /ownerHomePath|\/me\/home|Open (your )?workspace/)
  assert.match(pending, /Check status again/)
})

test('an approved account is redirected into /me/home by backend status alone', () => {
  assert.match(onboarding, /if \(status && onboardingScreen\(status\) === 'active'\) navigate\(onboardingCompletePath\)/)
})

test('reloading re-reads backend status; nothing about onboarding is kept in browser storage', () => {
  assert.match(onboarding, /useEffect\(\(\) => \{ setStatus\(null\); if \(user\) void load\(\) \}, \[user\]\)/)
  for (const source of [onboarding, owner]) {
    assert.doesNotMatch(source, /localStorage|sessionStorage|indexedDB/)
  }
})

test('lookup has loading, error, and signed-out states', () => {
  assert.match(onboarding, /Looking up NPPES…/)
  assert.match(onboarding, /aria-busy=\{busy === 'lookup'\}/)
  assert.match(onboarding, /className="error-banner" role="alert"/)
  assert.match(onboarding, /Create account/)
  assert.match(onboarding, /Sign in again to continue/)
})

/* ------------------------------------------------------- workspace gate */

test('OwnerShell resolves pilot access before fetching or rendering any owner-scoped content', () => {
  const body = shell()
  assert.match(body, /getOnboardingStatus\(\)\.then\(setOnboarding\)/)
  const order = ['if (!configured) return', 'if (authLoading) return', 'if (!user) return', 'if (!onboarding) return', 'if (gateRedirect) return', 'if (!status) return', '{children}']
  let cursor = -1
  for (const marker of order) {
    const index = body.indexOf(marker)
    assert.ok(index > cursor, `${marker} must come after the previous gate`)
    cursor = index
  }
  assert.match(body, /if \(user && onboarding && !gateRedirect\) loadStatus\(\)/, 'sandbox status is fetched only after the gate opens')
  assert.match(body, /if \(gateRedirect\) navigate\(gateRedirect\)/)
})

test('routing exposes onboarding at /me/onboarding and the physician gateway lands there', () => {
  assert.match(app, /if \(path === ownerOnboardingPath\) return <PhysicianOnboardingPage navigate=\{navigate\} params=\{params\} \/>/)
  assert.match(app, /physicianPath = physicianAuthed \? ownerOnboardingPath : signInPath\(ownerOnboardingPath\)/)
})

test('real NPPES identities on the claim page route into onboarding, never the legacy claim call', () => {
  const identityPage = slice(claim, 'export function ProviderIdentityPage', 'function AuthCard')
  const realBranch = slice(identityPage, "profile.claimable && !profile.synthetic", "profile.claimable && profile.synthetic")
  assert.match(realBranch, /ownerOnboardingPath/)
  assert.doesNotMatch(realBranch, /createProviderClaim|claim\(\)/)
})
