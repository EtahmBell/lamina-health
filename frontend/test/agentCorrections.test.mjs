/**
 * Physician-owned agent correction mechanic, in the Agent Coordination
 * timeline (demo-consolidation pass, Part 23-31; reworked by the agent
 * coordination oversight pass). "Review / Correct →" appears only on the
 * viewing physician's own agent's representations; a correction is
 * interpreted, scoped and explicitly confirmed, and never mutates the
 * original coordination entry.
 */

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'

const referralSource = readFileSync(new URL('../src/Referral.tsx', import.meta.url), 'utf8')
const api = readFileSync(new URL('../src/api.ts', import.meta.url), 'utf8')
const styles = readFileSync(new URL('../src/styles.css', import.meta.url), 'utf8')

const slice = (source, from, to) => {
  const start = source.indexOf(from)
  return source.slice(start, to !== undefined ? source.indexOf(to, start) : undefined)
}
const modal = () => slice(referralSource, 'export function AgentCoordinationModal', '/**\n * Generic, reusable PacketItem')

test('AgentCoordinationModal requires a viewerPhysicianId and shows "Review / Correct →" only where canCorrectEvent allows it', () => {
  const fn = modal()
  assert.match(fn, /viewerPhysicianId: string/)
  assert.match(fn, /canCorrect=\{canCorrectEvent\(viewerPhysicianId, item\)\}/)
  assert.match(fn, /\{canCorrect && <button type="button" className="coordination-correct-trigger" onClick=\{onCorrect\}>Review \/ Correct →<\/button>\}/)
})

test('the correction drawer shows the original representation, asks what to change, and only interprets (never saves) first', () => {
  const fn = modal()
  assert.match(fn, /<p className="eyebrow">Correct your agent<\/p>/)
  assert.match(fn, /Your agent represented this as/)
  assert.match(fn, /What would you change\?/)
  assert.match(fn, /Add context or explain how your agent should represent this in similar situations\./)
  assert.match(fn, /await interpretCoordinationCorrection\(referralId, item\.id, viewerPhysicianId, text\.trim\(\)\)/)
  assert.match(fn, />\{busy \? 'Interpreting…' : 'Interpret correction'\}<\/button>/)
})

test('the proposal is labelled not yet operational and offers Confirm correction / Edit / Cancel', () => {
  const fn = modal()
  assert.match(fn, /Proposed correction · Not yet operational/)
  assert.match(fn, /Current representation/)
  assert.match(fn, /Your correction/)
  assert.match(fn, /This would change/)
  assert.match(fn, />\{busy \? 'Saving…' : 'Confirm correction'\}<\/button>/)
  assert.match(fn, /onClick=\{\(\) => \{ setProposal\(null\); setScope\(null\) \}\} disabled=\{busy\}>Edit<\/button>/)
  assert.match(fn, /onClick=\{onCancel\} disabled=\{busy\}>Cancel<\/button>/)
})

test('confirming requires a chosen scope; an un-inferable scope preselects nothing', () => {
  const fn = modal()
  assert.match(fn, /setScope\(result\.suggested_scope\)/, 'a null suggestion leaves the choice to the physician')
  assert.match(fn, /disabled=\{busy \|\| !scope\} onClick=\{\(\) => void confirm\(\)\}/)
  assert.match(fn, /Apply this correction to/)
  assert.match(fn, /await confirmCoordinationCorrection\(referralId, item\.id, viewerPhysicianId, proposal\.correction_text, scope\)/)
})

test('a durable scope is unavailable when nothing durable can be learned, and says why', () => {
  const fn = modal()
  assert.match(fn, /const unavailable = option !== 'episode' && !proposal\.future_available/)
  assert.match(fn, /proposal\.future_unavailable_reason/)
})

test('a correction never edits the entry: the original stays visible (secondary) with the correction beneath it', () => {
  const fn = modal()
  assert.doesNotMatch(fn, /item\.statement = |event\.summary = /)
  assert.match(fn, /<span className="coordination-original-label">Original<\/span><p>“\{item\.statement\}”<\/p>/)
  assert.match(fn, /Corrected by Dr\. \{lastName\(viewerName\)\} · \{formatSubmittedAt\(correction\.created_at\)\}/)
  assert.match(fn, /onConfirmed=\{\(\) => \{ setCorrecting\(null\); load\(\) \}\}/, 'the timeline reloads from the backend after a confirmation')
})

test('"Review / Correct" is a compact copper secondary button -- not a large primary CTA', () => {
  assert.match(styles, /\.coordination-correct-trigger \{[^}]*border: 1px solid var\(--agent-copper-soft\);[^}]*border-radius: 999px;[^}]*background: var\(--agent-copper-surface\);[^}]*color: var\(--agent-copper-ink\);/s)
})

test('"Review / Correct" keeps a visible focus ring for keyboard users', () => {
  assert.match(styles, /\.coordination-correct-trigger:focus-visible \{ outline: 2px solid var\(--agent-copper\);/)
})

test('Lucy\'s own coordination modal (inside ReferralCoordinationSurface) passes her own physician id as the viewer, never Chen\'s', () => {
  const fn = slice(referralSource, 'export function ReferralCoordinationSurface', 'export function AgentCoordinationModal')
  assert.match(fn, /viewerPhysicianId=\{referral\.referring_physician_id\}/)
  assert.doesNotMatch(fn, /viewerPhysicianId=\{referral\.receiving_physician_id\}/)
})

test('Chen\'s coordination modals (RequestReviewModal and every ChenDownstreamCard branch) pass his own physician id as the viewer, never Lucy\'s', () => {
  const fn = slice(referralSource, 'export function RequestReviewModal', 'export function markReferralJustAccepted')
  const occurrences = [...fn.matchAll(/viewerPhysicianId=\{(referral|liveReferral)\.receiving_physician_id\}/g)]
  assert.ok(occurrences.length >= 1, 'RequestReviewModal must pass Chen\'s own id')
  assert.doesNotMatch(fn, /viewerPhysicianId=\{(referral|liveReferral)\.referring_physician_id\}/)

  const downstream = slice(referralSource, 'export function ChenDownstreamCard', 'const CHEN_PATIENT_STAGE_META')
  const downstreamOccurrences = [...downstream.matchAll(/viewerPhysicianId=\{liveReferral\.receiving_physician_id\}/g)]
  assert.equal(downstreamOccurrences.length, 6, 'every AgentCoordinationModal render inside ChenDownstreamCard must pass Chen\'s own id')
  assert.doesNotMatch(downstream, /viewerPhysicianId=\{liveReferral\.referring_physician_id\}/)
})

test('cross-physician phrasing is never exposed -- the affordance is always the generic "Review / Correct", gated purely on ownership', () => {
  assert.doesNotMatch(referralSource, /Correct (Chen|Lucy|Saruhashi)'s Agent/i)
})

test('coordination corrections go through interpret -> explicit confirm; the older feedback helpers are unchanged', () => {
  assert.match(api, /export const createAgentCorrection = \(/)
  assert.match(api, /export const getAgentCorrections = \(patientId: string\)/)
  assert.match(api, /Never writes anything -- cancelling the proposal changes nothing\./)
  assert.match(api, /export const interpretCoordinationCorrection = /)
  assert.match(api, /export const confirmCoordinationCorrection = \(referralId: number, itemId: string, physicianId: string, correctionText: string, scope: CorrectionScope\)/)
  assert.doesNotMatch(api, /applyCorrection|trainFromCorrection/i)
})
