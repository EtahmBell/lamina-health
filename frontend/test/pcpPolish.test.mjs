import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'

const app = readFileSync(new URL('../src/App.tsx', import.meta.url), 'utf8')
const styles = readFileSync(new URL('../src/styles.css', import.meta.url), 'utf8')
const demoPatients = readFileSync(new URL('../src/demoPatients.ts', import.meta.url), 'utf8')
const contextSuggestions = readFileSync(new URL('../src/contextSuggestions.ts', import.meta.url), 'utf8')
const slice = (from, to) => app.slice(app.indexOf(from), app.indexOf(to))

const patientPage = () => slice('function PatientWorkspace', 'export default function App')
const consultationsIndex = () => slice('function ConsultationsPage', 'function PatientConsultationsPage')

/* ------------------------------------------------------------------ banner */

/** Post-8B: the hero/CTA/optional-guidance banner moved into the sticky Next step
 * card in the right-hand column (see .next-step-card / .patient-next-step). */
test('the agent identity hero sits before optional guidance in source order', () => {
  const card = slice("nextStepState === 'idle' && <div className=\"next-step-card idle\">", '</div>}\n      </aside>')
  const heroIndex = card.indexOf('<h2>Find a specialist</h2>')
  const optionalIndex = card.indexOf('optionalGuidance(')
  assert.ok(heroIndex > 0 && optionalIndex > heroIndex, 'the hero headline precedes optional guidance in markup')
})

