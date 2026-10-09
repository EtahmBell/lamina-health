import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'

const app = readFileSync(new URL('../src/App.tsx', import.meta.url), 'utf8')
const network = readFileSync(new URL('../src/PhysicianNetwork.tsx', import.meta.url), 'utf8')
const api = readFileSync(new URL('../src/api.ts', import.meta.url), 'utf8')
const styles = readFileSync(new URL('../src/styles.css', import.meta.url), 'utf8')
const slice = (source, from, to) => source.slice(source.indexOf(from), source.indexOf(to))
const patientPage = () => slice(app, 'function PatientWorkspace', 'export default function App')
const playback = () => slice(app, 'function ConsultationNetwork', 'const messageLabel')
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
  assert.match(network, /Add physicians and practices you already work with\./)
  assert.match(network, /Lamina preserves this relationship alongside your broader network\./)
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
  assert.match(patientPage(), /Ask agent for referral options/)
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
  assert.match(patientsList(), /record\?\.has_consultation \? 'Ready for your review' : patient\.implemented \? 'Not yet consulted' : 'No action needed'/)
  assert.match(patientsList(), /record\?\.has_consultation && record\.latest_consulted_at \? shortDate\(record\.latest_consulted_at\)/)
  assert.doesNotMatch(patientsList(), /record\?\.last_consultation/)
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

/* ---------------------------------------------------------- completion */

test('a live consultation ends with a completion state over the graph', () => {
  assert.match(playback(), /completion !== 'idle' && result && <div className=\{`consult-complete/)
  assert.match(playback(), /Consultation complete/)
  assert.match(playback(), /\{result\.consultation\.length\} physician agent\{result\.consultation\.length === 1 \? '' : 's'\} consulted/)
  assert.match(playback(), /Recommendation ready/)
  assert.match(playback(), /role="status"/)
  assert.ok(someRule('.consult-complete', /position: absolute/), 'the overlay sits over the graph')
})

test('completion only follows a live run, never a reopened consultation', () => {
  assert.match(patientPage(), /setCompletion\('showing'\)/)
  const record = slice(app, 'function ConsultationRecordPage', 'const AGENT_TABS')
  assert.doesNotMatch(record, /ConsultationNetwork|setCompletion|consult-complete/,
    'a saved consultation has no playback and therefore no completion transition')
  assert.doesNotMatch(record, /scrollIntoView/)
  assert.equal((app.match(/setCompletion\('showing'\)/g) || []).length, 1, 'one live code path only')
  assert.doesNotMatch(app, /completionPlayed|animation_played/, 'no persisted completion flag')
})

test('completion timing holds, then guides the user to the recommendation', () => {
  const run = slice(app, 'const scrollToRecommendation', 'if (loading) return')
  assert.match(run, /await delay\(calm \? 0 : 350\)/)
  assert.match(run, /await delay\(calm \? 600 : 1000\)/)
  assert.match(run, /document\.querySelector<HTMLElement>\('\.recommendations'\)/)
  assert.match(run, /block: 'start'/)
  assert.match(run, /target\?\.focus\(\{ preventScroll: true \}\)/)
  assert.match(run, /void loadActivity\(\)/, 'canonical patient state refreshes after a run')
  assert.match(app, /className="recommendations" aria-label="Specialist recommendations" tabIndex=\{-1\}/)
  assert.ok(someRule('.recommendations', /scroll-margin-top: 92px/), 'the scroll target clears the top chrome')
})

test('reduced motion skips the animation without losing the outcome', () => {
  const run = slice(app, 'const scrollToRecommendation', 'if (loading) return')
  assert.match(app, /const prefersReducedMotion = \(\) => window\.matchMedia\?\.\('\(prefers-reduced-motion: reduce\)'\)\.matches/)
  assert.match(run, /const calm = prefersReducedMotion\(\)/)
  assert.match(run, /scrollToRecommendation\('auto'\)/)
  assert.match(run, /scrollToRecommendation\('smooth'\)/)
  assert.match(run, /if \(calm\) \{ setCompletion\('idle'\); setNetworkCollapsed\(true\); scrollToRecommendation\('auto'\); return \}/, 'no fade-out animation under reduced motion')
  assert.match(styles, /@media \(prefers-reduced-motion: reduce\) \{\s*\.consult-complete, \.consult-complete\.leaving \{ animation: none; \}/)
})

test('the graph and recommendation survive the transition', () => {
  assert.match(playback(), /completion === 'leaving' \? 'leaving' : ''/)
  const run = slice(app, 'const runConsult = async', 'if (loading) return')
  assert.match(run, /setCompletion\('idle'\)/, 'the overlay is removed, not left over the graph')
  assert.ok(run.lastIndexOf('setConsultation(null)') < run.indexOf('setCompletion('), 'the consultation is cleared only when a new run starts')
})
