import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'

const app = readFileSync(new URL('../src/App.tsx', import.meta.url), 'utf8')
const specialist = readFileSync(new URL('../src/Specialist.tsx', import.meta.url), 'utf8')
const api = readFileSync(new URL('../src/api.ts', import.meta.url), 'utf8')
const styles = readFileSync(new URL('../src/styles.css', import.meta.url), 'utf8')
const slice = (source, from, to) => source.slice(source.indexOf(from), source.indexOf(to))

const shell = () => slice(app, 'function ProductShell', 'function LandingPage')
const perspectiveSwitch = () => slice(app, 'function PerspectiveSwitch', 'function PortalAccountControl')
const routing = () => slice(app, 'export default function App', app.length)
const home = () => slice(specialist, 'export function SpecialistHomePage', 'function SpecialistCaseListRow')
const cases = () => slice(specialist, 'function SpecialistCaseListRow', 'export function SpecialistCaseDetailPage')
const detail = () => slice(specialist, 'export function SpecialistCaseDetailPage', 'export function SpecialistAgentPage')
const agentPage = () => slice(specialist, 'export function SpecialistAgentPage', specialist.length)

/* ----------------------------------------------------------- §47 routing */

test('specialist routes are registered in the SPA dispatcher', () => {
  const dispatch = routing()
  assert.match(dispatch, /path === '\/specialist' \|\| path === '\/specialist\/home'/)
  assert.match(dispatch, /path === '\/specialist\/cases'/)
  assert.match(dispatch, /\/\^\\\/specialist\\\/cases\\\/\(\\d\+\)\$\//)
  assert.match(dispatch, /path === '\/specialist\/agent'/)
  assert.match(dispatch, /perspective="specialist"/)
})

test('direct case-id routes use the consultation_record_id, not the canonical consultation_id', () => {
  assert.match(app, /specialistRecordId.*=.*path\.match\(\/\^\\\/specialist\\\/cases\\\/\(\\d\+\)\$\/\)/)
  assert.match(specialist, /export const specialistCasePath = \(recordId: number\) => `\/specialist\/cases\/\$\{recordId\}`/)
})

test('the perspective switch is the existing clinician pill, now a menu — not a new giant toggle', () => {
  const control = perspectiveSwitch()
  assert.match(control, /className="profile-control"/)
  assert.match(control, /aria-haspopup="menu"/)
  assert.match(control, /role="menu"/)
  assert.match(control, /Demo perspective/)
})

test('switching perspective only navigates — it never creates or resets a workspace', () => {
  const control = perspectiveSwitch()
  assert.match(control, /switchTo = \(path: string\) => \{ setOpen\(false\); navigate\(path\) \}/)
  assert.doesNotMatch(control, /resetJordanDemo|fetch\(|request\(/)
})

test('Lucy switches to /specialist/home and Iain switches to /home', () => {
  assert.match(app, /id: 'pcp' as const.*path: '\/home'/)
  assert.match(app, /id: 'specialist' as const.*path: '\/specialist\/home'/)
})

test('no client-selectable specialist persona exists anywhere in the frontend', () => {
  assert.doesNotMatch(app + specialist, /specialist_npi|specialistNpi|X-Specialist-NPI/i)
  assert.doesNotMatch(api, /specialist_npi=|specialistNpi/i)
  // every specialist API call takes no identity parameter — the backend controls it
  assert.match(api, /export const getSpecialistWorkspace = \(\) => request<SpecialistWorkspace>\('\/api\/workspace\/specialist'\)/)
  assert.match(api, /export const getSpecialistCases = \(\) => request<SpecialistCaseSummary\[\]>\('\/api\/workspace\/specialist\/cases'\)/)
})

test('profile access is preserved for Lucy and not fabricated for Iain', () => {
  const control = perspectiveSwitch()
  assert.match(control, /perspective === 'pcp' && <><div className="perspective-menu-divider"[\s\S]*navigate\('\/profile'\)/)
})

test('the demo perspective menu never references Supabase auth or identity claiming', () => {
  const control = perspectiveSwitch()
  assert.doesNotMatch(control, /useAuth|claim|Supabase/i)
})

test('PCP shell navigation and Lucy sidebar card are unchanged aside from the header control', () => {
  assert.match(shell(), /const items = perspective === 'specialist' \? SPECIALIST_NAV_ITEMS : navItems/)
  assert.match(shell(), /items\.map/)
  assert.match(shell(), /Active · Primary Care/)
})

test('specialist shell has Home, Cases, My Agent — no Patients, no Network', () => {
  const navBlock = slice(app, 'const SPECIALIST_NAV_ITEMS', 'function ProfileControl')
  assert.deepEqual(navBlock.match(/title: '[^']+'/g), ["title: 'Home'", "title: 'Cases'", "title: 'My Agent'"])
  assert.doesNotMatch(navBlock, /Patients|Physician Network/)
})

test('the specialist sidebar card never claims Active status for a reserved provider', () => {
  assert.match(shell(), /Synthetic demo profile · \{SPECIALIST_SPECIALTY\}/)
  assert.doesNotMatch(shell(), /perspective === 'specialist'[\s\S]{0,400}Active/)
})

/* -------------------------------------------------------------- §48 cases */

test('specialist cases render directly from the backend projection, with no client-side case injection', () => {
  const page = cases()
  assert.match(page, /getSpecialistCases\(\)\.then\(setCases\)/)
  assert.doesNotMatch(page, /DEMO_PATIENTS|JORDAN_ID|MARIA_ID/)
})

test('cases page groups by the canonical reviewed state only', () => {
  const page = cases()
  assert.match(page, /const needsReview = \(cases \?\? \[\]\)\.filter\(\(item\) => !item\.reviewed\)/)
  assert.match(page, /const reviewed = \(cases \?\? \[\]\)\.filter\(\(item\) => item\.reviewed\)/)
  assert.match(page, /group\('Needs review', needsReview\)/)
  assert.match(page, /group\('Reviewed', reviewed\)/)
})

test('case rows show referring physician and outcome from backend fields, not "your patients" framing', () => {
  const page = cases()
  assert.match(page, /Network consultation from \{item\.referring_physician\}/)
  assert.match(page, /<OutcomeBadge outcome=\{item\.specialist_outcome\} \/>/)
  assert.doesNotMatch(specialist, /[Yy]our patients/)
})

test('pristine and Maria-only both resolve to the same honest empty state, never a fabricated case', () => {
  const page = cases()
  assert.match(page, /No network cases yet/)
  assert.match(page, /SwitchToLucyHelper/)
})

/* ------------------------------------------------------------- §49 detail */

test('case detail hierarchy matches the specified order', () => {
  const page = detail()
  const order = ['Why your agent was consulted', 'What your agent received', 'What your agent said', 'Network outcome', 'Review your agent', 'network-transparency']
  const positions = order.map((token) => page.indexOf(token))
  assert.ok(positions.every((p) => p > 0), `missing one of ${order.join(', ')}`)
  assert.deepEqual(positions, [...positions].sort((a, b) => a - b))
})

test('bounded "what your agent received" context is rendered from agent_received, not the full PCP clinical overview', () => {
  const page = detail()
  assert.match(page, /detail\.agent_received\.summary/)
  assert.match(page, /detail\.agent_received\.facts/)
  assert.match(page, /detail\.agent_received\.signals/)
  assert.match(page, /Bounded clinical context provided to your agent for this network consultation\./)
  assert.doesNotMatch(page, /clinical-overview|clinicalTrends|labFlowsheet/)
})

test('what-your-agent-said reflects canonical fit, workup, and access fields', () => {
  const page = detail()
  assert.match(page, /detail\.agent_response\.fit/)
  assert.match(page, /detail\.agent_response\.required_workup/)
  assert.match(page, /detail\.agent_response\.access/)
  assert.doesNotMatch(page, /'BMP'|'UPCR'|'Approximately 8 days'/, 'specifics come from the API response, never hardcoded')
})

test('clarifications only render when clarification_count is positive, and never fabricate another agent\'s clarification', () => {
  const page = detail()
  assert.match(page, /clarifications\.length > 0/)
  assert.match(page, /detail\.agent_response\.interactions\.filter/)
  assert.doesNotMatch(page, /Onadeko/)
})

test('network outcome language distinguishes recommendation from a submitted referral', () => {
  const page = detail()
  assert.match(page, /Network recommendation · referral not yet submitted/)
  assert.doesNotMatch(page, /Referral received|Incoming referral|Referred to you|New referral/)
})

test('outcome labels are calm and descriptive, never styled as a quality score', () => {
  const labelBlock = slice(specialist, 'export const SPECIALIST_OUTCOME_LABELS', 'function OutcomeBadge')
  assert.match(labelBlock, /recommended: 'Recommended'/)
  assert.match(labelBlock, /alternative: 'Alternative'/)
  assert.match(labelBlock, /redirected: 'Redirected'/)
  assert.match(labelBlock, /consulted_not_selected: 'Consulted · not selected'/)
  assert.doesNotMatch(labelBlock, /score|ranking/i)
})

test('network context is compact, static, and collapsed by default — never the live animated graph', () => {
  const page = detail()
  assert.match(page, /const \[networkOpen, setNetworkOpen\] = useState\(false\)/)
  assert.doesNotMatch(page, /ConsultationNetwork|consulting=/)
})

/* ---------------------------------------------------- §50 review/calibration */

test('opening a case never auto-marks it reviewed', () => {
  const page = detail()
  const loadEffect = slice(page, 'const load = ()', 'const markReviewed')
  assert.doesNotMatch(loadEffect, /markSpecialistCaseReviewed/)
})

test('Yes calls the real backend review endpoint', () => {
  const page = detail()
  assert.match(page, /const markReviewed = async \(\) => \{[\s\S]*await markSpecialistCaseReviewed\(recordId\)/)
  assert.match(page, /onClick=\{markReviewed\}>Yes</)
})

test('Not quite opens calibration using the backend-provided proposal, not a second local state model', () => {
  const page = detail()
  assert.match(page, /onClick=\{\(\) => setCalibrationOpen\(true\)\}>Not quite/)
  assert.match(page, /const calibration = detail\.calibration/)
})

test('confirm/edit/reject call the real calibration endpoint and then mark the case reviewed', () => {
  const page = detail()
  const act = slice(page, 'const act = async', 'if (notFound) return')
  assert.match(act, /await updateSpecialistCalibration\(recordId, detail\.calibration\.key, action, statement\)/)
  assert.match(act, /await markSpecialistCaseReviewed\(recordId\)/)
})

test('calibration card visibility keys off whether the specialist acted, not the raw "suggested" status (edit keeps status suggested)', () => {
  const page = detail()
  assert.match(page, /calibration\.updated_at !== null/)
})

test('specialist feedback never touches the PCP My Agent calibration state', () => {
  assert.doesNotMatch(specialist, /updateAgentLearning|workflowStore|PCP_AGENT_ID/)
})

test('a 404 case renders "Case unavailable" without leaking cross-workspace existence', () => {
  const page = detail()
  assert.match(page, /if \(err instanceof ApiError && err\.status === 404\) setNotFound\(true\)/)
  const notFoundRender = slice(page, 'if (notFound) return', 'if (error) return')
  assert.match(notFoundRender, /Case unavailable/)
  assert.doesNotMatch(notFoundRender, /err\.message|\{error\}/)
})

/* -------------------------------------------------------------- §51 agent */

test('specialist My Agent renders identity and status honestly from backend fields', () => {
  const page = agentPage()
  assert.match(page, /workspace\.physician\.agent_name/)
  assert.match(page, /Reserved synthetic profile/)
  assert.doesNotMatch(page, />Verified<|>Active physician<|Physician-authorized/)
})

test('specialist My Agent invents no unsupported practice facts', () => {
  const page = agentPage()
  assert.doesNotMatch(page, /insurance|privileges|affiliation|availability/i)
})

test('specialist My Agent shows recent case activity from real case data, not a global calibration dashboard', () => {
  const page = agentPage()
  assert.match(page, /getSpecialistCases\(\)\.then\(setCases\)/)
  assert.doesNotMatch(page, /calibration/i)
})

/* --------------------------------------------------------------- styles */

test('outcome badges are text-led and not color-only', () => {
  assert.match(styles, /\.specialist-outcome-badge \{[^}]*display: inline-flex/)
})

test('specialist responsive rules collapse the two-column layouts under 700px', () => {
  const block = [...styles.matchAll(/@media \(max-width: 700px\) \{([^]*?)\n\}/g)].map((m) => m[1]).join('\n')
  assert.match(block, /\.specialist-said-grid \{ grid-template-columns: 1fr; \}/)
  assert.match(block, /\.specialist-participant-row \{ grid-template-columns: 1fr; \}/)
})
