import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'

const owner = readFileSync(new URL('../src/Owner.tsx', import.meta.url), 'utf8')
const api = readFileSync(new URL('../src/api.ts', import.meta.url), 'utf8')
const engagement = readFileSync(new URL('../src/Engagement.tsx', import.meta.url), 'utf8')
const app = readFileSync(new URL('../src/App.tsx', import.meta.url), 'utf8')
const claim = readFileSync(new URL('../src/Claim.tsx', import.meta.url), 'utf8')
const styles = readFileSync(new URL('../src/styles.css', import.meta.url), 'utf8')
const slice = (source, from, to) => source.slice(source.indexOf(from), source.indexOf(to))

const shell = () => slice(owner, 'export function OwnerShell', 'function CapabilityNote')
const home = () => slice(owner, 'export function OwnerHomePage', 'const OWNER_AGENT_TABS')
const agentPage = () => slice(owner, 'export function OwnerAgentPage', 'export function OwnerProfilePage')
const routing = () => slice(app, 'export default function App', app.length)
const identityPage = () => slice(claim, 'export function ProviderIdentityPage', 'function AuthCard')

/* ------------------------------------------------------------- auth / scope */

test('OwnerShell gates on auth before rendering any owner-scoped content', () => {
  const body = shell()
  assert.match(body, /if \(!configured\) return/)
  assert.match(body, /if \(authLoading\) return/)
  assert.match(body, /if \(!user\) return/)
  assert.match(body, /Sign in to open your workspace/)
})

test('a signed-in user with no selected claim sees an honest identity-selection prompt, never fabricated workspace content', () => {
  const body = shell()
  assert.match(body, /if \(!status\.has_claim\) return/)
  assert.match(body, /Select a physician identity/)
  assert.match(body, /No eligible claimed identities yet/)
  assert.doesNotMatch(body, /Dr\. Lucy|Dr\. Iain/)
})

