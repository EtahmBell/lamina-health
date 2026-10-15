/**
 * Bug-fix pass, Parts D-G/O/P/Q/W: root-cause fix for the Lucy final-state
 * phasing/glitch bug. A referral is a specialty-care episode, not the
 * patient's permanent identity -- once Lucy reviews the returned handoff,
 * the right rail must return to a generic current-care state exactly once,
 * with a stable background while the modal is open and no flash on reload.
 *
 * This does NOT assert that Tonjit must remain permanently in Dr. Chen's
 * Active Patients -- that was never the actual issue (see Part N).
 */

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'

const app = readFileSync(new URL('../src/App.tsx', import.meta.url), 'utf8')
const referralSource = readFileSync(new URL('../src/Referral.tsx', import.meta.url), 'utf8')

const slice = (source, from, to) => {
  const start = source.indexOf(from)
  return source.slice(start, to !== undefined ? source.indexOf(to, start) : undefined)
}
const surface = () => slice(referralSource, 'export function ReferralCoordinationSurface', '/**\n * The detailed, scrollable audit trail')
const recommendationView = () => slice(app, 'function RecommendationView', 'function PatientWorkspace')

/* ------------------------------------------------------- Part O/P: root cause */

test('the single authoritative collapse condition requires reviewed AND the handoff modal to be closed -- never reviewed alone', () => {
  const fn = surface()
  assert.match(fn, /if \(status === 'done' && referral && !justCompleted && reviewed && !handoffOpen\) \{/)
})

test('before this fix, the branch ignored handoffOpen entirely -- it must never regress to that', () => {
  const fn = surface()
  assert.doesNotMatch(fn, /if \(status === 'done' && referral && !justCompleted && reviewed\) \{/)
})

test('onReviewedChange and the component\'s own render branch are withheld by the exact same handoffOpen gate -- one source of truth, not two independently-decided conditions', () => {
  const fn = surface()
  assert.match(fn, /if \(handoffOpen \|\| handoff === undefined\) return/)
  assert.match(fn, /if \(status === 'done' && referral && !justCompleted && reviewed && !handoffOpen\) \{/)
})

/* ------------------------------------------------- Part F: background stability */

test('openHandoff marks the handoff viewed in the background immediately, but the collapse itself is gated on handoffOpen -- so the background card stays in its active/"Specialist follow-up received" structure for the entire time the modal is open, even though `reviewed` may already be true internally', () => {
  const fn = surface()
  assert.match(fn, /const openHandoff = \(\) => \{\s*\n\s*setHandoffOpen\(true\)/)
  assert.match(fn, /markHandoffViewed\(referral\.id, referral\.referring_physician_id\)/)
})

test('the transition happens exactly once, at modal close -- onClose flips handoffOpen false, and by then `reviewed` is already true, so the very next render is the only one that collapses', () => {
  const fn = surface()
  assert.match(fn, /onClose=\{\(\) => setHandoffOpen\(false\)\}/)
})

/* --------------------------------------------------------- Part Q: reload flash */

test('a restored consult_returned referral starts handoff as `undefined` (unknown), not `null` (known-absent) -- the distinction the loading gate depends on', () => {
  const fn = surface()
  assert.match(fn, /useState<HandoffSummary \| null \| undefined>\(\s*\n\s*restoredReferral\?\.status === 'consult_returned' \? undefined : null\s*\n\s*\)/)
})

test('the component renders a neutral "Opening referral…" placeholder while handoff is undefined -- never the active structure, never the collapsed structure', () => {
  const fn = surface()
  assert.match(fn, /if \(handoff === undefined\) \{\s*\n\s*return <div className="referral-coordination-surface" role="status"><div className="next-step-card idle"><p className="muted-note">Opening referral…<\/p><\/div><\/div>\s*\n\s*\}/)
})

test('the parent (RecommendationView) mirrors the same three-state logic -- episodeReviewed defaults to null ("not yet known"), never false, so it never assumes "active" before the real answer is known', () => {
  const fn = recommendationView()
  assert.match(fn, /useState<boolean \| null>\(null\)/)
})

test('while episodeReviewed is null for a consult_returned referral, the parent renders neither the Chen-specific "Referral to" framing nor the generic post-episode card -- just a neutral placeholder wrapping the still-loading child', () => {
  const fn = recommendationView()
  assert.match(fn, /if \(activeReferral\?\.status === 'consult_returned' && episodeReviewed === null\) \{/)
  const loadingBranch = slice(fn, "if (activeReferral?.status === 'consult_returned' && episodeReviewed === null) {", '// Once Lucy has reviewed')
  assert.doesNotMatch(loadingBranch, /Referral to</)
  assert.doesNotMatch(loadingBranch, /No specialty action pending/)
})

/* ---------------------------------------------- Part K: feels like the original flow */

test('the generic post-episode card reuses the same visual language as the original pre-referral "consult network" moment -- .consult-button and the spark icon, not a bespoke new element', () => {
  const fn = recommendationView()
  assert.match(fn, /<button type="button" className="consult-button" onClick=\{onReconsult\}>Consult network <span className="spark-icon" aria-hidden="true">✧<\/span><\/button>/)
})

/* ------------------------------------------- explicit non-goal (Part N confirmation) */

test('none of this introduces an invariant that Tonjit (or any patient) must remain permanently in Dr. Chen\'s Active Patients -- that grouping logic is untouched by this pass', () => {
  const chenQuery = slice(referralSource, 'export function ChenPatientsPage', 'export function ChenHomePage')
  assert.doesNotMatch(chenQuery, /handoff\.viewed_by_referring_physician_at/, 'Chen\'s own active-patient grouping must not be keyed on Lucy\'s review state at all')
})
