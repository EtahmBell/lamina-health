import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'

const app = readFileSync(new URL('../src/App.tsx', import.meta.url), 'utf8')
const styles = readFileSync(new URL('../src/styles.css', import.meta.url), 'utf8')
const slice = (from, to) => app.slice(app.indexOf(from), app.indexOf(to))

const patients = () => slice('function PatientSelector', 'function ConsultationsPage')
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

test('Patients groups by care state (Active vs Previous), never by recency, and keeps breathing room after the search bar', () => {
  const page = patients()
  assert.match(page, /Active patients/)
  assert.match(page, /Previous care/)
  assert.doesNotMatch(page, />Recent</, 'grouping must not be a time-based Recent/Previous split')
  assert.match(page, /const active = rows\.filter\(\(row\) => row\.priority < PREVIOUS_CARE_PRIORITY\)/)
  assert.match(page, /const previous = rows\.filter\(\(row\) => row\.priority >= PREVIOUS_CARE_PRIORITY\)/)
  assert.match(styles, /\.patient-search \{[^}]*margin-bottom: 28px/, 'the existing 28px spacing rhythm separates the search bar from the list, not an arbitrary gap')
})

test('Active vs Previous care assignment follows the PATIENT_STAGE_META care-state priority, not an invented recency field', () => {
  assert.match(app, /PREVIOUS_CARE_PRIORITY = PATIENT_STAGE_META\.followup\.priority/)
  assert.match(app, /'Ready for your review': 0, 'Not yet consulted': 1/, 'both real wired-case states remain Active')
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
  assert.match(page, /Find a specialist/)
  assert.match(page, /Let your agent consult the network and bring back referral options that fit this patient's needs\./)
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
  assert.match(page, /Add optional guidance/)
  assert.match(page, /setContext\(\(prev\) => \{/)
})

/* ------------------------------------------------------------------- §6 */

test('the completed graph header no longer repeats the specialist-emerged line', () => {
  assert.doesNotMatch(app, /A specialist has emerged from the structured agent consultation below\./)
})

/* --------------------------------------------------------------- §8-§10, §16 */

test('alternatives and the technical transparency section are both collapsed by default, not always-expanded cards', () => {
  const view = recommendation()
  assert.match(view, /const \[alternativesOpen, setAlternativesOpen\] = useState\(false\)/)
  assert.match(view, /Other referral options <span>\{alternativesOpen \? '−' : '\+'\}<\/span>/)
  assert.match(view, /alternativesOpen && <div className="alternatives-list">/, 'alternatives render as compact rows, not full duplicate cards')
  assert.match(view, /How your agent handled this/)
  assert.match(view, /networkOpen && <div className="network-record">/)
})

test('the recommendation-ready default card is compact -- one fit indicator, one metadata line, one rationale sentence, driven by the currently selected candidate', () => {
  const view = recommendation()
  assert.match(view, /<article className=\{`best-fit-card compact \$\{swapping \? 'swapping' : ''\}`\}>/)
  assert.match(view, /<p className="fit-indicator">\{selected\.clinical_fit === 'strong' \? 'Strong clinical fit'/)
  assert.match(view, /<p className="fit-meta">\{insuranceLabel\(selected\.insurance_status\)\} · \{selected\.availability\}<\/p>/)
  assert.match(view, /<p className="fit-rationale">\{selected\.reason\}<\/p>/)
  assert.doesNotMatch(view, /Network resolved · \{consultation\.consultation\.length\} agents consulted/, 'the consult count is demoted out of the header')
  assert.match(view, /\{consultation\.consultation\.length\} physician agent\{consultation\.consultation\.length === 1 \? '' : 's'\} consulted/, 'the count still exists, inside How your agent handled this')
})

test('selecting an alternative crossfades the primary card, relabels provenance, and never leaves one physician\'s reasoning under another', () => {
  const view = recommendation()
  assert.match(view, /const \[selectedId, setSelectedId\] = useState\(consultation\.recommended_physician\.physician_id\)/)
  assert.match(view, /const candidates = \[primary, \.\.\.consultation\.alternatives\]/)
  assert.match(view, /const selected = candidates\.find\(\(item\) => item\.physician_id === selectedId\) \?\? primary/)
  assert.match(view, /const isAgentPick = selected\.physician_id === primary\.physician_id/)
  assert.match(view, /\{isAgentPick \? 'Recommended physician' : 'Selected specialist'\}/)
  assert.match(view, /!isAgentPick && <p className="selection-provenance">Selected by you<\/p>/)
  assert.match(view, /option\.physician_id === primary\.physician_id && <span className="agent-pick-tag">Agent's top recommendation<\/span>/)
  assert.match(view, /onClick=\{\(\) => selectCandidate\(option\.physician_id\)\}>Select this specialist/)
  assert.doesNotMatch(view, /patientFact\(|anemiaCase/, 'the Jordan/Maria-specific hardcoded reasoning lookup is gone -- every candidate uses its own real evidence/reason fields')
})

test('Start referral and the "prepared for demo" confirmation act on the currently selected candidate, not always the agent\'s original pick', () => {
  const view = recommendation()
  assert.match(view, /Destination: \{cleanName\(selected\.physician_name\)\} · \{selected\.specialty\}/)
  assert.match(view, /Workup: \{selected\.required_workup\.join\(' · '\) \|\| 'None specified'\}/)
})

test('Review match details is a collapsed-by-default disclosure holding the richer reasoning', () => {
  const view = recommendation()
  assert.match(view, /const \[detailsOpen, setDetailsOpen\] = useState\(false\)/)
  assert.match(view, /Review match details <span>\{detailsOpen \? '−' : '\+'\}<\/span>/)
  assert.match(view, /detailsOpen && <div className="match-details">/)
  assert.match(view, /Why this match/)
  assert.match(view, /Before referral/)
})

test('the ready state renders the full recommendation directly in the sticky rail, not a tiny teaser card', () => {
  const page = patientPage()
  assert.match(page, /nextStepState === 'ready' && consultation && <>/)
  assert.match(page, /A specialist is ready for your review\./)
  assert.match(page, /<RecommendationView consultation=\{consultation\} navigate=\{navigate\} recordId=\{recordId\} \/>/)
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
  assert.match(app, /How your agent handled this/)
  assert.match(app, />Start referral </)
})
