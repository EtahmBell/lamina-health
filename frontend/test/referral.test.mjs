import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { derivePhases } from '../src/referralPhases.ts'

const app = readFileSync(new URL('../src/App.tsx', import.meta.url), 'utf8')
const referralSource = readFileSync(new URL('../src/Referral.tsx', import.meta.url), 'utf8')
const styles = readFileSync(new URL('../src/styles.css', import.meta.url), 'utf8')
const slice = (from, to) => app.slice(app.indexOf(from), app.indexOf(to))
const recommendation = () => slice('function RecommendationView', 'function PatientWorkspace')

const event = (sequence, event_type, overrides = {}) => ({
  sequence, event_type, actor: null, autonomy: null, summary: '', metadata: {}, created_at: '2026-10-12T00:00:00+00:00', ...overrides,
})

const requirement = (key, label, required = true) => ({ key, label, required, freshness_days: 180 })

const baseReferral = {
  id: 1, patient_id: 'patient-t2dm-003', referring_physician_id: 'agent-lucy-saruhashi',
  receiving_physician_id: 'physician-chen', specialty: 'Endocrinology',
  referral_question: 'Please evaluate for treatment intensification.', urgency: 'Routine outpatient referral',
  created_at: '2026-10-12T00:00:00+00:00', updated_at: '2026-10-12T00:00:00+00:00',
  receiving_requirements: [
    requirement('recent_hba1c', 'Recent HbA1c'),
    requirement('current_medications', 'Current diabetes medication list'),
    requirement('recent_renal_function', 'Recent renal function'),
    requirement('glucose_log', 'Glucose log or CGM data', false),
  ],
  requirement_results: [], packet: { items: [] }, coordination_events: [],
}

const READY_REFERRAL = {
  ...baseReferral,
  status: 'ready_for_review',
  packet: { items: [
    { key: 'recent_hba1c', label: 'Recent HbA1c', value: '9.6% on 2026-09-05', provenance: { source: 'patient_chart', attached_by: 'agent-lucy-saruhashi', attached_during: 'initial_assembly', observed_date: '2026-09-05' } },
    { key: 'recent_renal_function', label: 'Recent renal function', value: 'Creatinine: 0.9 mg/dL, eGFR: 97 mL/min/1.73m2 (2026-07-20)', provenance: { source: 'patient_chart', attached_by: 'agent-lucy-saruhashi', attached_during: 'preflight', observed_date: '2026-07-20' } },
  ] },
  coordination_events: [
    event(1, 'referral_created', { actor: 'referring_agent', autonomy: 'automatic' }),
    event(2, 'packet_assembled', { actor: 'referring_agent', autonomy: 'automatic' }),
    event(3, 'preflight_started', { actor: 'receiving_agent', autonomy: 'automatic' }),
    event(4, 'requirement_checked', { actor: 'receiving_agent', metadata: { requirement: 'recent_renal_function', result: 'missing_from_packet' } }),
    event(5, 'information_requested', { actor: 'receiving_agent', metadata: { requirement: 'recent_renal_function' } }),
    event(6, 'record_search_started', { actor: 'referring_agent', autonomy: 'automatic', metadata: { requirement: 'recent_renal_function' } }),
    event(7, 'record_found', { actor: 'referring_agent', autonomy: 'automatic', metadata: { requirement: 'recent_renal_function', observed_date: '2026-07-20' } }),
    event(8, 'information_attached', { actor: 'referring_agent', autonomy: 'automatic', metadata: { requirement: 'recent_renal_function' } }),
    event(9, 'requirement_rechecked', { actor: 'receiving_agent', metadata: { requirement: 'recent_renal_function', result: 'satisfied' } }),
    event(10, 'preflight_completed', { actor: 'system' }),
    event(11, 'referral_ready', { actor: 'system' }),
  ],
}

