/**
 * Tonjit demo-story pass + bug-fix pass: the documented Endocrinology
 * encounter must visibly change the PCP-facing Clinical Overview only
 * AFTER Chen sends the handoff (never merely because the encounter exists
 * -- that's an information-visibility boundary enforced server-side, see
 * Part A/B), Patient History gets a concise structured treatment-change
 * line, "Started by X" is quiet provenance text (never a pill/button), and
 * only the newly-visible medication row gets a smooth ~2.5s highlight.
 * See Parts D-M/P/V/W (demo-story) and A-N (bug-fix).
 */

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'

const app = readFileSync(new URL('../src/App.tsx', import.meta.url), 'utf8')
const referralSource = readFileSync(new URL('../src/Referral.tsx', import.meta.url), 'utf8')
const styles = readFileSync(new URL('../src/styles.css', import.meta.url), 'utf8')
const api = readFileSync(new URL('../src/api.ts', import.meta.url), 'utf8')

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

/* ------------------------------------------------------- bug-fix Part A/B:
 * PCP visibility gating lives server-side (as_physician_id), not as a
 * frontend filter -- the frontend just asks for the right identity's view.
 * ===================================================================== */

test('getPatient passes an optional as_physician_id query param, never parsed/filtered client-side', () => {
  assert.match(api, /export const getPatient = \(id: string, asPhysicianId\?: string\) => request<Patient>\(`\/api\/patients\/\$\{encodeURIComponent\(id\)\}\$\{asPhysicianId \? `\?as_physician_id=\$\{encodeURIComponent\(asPhysicianId\)\}` : ''\}`\)/)
})

test('Chen\'s own Patient Detail view asks for his own id (immediate visibility); Lucy\'s view omits it (gated on handoff-sent)', () => {
  const page = patientPage()
  assert.match(page, /getPatient\(patientId, perspective === 'receiving' \? CHEN_ID : undefined\)/)
})

/* ------------------------------------------------------------- Part F/I,
 * bug-fix Part C/D/E: "Current medications" renders the real, already
 * viewer-gated patient.medications list; only the row for a newly started
 * drug gets provenance + (conditionally) the highlight treatment.
 * ===================================================================== */

