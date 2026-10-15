/**
 * Physician-owned agent correction mechanic, in the Agent Coordination
 * timeline (demo-consolidation pass, Part 23-31). A quiet "Correct this"
 * per event, restricted to the viewing physician's own agent's events;
 * saved as a pending_training AgentCorrection, never mutating the original
 * immutable CoordinationEvent audit trail.
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

test('correctableEventOwner mirrors the backend ownership rule -- referring_agent events belong to the referring physician, receiving_agent events to the receiving physician, everything else (system) is never correctable', () => {
  const fn = slice(referralSource, 'function correctableEventOwner', 'export function AgentCoordinationModal')
  assert.match(fn, /event\.actor === 'referring_agent'\) return referral\.referring_physician_id/)
  assert.match(fn, /event\.actor === 'receiving_agent'\) return referral\.receiving_physician_id/)
  assert.match(fn, /return null/)
})

test('AgentCoordinationModal requires a viewerPhysicianId prop and only shows "Correct this" when the event\'s owner matches it', () => {
  const fn = modal()
  assert.match(fn, /viewerPhysicianId: string/)
  assert.match(fn, /const owner = correctableEventOwner\(referral, event\)/)
  assert.match(fn, /const correctable = owner != null && owner === viewerPhysicianId/)
  assert.match(fn, /\{correctable && !corrected && correctingSequence !== event\.sequence && <button type="button" className="coordination-correct-trigger" onClick=\{\(\) => openCorrection\(event\.sequence\)\}>Correct this<\/button>\}/)
})

test('a system event (no actor match) is never correctable, regardless of who is viewing', () => {
  const fn = slice(referralSource, 'function correctableEventOwner', 'export function AgentCoordinationModal')
  assert.doesNotMatch(fn, /actor === 'system'/, 'system events fall through to the final `return null` -- never special-cased into correctable')
})

test('the correction form asks "What should your agent have done or said instead?" and saves via createAgentCorrection, scoped to this referral/event', () => {
  const fn = modal()
  assert.match(fn, /What should your agent have done or said instead\?/)
  assert.match(fn, /await createAgentCorrection\(referral\.patient_id, viewerPhysicianId, correctionText\.trim\(\), \{/)
  assert.match(fn, /referralId: referral\.id \?\? undefined,/)
  assert.match(fn, /sourceEventSequence: correctingSequence,/)
  assert.match(fn, /selectedText: correctionSelectedText \|\| undefined,/)
})

test('an active text selection inside the timeline is opportunistically captured as selected_text, but is optional -- Save correction only requires correction text', () => {
  const fn = modal()
  assert.match(fn, /window\.getSelection\(\)\?\.toString\(\)\.trim\(\) \?\? ''/)
  assert.match(fn, /disabled=\{savingCorrection \|\| !correctionText\.trim\(\)\}/, 'selected text is never required to save')
})

test('saving a correction never mutates the original event -- it only sets local saved-state and shows a separate confirmation note beneath the event, the real event.summary/strong/p markup is untouched', () => {
  const fn = modal()
  assert.doesNotMatch(fn, /event\.summary = |event\.metadata\[/, 'the CoordinationEvent object itself is never written to')
  assert.match(fn, /setCorrectedSequences\(\(previous\) => new Set\(previous\)\.add\(correctingSequence\)\)/)
  assert.match(fn, /✓ Saved for your agent to review\. Nothing was changed automatically\./)
})

/* (bug-fix pass, Part A) The original plain text-link read as too subtle to
 * notice/click -- now an obvious, compact copper secondary button, reusing
 * the same --agent-copper-soft/-surface/-ink training/agent-language tokens
 * used elsewhere (e.g. .practice-chip-group.prominent), never a large
 * primary CTA. */
test('"Correct this" is an obvious, compact copper secondary button -- not a quiet text-link, and not a large primary CTA', () => {
  assert.match(styles, /\.coordination-correct-trigger \{[^}]*border: 1px solid var\(--agent-copper-soft\);[^}]*border-radius: 999px;[^}]*background: var\(--agent-copper-surface\);[^}]*color: var\(--agent-copper-ink\);/s)
  assert.doesNotMatch(styles, /\.coordination-correct-trigger \{[^}]*border: 0;/s, 'must not keep the old borderless text-link treatment')
})

test('"Correct this" keeps a visible focus ring for keyboard users', () => {
  assert.match(styles, /\.coordination-correct-trigger:focus-visible \{ outline: 2px solid var\(--agent-copper\);/)
})

test('Lucy\'s own coordination modal (inside ReferralCoordinationSurface) passes her own physician id as the viewer, never Chen\'s', () => {
  const fn = slice(referralSource, 'export function ReferralCoordinationSurface', 'export function AgentCoordinationModal')
  assert.match(fn, /viewerPhysicianId=\{referral\.referring_physician_id\}/)
  assert.doesNotMatch(fn, /viewerPhysicianId=\{referral\.receiving_physician_id\}/)
})

test('Chen\'s coordination modals (RequestReviewModal and every ChenDownstreamCard branch) pass her own physician id as the viewer, never Lucy\'s', () => {
  const fn = slice(referralSource, 'export function RequestReviewModal', 'export function markReferralJustAccepted')
  const occurrences = [...fn.matchAll(/viewerPhysicianId=\{(referral|liveReferral)\.receiving_physician_id\}/g)]
  assert.ok(occurrences.length >= 1, 'RequestReviewModal must pass Chen\'s own id')
  assert.doesNotMatch(fn, /viewerPhysicianId=\{(referral|liveReferral)\.referring_physician_id\}/)

  const downstream = slice(referralSource, 'export function ChenDownstreamCard', 'const CHEN_PATIENT_STAGE_META')
  const downstreamOccurrences = [...downstream.matchAll(/viewerPhysicianId=\{liveReferral\.receiving_physician_id\}/g)]
  assert.equal(downstreamOccurrences.length, 5, 'every AgentCoordinationModal render inside ChenDownstreamCard must pass Chen\'s own id')
  assert.doesNotMatch(downstream, /viewerPhysicianId=\{liveReferral\.referring_physician_id\}/)
})

test('"Correct Chen\'s Agent" / "Correct Lucy\'s Agent" cross-physician phrasing is never exposed -- the correction affordance is always generic "Correct this", gated purely on ownership', () => {
  assert.doesNotMatch(referralSource, /Correct (Chen|Lucy|Saruhashi)'s Agent/i)
})

test('corrections are structured for a future NLP-learning pass without exposing dead buttons now -- no "Confirm"/"Edit this preference" controls exist yet for an unbuilt interpretation pipeline', () => {
  const fn = modal()
  assert.doesNotMatch(fn, /Confirm preference|Edit this preference|Apply correction/i)
})

test('createAgentCorrection and getAgentCorrections are the only correction-related API helpers, and createAgentCorrection never implies immediate training', () => {
  assert.match(api, /export const createAgentCorrection = \(/)
  assert.match(api, /export const getAgentCorrections = \(patientId: string\)/)
  assert.doesNotMatch(api, /applyCorrection|trainFromCorrection|confirmCorrection/i)
})