test('the primary CTA sits in the Next step card and is enabled with empty optional context', () => {
  const page = patientPage()
  assert.match(page, /consult-button consult-button-hero[\s\S]{0,40}disabled=\{consulting\}[\s\S]{0,20}onClick=\{runConsult\}/)
  assert.doesNotMatch(page, /disabled=\{consulting \|\| !context/, 'the CTA is never gated on the optional field having a value')
})

test('optional guidance is explicitly labeled, collapsed by default, and visually secondary', () => {
  const page = patientPage()
  assert.match(page, /optional-guidance-label">Add optional guidance/)
  assert.match(page, /Add context only if you want to guide the network consultation\./)
  assert.match(page, /<details className="network-optional">/, 'optional guidance collapses by default behind a <details> disclosure')
  assert.ok(someRule('.network-optional', /border-top: 1px solid var\(--border\)/), 'optional guidance is visually separated below the hero')
})

test('no optional interaction is required before consulting the network', () => {
  const card = slice("nextStepState === 'idle' && <div className=\"next-step-card idle\">", '</div>}\n      </aside>')
  assert.doesNotMatch(card, /<input[^>]*\brequired\b/)
  assert.match(card, /onClick=\{runConsult\}/)
})

test('the Next step panel is sticky and sits beside clinical context on desktop', () => {
  assert.ok(someRule('.patient-next-step', /position: sticky/))
  assert.ok(someRule('.patient-detail-grid', /grid-template-columns: 1\.25fr 1fr/))
})

/* ----------------------------------------------------------------- mobile */

test('mobile stacks the Next step panel above the clinical context, full width', () => {
  const mobileRule = [...styles.matchAll(/@media \(max-width: 900px\) \{([^]*?)\n\}/g)].map((m) => m[1]).join('\n')
  assert.match(mobileRule, /\.patient-next-step \{ grid-column: 1; grid-row: 1; position: static;/)
  assert.ok(someRule('.consult-button-hero', /width: 100%/), 'the hero CTA is full-width unconditionally, not just on mobile')
})

/* -------------------------------------------------------------- specialty */

test('Jordan and Maria can quickly add a specialty-comparison phrase', () => {
  assert.match(contextSuggestions, /Compare nephrology vs cardiology/)
  assert.match(contextSuggestions, /Compare gastroenterology vs haematology/)
  assert.match(patientPage(), /specialtySuggestion\(patientId\)/, 'the banner wires the specialty suggestion in by patient id')
})

/* ------------------------------------------------------------------ chips */

test('chips compose with clean, period-separated phrasing and never duplicate', () => {
  const page = patientPage()
  assert.match(page, /already \? prev : prev \? `\$\{prev\}\. \$\{text\}` : text/)
})

test('a selected suggestion gets a non-color-only indicator', () => {
  assert.ok(someRule('.context-chip.added', /font-weight: 700/))
  assert.ok(someRule('.context-chip.added::before', /content: "✓ "/))
})

/* ---------------------------------------------------------------- copy */

test('compact patient-row status uses network-consultation terminology', () => {
  assert.match(app, /'Ready for your review' \| 'Not yet consulted'/)
  assert.doesNotMatch(app, /'Ready to consult'/)
  assert.doesNotMatch(demoPatients, /'Ready to consult'/)
})

test('the primary CTA copy remains "Consult network for referral"', () => {
  assert.match(patientPage(), /Consult network for referral/)
})

/* ----------------------------------------------------------- empty state */

test('the Consultations empty state reads "No network consultations yet"', () => {
  assert.match(consultationsIndex(), /No network consultations yet/)
  assert.doesNotMatch(consultationsIndex(), />No consultations yet</)
})

test('the empty-state CTA is structurally grouped with the centered content', () => {
  const index = consultationsIndex()
  assert.match(index, /className="empty-state history-empty">.*Select a patient/, )
  assert.ok(someRule('.empty-state .button-primary', /margin: 6px auto 0/), 'the CTA is centered on the same axis as the empty-state copy')
})

/* ----------------------------------------------------------- regression */

test('previous-consultation and re-consult states still work (now inside the idle-prior Next step card)', () => {
  const page = patientPage()
  assert.match(page, /Previous network consultation available\./)
  assert.match(page, /Re-consult the network/)
  assert.match(page, /nextStepState === 'idle-prior' && <div className="next-step-card idle">/)
})

test('the legacy graph/completion machinery from the prior pass is fully removed, not merely hidden', () => {
  const page = patientPage()
  assert.doesNotMatch(page, /networkCollapsed|NetworkConsultationSummary|ConsultationNetwork|setCompletion/)
})

test('the 4-column fact strip and the Agent task blurb are both removed from patient detail', () => {
  const page = patientPage()
  assert.doesNotMatch(page, /patient-fact-strip/)
  assert.doesNotMatch(page, /Agent task/)
  assert.doesNotMatch(page, /Evaluate appropriate specialty, required workup, and viable access options/)
  assert.doesNotMatch(app, /\.patient-fact-strip|\.agent-task\b/)
  assert.match(page, /<hr className="patient-header-divider" \/>/, 'a divider replaces the fact strip as the header-to-content transition')
})

test('Patient ID is demoted to subtle metadata (Care context / source record), never the big header line', () => {
  const page = patientPage()
  assert.doesNotMatch(page, /ID \{patient\.id\}/, 'the header line no longer surfaces the raw ID inline')
  assert.match(page, /\{ label: 'Patient ID', value: patient\.id \}/, 'it still exists, quietly, in careContext')
})

test('a patient who already has a completed consultation gets it auto-loaded as the current care state, not a bare "consultation exists" notice', () => {
  const page = patientPage()
  assert.match(page, /getConsultationRecord\(found\.latest_consultation_id\)/, 'the latest saved record is fetched on open')
  assert.match(page, /setConsultation\(record\.result\); setRecordId\(record\.id\)/)
  assert.match(page, /nextStepState === 'ready' && consultation && <>/, 'this routes into the same ready state as a fresh live run')
})

/** Every declaration block declared for a selector, in source order. */
function rulesFor(selector) {
  return [...styles.matchAll(
    new RegExp(`${selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*\\{([^}]*)\\}`, 'g'),
  )].map((match) => match[1])
}
function someRule(selector, pattern) {
  return rulesFor(selector).some((body) => pattern.test(body))
}
