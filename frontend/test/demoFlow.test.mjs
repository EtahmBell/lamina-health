import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'

const app = readFileSync(new URL('../src/App.tsx', import.meta.url), 'utf8')
const network = readFileSync(new URL('../src/PhysicianNetwork.tsx', import.meta.url), 'utf8')
const api = readFileSync(new URL('../src/api.ts', import.meta.url), 'utf8')
const styles = readFileSync(new URL('../src/styles.css', import.meta.url), 'utf8')
const slice = (source, from, to) => source.slice(source.indexOf(from), source.indexOf(to))
const patientPage = () => slice(app, 'function PatientWorkspace', 'export default function App')
const patientsList = () => slice(app, 'function PatientSelector', 'function ConsultationsPage')
const resetControl = () => slice(app, 'function DemoResetControl', 'function SettingsPage')
const profile = () => slice(app, 'function SettingsPage', 'function UnfinishedPatient')
/** Every declaration block declared for a selector, in source order. */
const rulesFor = (selector) => [...styles.matchAll(
  new RegExp(`${selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*\\{([^}]*)\\}`, 'g'),
)].map((match) => match[1])
const someRule = (selector, pattern) => rulesFor(selector).some((body) => pattern.test(body))

/* ------------------------------------------------------------- network */

test('the add-colleague flow is a focused modal, not a dominant inline banner (post-8B)', () => {
  assert.match(network, /<p className="eyebrow">Add a colleague<\/p>/)
  assert.doesNotMatch(network, /Build your network/)
  assert.match(network, /Find a physician to add to your network\./)
  assert.match(network, /Search any physician in the U\.S\. using NPPES/)
  assert.match(network, /searchProviders/, 'the NPPES search is preserved')
  assert.match(network, /addNetworkMember\(profile\.npi\)/, 'Add colleague is preserved')
})

test('recommended, consulted and redirected edges are visually distinct', () => {
  const consulted = rulesFor('.relationship-edge.consulted').at(-1)
  const redirected = rulesFor('.relationship-edge.redirected').at(-1)
  assert.ok(someRule('.relationship-edge.recommended', /stroke: var\(--accent\)/), 'recommended is rust')
  assert.match(consulted, /stroke: var\(--clinical\)/, 'consulted is navy')
  assert.doesNotMatch(consulted, /dasharray: \d/, 'consulted is solid')
  assert.match(redirected, /stroke-dasharray: 7 6/, 'redirected is clearly dashed')
  assert.notEqual(
    consulted.match(/stroke:\s*([^;]+)/)[1].trim(),
    redirected.match(/stroke:\s*([^;]+)/)[1].trim(),
    'consulted and redirected must not share a stroke colour',
  )
})

/* ------------------------------------------------------- patient states */

test('the patient page reads canonical consultation state, not activity counters', () => {
  assert.match(patientPage(), /getPatientActivity\(\)/)
  assert.match(patientPage(), /activity\?\.has_consultation === true && activity\.latest_consultation_id !== null/)
  assert.doesNotMatch(patientPage(), /consultation_count/, 'no counter inference')
})

/** Post-8B: the consult trigger/prior-consult/re-consult states all now live inside
 * the sticky Next step card (.next-step-card), keyed by nextStepState, rather than a
 * standalone network-action banner. */
test('a never-consulted patient keeps the first-time consult prompt', () => {
  assert.match(patientPage(), /nextStepState === 'idle' && <div className="next-step-card idle">/)
  assert.match(patientPage(), /Find a specialist/)
  assert.match(patientPage(), /Add context only if you want to guide the network consultation\./)
  assert.match(patientPage(), /onClick=\{runConsult\}/)
})

test('a previously consulted patient surfaces the latest consultation instead', () => {
  const prior = slice(app, "nextStepState === 'idle-prior'", 'className="patient-clinical-main"')
  assert.match(prior, /Previous network consultation available\./)
  assert.match(prior, /cleanName\(activity\?\.latest_recommended_physician \|\| ''\)/)
  assert.match(prior, /activity\.latest_recommended_specialty/)
  assert.match(prior, /formatTime\(activity\.latest_consulted_at\)/)
  assert.match(prior, /navigate\(consultationPath\(activity\?\.latest_consultation_id as number\)\)/)
  assert.match(patientPage(), /consultation \? 'ready' : priorConsultation \? 'idle-prior' : 'idle'/)
})

