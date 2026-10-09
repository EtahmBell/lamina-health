import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'

const app = readFileSync(new URL('../src/App.tsx', import.meta.url), 'utf8')
const styles = readFileSync(new URL('../src/styles.css', import.meta.url), 'utf8')
const slice = (from, to) => app.slice(app.indexOf(from), app.indexOf(to))

const patients = () => slice('function PatientSelector', 'function ConsultationsPage')
const consultationNetwork = () => slice('function ConsultationNetwork', 'function NetworkConsultationSummary')
const networkSummary = () => slice('function NetworkConsultationSummary', 'const messageLabel')
const recommendation = () => slice('function RecommendationView', 'function PatientWorkspace')
const patientPage = () => slice('function PatientWorkspace', 'export default function App')
const recordPage = () => slice('function ConsultationRecordPage', 'const AGENT_TABS')

/* ------------------------------------------------------------- §1, §2, §17 */

test('the patients page frames itself as a referral worklist (post-8B: a worklist, not a directory)', () => {
  assert.match(patients(), /<h1>Patients<\/h1><p>Your active referral worklist\.<\/p>/)
  assert.doesNotMatch(patients(), /Specialty Care Consult/)
})

test('the worklist uses a small controlled status vocabulary tied to real consultation/implementation data, sorted physician-action-first', () => {
  assert.match(app, /type WorklistStatus = 'Ready for your review' \| 'Not yet consulted'/)
  assert.match(app, /WORKLIST_STATUS_PRIORITY: Record<WorklistStatus, number> = \{ 'Ready for your review': 0, 'Not yet consulted': 1 \}/)
  assert.match(app, /PATIENT_STAGE_META: Record<PatientStage,/, 'non-implemented patients get an honest stage label, not a blanket fallback')
  assert.doesNotMatch(patients(), /'Ready to consult'/)
})