test('Current medications renders from the real, server-gated patient.medications list -- never a second, independent medications source, never client-side filtering by handoff status', () => {
  const page = patientPage()
  assert.match(page, /patient\.medications\.map\(\(item\) => \{/)
  assert.match(page, /entry\.medication === item && entry\.action === 'start'/)
})

test('provenance reads "Started by X" as quiet secondary text, never "Updated by X"', () => {
  const page = patientPage()
  assert.match(page, /Started by \{change\.specialty\}/)
  assert.doesNotMatch(page, /Updated by \{change\.specialty\}/)
})

test('provenance is a <small>, not a <span> styled as a button/pill, and is never itself clickable (no onClick, not a <button>)', () => {
  const page = patientPage()
  assert.match(page, /<small className=\{`medication-provenance \$\{medicationHighlight \? 'medication-provenance-enter' : ''\}`\}>Started by/)
  assert.doesNotMatch(page, /<button[^>]*medication-provenance/)
})

test('the CSS for .medication-provenance is quiet secondary text -- no border, no filled background, no uppercase, no bold, no pill radius', () => {
  const rule = styles.slice(styles.indexOf('.medication-provenance {'), styles.indexOf('\n', styles.indexOf('.medication-provenance {')))
  assert.doesNotMatch(rule, /border:|background:|text-transform: uppercase|font-weight: 700|border-radius: 999px/)
  assert.match(rule, /color: var\(--mineral-deep\)/)
})

test('a discontinuation is named in one compact note -- never repeating "Endocrinology" a second/third time alongside the row\'s own provenance', () => {
  const page = patientPage()
  assert.match(page, /\{patient\.recent_medication_changes\.filter\(\(entry\) => entry\.action === 'discontinue'\)\.map\(\(entry\) => entry\.medication\)\.join\(', '\)\} discontinued/)
  const noteBlock = slice(page, 'className="medication-change-note"', '</p>}')
  assert.doesNotMatch(noteBlock, /Endocrinology|specialty/i, 'the note itself must not repeat the specialty name -- that provenance already lives on the Semaglutide row')
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

/* ------------------------------------------------------------- Part J-M,
 * bug-fix Part H: the highlight's own TIMING was already correctly bounded
 * by recordHandoff being non-null (the backend already withholds a draft
 * handoff from Lucy's unauthenticated GET), which this pass preserves.
 * ===================================================================== */

test('the highlight plays only for Lucy (never the receiving/Chen perspective), only when there is a real medication change, and only before she has reviewed the (necessarily already-sent) handoff', () => {
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

/* --------------------------------------------------- bug-fix Part E/F/N:
 * only the specific medication row highlights, via a smooth eased keyframe,
 * never the whole section/Metformin/heading, never a hard on/off cut.
 * ===================================================================== */

test('only the row for a newly-started medication gets the highlight class -- never the whole Current medications section, never an unrelated row like Metformin', () => {
  const page = patientPage()
  assert.match(page, /<li key=\{item\} className=\{change && medicationHighlight \? 'medication-row-highlight' : ''\}>/)
  assert.doesNotMatch(page, /<section className=\{medicationHighlight/, 'the highlight must not be applied at the section level anymore')
})

test('the row highlight is a smooth eased keyframe over ~2.5s (ease in, hold, ease out) -- never a hard on/off background-color cut', () => {
  assert.match(styles, /@keyframes medication-row-wash \{/)
  const keyframes = slice(styles, '@keyframes medication-row-wash {', '\n}')
  assert.match(keyframes, /0% \{ background-color: transparent;/)
  assert.match(keyframes, /100% \{ background-color: transparent;/)
  // a genuine ease (more than just two keyframe stops) -- not a plain 0%/100% toggle
  assert.ok((keyframes.match(/\d+% \{/g) ?? []).length >= 4, 'expected at least 4 keyframe stops (enter/peak-start/peak-end/exit) for a real ease in/hold/ease out, not a hard cut')
  assert.match(styles, /\.medication-row-highlight \{[^}]*animation: medication-row-wash 2500ms ease-in-out;/)
})

test('the provenance text may fade in alongside the row highlight, via its own keyframe, but remains visible unconditionally afterward (never gated permanently on medicationHighlight)', () => {
  assert.match(styles, /@keyframes medication-provenance-fade-in \{/)
  assert.match(styles, /\.medication-provenance-enter \{ animation: medication-provenance-fade-in 2500ms ease-in-out; \}/)
  const page = patientPage()
  // the <small> itself always renders when `change` exists -- the -enter
  // class only ever adds an animation on top, never controls visibility
  assert.match(page, /\{change && <small className=\{`medication-provenance/)
})

test('reduced motion disables both the row-wash and provenance-fade-in animations entirely, via CSS media overrides', () => {
  assert.match(styles, /@media \(prefers-reduced-motion: reduce\) \{\s*\n\s*\.medication-row-highlight \{ animation: none; \}\s*\n\s*\.medication-provenance-enter \{ animation: none; \}\s*\n\}/)
})

test('the highlight never flashes the whole page -- there is no document.body class/style manipulation anywhere in this animation', () => {
  const page = patientPage()
  assert.doesNotMatch(page, /document\.body\.(classList|style)/)
})

test('no layout shift: the row highlight only ever animates background-color/box-shadow, never a size/position/margin/padding property that would move content', () => {
  const keyframes = slice(styles, '@keyframes medication-row-wash {', '\n}')
  assert.doesNotMatch(keyframes, /\b(width|height|margin|padding|top|left|transform)\s*:/i)
})

/* --------------------------------------------------------------- Part J:
 * the final reviewed card no longer shows a status pill.
 * ===================================================================== */

test('"No specialty action pending" status pill no longer exists anywhere', () => {
  assert.doesNotMatch(app, /No specialty action pending/)
})

test('the final reviewed card keeps the reviewed headline and Consult network action, without a status-label wrapper around them', () => {
  const fn = slice(app, 'if (episodeReviewed) {', '{coordinationSurface}')
  assert.match(fn, /\{cleanName\(selected\.physician_name\)\}'s consultation has been reviewed\./)
  assert.match(fn, /onClick=\{onReconsult\}>Consult network/)
  assert.doesNotMatch(fn, /status-label/)
})