test('re-consulting is available but secondary, and reveals optional context', () => {
  const prior = slice(app, "nextStepState === 'idle-prior'", 'className="patient-clinical-main"')
  assert.match(prior, /setReconsulting\(true\)\}>Re-consult the network/)
  assert.match(prior, /reconsulting[\s\S]*optionalGuidance\('Add what changed, if anything, since the last consultation\.'\)/)
  assert.match(prior, /onClick=\{runConsult\}/, 'the existing append-only consultation flow is reused')
  const actionIndex = prior.indexOf('View consultation')
  const reconsultIndex = prior.indexOf('Re-consult the network')
  assert.ok(actionIndex < reconsultIndex, 'View consultation leads; re-consult follows')
})

test('the previous-consultation state reads as resolved, not as an alert', () => {
  assert.ok(someRule('.next-step-card.idle .button-primary', /background: var\(--clinical\)/), 'navy resolved emphasis, not rust')
  assert.ok(!rulesFor('.next-step-card.idle').some((body) => /var\(--danger\)|var\(--warning\)/.test(body)))
})

test('the patient worklist derives status from canonical consultation/implementation data, not an inferred counter', () => {
  assert.match(patientsList(), /record\?\.has_consultation \? 'Ready for your review' : patient\.implemented \? 'Not yet consulted' : null/)
  assert.match(patientsList(), /record\?\.has_consultation && record\.latest_consulted_at \? shortDate\(record\.latest_consulted_at\)/)
  assert.doesNotMatch(patientsList(), /record\?\.last_consultation/)
})

test('non-implemented patients show a believable stage label, not a blanket "no action needed"', () => {
  assert.match(patientsList(), /PATIENT_STAGE_META\[patient\.stage\]/)
  assert.doesNotMatch(patientsList(), /No action needed/, 'the old one-size-fits-all fallback label is gone')
})

/* --------------------------------------------------------------- reset */

test('Profile exposes a demo reset behind a confirmation', () => {
  assert.match(profile(), /<h2>Demo environment<\/h2>/)
  assert.match(profile(), /Synthetic data · no PHI/)
  assert.match(profile(), /<DemoResetControl \/>/)
  assert.match(resetControl(), /Jordan Lee demo case/)
  assert.match(resetControl(), /Reset Jordan to pre-consult state\./)
  assert.match(resetControl(), /Reset Jordan demo case\?/)
  assert.match(resetControl(), /This removes Jordan's Lamina consultation history and returns the case to its pre-consult demo state\. Synthetic patient data is unchanged\./)
  assert.match(resetControl(), /setStage\('idle'\)\}>Cancel/)
  assert.match(resetControl(), />Reset case</)
})

test('reset calls the canonical endpoint and confirms quietly', () => {
  assert.match(api, /'\/api\/workspace\/demo\/reset\/jordan', \{ method: 'POST' \}/)
  assert.match(resetControl(), /await resetJordanDemo\(\)/)
  assert.match(resetControl(), /Jordan demo case reset\./)
  assert.doesNotMatch(resetControl(), /window\.location|location\.reload/, 'no full page reload')
  assert.doesNotMatch(resetControl(), /Medplum/, 'reset must not claim clinical data is deleted')
})

/* ------------------------------------------------- simplified loading state */

test('consulting shows a single calm loading card in the rail -- no graph, no multi-step animation, no completion overlay', () => {
  const run = slice(app, 'const runConsult = async', 'if (loading) return')
  assert.match(run, /setConsulting\(true\); setConsultation\(null\); setRecordId\(undefined\); setError\(null\)/)
  assert.match(run, /await consultNetwork\(patientId, context\)/)
  assert.doesNotMatch(run, /setVisibleMessageCount|setCompletion|setNetworkCollapsed/, 'no per-message replay or completion state machine remains')
  assert.doesNotMatch(app, /function ConsultationNetwork|function NetworkConsultationSummary/, 'the old graph/compact-summary components are removed, not just unused')
  assert.match(patientPage(), /Consulting the network/)
  assert.match(patientPage(), /Your agent is finding a match\./)
  assert.match(patientPage(), /Comparing clinical fit, referral requirements, access, and your practice preferences…/)
})

test('a completed live run scrolls to the recommendation once, with no artificial delay loop', () => {
  const run = slice(app, 'const runConsult = async', 'if (loading) return')
  assert.match(run, /void refreshActivity\(\)/, 'canonical patient state refreshes after a run')
  assert.match(run, /requestAnimationFrame\(\(\) => scrollToRecommendation\(prefersReducedMotion\(\) \? 'auto' : 'smooth'\)\)/)
  assert.doesNotMatch(run, /await delay\(/, 'no setTimeout-based animation sequencing')
  assert.match(app, /className="recommendations" aria-label="Specialist recommendations" tabIndex=\{-1\}/)
  assert.ok(someRule('.recommendations', /scroll-margin-top: 92px/), 'the scroll target clears the top chrome')
})
