/**
 * Tonjit demo-story pass: the documented Endocrinology encounter must
 * visibly change the Clinical Overview (not just the handoff), Patient
 * History gets a concise structured treatment-change line, and the change
 * is briefly highlighted once per session before Lucy reviews the handoff.
 * See Parts D-M/P/V/W of the request.
 */

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'

const app = readFileSync(new URL('../src/App.tsx', import.meta.url), 'utf8')
const referralSource = readFileSync(new URL('../src/Referral.tsx', import.meta.url), 'utf8')
const styles = readFileSync(new URL('../src/styles.css', import.meta.url), 'utf8')

const slice = (source, from, to) => {
  const start = source.indexOf(from)
  return source.slice(start, to !== undefined ? source.indexOf(to, start) : undefined)
}
const patientPage = () => slice(app, 'function PatientWorkspace', 'function RecommendationView')

/* --------------------------------------------------------------- Part E */

test('no brand name (Ozempic/Wegovy) is ever hardcoded in the frontend -- only the generic drug name Semaglutide', () => {
  assert.doesNotMatch(app, /Ozempic|Wegovy/i)
  assert.doesNotMatch(referralSource, /Ozempic|Wegovy/i)
})

/* ------------------------------------------------------------- Part F/I */

test('Current medications renders from the real derived patient.medications list, with inline provenance for a newly started drug -- never a second, independent medications source', () => {
  const page = patientPage()
  assert.match(page, /patient\.medications\.map\(\(item\) => \{/)
  assert.match(page, /entry\.medication === item && entry\.action === 'start'/)
  assert.match(page, /<span className="medication-provenance">Updated by \{change\.specialty\}<\/span>/)
})

test('a compact contextual note names both the started and discontinued medications with specialty provenance', () => {
  const page = patientPage()
  assert.match(page, /Updated after \{patient\.recent_medication_changes\[0\]\.specialty\} consultation/)
  assert.match(page, /className="medication-change-note"/)
})

/* ----------------------------------------------------------------- Part P */

test('Patient history gets a concise structured treatment-change line, derived from medication_changes -- never parsed from the free-text plan', () => {
  const page = patientPage()
  assert.match(page, /recordEncounter\.medication_changes\.length > 0 && <p className="timeline-event-medication-change">/)
  assert.match(page, /Treatment intensified: /)
  assert.match(page, /change\.action !== 'continue'/)
  assert.doesNotMatch(page, /recordEncounter\.plan\.(split|match|includes)/, 'must never parse the prose plan to derive medication facts')
})

test('Patient history names the consulting physician when known, without hardcoding a specific patient', () => {
  const page = patientPage()
  assert.match(page, /recordEncounter\.physician_id === CHEN_ID && <p className="timeline-event-clinician">\{CHEN_NAME\}<\/p>/)
})

/* ------------------------------------------------------------- Part J-M */

test('the highlight plays only for Lucy (never the receiving/Chen perspective), only when there is a real medication change, and only before she has reviewed the handoff', () => {
  const page = patientPage()
  assert.match(page, /if \(perspective === 'receiving' \|\| prefersReducedMotion\(\)\) return/)
  assert.match(page, /if \(!patient \|\| patient\.recent_medication_changes\.length === 0\) return/)
  assert.match(page, /if \(!recordHandoff \|\| recordHandoff\.viewed_by_referring_physician_at\) return/)
})

test('the highlight is a one-shot-per-session flag via the shared consumeMedicationHighlightFlag helper (Referral.tsx), keyed by encounter id -- never raw sessionStorage access inside App.tsx itself', () => {
  const page = patientPage()
  assert.match(page, /if \(!consumeMedicationHighlightFlag\(recordHandoff\.encounter_id\)\) return/)
  assert.match(referralSource, /export function consumeMedicationHighlightFlag\(encounterId: number\): boolean \{/)
  assert.match(referralSource, /const key = `lamina:lucy:medication-highlight:\$\{encounterId\}`/)
})

test('the highlight fades after approximately 2.5 seconds, via a plain timeout that is cleared on cleanup', () => {
  const page = patientPage()
  assert.match(page, /window\.setTimeout\(\(\) => setMedicationHighlight\(false\), 2500\)/)
  assert.match(page, /return \(\) => window\.clearTimeout\(timer\)/)
})

test('reduced motion disables the highlight animation entirely, via a CSS media override, matching the house pattern used elsewhere (e.g. .handoff-wash)', () => {
  assert.match(styles, /\.medication-highlight \{[^}]*transition: background-color 600ms ease-in-out;/)
  assert.match(styles, /@media \(prefers-reduced-motion: reduce\) \{ \.medication-highlight \{ transition: none; \} \}/)
})

test('the highlight never flashes the whole page -- it is scoped to a single section className, not a page-level or body-level class', () => {
  const page = patientPage()
  assert.doesNotMatch(page, /document\.body\.(classList|style)/)
  assert.match(page, /className=\{medicationHighlight \? 'medication-highlight' : ''\}/)
})

test('the provenance label itself ("Updated by X") renders unconditionally, independent of medicationHighlight -- it may outlive the brief wash (Part L)', () => {
  const page = patientPage()
  const medicationsSection = slice(page, '<section className={medicationHighlight', '</section>')
  assert.doesNotMatch(medicationsSection, /medicationHighlight && <span className="medication-provenance"/, 'the provenance label must not itself be gated on the transient highlight boolean')
})