const NO_MISSING_REFERRAL = {
  ...baseReferral,
  status: 'ready_for_review',
  receiving_requirements: [requirement('recent_hba1c', 'Recent HbA1c')],
  packet: { items: [{ key: 'recent_hba1c', label: 'Recent HbA1c', value: '9.6%', provenance: { source: 'patient_chart', attached_by: 'agent-lucy-saruhashi', attached_during: 'initial_assembly', observed_date: '2026-09-05' } }] },
  coordination_events: [
    event(1, 'referral_created', { actor: 'referring_agent' }),
    event(2, 'packet_assembled', { actor: 'referring_agent' }),
    event(3, 'preflight_started', { actor: 'receiving_agent' }),
    event(4, 'requirement_checked', { actor: 'receiving_agent', metadata: { requirement: 'recent_hba1c', result: 'satisfied' } }),
    event(5, 'preflight_completed', { actor: 'system' }),
    event(6, 'referral_ready', { actor: 'system' }),
  ],
}

const UNRESOLVED_REFERRAL = {
  ...baseReferral,
  status: 'resolving',
  coordination_events: [
    event(1, 'referral_created', { actor: 'referring_agent' }),
    event(2, 'packet_assembled', { actor: 'referring_agent' }),
    event(3, 'preflight_started', { actor: 'receiving_agent' }),
    event(4, 'requirement_checked', { actor: 'receiving_agent', metadata: { requirement: 'recent_renal_function', result: 'missing_from_packet' } }),
    event(5, 'information_requested', { actor: 'receiving_agent', metadata: { requirement: 'recent_renal_function' } }),
    event(6, 'record_search_started', { actor: 'referring_agent', metadata: { requirement: 'recent_renal_function' } }),
    event(7, 'record_not_found', { actor: 'referring_agent', metadata: { requirement: 'recent_renal_function' } }),
    event(8, 'requirement_rechecked', { actor: 'receiving_agent', metadata: { requirement: 'recent_renal_function', result: 'missing_from_packet' } }),
    event(9, 'physician_action_required', { actor: 'system', autonomy: 'physician_required', metadata: { requirement: 'recent_renal_function' } }),
  ],
}

/* ------------------------------------------------------------ phase derivation (Part U) */

test('a referral with a resolved missing requirement derives preparing -> checking -> missing -> found -> ready, using the real attached result', () => {
  const phases = derivePhases(READY_REFERRAL)
  assert.deepEqual(phases.map((phase) => phase.kind), ['preparing', 'checking', 'missing', 'found', 'ready'])
  const missing = phases.find((phase) => phase.kind === 'missing')
  assert.equal(missing.requirementLabel, 'Recent renal function')
  const found = phases.find((phase) => phase.kind === 'found')
  assert.match(found.value, /Creatinine: 0\.9 mg\/dL/)
  assert.match(found.value, /eGFR: 97 mL\/min\/1\.73m2/)
  assert.equal(found.observedDate, '2026-07-20')
  const ready = phases.find((phase) => phase.kind === 'ready')
  assert.equal(ready.resolvedCount, 1)
})

test('a referral with nothing missing never shows a fabricated missing/found phase', () => {
  const phases = derivePhases(NO_MISSING_REFERRAL)
  assert.deepEqual(phases.map((phase) => phase.kind), ['preparing', 'checking', 'ready'])
  assert.equal(phases.find((phase) => phase.kind === 'ready').resolvedCount, 0)
})

test('an unresolved referral derives the real unresolved phase instead of falsely rendering ready', () => {
  const phases = derivePhases(UNRESOLVED_REFERRAL)
  assert.deepEqual(phases.map((phase) => phase.kind), ['preparing', 'checking', 'missing', 'unresolved'])
  assert.doesNotMatch(phases.map((phase) => phase.kind).join(','), /ready/)
  const unresolved = phases.find((phase) => phase.kind === 'unresolved')
  assert.deepEqual(unresolved.requirementLabels, ['Recent renal function'])
})

/* --------------------------------------------------------- referring UI (Part S) */

test('Start referral renders for the real flow via ReferralCoordinationSurface, gated on the real referral question, not a patient name', () => {
  const view = recommendation()
  assert.match(view, /referralQuestion\s*\n?\s*\?\s*<ReferralCoordinationSurface/)
  assert.doesNotMatch(view, /TONJIT_ID|patient\.name === |patient\.display_name === /, 'the referral surface is gated on referral_question data, never a patient-name/id check')
  assert.doesNotMatch(referralSource, /Tonjit/i, 'no patient-name-specific branching anywhere in Referral.tsx')
})

