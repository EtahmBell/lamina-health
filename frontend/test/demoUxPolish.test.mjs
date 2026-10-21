/**
 * Demo UX + semantic polish pass: example-vs-stored-data clarity, a clean
 * confirmation moment, conditional modality rendering (never a misleading
 * "Either; no strong preference" line), deduplicated Before-referral
 * sections, learned-this-week copy, Soon/Visit separator spacing, and the
 * Ask-the-Network card's surface treatment + sticky behavior.
 */

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'

const referralPreferences = readFileSync(new URL('../src/ReferralPreferences.tsx', import.meta.url), 'utf8')
const engagement = readFileSync(new URL('../src/Engagement.tsx', import.meta.url), 'utf8')
const api = readFileSync(new URL('../src/api.ts', import.meta.url), 'utf8')
const styles = readFileSync(new URL('../src/styles.css', import.meta.url), 'utf8')

const slice = (source, from, to) => source.slice(source.indexOf(from), source.indexOf(to))

// ---------------------------------------------------------------- Part 5: example, not stored data

test('the source-text textarea starts empty and only ever shows the demo text as a placeholder, never a pre-populated value', () => {
  assert.match(referralPreferences, /const \[sourceText, setSourceText\] = useState\(''\)/)
  assert.match(referralPreferences, /value=\{sourceText\}/)
  assert.doesNotMatch(referralPreferences, /value=\{sourceText \|\| placeholder/)
  assert.match(referralPreferences, /placeholder=\{\s*placeholder \?\? \(/)
})

test('a small "Example" label sits above the textarea, so it reads as illustrative, never as already-stored input', () => {
  assert.match(referralPreferences, /referral-pref-example-label">Example</)
})

// ---------------------------------------------------------------- Part 6: confirmation moment

test('confirming replaces the form entirely with a success state, never leaving the physician in a big editable form as the next view', () => {
  const section = slice(referralPreferences, 'return <section className="profile-section referral-preference-section"', '/** Demo coherence pass, Part D/J')
  assert.match(section, /confirmedNote\s*\n\s*\? <div className="referral-pref-success"/)
  assert.match(section, /✓ \{confirmedNote\}/)
  assert.match(section, />Done</)
})

test('Done clears the note and, when provided, closes the modal cleanly via onDone', () => {
  assert.match(referralPreferences, /const finishConfirmation = \(\) => \{ setConfirmedNote\(''\); onDone\?\.\(\) \}/)
  assert.match(referralPreferences, /onDone=\{onClose\}/)
})

// ---------------------------------------------------------------- Part 7/10: conditional modality, never "Either"

test('StructuredReferralPreference carries structured modality_rules, the preferred source over the flat enum', () => {
  assert.match(api, /export type ModalityRule = \{ modality: 'econsult' \| 'in_person'; condition: string \}/)
  assert.match(api, /modality_rules: ModalityRule\[\]/)
})

test('the interpretation review UI renders each modality rule as its own labeled block, never collapsing conditional guidance into one flat line', () => {
  const readOnly = slice(referralPreferences, 'function ReadOnlyInterpretation', 'function StructuredRulesEditor')
  assert.match(readOnly, /rules\.modality_rules\.length > 0/)
  assert.match(readOnly, /MODALITY_RULE_HEADING\[rule\.modality\]/)
  // The flat "Either; no strong preference" line only ever renders when
  // there are NO real conditional rules to show instead.
  assert.match(readOnly, /: rules\.modality !== 'unspecified' && <div className="referral-pref-group">/)
})

test('EMPTY_RULES includes modality_rules so a fresh draft never crashes on the new field', () => {
  assert.match(referralPreferences, /modality_rules: \[\],?\s*\}/)
})

// ---------------------------------------------------------------- Part 3: Before referral sections never duplicate

test('Practice Representation labels the two Before-referral columns "Required before review" / "Helpful when available", never duplicating the same item across them', () => {
  const practiceTab = slice(engagement, 'export function PracticeTab', 'function trainHistorySummaryLine')
  assert.match(practiceTab, /label: 'Required before review', items: sections\.referral_requirements/)
  assert.match(practiceTab, /label: 'Helpful when available', items: sections\.preferred_workup/)
  assert.doesNotMatch(practiceTab, /workupSameAsReferral/)
})

// ---------------------------------------------------------------- Part 11: learned-this-week copy

test('the learned-this-week card uses "One clarification needs your input", not the casual "1 thing needs your judgment"', () => {
  assert.match(engagement, /One clarification needs your input/)
  assert.doesNotMatch(engagement, /1 thing needs your judgment/)
})

// ---------------------------------------------------------------- Part 12: Soon / Visit spacing

test('a CSS rule gives breathing room between the priority pill and the modality separator that follows it', () => {
  assert.match(styles, /\.priority-chip \+ \.incoming-request-modality \{ margin-left: 6px; \}/)
})

// ---------------------------------------------------------------- Part 13/14: Ask the Network card + sticky

test('the Ask the Network card gets a real surface treatment (cream background, soft shadow), not raw form controls on the page', () => {
  assert.match(styles, /\.ask-network-card \{ border: 1px solid var\(--border\); border-radius: 14px; background: var\(--surface\); box-shadow: var\(--shadow-soft\);/)
})

test('the Ask the Network rail is sticky on desktop and stacks normally below the layout\'s own mobile breakpoint', () => {
  assert.match(styles, /@media \(min-width: 961px\) \{ \.network-colleagues-layout \.active-network-rail \{ position: sticky; top: 76px; \} \}/)
  assert.match(styles, /@media \(max-width: 960px\) \{ \.network-colleagues-layout \{ grid-template-columns: 1fr; \} \}/)
})