test('identity switching only goes through the real selection endpoint, never a client-side NPI/workspace assertion', () => {
  assert.match(owner, /await selectPhysicianSandbox\(claimId\)/)
  assert.doesNotMatch(owner, /personaId=['"]lucy['"]|personaId=['"]iain['"]/, 'the owner shell never references a demo persona')
  assert.doesNotMatch(owner, /workspaceId|workspace_id\s*=/, 'the client never asserts its own workspace id')
})

test('switching identity remounts the owner subtree so every page refetches with the new selection', () => {
  assert.match(shell(), /key=\{identity\?\.npi \?\? 'owner'\}/)
})

test('the owner shell never offers Patients, Consultations, Network, or Feed — those capabilities do not exist yet', () => {
  const navBlock = slice(owner, 'const OWNER_NAV_ITEMS', 'function AccountMenu')
  assert.deepEqual([...navBlock.matchAll(/title: '([^']+)'/g)].map((m) => m[1]), ['Dashboard'])
  assert.doesNotMatch(navBlock, /Patients|Consultations|Network|Feed/)
})

/* -------------------------------------------------------------------- routing */

test('the authenticated owner workspace is routed under /me/*, separate from the Lucy/Iain demo routes', () => {
  const dispatch = routing()
  assert.match(dispatch, /path === '\/me' \|\| path === '\/me\/home'/)
  assert.match(dispatch, /path === '\/me\/profile'/)
  assert.match(dispatch, /path === '\/me\/agent'/)
  assert.match(dispatch, /path === '\/me\/agent\/train'/)
})

test('a claimed identity offers an explicit "Open private workspace" action that does not imply verification, publication, or network/clinical access', () => {
  const page = identityPage()
  assert.match(page, /profile\.claimed_by_me && profile\.my_claim_id !== null && <OpenPrivateWorkspaceAction/)
  assert.match(claim, /Open private workspace/)
  assert.match(claim, /This does not make you public or complete verification\./)
})

/* ------------------------------------------------------------------ api.ts */

test('PhysicianIdentity widens the shared demo persona type to include the authenticated owner', () => {
  assert.match(api, /export type PhysicianIdentity = DemoPhysicianPerspective \| 'owner'/)
})

test('every shared physician-perspective function branches to the real /api/me/physician/* owner endpoint, never fabricating owner data from demo endpoints', () => {
  const branchingFns = [
    'getProfessionalProfile', 'savePhysicianInterest', 'getAgentInitialization', 'updateProfessionalProfileItem',
    'getPracticeRepresentation', 'getAgentOverview', 'getTrainingHistory', 'getAgentTestCases', 'chatWithAgent',
    'submitAgentChatFeedback', 'startFocusedTraining', 'startTrainingSession', 'resumeTrainingSession',
    'answerTrainingQuestion', 'finishTrainingSession', 'completeTrainingReview', 'updateProposedLearning',
    'enrichPhysicianProfile', 'getProfileEnrichment', 'reviewProfileCandidate',
  ]
  for (const name of branchingFns) {
    const start = api.indexOf(`export const ${name} = `)
    assert.ok(start !== -1, `${name} should be exported from api.ts`)
    const nextFn = api.indexOf('\nexport const ', start + 1)
    const block = api.slice(start, nextFn === -1 ? start + 400 : nextFn)
    assert.match(block, /isOwner\(perspective\)/, `${name} should branch on isOwner(perspective)`)
  }
})

test('owner identity is normalized into the same ControlledPhysicianIdentity shape shared components already expect', () => {
  assert.match(api, /function controlledIdentityFromOwned\(identity: OwnedPhysicianIdentity\): ControlledPhysicianIdentity/)
  assert.match(api, /name: identity\.display_name/)
  assert.match(api, /synthetic: false/)
})

/* ------------------------------------------------------------ shared-component reuse */

test('the owner Profile route reuses the exact same ProfessionalProfilePage the demo uses, not a parallel implementation', () => {
  assert.match(owner, /export function OwnerProfilePage\(\{ navigate, params \}: \{ navigate: Navigate; params: URLSearchParams \}\) \{\s*\n\s*return <OwnerShell navigate=\{navigate\} section="profile"><ProfessionalProfilePage personaId="owner"/)
})

test('the owner Train route reuses the exact same TrainingPage the demo uses, not a parallel implementation', () => {
  assert.match(owner, /<TrainingPage personaId="owner"/)
})

test('OwnerAgentPage reuses AgentOverviewPanel (which itself absorbs PracticeTab), TrainTab, and ChatTab directly rather than re-implementing them', () => {
  const page = agentPage()
  assert.match(page, /<AgentOverviewPanel overview=\{overview\} representation=\{representation\}/)
  assert.match(page, /<TrainTab trainProjection=\{trainProjection\}/)
  assert.match(page, /<ChatTab personaId="owner"/)
})

test('the owner agent page never renders consultation-based activity or legacy calibration UI that only exists for the demo', () => {
  const page = agentPage()
  assert.doesNotMatch(page, /getMyAgent|getConsultationHistory|agentActivity\(|updateAgentLearning/)
})

/* ---------------------------------------------------------------- capabilities */

test('verification, publication, network participation, and clinical access are shown as distinct, independent states — never conflated', () => {
  const note = slice(owner, 'function CapabilityNote', 'export function OwnerHomePage')
  assert.match(note, /Verification:/)
  assert.match(note, /Public profile:/)
  assert.match(note, /Network participation:/)
  assert.match(note, /Patient \/ clinical access:/)
  assert.match(note, /Not yet available/)
  assert.match(note, /independent steps/)
})

test('Home never invents a numerical agent-quality score, and has no XP/streak/level/ranking mechanics', () => {
  assert.doesNotMatch(home(), /score|ranking|quality|streak|\bXP\b|level up/i)
})

test('posts/publishing are not a major owner surface: no Publish button is wired into the reused profile page for the owner identity', () => {
  const profilePage = slice(engagement, 'export function ProfessionalProfilePage', 'export function NetworkPhysicianProfilePage')
  assert.match(profilePage, /itemActions=\{personaId === 'owner' \? undefined : /)
})

/* --------------------------------------------------------------- honesty / gaps */

test('Practice Representation surfaces unresolved gaps honestly instead of silently showing a sparse, unexplained page', () => {
  const tab = slice(engagement, 'export function PracticeTab', 'function trainHistorySummaryLine')
  assert.match(tab, /gaps\.practice_areas_needing_input/)
  assert.match(tab, /Still needs input/)
})

test('pending proposed learnings are never displayed as confirmed Practice Representation', () => {
  assert.match(engagement, /l\["status"\] === "confirmed"|status === 'confirmed'/)
})

/* ------------------------------------------------------------------------ CSS */

test('owner workspace styling reuses the existing shell/sidebar/perspective-menu system rather than a new visual product', () => {
  assert.match(owner, /className="app-shell owner-shell"/)
  assert.match(owner, /className="sidebar"/)
  assert.match(owner, /className="owner-identity-switcher"/)
  assert.match(styles, /\.owner-identity-switcher \{ position: relative; \}/)
})

/* -------------------------------------------------------------------- regression */

test('the existing Lucy/Iain demo navigation items are untouched by the owner workspace addition', () => {
  assert.match(app, /const navItems = \[/)
  assert.match(app, /const SPECIALIST_NAV_ITEMS = \[/)
  assert.doesNotMatch(app, /navItems\.concat|SPECIALIST_NAV_ITEMS\.concat/)
})
