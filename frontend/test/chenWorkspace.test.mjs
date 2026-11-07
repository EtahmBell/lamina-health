import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'

const app = readFileSync(new URL('../src/App.tsx', import.meta.url), 'utf8')
const referralSource = readFileSync(new URL('../src/Referral.tsx', import.meta.url), 'utf8')
const engagement = readFileSync(new URL('../src/Engagement.tsx', import.meta.url), 'utf8')
const demoPatients = readFileSync(new URL('../src/demoPatients.ts', import.meta.url), 'utf8')
const styles = readFileSync(new URL('../src/styles.css', import.meta.url), 'utf8')

const slice = (source, from, to) => source.slice(source.indexOf(from), to !== undefined ? source.indexOf(to) : undefined)
const routing = () => slice(app, 'export default function App', app.length)

/* ----------------------------------------------------- Part A/O: navigation */

test('Chen sidebar shows Dashboard, Patients, and Network -- the same standard three-item navigation Lucy has', () => {
  const navBlock = slice(app, 'const CHEN_NAV_ITEMS', 'const DEMO_PERSPECTIVES')
  assert.match(navBlock, /\{ id: 'chen-home', title: 'Dashboard', icon: '⌂', path: '\/chen\/home' \}/)
  assert.match(navBlock, /\{ id: 'chen-patients', title: 'Patients', icon: '✦', path: '\/chen\/patients' \}/)
  assert.match(navBlock, /\{ id: 'chen-network', title: 'Network', icon: <NetworkNavIcon \/>, path: '\/chen\/network' \}/)
})

test('Chen reaches his agent through the "Your Agent" primary nav item, same as Lucy (specialist agent-first pass)', () => {
  const nav = slice(app, 'const CHEN_NAV_ITEMS', 'const DEMO_PERSPECTIVES')
  assert.ok(nav.includes("{ id: 'chen-agent', title: 'Your Agent', icon: <AgentNavIcon />, path: '/chen/agent?tab=overview' }"))
})

test('Chen Profile is reached via the avatar menu\'s profilePath, the same convention as Lucy\'s and Iain\'s -- not a sidebar nav item', () => {
  const navBlock = slice(app, 'const CHEN_NAV_ITEMS', 'const DEMO_PERSPECTIVES')
  assert.doesNotMatch(navBlock, /Profile/)
  assert.match(app, /profilePath: '\/chen\/profile'/)
})

test('all five Chen workspace routes are registered: Dashboard, Patients, Patient Detail, Network, Agent, Profile', () => {
  const dispatch = routing()
  assert.match(dispatch, /path === '\/chen' \|\| path === '\/chen\/home'/)
  assert.match(dispatch, /path === '\/chen\/patients'\)/)
  assert.match(dispatch, /path === '\/chen\/network'\)/)
  assert.match(dispatch, /path === '\/chen\/agent'\)/)
  assert.match(dispatch, /path === '\/chen\/profile'/)
})

test('Lucy\'s workspace keeps its Dashboard, Patients and Network routes (physician-agent home pass adds For you and Your Agent around them)', () => {
  for (const item of ["{ id: 'home', title: 'Dashboard', icon: '⌂', path: '/home' }", "{ id: 'patients', title: 'Patients', icon: '✦', path: '/patients' }", "{ id: 'network', title: 'Network', icon: <NetworkNavIcon />, path: '/network' }"]) {
    assert.ok(app.includes(item), item)
  }
  assert.match(routing(), /path === '\/home'\) return <HomePage/)
})

