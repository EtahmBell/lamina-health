import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { lifecycleLine } from '../src/pilotState.ts'

/* Step 18: readiness review and physician-approved activation (frontend). */

const source = (name) => readFileSync(new URL(`../src/${name}`, import.meta.url), 'utf8')
const readiness = source('PilotReadiness.tsx')
const pilot = source('Pilot.tsx')
const api = source('pilotApi.ts')
const slice = (text, from, to) => text.slice(text.indexOf(from), to ? text.indexOf(to, text.indexOf(from)) : undefined)

test('the review speaks in raw counts and never shows a score or accuracy', () => {
  assert.doesNotMatch(readiness, /accuracy|confident|smart|quality score/i)
  assert.match(readiness, /There is no overall score\./)
  // A percentage only when the server provides one (denominator at or above the minimum).
  assert.match(readiness, /\{tally\.text\}\{tally\.percent !== null \? ` \(\$\{tally\.percent\}%\)` : ''\}/)
  assert.match(readiness, /Since your current rules/)
  assert.match(readiness, /All time/)
})

test('turning a capability on needs an explicit confirmation that restates the change', () => {
  const card = slice(readiness, 'function CapabilityCard', 'function AlwaysYours')
  assert.match(card, /\{cap\.confirm_text\}/)
  assert.match(card, /onSet\('active', \{ confirm: true \}\)/)
  // Eligible ALLOWS it; the button only appears when eligible (or always available) and within the practice limit.
  assert.match(card, /cap\.state !== 'active' && canActivate && \(eligibility\?\.eligible \|\| eligibility\?\.always_available\)/)
  assert.match(card, /Eligible to turn on\.<\/strong> That allows it; it stays as it is until you choose\./)
})

test('the boundary is shown: always yours, and coming later without controls', () => {
  const always = slice(readiness, 'function AlwaysYours', 'function PracticeLimits')
  assert.match(always, /Always yours/)
  assert.match(always, /Coming later \(not available yet\)/)
  assert.doesNotMatch(always, /<button|<select|<input/, 'no fake controls')
})

test('staff get a read-only view with no controls', () => {
  const staff = slice(readiness, 'if (!physician) {', 'const metrics = review.metrics!')
  assert.doesNotMatch(staff, /<button|onSet|setCapabilityState|pauseAllCapabilities/)
  assert.match(staff, /Only \{doctor\} can change this\./)
  assert.match(staff, /Drafted by \{doctor\}’s agent/)
})

test('only a physician can mark a flag serious; anyone can flag a draft as wrong', () => {
  const flag = slice(pilot, 'function AgentItemFlag', 'function InformationRequestPanel')
  assert.match(flag, /Flag this draft as wrong/)
  assert.match(flag, /\{physician && <label className="pilot-check"><input type="checkbox" checked=\{serious\}/)
})

test('authenticated activation calls sit outside the public (no-account) section', () => {
  const publicSection = slice(api, '/* ------------------------------------------------- public (no account needed) */')
  assert.doesNotMatch(publicSection, /activation/)
})

test('lifecycle line says when the agent is partly active, for staff too', () => {
  const staff = { physician: false, doctor: 'Dr. A' }
  assert.equal(lifecycleLine({ state: 'shadow', label: 'Shadow mode — your agent recommends; you and your staff decide.', capabilities_line: 'Partly active · 1 capability on' }, staff),
    'Partly active · 1 capability on — Dr. A’s agent prepares drafts for review; Dr. A decides.')
  assert.equal(lifecycleLine({ state: 'shadow', label: 'Shadow mode — your agent recommends; you and your staff decide.', capabilities_line: null }, staff),
    'Shadow mode — Dr. A’s agent recommends; Dr. A decides. Staff handle intake and paperwork.')
})

/* Step 18 decisions */

test('the readiness page opens with a short summary and one recommended action', () => {
  const top = slice(readiness, 'const summary = review.summary', 'className="pilot-readiness-head"')
  assert.match(top, /pilot-readiness-summary/)
  assert.match(top, /<dt>Status<\/dt>/)
  assert.match(top, /<dt>Eligible<\/dt>/)
  assert.match(top, /Recommended:<\/strong> \{summary\.recommended\.text\}/)
  // The summary comes before the metrics on the page.
  assert.ok(readiness.indexOf('pilot-readiness-summary') < readiness.indexOf('What your agent observed'))
})

test('"possible fit" → declined or redirected is its own list, not a disagreement', () => {
  assert.match(readiness, /“Possible fit” → declined or redirected/)
  assert.match(readiness, /metrics\.possible_not_accepted/)
  assert.match(readiness, /They aren’t counted as agreement or as disagreement\./)
})

test('notices the physician did not cause are acknowledged explicitly', () => {
  assert.match(readiness, /acknowledgeCapabilityNotice\(notice\.id\)/)
  assert.match(readiness, />Got it</)
})

test('staff see who made the last change', () => {
  const staff = slice(readiness, 'if (!physician) {', 'const metrics = review.metrics!')
  assert.match(staff, /Last changed by \{cap\.updated_by_name \?\? 'a practice member'\}/)
})

test('"Ready" with required items missing needs a confirmation naming them', () => {
  assert.match(pilot, /Still missing:<\/strong> \{missingRequired\.join\(', '\)\}/)
  assert.match(pilot, /disabled=\{busy \|\| \(missingRequired\.length > 0 && !readyAnyway\)\}/)
  assert.match(pilot, /markReferralReady\(referral\.id, note, missingRequired\.length \? missingRequired : undefined\)/)
})

test('an agent draft keeps the status and says who drafted it', () => {
  assert.match(pilot, /\{standing\.status_label \?\? STATUS_LABELS\[referral\.status\]\}/)
  assert.match(source('pilotState.ts'), /Information request drafted by \$\{event\.actor_name \?\? 'the agent'\} \(not sent\)/)
})
