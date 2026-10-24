/* Teaching-intent expansion pass: the proposal shows case interests as
 * their own positive-fit group, explains honestly when it needs more
 * detail (and then offers no "Looks right"), and says when guidance is
 * already represented. */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'

const read = (path) => readFileSync(new URL(path, import.meta.url), 'utf8').replaceAll(String.fromCharCode(13), '')
const preferences = read('../src/ReferralPreferences.tsx')
const api = read('../src/api.ts')
const slice = (source, from, to) => source.slice(source.indexOf(from), to === undefined ? undefined : source.indexOf(to, source.indexOf(from)))
const readOnly = () => slice(preferences, 'function ReadOnlyInterpretation', 'function StructuredRulesEditor')
const review = () => slice(preferences, 'export function PreferenceDraftReview', '/** Placeholder and example')

test('the structured preference carries case interests and a non-operational note', () => {
  assert.match(api, /case_interests\?: string\[\]/)
  assert.match(api, /interpretation_note\?: string \| null/)
})

test('case interests render as a readable "Case interest" group with their supporting-only effect', () => {
  const fn = readOnly()
  assert.match(fn, /<p className="section-label">Case interest<\/p>/)
  assert.match(fn, /interests\.map\(\(item\) => <li className="referral-pref-requirement-row" key=\{item\}><span>\{item\}<\/span><\/li>\)/)
  assert.match(fn, /Similar cases become a stronger fit for your practice\. This never makes a case required or excluded\./)
  assert.doesNotMatch(fn, /intent_type|condition_code|CASE_INTEREST/, 'no parser internals in the UI')
})

test('the case family reads as the condition ("Diabetes"), as the proposal\'s metadata line', () => {
  assert.match(preferences, /type_2_diabetes: 'Diabetes', ckd_hypertension: 'Kidney disease and hypertension'/)
})

test('an interpretation with no operational content asks for more detail, using the interpreter\'s note', () => {
  const fn = readOnly()
  assert.match(fn, /\{isEmptyInterpretation\(rules\) && <div className="referral-pref-needs-detail">/)
  assert.match(fn, /I need a little more detail\./)
  assert.match(fn, /\{rules\.interpretation_note \?\? /)
})

test('nothing empty -- or already represented -- can be confirmed', () => {
  assert.match(preferences, /&& \(rules\.case_interests \?\? \[\]\)\.length === 0/, 'case interests count as content')
  const card = review()
  assert.match(card, /const nothingToConfirm = isEmptyInterpretation\(draft\.structured_rules\) \|\| \(keptLabels\.length > 0 && isEmptyInterpretation\(added\)\)/)
  assert.ok(card.includes('{!nothingToConfirm && <button type="button" className="button-primary" disabled={busy} onClick={() => void confirm()}>Looks right</button>}'))
  assert.match(card, /Your agent already represents this guidance\./)
  assert.match(card, /No operational change is needed\./)
  assert.match(preferences, /\.\.\.\(rules\.case_interests \?\? \[\]\)\.filter\(\(item\) => \(confirmed\.case_interests \?\? \[\]\)\.includes\(item\)\)/)
})

test('case interests can be removed while editing an interpretation', () => {
  const editor = slice(preferences, 'function StructuredRulesEditor', 'function ConfirmedPreferenceSummary')
  assert.match(editor, /case_interests: \(rules\.case_interests \?\? \[\]\)\.filter\(\(x\) => x !== item\)/)
})
