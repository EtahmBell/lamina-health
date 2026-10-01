import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'

const source = readFileSync(new URL('../src/App.tsx', import.meta.url), 'utf8')
const styles = readFileSync(new URL('../src/styles.css', import.meta.url), 'utf8')
const slice = (from, to) => source.slice(source.indexOf(from), source.indexOf(to))

const portal = () => slice('function LandingPage', 'function formatTime')
const shell = () => slice('function ProductShell', 'function LandingPage')
const home = () => slice('function HomePage', 'function PatientSelector')
const patients = () => slice('function PatientSelector', 'function ConsultationsPage')
const consultationsIndex = () => slice('function ConsultationsPage', 'function PatientConsultationsPage')
const myAgent = () => slice('function MyAgentPage', 'function ProfilePage')
const consultationLog = () => slice('function ConsultationLog', 'function RecommendationView')
const recommendation = () => slice('function RecommendationView', 'function PatientWorkspace')
const patientPage = () => slice('function PatientWorkspace', 'export default function App')

/* ------------------------------------------------------------------ portal */

test('root remains the portal and the portal circle enters Home', () => {
  assert.match(source, /if \(path === '\/'\) return <LandingPage navigate=\{navigate\} \/>/)
  assert.match(portal(), /navigate\('\/home'\)/)
  assert.match(portal(), /Enter workspace/)
  assert.doesNotMatch(portal(), /getConsultationHistory/)
})

test('the portal greeting is time-aware and the stale question is gone', () => {
  assert.match(portal(), /timeAwareGreeting\(PCP_NAME\)/)
  assert.doesNotMatch(source, /Who are we helping today\?/)
  assert.doesNotMatch(portal(), /Good (morning|afternoon|evening)/)
  assert.match(portal(), /Your agent is ready\./)
})

/* ------------------------------------------------------------------- shell */

test('workspace sidebar keeps Home as a dashboard destination', () => {
  const navigation = slice('const navItems', 'function ProfileControl')
  assert.deepEqual(navigation.match(/title: '[^']+'/g), [
    "title: 'Home'", "title: 'Patients'", "title: 'Consultations'", "title: 'My Agent'", "title: 'Physician Network'",
  ])
  assert.match(navigation, /title: 'Home'.*path: '\/home'/s)
})

test('workspace logo returns every shell screen to the portal', () => {
  assert.match(shell(), /className="brand-button" onClick=\{\(\) => navigate\('\/'\)\}/)
  assert.match(shell(), /aria-label="Return to Lamina portal"/)
})

test('workspace header keeps right controls without a generic page label', () => {
  assert.match(shell(), /className="workspace-bar-actions"><SyntheticStatus \/><ProfileControl navigate=\{navigate\} \/>/)
  assert.doesNotMatch(shell(), /section === 'home'/)
})

test('the sidebar physician-agent block is one clickable control into My Agent', () => {
  assert.match(shell(), /<button className="sidebar-clinician" onClick=\{\(\) => navigate\('\/agent\?tab=overview'\)\}/)
  assert.match(shell(), /aria-label=\{`Open \$\{PCP_AGENT_NAME\} overview`\}/)
  assert.match(styles, /\.sidebar-clinician:hover strong/)
})

/* -------------------------------------------------------------------- home */

test('Home is a titled work queue with no repeated greeting or patient directory', () => {
  assert.match(home(), /<h1>Home<\/h1>/)
  assert.doesNotMatch(home(), /Good (morning|afternoon|evening)/)
  assert.doesNotMatch(source, /physician workspace/i)
  assert.doesNotMatch(home(), /Recent patients|home-patients|getPatientActivity/)
  assert.match(home(), /Current work/)
  assert.doesNotMatch(home(), /Needs your attention/)
  assert.match(home(), /Recent agent activity/)
  assert.match(home(), /<p>Current work and recent agent activity\.<\/p>/, 'Home needs a quiet subtitle, not a greeting')
  assert.match(source, /className="button-primary home-start" onClick=\{\(\) => navigate\('\/patients'\)\}/)
})

test('the Home activity header links to all agent activity, not to consultations', () => {
  assert.match(home(), /onClick=\{\(\) => navigate\('\/agent\?tab=activity'\)\}>View all activity/)
  assert.doesNotMatch(home(), /View all consultations/)
  assert.match(home(), /'View interaction' : 'View consultation'/)
})

test('the Your Agent summary carries existing factual state only', () => {
  const card = home().slice(home().indexOf('home-agent-card'), home().indexOf('</aside>'))
  assert.match(card, /Last activity/)
  assert.match(card, /Proposed learnings/)
  assert.match(card, /awaiting your confirmation/)
  assert.match(card, /navigate\('\/agent\?tab=overview'\)/)
  assert.doesNotMatch(card, /Math\.|%|average|score|trend/i, 'no invented metrics')
})