test('ReferralCoordinationSurface calls the real referral API helpers, never a local fabrication', () => {
  assert.match(referralSource, /createReferral\(patientId, receivingPhysicianId\)/)
  assert.match(referralSource, /runReferralPreflight\(created\.id/)
  assert.doesNotMatch(referralSource, /setTimeout\(\s*\(\)\s*=>\s*show/i, 'no setTimeout(showFakeEvent) pattern')
})

test('the legacy local "prepared for demo" referral path is preserved for patients without a stored referral question (Jordan/Maria)', () => {
  const view = recommendation()
  assert.match(view, /Referral prepared for demo/)
  assert.match(view, /No referral was transmitted\./)
})

test('no receiving-side accept/redirect/clarification UI exists yet', () => {
  assert.doesNotMatch(app, /Accept referral|Decline referral|Redirect referral|Request clarification/i)
  assert.doesNotMatch(referralSource, /Accept referral|Decline referral|Redirect referral|Request clarification/i)
})

test('an unresolved workflow renders a truthful "needs your input" state, never a fabricated ready state', () => {
  assert.match(referralSource, /Needs your input/)
  assert.match(referralSource, /could not resolve/)
})

/* -------------------------------------------------------------- modals (Part T) */

test('See agent coordination opens the AgentCoordinationModal, built from real coordination events', () => {
  assert.match(referralSource, /See agent coordination/)
  assert.match(referralSource, /referral\.coordination_events\.map/)
  assert.match(referralSource, /role="dialog" aria-modal="true" aria-label="Agent coordination"/)
})

test('the coordination modal and consultation-detail modal share the same post-flow-overlay/post-flow-dialog shell and close behavior', () => {
  assert.match(referralSource, /className="post-flow-overlay"/)
  assert.match(referralSource, /className="post-flow-dialog coordination-dialog"/)
  assert.match(app, /className="post-flow-dialog consult-detail-dialog"/)
  assert.match(referralSource, /event\.key === 'Escape'/)
  assert.match(recommendation(), /event\.key === 'Escape'/)
})

test('consultation detail now opens in a modal, not an inline expansion constrained to the right rail', () => {
  const view = recommendation()
  assert.match(view, /View consultation details/)
  assert.match(view, /networkOpen && <div className="post-flow-overlay"/)
  assert.doesNotMatch(view, /networkOpen && <div className="network-record">/, 'the old inline-expansion structure is gone')
})

test('neither modal exposes hidden chain-of-thought language', () => {
  for (const source of [app, referralSource]) {
    assert.doesNotMatch(source, /chain of thought/i)
    assert.doesNotMatch(source, /reasoning trace/i)
    assert.doesNotMatch(source, /hidden reasoning/i)
  }
  assert.match(app, /Hidden model chain-of-thought is not stored or shown\./)
})

test('the coordination dialog has a sensible max width and relies on the shared scrollable dialog shell', () => {
  assert.ok(styles.includes('.coordination-dialog, .consult-detail-dialog { width: min(100%, 640px); }'))
  assert.match(styles, /\.post-flow-dialog \{[^}]*max-height: 86vh;[^}]*overflow-y: auto/)
})

/* ---------------------------------------------------------- right rail stays compact (Part M) */

test('the right rail surface itself has no nested scroll container -- detail lives in the modal, not inline', () => {
  assert.doesNotMatch(referralSource, /overflow-y: auto/)
  assert.doesNotMatch(referralSource, /className="referral-coordination-surface[^"]*scroll/)
})

/* ------------------------------------------------------------- reduced motion (Part G/U) */

test('reduced motion disables the phase crossfade and the status pulse, without breaking functionality', () => {
  assert.match(referralSource, /prefersReducedMotion\(\)/)
  assert.match(referralSource, /if \(!prefersReducedMotion\(\)\) \{/)
  assert.match(styles, /@media \(prefers-reduced-motion: reduce\) \{ \.referral-phase \{ transition: none; \} \}/)
  assert.match(styles, /@media \(prefers-reduced-motion: reduce\) \{ \.status-label\.pulse \{ animation: none; \} \}/)
})
