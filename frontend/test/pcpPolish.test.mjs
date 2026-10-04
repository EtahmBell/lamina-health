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

test('the agent identity hero sits before optional guidance in source order', () => {
  const banner = slice('network-action brief-action', 'agent-task')
  const heroIndex = banner.indexOf('network-hero')
  const optionalIndex = banner.indexOf('network-optional')
  assert.ok(heroIndex > 0 && optionalIndex > heroIndex, 'network-hero precedes network-optional in markup')
})

test('the primary CTA sits in the hero row and is enabled with empty optional context', () => {
  const page = patientPage()
  assert.match(page, /network-hero[\s\S]*consult-button consult-button-hero[\s\S]*disabled=\{consulting\}[\s\S]*Consult network for referral/)
  assert.doesNotMatch(page, /disabled=\{consulting \|\| !context/, 'the CTA is never gated on the optional field having a value')
})

test('optional guidance is explicitly labeled and visually secondary', () => {
  const page = patientPage()
  assert.match(page, /optional-guidance-label">Optional guidance/)
  assert.match(page, /Add context only if you want to guide the network consultation\./)
  assert.ok(someRule('.network-optional', /border-top: 1px solid var\(--border\)/), 'optional guidance is visually separated below the hero')
})

test('no optional interaction is required before consulting the network', () => {
  const banner = slice('network-action brief-action', 'agent-task')
  assert.doesNotMatch(banner, /<input[^>]*\brequired\b/)
  assert.match(banner, /onClick=\{runConsult\}/)
})

test('the hero is top-aligned, not centered against the taller optional column', () => {
  assert.ok(someRule('.brief-action .network-copy', /align-items: flex-start/))
  assert.ok(someRule('.network-action.brief-action', /flex-direction: column/))
})

/* ----------------------------------------------------------------- mobile */

test('mobile stacks the hero above optional guidance with a full-width CTA', () => {
  const mobileRule = [...styles.matchAll(/@media \(max-width: 700px\) \{([^]*?)\n\}/g)].map((m) => m[1]).join('\n')
  assert.match(mobileRule, /\.network-hero \{ flex-direction: column/)
  assert.match(mobileRule, /\.consult-button-hero \{ width: 100%/)
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
  assert.match(demoPatients, /'Ready for network' \| 'Not yet consulted' \| 'Consultation complete'/)
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

test('previous-consultation and re-consult states still work', () => {
  const page = patientPage()
  assert.match(page, /Previous network consultation available\./)
  assert.match(page, /Re-consult the network/)
  assert.match(page, /reconsult-panel/)
})

test('completion behavior from the prior pass is unchanged', () => {
  const page = patientPage()
  assert.match(page, /networkCollapsed/)
  assert.match(page, /NetworkConsultationSummary/)
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