test('the synthetic patient population spans a believable spread of stages, not every patient "ready for review"', () => {
  const demoPatients = readFileSync(new URL('../src/demoPatients.ts', import.meta.url), 'utf8')
  assert.match(demoPatients, /export type PatientStage = 'new' \| 'in_review' \| 'referred' \| 'workup' \| 'followup' \| 'closed'/)
  const implementedCount = (demoPatients.match(/implemented: true/g) || []).length
  assert.equal(implementedCount, 2, 'only Jordan and Maria carry a wired consult-engine case')
  const stages = new Set([...demoPatients.matchAll(/stage: '(\w+)'/g)].map((match) => match[1]))
  for (const stage of ['new', 'in_review', 'workup', 'referred', 'followup', 'closed']) {
    assert.ok(stages.has(stage), `at least one patient should be in the ${stage} stage`)
  }
  const patientCount = (demoPatients.match(/^ {2}\{\s*$/gm) || []).length
  assert.ok(patientCount >= 8, 'the roster should feel like an established practice, not a four-patient demo')
})

test('primary consult CTAs name the network and the referral purpose', () => {
  assert.match(patientPage(), /Consult network for referral/)
  assert.doesNotMatch(patientPage(), />Consult the network</)
})

/* ------------------------------------------------------------------- §3 */

test('patient-group section counts sit beside their heading, not pushed to the far edge', () => {
  const rule = styles.slice(styles.indexOf('.patient-group-heading { justify-content'))
  assert.match(rule, /^\.patient-group-heading \{ justify-content: flex-start; gap: 8px; \}/)
})

/* ------------------------------------------------------------------- §4 */

test('the Next step panel explains why the network is being consulted, for both the never-consulted and previously-consulted states', () => {
  const page = patientPage()
  assert.match(page, /Ask agent for referral options/)
  assert.match(page, /Your agent consults the network to identify an appropriate referral destination and required next steps\./)
  assert.match(page, /Previous network consultation available\./, 'the previously-consulted state is preserved with network-consultation terminology')
})

/* ------------------------------------------------------------------- §5 */

test('optional-context suggestion chips are derived only from real patient fields', () => {
  assert.match(app, /import \{ accessSuggestions, specialtySuggestion \} from '\.\/contextSuggestions\.ts'/)
  const page = patientPage()
  assert.match(page, /const specialty = specialtySuggestion\(patientId\)/)
  assert.match(page, /const access = accessSuggestions\(patient\)/)
  assert.match(page, /<span>Specialty<\/span>/)
  assert.match(page, /<span>Access<\/span>/, 'access/logistics suggestions are grouped separately from specialty-direction guidance')
  assert.match(page, /addSuggestion\(item\.text\)/)
})

test('the optional-context field remains optional with suggestions only appending into it', () => {
  const page = patientPage()
  assert.match(page, /Optional guidance/)
  assert.match(page, /setContext\(\(prev\) => \{/)
})

/* ------------------------------------------------------------------- §6 */

test('the completed graph header no longer repeats the specialist-emerged line', () => {
  assert.doesNotMatch(app, /A specialist has emerged from the structured agent consultation below\./)
})

/* ------------------------------------------------------------------- §7 */

test('graph typography is bumped for node names, key labels, and body text', () => {
  assert.match(styles, /\.consult-peer strong \{ font-size: \.92rem; \}/)
  assert.match(styles, /\.consult-network-center strong \{ font-size: \.98rem; \}/)
  assert.match(styles, /\.consult-stage-rail > span \{ font-size: \.82rem; \}/)
  assert.match(styles, /\.consult-peer em, \.consult-peer p \{ font-size: \.86rem; \}/)
  assert.match(styles, /\.consult-current-event p \{ font-size: \.9rem; \}/)
})

/* --------------------------------------------------------------- §8-§10, §16 */

test('the live graph stays mounted while consulting, including non-selected clarifications', () => {
  const network = consultationNetwork()
  assert.match(network, /clarification\.length > 0 && <div className="consult-clarification">/)
  assert.doesNotMatch(network, /consult-resolution/, 'the redundant resolution block is superseded by the compact summary')
})

test('the full graph collapses into a compact summary once a live run completes', () => {
  const page = patientPage()
  assert.match(page, /const \[networkCollapsed, setNetworkCollapsed\] = useState\(false\)/)
  assert.match(page, /\(consulting \|\| \(consultation && !networkCollapsed\)\) && <ConsultationNetwork/)
  assert.match(page, /consultation && !consulting && networkCollapsed && <NetworkConsultationSummary/)
  assert.match(page, /setNetworkCollapsed\(false\)/, 'collapsing resets for every new run, including re-consults')
  assert.match(page, /setNetworkCollapsed\(true\)/)
})

test('the compact summary names the physician-agent count and exposes the full record without duplicating it', () => {
  const summary = networkSummary()
  assert.match(summary, /Network consultation complete/)
  assert.match(summary, /\{count\} physician agent\{count === 1 \? '' : 's'\} consulted/)
  assert.match(summary, /View network consultation/)
  assert.doesNotMatch(summary, /ConsultationLog/, 'the summary triggers the existing detail view rather than rendering its own copy')
})

test('the compact summary opens the same detailed view RecommendationView already owns', () => {
  const page = patientPage()
  assert.match(page, /onViewNetwork=\{\(\) => setOpenNetworkSignal\(\(count\) => count \+ 1\)\}/)
  assert.match(page, /<RecommendationView consultation=\{consultation\} navigate=\{navigate\} openNetworkSignal=\{openNetworkSignal\} \/>/)
  const view = recommendation()
  assert.match(view, /openNetworkSignal\?: number/)
  assert.match(view, /if \(!openNetworkSignal\) return\s*\n\s*setNetworkOpen\(true\)/)
})

test('reduced motion collapses the graph immediately with no replay animation', () => {
  const page = patientPage()
  assert.match(page, /if \(calm\) \{ setCompletion\('idle'\); setNetworkCollapsed\(true\); scrollToRecommendation\('auto'\); return \}/)
})

/* ------------------------------------------------------------------ §11 */

test('historical consultations render recommendation-first with no graph and no completion replay', () => {
  const record = recordPage()
  assert.doesNotMatch(record, /ConsultationNetwork/)
  assert.doesNotMatch(record, /NetworkConsultationSummary/)
  assert.doesNotMatch(record, /completion/i)
  assert.match(record, /<RecommendationView consultation=\{record\.result\} navigate=\{navigate\} focusEventId=\{focusEventId\} recordId=\{record\.id\} \/>/)
})

/* ------------------------------------------------------------------ §12 */

test('a selected-physician clarification may surface as a concise note, never a standalone block', () => {
  const view = recommendation()
  assert.match(view, /selectedClarificationAnswer && <p className="clarification-note">Clarified before referral: \{selectedClarificationAnswer\.summary\}<\/p>/)
})

/* -------------------------------------------------------------- §13, §14, §15 */

test('no hidden-reasoning language leaks into PCP-facing copy', () => {
  assert.doesNotMatch(app, /chain of thought/i)
  assert.doesNotMatch(app, /reasoning trace/i)
  assert.doesNotMatch(app, /hidden reasoning/i)
})

test('the existing agent-handling and referral affordances are preserved', () => {
  assert.match(app, /How your agent handled this case/)
  assert.match(app, />Start referral </)
})