test('Iain\'s specialist routes/nav remain valid and untouched (he is simply no longer the switcher\'s secondary entry)', () => {
  const dispatch = routing()
  assert.match(dispatch, /path === '\/specialist' \|\| path === '\/specialist\/home'/)
  assert.match(app, /const SPECIALIST_NAV_ITEMS = \[/)
})

/* ------------------------------------------------------------- Part B: Dashboard */

test('Chen\'s Dashboard is the same agent-first Dashboard as Lucy\'s -- greeting, agent status, briefing, Needs you, While you were away -- populated with his own data (specialist agent-first pass)', () => {
  assert.ok(app.includes('<ProductShell navigate={navigate} section="chen-home" perspective="chen" agentDock><AgentDashboard navigate={navigate} persona="chen" /></ProductShell>'))
  assert.doesNotMatch(referralSource, /export function ChenHomePage/, 'the old Chen-only Dashboard is retired, not stacked under the new one')
})

test('a new referral on Chen\'s Dashboard is that patient\'s Needs-you item, built from the real submitted-referral data and opening the same RequestReviewModal -- never a duplicate fixture (specialist agent-first pass)', () => {
  const home = readFileSync(new URL('../src/AgentHome.tsx', import.meta.url), 'utf8')
  assert.ok(home.includes("getPhysicianReferrals(CHEN_ID, 'submitted')"))
  assert.ok(home.includes('specialistNextSteps(data.incoming, accepted, data.careState, now, PCP_NAME)'))
  assert.ok(home.includes("item.kind === 'incoming_referral' ? incoming.find((candidate) => candidate.id === item.referralId)"))
  assert.ok(home.includes('<RequestReviewModal referral={reviewing} receivingPhysicianName={CHEN_NAME} onAccepted={handleAccepted} onClose={() => setReviewing(null)} />'))
  assert.doesNotMatch(home, /submitted-fixture|fakeReferral|mockReferral/i)
})

/* ============================================================= Tonjit demo-
 * story / bug-fix pass, Part A-C: the Dashboard worklist must also surface
 * an accepted referral with an outstanding action, ranked above the static
 * seeded roster while a handoff review is pending, but demoted back to
 * ordinary priority once sent -- never a permanent-residency guarantee.
 * =========================================================================== */

test('Chen\'s queue merges accepted-or-later referrals from their real encounter/handoff state -- the same step builder, now pure in specialistWorklist.ts', () => {
  const home = readFileSync(new URL('../src/AgentHome.tsx', import.meta.url), 'utf8')
  assert.ok(home.includes('getPhysicianReferrals(CHEN_ID)'))
  assert.ok(home.includes("['accepted', 'scheduled', 'consult_returned'].includes(referral.status)"))
  assert.ok(home.includes('getEncounter(referral.id).catch(() => null), getHandoff(referral.id, CHEN_ID).catch(() => null)'))
  const worklistSource = readFileSync(new URL('../src/specialistWorklist.ts', import.meta.url), 'utf8')
  const builder = worklistSource.slice(worklistSource.indexOf('export function specialistNextSteps'))
  assert.match(builder, /acceptedReferralStep\(referral, \{/)
  assert.match(builder, /referralReviewStep\(referral, now, referringName\)/)
  assert.match(builder, /\.\.\.seeded/)
})

test('a pending "Review handoff" is a physician-judgment Needs-you item for Chen -- from real handoff state, never a hard-coded rank or patient id', () => {
  const queue = readFileSync(new URL('../src/physicianQueue.ts', import.meta.url), 'utf8')
  assert.ok(queue.includes("if (step.kind === 'review_handoff') {"))
  assert.doesNotMatch(queue, /TONJIT_ID|patient-t2dm-003/)
})

test('once a handoff is sent the referral leaves Chen\'s queue, and no patient is ever pinned to the Dashboard by id', () => {
  const worklist = readFileSync(new URL('../src/specialistWorklist.ts', import.meta.url), 'utf8')
  assert.match(worklist, /if \(state\.handoffStatus === 'sent'\) return null/)
  const home = readFileSync(new URL('../src/AgentHome.tsx', import.meta.url), 'utf8')
  assert.doesNotMatch(home, /patient\.id === TONJIT_ID|patient_id === TONJIT_ID|patientId === TONJIT_ID/)
})

test('Chen\'s Dashboard never shows fake Needs-you rows when there are none', () => {
  const home = readFileSync(new URL('../src/AgentHome.tsx', import.meta.url), 'utf8')
  assert.ok(home.includes('{top.length > 0 && <section className="agent-needs" aria-label="Needs you">'))
})

/* ---------------------------------------------------- Part C/D/E: seeded patients */

test('Chen\'s seeded patient roster has exactly six entries, tagged owner: \'chen\', and Tonjit is never one of them', () => {
  const chenBlock = slice(demoPatients, "owner: 'chen'")
  const ownerMatches = demoPatients.match(/owner: 'chen'/g) ?? []
  assert.equal(ownerMatches.length, 6)
  assert.doesNotMatch(demoPatients, /id: 'patient-t2dm-003'[\s\S]{0,400}owner: 'chen'/)
  assert.match(demoPatients, /export const CHEN_PATIENT_IDS = DEMO_PATIENTS\.filter\(\(patient\) => patient\.owner === 'chen'\)\.map\(\(patient\) => patient\.id\)/)
  void chenBlock
})

test('seeded patients are excluded from Lucy\'s own Patients page, watch rows, and roster count badge', () => {
  assert.match(app, /const visible = DEMO_PATIENTS\.filter\(\(patient\) => patient\.owner !== 'chen' && /)
  assert.match(app, /DEMO_PATIENTS\.filter\(\(patient\) => patient\.implemented && patient\.owner !== 'chen'\)/)
  assert.match(app, /\{DEMO_PATIENTS\.filter\(\(patient\) => patient\.owner !== 'chen'\)\.length\} synthetic patients/)
})

test('the Chen Patient Detail route accepts any of the six seeded ids, in addition to an accepted Tonjit', () => {
  const dispatch = routing()
  assert.match(dispatch, /chenPatientId === TONJIT_ID \|\| \(chenPatientId && CHEN_PATIENT_IDS\.includes\(chenPatientId\)\)\)/)
})

/* -------------------------------------------------------------- Part F: Patients */

test('ChenPatientsPage supports search, active/previous grouping, and the existing WorklistRows rendering -- same maturity as Lucy\'s', () => {
  const fn = slice(referralSource, 'export function ChenPatientsPage', 'export function ChenHomePage')
  assert.match(fn, /className="patient-search"/)
  assert.match(fn, /<section className="patient-worklist-section">\s*\n\s*<div className="home-section-heading"><h2>Active patients<\/h2>/)
  assert.match(fn, /<h2>Previous care<\/h2>/)
  assert.match(fn, /<WorklistRows rows=\{active\} navigate=\{navigate\} basePath="\/chen\/patients" highlightIds=\{highlighted\} \/>/)
})

test('on Patients, an incoming referral is a row in the same list (opening the review in place) -- never a separate header control', () => {
  const fn = slice(referralSource, 'export function ChenPatientsPage', 'export function ChenHomePage')
  const headerBlock = slice(fn, '<header className="selector-header">', '</header>')
  assert.doesNotMatch(headerBlock, /IncomingRequestsControl/)
  assert.match(fn, /nextStep: 'Review referral', priority: -3, updated: null, onOpen: \(\) => setReviewing\(referral\)/)
  assert.match(fn, /const rows = \[\.\.\.incomingRows, \.\.\.acceptedRows, \.\.\.seededRows\]/)
})

test('seeded-patient stage copy is reframed for an established specialist practice, reusing the existing PatientStage vocabulary (no new enum)', () => {
  const fn = slice(referralSource, 'const CHEN_PATIENT_STAGE_META', 'const CHEN_PREVIOUS_CARE_PRIORITY')
  assert.match(fn, /Record<PatientStage, \{ label: string; tone: string; nextStep: string; priority: number \}>/)
  assert.match(fn, /'Ready for review'/)
  assert.match(fn, /'Awaiting workup'/)
  assert.match(fn, /'Follow-up scheduled'/)
})

/* ----------------------------------------------------- Part G: Patient Detail */

test('Chen\'s pre-existing patients get a lightweight "in your care" status card, never a fabricated specialist-treatment workflow', () => {
  const fn = slice(app, 'function ReceivingReferralCard', 'function PatientWorkspace')
  assert.match(fn, /In your care/)
  assert.match(fn, /demoPatient\?\.reason \?\? 'Established patient'/)
  assert.match(fn, /demoPatient\?\.stageNote \?\? 'Continue care as appropriate\.'/)
})

/* ------------------------------------------------------------ Part H: My Agent */

test('/chen/agent uses Chen\'s own real identity/representation data, never Lucy\'s or Iain\'s', () => {
  const fn = slice(referralSource, 'export function ChenAgentPage', 'export function ChenNetworkPage')
  assert.match(fn, /getPracticeRepresentation\('chen'\)/)
  assert.match(fn, /getAgentOverview\('chen'\)/)
  assert.match(fn, /getTrainingHistory\('chen'\)/)
  assert.match(fn, /<h1>\{agentName\}<\/h1>/)
  assert.match(fn, /\{CHEN_SPECIALTY\} · Represents your practice/)
})

test('/chen/agent reuses the exact same Overview/Train/Test tabs and shared panels as Lucy\'s and Iain\'s My Agent -- no Chen-specific version', () => {
  const fn = slice(referralSource, 'export function ChenAgentPage', 'export function ChenNetworkPage')
  assert.match(fn, /<AgentOverviewPanel overview=\{overview\} representation=\{representation\} navigate=\{navigate\} trainPath=\{trainingPath\('chen'\)\} personaId="chen" onRepresentationChanged=/)
  assert.match(fn, /<TrainTab trainProjection=\{trainProjection\} navigate=\{navigate\} trainPath=\{trainingPath\('chen'\)\} personaId="chen" learningOpportunities=\{overview\.learning_opportunities\} focusId=\{params\?\.get\('focus'\) \?\? null\}/)
  assert.match(fn, /<ChatTab personaId="chen" agentName=\{agentName\} navigate=\{navigate\} trainPath=\{trainingPath\('chen'\)\} \/>/)
  assert.doesNotMatch(referralSource, /function ChenOverviewPanel|function ChenTrainTab|function ChenChatTab/)
})

/* ------------------------------------------------------------- Part J: Network */

test('/chen/network is the shared PhysicianNetworkPage (Colleagues + Feed), with no Chen-specific Network fork left', () => {
  assert.doesNotMatch(referralSource, /function ChenNetworkPage|function ChenMyNetworkTab/)
  const shared = readFileSync(new URL('../src/PhysicianNetwork.tsx', import.meta.url), 'utf8').replaceAll(String.fromCharCode(13), '')
  const fn = slice(shared, 'export function PhysicianNetworkPage', '/** UX polish pass, Part A/B')
  assert.match(fn, /<NetworkTabs tab=\{tab\} onSelect=\{selectTab\} \/>/)
  assert.match(fn, /const \[tab, setTab\] = useState<NetworkTab>\(tabParam === 'feed' \? 'feed' : 'my-network'\)/)
  assert.match(fn, /<MyNetworkTab navigate=\{navigate\} perspective=\{perspective\} onViewInFeed=\{viewInFeed\} \/>/)
  assert.match(fn, /<NetworkFeedTab personaId=\{perspective\} navigate=\{navigate\}/)
})

test('Colleagues routes resolve inside the viewer\'s own perspective (networkProfilePath(perspective, ...)), never Lucy\'s', () => {
  const shared = readFileSync(new URL('../src/PhysicianNetwork.tsx', import.meta.url), 'utf8')
  assert.match(shared, /navigate\(persona \? networkProfilePath\(perspective, persona\) : directoryProfilePath\(perspective, suggestion\.npi\)\)/)
  assert.match(shared, /navigate\(directoryProfilePath\(perspective, member\.npi\)\)/)
})

/* ------------------------------------------------------------ Part K: identity audit */

test('the shared chat starter prompts no longer hardcode a nephrology/cardiology-specific question -- generic wording works for any specialty, including Chen\'s', () => {
  assert.doesNotMatch(engagement, /nephrology over cardiology/i)
  assert.match(engagement, /What makes a case a good fit for my practice\?/)
})

test('backend portrait/generated-question fallbacks are generic per-persona, never hardcoded to assume every non-Lucy physician is Iain', () => {
  const backendEngagement = readFileSync(new URL('../../backend/engagement.py', import.meta.url), 'utf8')
  const backendAgentExperience = readFileSync(new URL('../../backend/agent_experience.py', import.meta.url), 'utf8')
  assert.match(backendAgentExperience, /elif persona_id == "iain":/)
  assert.match(backendAgentExperience, /physician = PHYSICIANS_BY_ID\[PERSONAS\[persona_id\]\["physician_id"\]\]/)
  assert.match(backendEngagement, /elif persona_id == "iain":\s*\n\s*practice = "nephrology"/)
  assert.match(backendEngagement, /practice = PERSONAS\[persona_id\]\["specialty"\]\.lower\(\)/)
})

test('Chen has his own real PERSONAS/DEMO_ENRICHMENT/BASE_PROFILE_ITEMS/TRAINING_QUESTIONS entries so shared engagement endpoints never crash or fall back to someone else\'s identity', () => {
  const backendEngagement = readFileSync(new URL('../../backend/engagement.py', import.meta.url), 'utf8')
  const backendProfessionalServices = readFileSync(new URL('../../backend/professional_services.py', import.meta.url), 'utf8')
  assert.match(backendEngagement, /"chen": \{\s*\n\s*"id": "chen",\s*\n\s*"physician_id": "physician-chen",/)
  assert.match(backendEngagement, /EDITABLE_PERSONAS = \{"lucy", "iain", "chen"\}/)
  // Demo coherence pass, Part L: Chen's TRAINING_QUESTIONS entry is no
  // longer deliberately empty -- it now carries one real canonical-case
  // question -- but it must still be a real, present dict key (never a
  // missing one that would KeyError).
  assert.match(backendEngagement, /TRAINING_QUESTIONS: dict\[str, list\[dict\[str, Any\]\]\] = \{[\s\S]*?"chen": \[/, 'TRAINING_QUESTIONS has a real chen entry')
  assert.match(backendProfessionalServices, /"chen": \[\s*\n\s*\("training", "Synthetic endocrinology training background"\),/)
})

/* ================================================================= Part 12
 * (demo-consolidation pass) Chen's Dashboard had the Patients section
 * flush against the agent banner above it -- the adjacent-sibling margin
 * rule (`.patient-worklist-section + .patient-worklist-section`) never
 * applies to the FIRST such section on the page, only later ones. Fixed by
 * a dashboard-page-scoped rule so Lucy's PatientSelector/ChenPatientsPage
 * (which reuse the same class but are not `.dashboard-page`) are untouched.
 * ===================================================================== */

test('ChenHomePage\'s Patients section matches the same 36px section-spacing rhythm used elsewhere, via a .dashboard-page-scoped rule -- not a redesign', () => {
  assert.match(styles, /\.dashboard-page \.patient-worklist-section \{ margin-top: var\(--section-space\); \}/)
})

test('the dashboard-page spacing fix is scoped narrowly -- it never touches PatientSelector/ChenPatientsPage, which reuse .patient-worklist-section but are not .dashboard-page', () => {
  assert.doesNotMatch(app, /className="dashboard-page[^"]*"[\s\S]{0,4000}export function ChenPatientsPage/, 'ChenPatientsPage must not itself be wrapped in .dashboard-page')
})