test('Patients uses canonical consultation state rather than inferring from legacy activity', () => {
  assert.match(patients(), /record\?\.has_consultation/)
  assert.match(patients(), /record\?\.latest_consulted_at/)
  assert.doesNotMatch(patients(), /record\?\.last_consultation/)
})

test('Home activity carries timestamps and differentiates interactions from milestones', () => {
  assert.match(home(), /eventTimestamp\(item\.time\)/)
  assert.match(home(), /activityPath\(item\)/)
  assert.match(home(), /Agent interaction/)
  assert.match(home(), /Consultation milestone/)
  assert.match(home(), /activity-marker \$\{item\.kind\}/)
  assert.match(home(), /agentActivity\(ordered\)\.slice\(0, 3\)/)
})

test('the Home learning row opens Calibration, not the agent overview', () => {
  assert.match(home(), /agent learning\{pending\.length === 1/)
  assert.match(home(), /navigate\(calibrationPath\(\)\)/)
})

/* ---------------------------------------------------------- patient detail */

test('the editorial referral brief is gone from the patient page', () => {
  assert.doesNotMatch(source, /patient-monogram|brief-synthesis|decision-signals|clinical-question/)
  assert.doesNotMatch(source, /Specialty care referral brief/)
  assert.doesNotMatch(source, /Clinical question/)
  assert.doesNotMatch(source, /Progressive renal decline is occurring/)
  assert.doesNotMatch(source, /patient-row-avatar large/)
})

test('the patient page leads with a compact identity then the consult action', () => {
  const page = patientPage()
  const order = ['patient-identity', 'Ready to consult the network.', 'Agent task', 'Clinical overview']
  const positions = order.map((token) => page.indexOf(token))
  assert.ok(positions.every((position) => position > 0), `missing one of ${order.join(', ')}`)
  assert.deepEqual(positions, [...positions].sort((a, b) => a - b))
  assert.ok(page.includes('{patient.age} years · {patient.location}'))
  assert.match(page, /Anything your agent should consider\?/)
})

test('the clinical overview is built from available patient data only', () => {
  const page = patientPage()
  assert.match(page, /const trends = clinicalTrends\(patient\.labs\)/)
  assert.match(page, /trends\.domain && trends\.series\.length > 0/)
  assert.match(page, /<TrendChart /)
  for (const label of ['Problems', 'Current medications', 'Clinical trajectory', 'Latest relevant results', 'Recent relevant context', 'Care context']) {
    assert.match(page, new RegExp(label))
  }
  assert.match(page, /View source clinical data/)
  assert.match(page, /trends\.series\.length > 1 \? 'paired' : 'single'/, 'paired charts use the page width')
})

test('the source record is a readable table of every measurement, not mini-cards', () => {
  const page = patientPage()
  assert.match(page, /const flowsheet = labFlowsheet\(patient\.labs\)/)
  assert.match(page, /<table className="record-table">/)
  assert.match(page, /<th scope="col">Date<\/th>/)
  assert.match(page, /<th scope="row">\{labDate\(row\.date\)\}<\/th>/)
  assert.match(page, /aria-label="No result recorded"/)
  assert.match(page, /Laboratory history/)
  assert.match(page, /Provenance/)
  assert.doesNotMatch(page, /source-record-grid|source-labs/, 'the mini-card lab grid is gone')
})

test('trend charts expose dates, a numeric axis and the value at each reading', () => {
  const chart = readFileSync(new URL('../src/TrendChart.tsx', import.meta.url), 'utf8')
  assert.match(chart, /valueTicks\(series\.points\.map\(\(point\) => point\.value\)\)/)
  assert.match(chart, /ticks\.map\(\(tick\) => <span key=\{tick\}/, 'y axis tick labels')
  assert.match(chart, /className="trend-chart-axis"/)
  assert.match(chart, /plotted\.map\(\(point, index\) => <span key=\{`axis-\$\{index\}`\}/, 'a label at every reading')
  assert.match(chart, /className=\{`trend-value \$\{point\.top < 26 \? 'below' : 'above'\}`\}/)
  assert.match(chart, /role="img" aria-label=\{description\}/)
})

/* ----------------------------------------------------------- consultations */

test('the consultations index groups by patient and drills into one history', () => {
  assert.match(consultationsIndex(), /groupConsultationsByPatient\(records\)/)
  assert.match(consultationsIndex(), /\{group\.count\} consultation/)
  assert.match(consultationsIndex(), /\/consultations\/patient\/\$\{group\.patientId\}/)
  assert.doesNotMatch(consultationsIndex(), /records\.map/)
  assert.ok(source.includes('/^\\/consultations\\/patient\\/([^/]+)$/'))
  const history = slice('function PatientConsultationsPage', 'function ConsultationRecordPage')
  assert.match(history, /page-breadcrumb/)
  assert.match(history, /group\.records\.map/)
})

/* ------------------------------------------------------- interaction links */

test('an interaction target expands the network consultation and highlights the event', () => {
  assert.match(recommendation(), /useState\(Boolean\(focusEventId\)\)/)
  assert.match(recommendation(), /setNetworkOpen\(true\); setHighlight\(true\)/)
  assert.match(recommendation(), /eventDomId\(focusEventId\)\)\?\.scrollIntoView/)
  assert.match(consultationLog(), /id=\{eventDomId\(message\.id\)\}/)
  assert.match(consultationLog(), /open=\{message\.id === focusEventId\}/)
  assert.match(consultationLog(), /message\.id === focusEventId \? 'targeted' : ''/)
  assert.match(source, /focusEventId=\{params\.get\('event'\)\}/)
  assert.match(styles, /\.consult-record-event \{ scroll-margin/)
  assert.match(styles, /\.consult-record-event\.event-focus/)
})

test('the targeted event keeps its normal layout with no grey evidence slab', () => {
  assert.match(styles, /\.consult-record-event\.targeted \.consult-record-evidence \{[^}]*background: transparent/,
    'the default grey evidence panel must be cleared inside a targeted event')
  const targeted = styles.slice(styles.indexOf('.consult-record-event.targeted {'), styles.indexOf('.learning-card {'))
  assert.doesNotMatch(targeted, /padding|margin|border-width|font-size/, 'highlighting must not move anything')
  for (const rule of ['.consult-record-event.targeted {', '.consult-record-event.event-focus {']) {
    const declaration = styles.slice(styles.indexOf(rule), styles.indexOf('}', styles.indexOf(rule)))
    assert.match(declaration, /inset 0 0 0 2px/, 'both states use the same ring width so nothing reflows')
  }
})

test('My Agent activity reuses the one deep-link helper instead of a second implementation', () => {
  assert.match(myAgent(), /agentActivity\(records\)/)
  assert.match(myAgent(), /navigate\(activityPath\(event\)\)/)
  assert.doesNotMatch(source, /\?event=/, 'event URLs are built in agentActivity.ts only')
})

/* ------------------------------------------------------------- calibration */

test('Not quite routes to the case-linked proposal without confirming anything', () => {
  assert.match(recommendation(), /Does this reflect how you would practice\?/)
  assert.match(recommendation(), /Not quite/)
  assert.match(recommendation(), /calibrationPath\(learningKeyForPatient\(consultation\.patient_id\), consultation\.patient_id, recordId\)/)
  const feedback = recommendation().slice(
    recommendation().indexOf('recommendation-feedback'),
    recommendation().indexOf('options-section'),
  )
  assert.doesNotMatch(feedback, /updateAgentLearning|act\(/)
})

test('a proposed learning stays proposed until Confirm or Edit, and focus is visual only', () => {
  assert.match(myAgent(), /Proposed · needs confirmation/)
  assert.match(myAgent(), /focusedLearning === learning\.key \? 'focused' : ''/)
  assert.match(myAgent(), /id=\{`learning-\$\{learning\.key\}`\}/)
  assert.match(myAgent(), /learning-case-source/)
  for (const action of ['confirm', 'edit', 'reject']) {
    assert.match(myAgent(), new RegExp(`act\\(learning, '${action}'`))
  }
  const focusEffect = myAgent().slice(myAgent().indexOf('if (!focusedLearning'), myAgent().indexOf('const act ='))
  assert.doesNotMatch(focusEffect, /updateAgentLearning|act\(/)
  assert.match(styles, /\.learning-card\.focused/)
})

test('Calibration can be addressed directly by query state', () => {
  assert.match(myAgent(), /params\.get\('tab'\)/)
  assert.match(myAgent(), /params\.get\('learning'\)/)
  assert.match(source, /<MyAgentPage navigate=\{navigate\} params=\{params\} \/>/)
})

/* -------------------------------------------------------------- pass scope */

test('My Agent still exposes the four inspectable layers and no Pass 2 work leaked in', () => {
  assert.match(source, /\['overview', 'knowledge', 'calibration', 'activity'\]/)
  const identity = readFileSync(new URL('../src/demoIdentity.ts', import.meta.url), 'utf8')
  assert.match(identity, /PCP_NAME = 'Dr\. Lucy Saru'/)
  assert.match(identity, /PCP_AGENT_NAME = "Dr\. Lucy Saru's Agent"/)
  assert.doesNotMatch(source, /specialist mode|Build your network|role selector/i)
})
