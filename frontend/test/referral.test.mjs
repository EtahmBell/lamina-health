import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { derivePhases, PHASE_FADE_MS, PHASE_HOLD_MS, restorePhase } from '../src/referralPhases.ts'

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
  status: 'submitted',
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
    event(12, 'referral_submitted', { actor: 'system', autonomy: 'automatic', metadata: { receiving_physician_id: 'physician-chen', specialty: 'Endocrinology' } }),
  ],
}

const NO_MISSING_REFERRAL = {
  ...baseReferral,
  status: 'submitted',
  receiving_requirements: [requirement('recent_hba1c', 'Recent HbA1c')],
  packet: { items: [{ key: 'recent_hba1c', label: 'Recent HbA1c', value: '9.6%', provenance: { source: 'patient_chart', attached_by: 'agent-lucy-saruhashi', attached_during: 'initial_assembly', observed_date: '2026-09-05' } }] },
  coordination_events: [
    event(1, 'referral_created', { actor: 'referring_agent' }),
    event(2, 'packet_assembled', { actor: 'referring_agent' }),
    event(3, 'preflight_started', { actor: 'receiving_agent' }),
    event(4, 'requirement_checked', { actor: 'receiving_agent', metadata: { requirement: 'recent_hba1c', result: 'satisfied' } }),
    event(5, 'preflight_completed', { actor: 'system' }),
    event(6, 'referral_ready', { actor: 'system' }),
    event(7, 'referral_submitted', { actor: 'system', autonomy: 'automatic', metadata: { receiving_physician_id: 'physician-chen', specialty: 'Endocrinology' } }),
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

test('a referral with a resolved missing requirement derives preparing -> checking -> missing -> found -> ready -> sent, using the real attached result', () => {
  const phases = derivePhases(READY_REFERRAL)
  assert.deepEqual(phases.map((phase) => phase.kind), ['preparing', 'checking', 'missing', 'found', 'ready', 'sent'])
  const missing = phases.find((phase) => phase.kind === 'missing')
  assert.equal(missing.requirementLabel, 'Recent renal function')
  const found = phases.find((phase) => phase.kind === 'found')
  assert.match(found.value, /Creatinine: 0\.9 mg\/dL/)
  assert.match(found.value, /eGFR: 97 mL\/min\/1\.73m2/)
  assert.equal(found.observedDate, '2026-07-20')
  const ready = phases.find((phase) => phase.kind === 'ready')
  assert.equal(ready.resolvedCount, 1)
})

test('a referral with nothing missing never shows a fabricated missing/found phase, but still ends in sent', () => {
  const phases = derivePhases(NO_MISSING_REFERRAL)
  assert.deepEqual(phases.map((phase) => phase.kind), ['preparing', 'checking', 'ready', 'sent'])
  assert.equal(phases.find((phase) => phase.kind === 'ready').resolvedCount, 0)
})

test('the UI does not stop permanently at ready -- a successfully submitted referral always reaches the sent phase after ready', () => {
  const phases = derivePhases(READY_REFERRAL).map((phase) => phase.kind)
  const readyIndex = phases.indexOf('ready')
  const sentIndex = phases.indexOf('sent')
  assert.ok(readyIndex > -1 && sentIndex > -1 && sentIndex === readyIndex + 1)
})

test('an unresolved referral never reaches the sent phase', () => {
  const phases = derivePhases(UNRESOLVED_REFERRAL).map((phase) => phase.kind)
  assert.ok(!phases.includes('sent'))
  assert.ok(!phases.includes('ready'))
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
  assert.match(view, /networkOpen && <ModalPortal><div className="post-flow-overlay"/)
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

/* -------------------------------------------------------- polish pass: transitions */

test('the content swap happens while still faded out, then a double-rAF lets the browser paint before fading back in -- fixing the flash/snap bug', () => {
  const start = referralSource.indexOf('const revealPhase =')
  const end = referralSource.indexOf('const start = async', start)
  const body = referralSource.slice(start, end)
  const fadeOutIndex = body.indexOf('setFading(true)')
  const swapIndex = body.indexOf('setVisiblePhase(phase)')
  const paintIndex = body.indexOf('await nextPaint()')
  const fadeInIndex = body.indexOf('setFading(false)')
  assert.ok(fadeOutIndex > -1 && swapIndex > -1 && paintIndex > -1 && fadeInIndex > -1, 'all four steps should be present')
  assert.ok(fadeOutIndex < swapIndex, 'fade out must start before content swaps')
  assert.ok(swapIndex < paintIndex, 'content swaps while still invisible')
  assert.ok(paintIndex < fadeInIndex, 'a real paint is awaited before fading back in -- no same-tick snap')
})

test('phase transitions use one continuously stable surface -- content is swapped in place, not unmounted into separate cards', () => {
  const view = recommendation()
  assert.match(view, /<ReferralCoordinationSurface key=\{selected\.physician_id\}/, 'only the whole surface remounts on candidate switch, never per-phase')
  assert.match(referralSource, /<div className=\{`referral-phase \$\{fading \? 'phase-fading' : ''\}`\}>/)
})

/* ------------------------------------------------------------- polish pass: pacing */

test('pacing was slowed from the previous pass -- each phase holds longer, and the crossfade itself is slightly longer', () => {
  assert.ok(PHASE_HOLD_MS.preparing >= 1500 && PHASE_HOLD_MS.preparing > 1300)
  assert.ok(PHASE_HOLD_MS.checking >= 1500 && PHASE_HOLD_MS.checking > 1300)
  assert.ok(PHASE_HOLD_MS.missing >= 1800 && PHASE_HOLD_MS.missing > 1500)
  assert.ok(PHASE_HOLD_MS.found >= 1800 && PHASE_HOLD_MS.found > 1500)
  assert.ok(PHASE_FADE_MS > 180)
})

test('the full Tonjit-style sequence (preparing, checking, missing, found, ready) still breathes without feeling sluggish', () => {
  const totalHold = PHASE_HOLD_MS.preparing + PHASE_HOLD_MS.checking + PHASE_HOLD_MS.missing + PHASE_HOLD_MS.found + PHASE_HOLD_MS.ready
  assert.ok(totalHold >= 7000, 'slower than before')
  assert.ok(totalHold <= 12000, 'still not sluggish')
})

/* --------------------------------------------------- polish pass: timeline dot color */

test('timeline dots are colored by which agent actually acted on the event, using the existing mineral/copper palette', () => {
  assert.match(referralSource, /className=\{`coordination-event actor-\$\{event\.actor \?\? 'system'\}`\}/)
  assert.match(styles, /\.coordination-event\.actor-referring_agent::before \{ background: var\(--mineral-deep\); \}/)
  assert.match(styles, /\.coordination-event\.actor-receiving_agent::before \{ background: var\(--copper\); \}/)
  assert.match(styles, /\.coordination-event\.actor-system::before \{ background: var\(--border\); \}/)
})

/* ------------------------------------------------------- modal portal (Part A/M) */

test('both activity modals mount through the shared ModalPortal, not inline inside Patient Detail', () => {
  assert.match(referralSource, /import \{ ModalPortal \} from '\.\/ModalPortal\.tsx'/)
  assert.match(referralSource, /return <ModalPortal><div className="post-flow-overlay"/)
  assert.match(app, /import \{ ModalPortal \} from '\.\/ModalPortal\.tsx'/)
  assert.match(app, /networkOpen && <ModalPortal><div className="post-flow-overlay"/)
})

test('ModalPortal renders into a dedicated node appended to document.body, a sibling of #root -- not a descendant of the patient page DOM', () => {
  const portalSource = readFileSync(new URL('../src/ModalPortal.tsx', import.meta.url), 'utf8')
  assert.match(portalSource, /document\.body\.appendChild\(node\)/)
  assert.match(portalSource, /createPortal\(children, root\)/)
  assert.doesNotMatch(portalSource, /getElementById\('root'\)/, 'must not portal back inside the app root')
})

test('ModalPortal locks body scroll while open and restores it cleanly on close', () => {
  const portalSource = readFileSync(new URL('../src/ModalPortal.tsx', import.meta.url), 'utf8')
  assert.match(portalSource, /document\.body\.style\.overflow = 'hidden'/)
  assert.match(portalSource, /document\.body\.style\.overflow = ''/)
  assert.match(portalSource, /return unlockBodyScroll/, 'cleanup runs on unmount')
})

test('the overlay still uses fixed viewport positioning and an opaque dialog background -- the portal is the structural fix, isolation is just cheap extra safety', () => {
  assert.match(styles, /\.post-flow-overlay \{ position: fixed; inset: 0;/)
  assert.match(styles, /\.post-flow-dialog \{[^}]*background-color: var\(--surface\);/)
})

test('the now-redundant chart isolation patch from the previous pass was removed, not left behind', () => {
  assert.doesNotMatch(styles, /\.trend-chart-plot \{[^}]*isolation: isolate/, 'the portal makes this unnecessary -- charts can never be an ancestor of the modal anymore')
})

/* --------------------------------------------------- polish pass: Tonjit demo reset */

test('a Tonjit referral-demo reset endpoint exists and is wired through the generic request helper', () => {
  const api = readFileSync(new URL('../src/api.ts', import.meta.url), 'utf8')
  assert.match(api, /resetTonjitDemo = \(\) => request<DemoResetResult>\('\/api\/workspace\/demo\/reset\/tonjit', \{ method: 'POST' \}\)/)
})

/* ------------------------------------------------------ referral handoff (Part B-L) */

test('the sent phase renders "Referral sent" / Awaiting specialist review, never the word accepted', () => {
  assert.match(referralSource, /case 'sent':/)
  assert.match(referralSource, /<h3>Referral sent\.<\/h3>/)
  assert.match(referralSource, /Awaiting specialist review/)
  assert.doesNotMatch(referralSource, /accepted/i)
})

test('the confirmation toast only fires from the real "sent" phase reveal, never from error/unresolved paths', () => {
  const toastTrigger = referralSource.match(/if \(phase\.kind === 'sent'\) setToastVisible\(true\)/g) ?? []
  assert.ok(toastTrigger.length >= 1, 'toast is triggered when the sent phase is revealed')
  assert.doesNotMatch(referralSource, /setToastVisible\(true\)[^}]*catch|catch[^}]*setToastVisible\(true\)/s, 'never set from the error path')
})

test('Toast is a small, non-blocking, auto-dismissing confirmation -- not the durable rail state', () => {
  assert.match(referralSource, /function Toast\(/)
  assert.match(referralSource, /window\.setTimeout\(onDismiss, TOAST_VISIBLE_MS\)/)
  assert.match(referralSource, /role="status" aria-live="polite"/)
})

test('"See agent coordination" remains available once submission completes, not just while ready', () => {
  assert.match(referralSource, /\{status === 'done' && referral && <button type="button" className="text-button" onClick=\{\(\) => setCoordinationOpen\(true\)\}>See agent coordination/)
})

test('the coordination modal footer reflects the real submitted status, derived from referral data not a hardcoded physician', () => {
  assert.match(referralSource, /referral\.status === 'submitted' \? '✓ Referral sent to the receiving specialist'/)
})

test('EVENT_TYPE_TITLES maps referral_submitted to a plain operational label, not fabricated reasoning', () => {
  const phasesSource = readFileSync(new URL('../src/referralPhases.ts', import.meta.url), 'utf8')
  assert.match(phasesSource, /referral_submitted: 'Referral sent'/)
})

/* ---------------------------------------------------------- hydration (reload fix) */

test('restorePhase restores the real terminal phase for a submitted referral -- sent, not the animated sequence', () => {
  const phase = restorePhase(READY_REFERRAL)
  assert.deepEqual(phase, { kind: 'sent' })
})

test('restorePhase restores the real terminal phase for a stuck/unresolved referral honestly', () => {
  const phase = restorePhase(UNRESOLVED_REFERRAL)
  assert.deepEqual(phase, { kind: 'unresolved', requirementLabels: ['Recent renal function'] })
})

test('restorePhase returns null for transient mid-flight statuses -- nothing real to restore, caller falls back to idle (Start referral)', () => {
  for (const status of ['draft', 'assembling', 'preflight']) {
    assert.equal(restorePhase({ ...baseReferral, status, coordination_events: [] }), null)
  }
})

test('ReferralCoordinationSurface hydrates from the backend on mount instead of assuming no referral exists', () => {
  assert.match(referralSource, /import \{ createReferral, getActiveReferral, runReferralPreflight/)
  assert.match(referralSource, /getActiveReferral\(patientId\)\.then/)
  assert.match(referralSource, /useState<'hydrating' \| 'idle' \| 'running' \| 'done' \| 'error'>\('hydrating'\)/)
})

test('a restored referral is only honored when it targets the currently selected physician, not a stale referral to a different candidate', () => {
  assert.match(referralSource, /existing\.receiving_physician_id === receivingPhysicianId/)
})

test('hydration never calls createReferral or runReferralPreflight -- it is a pure read, never a rerun/resubmit', () => {
  const hydrationEffectStart = referralSource.indexOf('useEffect(() => {\n    let ignore = false')
  const hydrationEffectEnd = referralSource.indexOf('}, [patientId, receivingPhysicianId])', hydrationEffectStart)
  const hydrationEffect = referralSource.slice(hydrationEffectStart, hydrationEffectEnd)
  assert.ok(hydrationEffect.length > 0, 'the hydration effect block should be found')
  assert.doesNotMatch(hydrationEffect, /createReferral\(|runReferralPreflight\(/)
  assert.match(hydrationEffect, /getActiveReferral/)
})

test('restoring a submitted referral still allows "See agent coordination" to open with the real restored events', () => {
  assert.match(referralSource, /setReferral\(existing\)/)
  assert.match(referralSource, /setStatus\('done'\)/)
  assert.match(referralSource, /\{status === 'done' && referral && <button type="button" className="text-button" onClick=\{\(\) => setCoordinationOpen\(true\)\}>See agent coordination/)
})

/* ------------------------------------------------------ patient-level referral lookup (backend) */

test('a patient-level active-referral lookup helper exists on the frontend API, scoped by patient only (no frontend-guessed referral IDs)', () => {
  const api = readFileSync(new URL('../src/api.ts', import.meta.url), 'utf8')
  assert.match(api, /getActiveReferral = \(patientId: string\) => request<Referral \| null>\(`\/api\/patients\/\$\{encodeURIComponent\(patientId\)\}\/referrals\/active`\)/)
})

/* -------------------------------------------------------- Recommended Physician spacing */

test('the Recommended Physician card has breathing room between the eyebrow and the physician identity row', () => {
  assert.match(styles, /\.best-fit-card\.compact \.best-fit-physician \{ padding: 8px 0 0; gap: 12px; \}/)
  assert.doesNotMatch(styles, /\.best-fit-card\.compact \.best-fit-physician \{ padding: 0; gap: 12px; \}/)
})
