/**
 * First NLP physician-representation feature: natural-language referral
 * preferences (Part B/C/F/G/H/I/Q/U). A DRAFT must never read as
 * operational; only "Looks right" (confirm) does, and the UI must make
 * that distinction obvious.
 */

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'

const api = readFileSync(new URL('../src/api.ts', import.meta.url), 'utf8')
const referralPreferences = readFileSync(new URL('../src/ReferralPreferences.tsx', import.meta.url), 'utf8')
const engagement = readFileSync(new URL('../src/Engagement.tsx', import.meta.url), 'utf8')

const slice = (source, from, to) => source.slice(source.indexOf(from), source.indexOf(to))

test('the API client exposes interpret/list/edit/confirm/reject against the real workspace-scoped endpoint', () => {
  assert.match(api, /const referralPreferencesBase = \(personaId: PhysicianIdentity\) => `\/api\/workspace\/physician\/\$\{encodeURIComponent\(personaId\)\}\/referral-preferences`/)
  assert.match(api, /export const listReferralPreferences = /)
  const interpretFn = slice(api, 'export const interpretReferralPreference', 'export const editReferralPreference')
  assert.match(interpretFn, /\/interpret`/)
  assert.match(interpretFn, /method: 'POST'/)
  const editFn = slice(api, 'export const editReferralPreference', 'export const confirmReferralPreference')
  assert.match(editFn, /method: 'PATCH'/)
  assert.match(api, /export const confirmReferralPreference = .*\/confirm`, \{ method: 'POST' \}/)
  assert.match(api, /export const rejectReferralPreference = .*\/reject`, \{ method: 'POST' \}/)
})

test('interpreting never calls confirm -- a draft is created and reviewed before anything becomes operational', () => {
  const interpretFn = slice(referralPreferences, 'const interpret = async', 'const confirm = async')
  assert.match(interpretFn, /interpretReferralPreference\(personaId, trimmed\)/)
  assert.doesNotMatch(interpretFn, /confirmReferralPreference/)
})

test('only the explicit "Looks right" action calls confirmReferralPreference', () => {
  const confirmFn = slice(referralPreferences, 'const confirm = async', 'const saveEdits = async')
  assert.match(confirmFn, /confirmReferralPreference\(personaId, draft\.id\)/)
  const reviewActions = slice(referralPreferences, 'referral-pref-review-actions', '</div>\n    </div>\n  </section>')
  assert.match(reviewActions, />Looks right</)
  assert.match(reviewActions, /onClick=\{\(\) => void confirm\(\)\}/)
})

test('the draft review card is visually marked as not yet operational, distinct from a confirmed preference', () => {
  assert.match(referralPreferences, /referral-pref-status-\$\{draft\.status\}/)
  assert.match(referralPreferences, /draft\.status === 'draft' \? 'Draft -- not yet operational' : draft\.status/)
})

test('"Edit interpretation" offers structured editing -- toggle required/helpful and remove a rule -- never raw JSON', () => {
  assert.match(referralPreferences, /function StructuredRulesEditor/)
  assert.match(referralPreferences, /Move to helpful/)
  assert.match(referralPreferences, /Move to required/)
  assert.doesNotMatch(referralPreferences, /JSON\.stringify\(rules/)
  assert.doesNotMatch(referralPreferences, /<textarea[^>]*value=\{JSON/)
})

test('"Start over" rejects the draft rather than silently discarding it, and never confirms it', () => {
  const startOverFn = slice(referralPreferences, 'const startOver = async', 'return <section')
  assert.match(startOverFn, /rejectReferralPreference\(personaId, draft\.id\)/)
  assert.doesNotMatch(startOverFn, /confirmReferralPreference/)
})

test('the currently-confirmed preference is shown with its provenance, reusing the "confirmed" status rather than a new concept', () => {
  assert.match(referralPreferences, /confirmedPreference = preferences\?\.find\(\(item\) => item\.status === 'confirmed'\)/)
  assert.match(referralPreferences, /Confirmed \{preference\.confirmed_at/)
})

test('the section lives on the physician\'s own Profile, scoped to the one physician this pass wires it for', () => {
  const profilePage = slice(engagement, 'export function ProfessionalProfilePage', 'function NetworkAskAgentModal')
  assert.match(profilePage, /personaId === 'chen' && <ReferralPreferenceSection personaId=\{personaId\} \/>/)
})

test('Practice Representation shows a confirmed modality preference as plain text, not a new raw JSON block', () => {
  const practiceTab = slice(engagement, 'export function PracticeTab', 'function trainHistorySummaryLine')
  assert.match(practiceTab, /\{sections\.modality_preference && <div className="practice-workup-block">.*<p className="practice-access-line">\{sections\.modality_preference\}<\/p><\/div>\}/)
})
