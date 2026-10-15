import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { derivePhases, formatSubmittedAt, PHASE_FADE_MS, PHASE_HOLD_MS, restorePhase, SUCCESS_WASH_HOLD_MS } from '../src/referralPhases.ts'

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
  const sent = phases.find((phase) => phase.kind === 'sent')
  assert.equal(sent.resolvedCount, 1)
  assert.equal(sent.submittedAt, '2026-10-12T00:00:00+00:00')
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

test('ReferralCoordinationSurface renders in Referral mode, gated on the real referral question, not a patient name', () => {
  const view = recommendation()
  assert.match(view, /if \(referralQuestion && viewMode === 'referral'\) \{/)
  assert.match(view, /<ReferralCoordinationSurface/)
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

test('Accept referral is the only functional receiving-side decision -- no decline/redirect/clarification workflow exists', () => {
  assert.match(referralSource, /Accept referral/)
  assert.doesNotMatch(app, /Decline referral|Redirect referral|Request clarification/i)
  assert.doesNotMatch(referralSource, /Decline referral|Redirect referral|Request clarification/i)
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
  const start = referralSource.indexOf('const crossfade =')
  const end = referralSource.indexOf('const revealPhase =', start)
  const body = referralSource.slice(start, end)
  const fadeOutIndex = body.indexOf('setFading(true)')
  const swapIndex = body.indexOf('apply()')
  const paintIndex = body.indexOf('await nextPaint()')
  const fadeInIndex = body.indexOf('setFading(false)')
  assert.ok(fadeOutIndex > -1 && swapIndex > -1 && paintIndex > -1 && fadeInIndex > -1, 'all four steps should be present')
  assert.ok(fadeOutIndex < swapIndex, 'fade out must start before content swaps')
  assert.ok(swapIndex < paintIndex, 'content swaps while still invisible')
  assert.ok(paintIndex < fadeInIndex, 'a real paint is awaited before fading back in -- no same-tick snap')
})

test('phase transitions use one continuously stable surface -- content is swapped in place, not unmounted into separate cards', () => {
  const view = recommendation()
  assert.match(view, /<ReferralCoordinationSurface\s*\n\s*key=\{selected\.physician_id\}/, 'only the whole surface remounts on candidate switch, never per-phase')
  assert.match(referralSource, /<div className=\{`referral-phase \$\{fading \? 'phase-fading' : ''\}`\}>/)
})

/* ------------------------------------------------------------- polish pass: pacing */

test('the crossfade duration is a slow, soft dissolve (~450-600ms), not the previous snappy ~260ms fade', () => {
  assert.ok(PHASE_FADE_MS >= 450 && PHASE_FADE_MS <= 600, `expected 450-600ms, got ${PHASE_FADE_MS}`)
  assert.match(styles, /\.referral-phase \{ width: 100%; transition: opacity 500ms ease-in-out; \}/)
})

test('the substantive phases (preparing/checking/missing/found) each hold roughly 1.8-2.2 seconds so they can actually be read', () => {
  for (const kind of ['preparing', 'checking', 'missing', 'found']) {
    assert.ok(PHASE_HOLD_MS[kind] >= 1800 && PHASE_HOLD_MS[kind] <= 2200, `${kind}: expected 1800-2200ms, got ${PHASE_HOLD_MS[kind]}`)
  }
})

test('the success-wash hold is also roughly 1.8-2.2 seconds, matching the other substantive phases', () => {
  assert.ok(SUCCESS_WASH_HOLD_MS >= 1800 && SUCCESS_WASH_HOLD_MS <= 2200, `expected 1800-2200ms, got ${SUCCESS_WASH_HOLD_MS}`)
})

test('the full live referral sequence lands in a demo-acceptable ballpark -- slower than the previous pass, not absurdly long', () => {
  const crossfades = 6 // checking, missing, found, ready, wash-in, wash-out
  const holds = PHASE_HOLD_MS.preparing + PHASE_HOLD_MS.checking + PHASE_HOLD_MS.missing + PHASE_HOLD_MS.found
    + PHASE_HOLD_MS.ready + SUCCESS_WASH_HOLD_MS + PHASE_HOLD_MS.sent
  const total = holds + crossfades * PHASE_FADE_MS
  assert.ok(total > 10000, 'slower than the previous pass')
  assert.ok(total < 20000, 'still a bounded, non-absurd demo sequence')
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

test('the durable sent state renders "Awaiting Dr. X\'s review" as the primary headline -- no standalone "Referral sent." heading, and never claims acceptance itself', () => {
  assert.match(referralSource, /case 'sent':/)
  const sentCaseSource = referralSource.slice(referralSource.indexOf("case 'sent':"), referralSource.indexOf("case 'accepted':"))
  assert.doesNotMatch(sentCaseSource, /<h3>Referral sent\.<\/h3>/, 'the repetitive standalone heading was removed')
  assert.match(sentCaseSource, /<h3>Awaiting Dr\. \{who\}'s review<\/h3>/)
  assert.doesNotMatch(sentCaseSource, /accepted/i, 'the sent/submitted phase never claims the referral has been accepted -- that is a separate, later, real physician action')
})

test('the brief completion overlay and the durable card both derive their copy from the same real phase data, never two conflicting claims', () => {
  assert.match(referralSource, /className=\{`referral-handoff-overlay \$\{justCompleted \? 'visible' : ''\}`\}/)
  assert.match(referralSource, /<h3>Referral handoff complete<\/h3>/)
  assert.match(referralSource, /<p>Sent to \{receivingPhysicianName\}<\/p>/)
  assert.match(referralSource, /const sentResolvedCount = visiblePhase\.kind === 'sent' \? visiblePhase\.resolvedCount : 0/)
  assert.match(referralSource, /\{sentResolvedCount > 0 && <small>\{resolvedSummary\(sentResolvedCount\)\} automatically\.<\/small>\}/)
})

test('"Referral handoff complete" is distinct from "Referral complete" -- it never implies the specialist has accepted', () => {
  assert.match(referralSource, /Referral handoff complete/)
  assert.doesNotMatch(referralSource, />Referral complete</)
})

test('the completion overlay covers the entire card (position: absolute over the position: relative card), not just the inner phase text -- so it reads as a true card takeover with no layout jump', () => {
  assert.match(styles, /\.referral-handoff-overlay \{ position: absolute; inset: 0;/)
  assert.match(styles, /\.best-fit-card\.referral-card \{ padding-bottom: 26px; position: relative; \}/)
})

test('the completion overlay is centered both horizontally and vertically within the card', () => {
  assert.match(styles, /\.referral-handoff-overlay \{[^}]*align-items: center;[^}]*justify-content: center;[^}]*text-align: center;/)
})

test('the overlay has no links, status pill, or match information -- for this moment the completion message IS the card', () => {
  const overlaySource = referralSource.slice(referralSource.indexOf('<div className={`referral-handoff-overlay'), referralSource.indexOf('{coordinationOpen'))
  assert.doesNotMatch(overlaySource, /status-label|text-button|referral-mode-links/)
})

test('the durable card shows a quiet resolved-item + submitted-timestamp metadata line, sourced from real referral/event data', () => {
  assert.match(referralSource, /className="referral-submission-meta"/)
  assert.match(referralSource, /phase\.submittedAt \? ` · Submitted \$\{formatSubmittedAt\(phase\.submittedAt\)\}` : ''/)
})

test('the old bottom-right toast was removed -- the full-card success wash is now the primary (and only) confirmation', () => {
  assert.doesNotMatch(referralSource, /function Toast\(/)
  assert.doesNotMatch(referralSource, /lamina-toast/)
  assert.doesNotMatch(styles, /\.lamina-toast/)
})

test('the active-episode card exposes "Review handoff" as the primary action and the three artifact links directly, with no "Back to referral details" modal in between (demo-consolidation pass, Part 1-2)', () => {
  assert.match(referralSource, /\{status === 'done' && referral && !justCompleted && handoff && <div className="referral-mode-links">/)
  assert.match(referralSource, /onClick=\{openHandoff\}>Review handoff →<\/button>/)
  assert.match(referralSource, /\{status === 'done' && referral && !justCompleted && <div className="referral-artifact-links">/)
  assert.match(referralSource, /onClick=\{\(\) => setPacketOpen\(true\)\}>View referral packet →<\/button>/)
  assert.match(referralSource, /onClick=\{\(\) => setCoordinationOpen\(true\)\}>See agent coordination →<\/button>/)
  assert.doesNotMatch(referralSource, /function ReferralDetailsModal/, 'the modal was removed entirely -- direct links replace it')
  assert.doesNotMatch(referralSource, /Back to referral details/)
})

test('the success wash state appears only via the real "sent" phase reveal -- never from the error/unresolved paths', () => {
  const revealSentSource = referralSource.slice(referralSource.indexOf('const revealSentPhase ='), referralSource.indexOf('const start = async'))
  assert.match(revealSentSource, /setWash\(true\)/)
  assert.doesNotMatch(referralSource, /catch[\s\S]{0,200}setWash\(true\)/, 'never set from the error-catch path')
})

test('the success wash honors reduced motion -- a short static hold instead of an animated crossfade, but the completion moment still occurs', () => {
  const revealSentSource = referralSource.slice(referralSource.indexOf('const revealSentPhase ='), referralSource.indexOf('const start = async'))
  assert.match(revealSentSource, /prefersReducedMotion\(\) \? 500 : SUCCESS_WASH_HOLD_MS/)
})

test('the full-card success-wash background transition respects prefers-reduced-motion', () => {
  assert.match(styles, /@media \(prefers-reduced-motion: reduce\) \{\s*\n\s*\.best-fit-card\.referral-card \{ transition: none; \}/)
})

test('the success wash makes no backend calls itself -- create+preflight already happened before any phase was revealed', () => {
  const revealSentSource = referralSource.slice(referralSource.indexOf('const revealSentPhase ='), referralSource.indexOf('const start = async'))
  assert.doesNotMatch(revealSentSource, /createReferral\(|runReferralPreflight\(/)
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
  assert.deepEqual(phase, { kind: 'sent', resolvedCount: 1, submittedAt: '2026-10-12T00:00:00+00:00' })
})

test('restorePhase restores the real terminal phase for a stuck/unresolved referral honestly', () => {
  const phase = restorePhase(UNRESOLVED_REFERRAL)
  assert.deepEqual(phase, { kind: 'unresolved', requirementLabels: ['Recent renal function'] })
})

test('restorePhase returns null only for draft (impossible in persisted data) -- assembling/preflight restore to the static preparing phase, never idle', () => {
  assert.equal(restorePhase({ ...baseReferral, status: 'draft', coordination_events: [] }), null)
  for (const status of ['assembling', 'preflight']) {
    assert.deepEqual(restorePhase({ ...baseReferral, status, coordination_events: [] }), { kind: 'preparing' })
  }
})

test('RecommendationView (not ReferralCoordinationSurface) hydrates from the backend on mount instead of assuming no referral exists -- it owns viewMode', () => {
  const view = recommendation()
  assert.match(view, /getActiveReferral\(consultation\.patient_id\)\.then/)
  assert.match(view, /const \[viewMode, setViewMode\] = useState<'discovery' \| 'referral'>\('discovery'\)/)
  assert.match(view, /const \[activeReferral, setActiveReferral\] = useState<Referral \| null>\(null\)/)
  assert.doesNotMatch(referralSource, /getActiveReferral/, 'ReferralCoordinationSurface itself no longer does its own hydration lookup')
})

test('a restored referral syncs the selected candidate to whatever physician it was actually created for', () => {
  const view = recommendation()
  assert.match(view, /setSelectedId\(existing\.receiving_physician_id\)/)
})

test('hydration never calls createReferral or runReferralPreflight -- it is a pure read, never a rerun/resubmit', () => {
  const view = recommendation()
  const hydrationEffectStart = view.indexOf('if (!referralQuestion) return')
  const hydrationEffectEnd = view.indexOf('}, [consultation.patient_id, referralQuestion])', hydrationEffectStart)
  const hydrationEffect = view.slice(hydrationEffectStart, hydrationEffectEnd)
  assert.ok(hydrationEffect.length > 0, 'the hydration effect block should be found')
  assert.doesNotMatch(hydrationEffect, /createReferral\(|runReferralPreflight\(/)
  assert.match(hydrationEffect, /getActiveReferral/)
})

test('ReferralCoordinationSurface accepts a restoredReferral prop and jumps straight to its real terminal state -- no animation, no API call', () => {
  assert.match(referralSource, /restoredReferral: Referral \| null/)
  assert.match(referralSource, /useState<'running' \| 'done' \| 'error'>\(restoredReferral \? 'done' : 'running'\)/)
  assert.match(referralSource, /useState<DisplayPhase \| null>\(restoredReferral \? restorePhase\(restoredReferral\) : null\)/)
  assert.match(referralSource, /if \(restoredReferral\) return \/\/ already hydrated synchronously via initial state above/)
})

test('restoring a submitted referral still allows "See agent coordination" to open with the real restored events', () => {
  assert.match(referralSource, /useState<Referral \| null>\(restoredReferral\)/)
  assert.match(referralSource, /\{status === 'done' && referral && !justCompleted && <div className="referral-artifact-links">/)
  assert.match(referralSource, /onClick=\{\(\) => setCoordinationOpen\(true\)\}>See agent coordination →<\/button>/)
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

/* ========================================================================
 * Discovery <-> Referral mode (this pass)
 * ===================================================================== */

const referralModeBranch = () => {
  const view = recommendation()
  const start = view.indexOf("if (referralQuestion && viewMode === 'referral')")
  const end = view.indexOf('// DISCOVERY MODE', start)
  return view.slice(start, end)
}
const discoveryModeBranch = () => {
  const view = recommendation()
  return view.slice(view.indexOf('// DISCOVERY MODE'))
}

/* -------------------------------------------------------------- Part S */

test('Start referral switches the frontend viewMode to referral -- a presentation switch only, never a backend status', () => {
  assert.match(discoveryModeBranch(), /onClick=\{startReferral\}>Start referral/)
  const startReferralSource = recommendation().slice(recommendation().indexOf('const startReferral = '), recommendation().indexOf('const activeReferralPhysician ='))
  assert.match(startReferralSource, /setViewMode\('referral'\)/)
  assert.doesNotMatch(startReferralSource, /fetch\(|request\(|createReferral\(/, 'the mode switch itself makes no backend call -- ReferralCoordinationSurface does that once rendered')
})

test('the "Your agent got back to you / specialist ready for review" panel does not exist in the Referral-mode branch', () => {
  assert.doesNotMatch(referralModeBranch(), /Your agent got back to you/)
  assert.doesNotMatch(referralModeBranch(), /A specialist is ready for your review/)
})

test('"RECOMMENDED PHYSICIAN" is not the primary heading in Referral mode -- "Referral to" replaces it', () => {
  assert.doesNotMatch(referralModeBranch(), /Recommended physician|Selected specialist/)
  assert.match(referralModeBranch(), /<p className="best-fit-kicker">Referral to<\/p>/)
})

test('the physician identity (avatar/name/specialty) remains visible in Referral mode', () => {
  assert.match(referralModeBranch(), /className="best-fit-physician"/)
  assert.match(referralModeBranch(), /\{cleanName\(selected\.physician_name\)\}/)
  assert.match(referralModeBranch(), /\{selected\.specialty\}/)
})

test('recommendation rationale, fit indicator, and feedback are not rendered in Referral mode', () => {
  assert.doesNotMatch(referralModeBranch(), /fit-rationale|fit-indicator|fit-meta/)
  assert.doesNotMatch(referralModeBranch(), /Does this reflect how you would practice/)
})

test('match details / alternatives / consult detail are not rendered in Referral mode -- they belong to Discovery', () => {
  assert.doesNotMatch(referralModeBranch(), /Review match details|Other referral options|How your agent handled this/)
})

test('"Back to match options" appears in Referral mode, using exactly that wording', () => {
  assert.match(referralModeBranch(), /← Back to match options/)
  assert.doesNotMatch(referralModeBranch(), /discovery mode/i, '"discovery mode" is internal terminology, never user-facing copy')
})

/* -------------------------------------------------------------- Part T */

test('Back to match options only flips the frontend viewMode -- no referral-cancelling/un-submitting API call', () => {
  assert.match(referralModeBranch(), /onClick=\{\(\) => setViewMode\('discovery'\)\}>← Back to match options/)
})

test('Discovery mode shows a quiet "referral active" notice and "Return to active referral" once a referral exists', () => {
  const discovery = discoveryModeBranch()
  assert.match(discovery, /\{activeReferral && <div className="referral-active-notice">/)
  assert.match(discovery, /Referral active with \$\{activeReferralPhysicianLabel\}/)
  assert.match(discovery, /Awaiting specialist review/)
  assert.match(discovery, /onClick=\{\(\) => setViewMode\('referral'\)\}>Return to active referral/)
})

test('Discovery mode\'s "referral active" notice shows an accepted-specific message once the referral is accepted, never the stale "awaiting review" wording', () => {
  const discovery = discoveryModeBranch()
  assert.match(discovery, /activeReferral\.status === 'accepted'/)
  assert.match(discovery, /Referral accepted by \$\{activeReferralPhysicianLabel\}/)
  assert.match(discovery, /Added to their care/)
})

test('Dr. Chen\'s card shows a real episode-status CTA ("Referral active"/"Referral completed") instead of "Start referral" once that physician is the active referral\'s destination -- never silently re-rendering Start referral and risking a second referral (demo-consolidation pass, Part 3/4)', () => {
  const discovery = discoveryModeBranch()
  assert.match(discovery, /activeReferral && activeReferral\.receiving_physician_id === selected\.physician_id/)
  assert.match(discovery, /className="referral-episode-status"/)
  assert.match(discovery, /activeReferral\.status === 'consult_returned' \? 'Referral completed' : 'Referral active'/)
  assert.match(discovery, /activeReferral\.status === 'consult_returned' \? 'View specialty-care episode →' : 'Return to current referral →'/)
})

test('selecting a different physician while a referral is active cannot silently start/replace it -- a quiet locked note appears instead of Start referral', () => {
  const discovery = discoveryModeBranch()
  assert.match(discovery, /: activeReferral\s*\n\s*\? <p className="referral-locked-note">A referral is already active with \{activeReferralPhysicianLabel\}\.<\/p>/)
})

test('Review match details and Other referral options remain accessible in Discovery mode even when a referral is already active', () => {
  const discovery = discoveryModeBranch()
  assert.match(discovery, /Review match details/)
  assert.match(discovery, /Other referral options/)
})

/* -------------------------------------------------------------- Part U */

test('"View referral packet" opens a ModalPortal-based modal rendering the real packet question and items', () => {
  assert.match(referralSource, /export function ReferralPacketModal/)
  const modalSource = referralSource.slice(referralSource.indexOf('export function ReferralPacketModal'), referralSource.indexOf('RECEIVING SIDE'))
  assert.match(modalSource, /<ModalPortal>/)
  assert.match(modalSource, /role="dialog" aria-modal="true" aria-label="Referral packet"/)
  assert.match(modalSource, /\{referral\.referral_question\}/)
  assert.match(modalSource, /referral\.packet\.items\.map/)
})

test('the packet modal renders label/value/provenance generically from PacketItem data, never a hardcoded Tonjit string', () => {
  const modalSource = referralSource.slice(referralSource.indexOf('export function ReferralPacketModal'), referralSource.indexOf('RECEIVING SIDE'))
  assert.match(modalSource, /<strong>\{item\.label\}<\/strong>/)
  assert.match(modalSource, /<p>\{item\.value\}<\/p>/)
  assert.doesNotMatch(modalSource, /Tonjit|recent_renal_function|Creatinine|HbA1c/i)
})

test('an item added during preflight shows generic provenance -- "added during preflight", derived from PacketItemProvenance, not hardcoded to any one requirement', () => {
  const fnSource = referralSource.slice(referralSource.indexOf('function packetItemProvenanceLine'), referralSource.indexOf('export function ReferralPacketModal'))
  assert.match(fnSource, /item\.provenance\.attached_during !== 'preflight'/)
  assert.match(fnSource, /Added during agent preflight/)
  assert.doesNotMatch(fnSource, /recent_renal_function|renal/i, 'generic for any future preflight-attached item, not just renal function')
})

test('the referral packet modal closes via the shared close button/Escape, consistent with the other activity modals', () => {
  const modalSource = referralSource.slice(referralSource.indexOf('export function ReferralPacketModal'), referralSource.indexOf('RECEIVING SIDE'))
  assert.match(modalSource, /post-flow-close.*onClick=\{onClose\}/)
  assert.match(modalSource, /event\.key === 'Escape'/)
})

/* -------------------------------------------------------------- Part V */

test('switching back to the restored Referral mode via "Return to active referral" triggers no new backend call -- it reuses already-hydrated referral data', () => {
  const discovery = discoveryModeBranch()
  const returnButton = discovery.slice(discovery.indexOf('Return to active referral') - 120, discovery.indexOf('Return to active referral') + 30)
  assert.doesNotMatch(returnButton, /fetch\(|request\(|createReferral\(|runReferralPreflight\(|getActiveReferral\(/)
})

test('hydration only switches to Referral mode when a real restorable phase exists -- otherwise Discovery (the default) is left untouched', () => {
  const view = recommendation()
  const hydrationBlock = view.slice(view.indexOf('if (!referralQuestion) return'), view.indexOf("}, [consultation.patient_id, referralQuestion])"))
  assert.match(hydrationBlock, /setActiveReferral\(existing\)/, 'the prior episode is always tracked, even if its view is not restored')
  assert.match(hydrationBlock, /if \(phase\) \{\s*\n\s*setSelectedId\(existing\.receiving_physician_id\)\s*\n\s*setViewMode\('referral'\)\s*\n\s*\}/, 'setViewMode is only called inside the `if (phase)` branch, not unconditionally')
})

test('right after an explicit re-consult, hydration still tracks the prior episode (for duplicate-guard/CTA purposes) but does not snap the view back into it (demo-consolidation pass, Part 6)', () => {
  const view = recommendation()
  const hydrationBlock = view.slice(view.indexOf('if (!referralQuestion) return'), view.indexOf("}, [consultation.patient_id, referralQuestion])"))
  assert.match(hydrationBlock, /setActiveReferral\(existing\)[\s\S]*?if \(justConsulted\) return/)
  const justConsultedIndex = hydrationBlock.indexOf('if (justConsulted) return')
  const phaseIndex = hydrationBlock.indexOf('const phase = restorePhase(existing)')
  assert.ok(justConsultedIndex > -1 && phaseIndex > -1 && justConsultedIndex < phaseIndex, 'the early return must come before any view-mode-switching logic')
})

/* ========================================================================
 * Spacing / vertical rhythm (this pass, Part A)
 * ===================================================================== */

test('the referral card uses a deliberate spacing hierarchy, not one global margin bump', () => {
  assert.match(styles, /\.best-fit-card\.referral-card \.best-fit-physician \{ padding-top: 12px; \}/)
  assert.match(styles, /\.best-fit-card\.referral-card \.referral-coordination-surface \{ margin-top: 22px; \}/)
  assert.match(styles, /\.referral-coordination-surface h3 \{ margin: 14px 0 0;/)
  assert.match(styles, /\.referral-coordination-surface small \{ display: block; margin-top: 10px;/)
  assert.match(styles, /\.referral-mode-links \{[^}]*margin-top: 18px;/)
  assert.match(styles, /\.best-fit-card\.referral-card \{ padding-bottom: 26px;/)
})

/* ========================================================================
 * Final completion polish pass (slower crossfade + centered takeover)
 * ===================================================================== */

test('the sequence never stacks old-phase content, the completion overlay, and durable content at once -- revealSentPhase swaps state atomically, one clean moment at a time', () => {
  const revealSentSource = referralSource.slice(referralSource.indexOf('const revealSentPhase ='), referralSource.indexOf('const start = async'))
  // step 1: crossfade swaps visiblePhase + the wash (local + mirrored-up) together (one atomic apply())
  assert.match(revealSentSource, /await crossfade\(\(\) => \{ setVisiblePhase\(phase\); setWash\(true\) \}\)/)
  // step 2: the wash flips off on its own (the overlay's own CSS transition owns this fade)
  assert.match(revealSentSource, /setWash\(false\)/)
})

test('the overlay is a pure CSS opacity transition (no JS double-rAF needed for its own fade) for the completion text', () => {
  assert.match(styles, /\.referral-handoff-overlay \{[^}]*opacity: 0;[^}]*transition: opacity 500ms ease-in-out;/)
  assert.match(styles, /\.referral-handoff-overlay\.visible \{ opacity: 1;/)
})

/* ========================================================================
 * Success-wash card-shape fix (geometry bug: inset:0 + border-radius:inherit
 * against an asymmetric-bordered card mismatched at the corners)
 * ===================================================================== */

test('the wash background lives on the card itself, not on a separately-positioned/radiused overlay -- the root cause of the corner mismatch', () => {
  assert.doesNotMatch(styles, /\.referral-handoff-overlay \{[^}]*background:/, 'the overlay must not carry its own background any more')
  assert.doesNotMatch(styles, /\.referral-handoff-overlay \{[^}]*border-radius: inherit/, 'border-radius: inherit against an inset box was the actual bug')
  assert.match(styles, /\.best-fit-card\.referral-card\.handoff-wash \{ background: rgb\(52 79 93 \/ 100%\); \}/)
})

/* ========================================================================
 * Polish pass, Part B: an opaque card BACKGROUND alone cannot hide the
 * card's own foreground children (avatar/kicker/"Sent" pill/phase text),
 * since a background always paints beneath its own content regardless of
 * that background's opacity. Fixed by explicitly fading the foreground
 * content out in lockstep with the wash, never a z-index-only trick and
 * never a second overlay box that could mismatch the card's corners.
 * ===================================================================== */

test('the wash is effectively fully opaque, not merely "mostly opaque"', () => {
  assert.match(styles, /\.best-fit-card\.referral-card\.handoff-wash \{ background: rgb\(52 79 93 \/ 100%\); \}/)
})

test('underlying card content (back-button, kicker, physician row, current phase content) is explicitly faded out during the wash, in lockstep with it -- never left to bleed through under a transparent overlay', () => {
  assert.match(styles, /\.best-fit-card\.referral-card\.handoff-wash > \.back-to-match,\s*\.best-fit-card\.referral-card\.handoff-wash > \.best-fit-kicker,\s*\.best-fit-card\.referral-card\.handoff-wash > \.best-fit-physician,\s*\.best-fit-card\.referral-card\.handoff-wash \.referral-phase \{\s*opacity: 0; pointer-events: none; transition: opacity 500ms ease-in-out;\s*\}/)
})

test('the hidden-during-wash content also gets a reduced-motion override, so it snaps instead of animating', () => {
  assert.match(styles, /@media \(prefers-reduced-motion: reduce\) \{\s*\.best-fit-card\.referral-card \{ transition: none; \}\s*\.best-fit-card\.referral-card\.handoff-wash > \.back-to-match,\s*\.best-fit-card\.referral-card\.handoff-wash > \.best-fit-kicker,\s*\.best-fit-card\.referral-card\.handoff-wash > \.best-fit-physician,\s*\.best-fit-card\.referral-card\.handoff-wash \.referral-phase \{ transition: none; \}/)
})

/* ========================================================================
 * Closed-loop referral follow-up pass, item 1: the wash looked faint/
 * translucent against a near-white card -- a pale tint at 96% opacity is
 * still a pale tint. Fixed by switching to the same deep mineral blue used
 * for primary actions elsewhere, kept mostly (not fully) opaque, with the
 * overlay text recolored for contrast against the darker fill.
 * ===================================================================== */

test('the completion wash is a deliberately mostly-opaque, strongly-tinted confirmation, not a faint near-white overlay', () => {
  const washMatch = styles.match(/\.best-fit-card\.referral-card\.handoff-wash \{ background: rgb\((\d+) (\d+) (\d+) \/ (\d+)%\); \}/)
  assert.ok(washMatch, 'expected a single rgb(...) wash background declaration')
  const [, r, g, b, alpha] = washMatch.map(Number)
  assert.ok(Number(alpha) >= 90, 'the wash must be mostly opaque, not a faint translucent tint')
  const isPaleNearWhite = r > 200 && g > 200 && b > 200
  assert.ok(!isPaleNearWhite, 'the wash must be a real, saturated Lamina-palette color, not a near-white tint indistinguishable from the card\'s own background')
})

test('the overlay text recolors for contrast against the darker wash, rather than keeping colors tuned for the old near-white background', () => {
  assert.match(styles, /\.referral-handoff-check \{ font-family: var\(--font-display\); font-size: 1\.4rem; color: #fffefa; \}/)
  assert.match(styles, /\.referral-handoff-overlay h3 \{ margin: 2px 0 0; font-size: 1\.1rem; font-weight: 500; color: #fffefa; \}/)
  assert.doesNotMatch(styles, /\.referral-handoff-check \{[^}]*color: var\(--mineral-deep\)/, 'the checkmark must not keep the old dark-on-light color, now illegible on a dark wash')
})

test('the wash transitions via background-color on the card, with a reduced-motion override, mirroring the overlay\'s own fade timing', () => {
  assert.match(styles, /\.best-fit-card\.referral-card \{ transition: background-color 500ms ease-in-out; \}/)
  assert.match(styles, /@media \(prefers-reduced-motion: reduce\) \{\s*\n\s*\.best-fit-card\.referral-card \{ transition: none; \}/)
})

test('ReferralCoordinationSurface mirrors the wash state up to the parent via onWashChange, exactly in lockstep with its own local justCompleted', () => {
  assert.match(referralSource, /onWashChange\?: \(active: boolean\) => void/)
  assert.match(referralSource, /const setWash = \(active: boolean\) => \{ setJustCompleted\(active\); onWashChange\?\.\(active\) \}/)
})

test('the parent card toggles .handoff-wash from onWashChange, and resets it on unmount so a cancelled run never leaves a stuck wash', () => {
  assert.match(app, /const \[washActive, setWashActive\] = useState\(false\)/)
  assert.match(app, /\$\{washActive \? 'handoff-wash' : ''\}/)
  assert.match(app, /onWashChange=\{setWashActive\}/)
  assert.match(referralSource, /onWashChange\?\.\(false\)\s*\n\s*\/\/ eslint-disable-next-line react-hooks\/exhaustive-deps\s*\n\s*\}, \[\]\)/)
})

test('no backend calls happen anywhere in start() other than the single create+preflight pair before the phase loop begins', () => {
  const startSource = referralSource.slice(referralSource.indexOf('const start = async'), referralSource.indexOf('if (status === \'error\')'))
  const createCalls = startSource.match(/createReferral\(/g) ?? []
  const preflightCalls = startSource.match(/runReferralPreflight\(/g) ?? []
  assert.equal(createCalls.length, 1)
  assert.equal(preflightCalls.length, 1)
})

/* ========================================================================
 * Bug-fix pass, Part B/U: synthetic appointment time must read as a normal
 * daytime clinic hour everywhere, via the SAME shared formatSubmittedAt
 * used by every consumer (Lucy, Chen, scheduling details, history) -- never
 * a per-view reformat. The backend now emits a naive (no UTC offset)
 * clinic-local datetime string specifically so formatSubmittedAt's
 * `new Date(value)` parses it as local time directly, with no hidden
 * timezone conversion regardless of the viewing browser's own timezone.
 * ===================================================================== */

test('formatSubmittedAt renders a naive (no UTC offset) datetime string using its own literal hour/minute, never shifting it by the viewing environment\'s timezone', () => {
  assert.match(formatSubmittedAt('2099-01-14T15:30'), /3:30\s*PM/)
})

test('formatSubmittedAt is the one shared formatter for every appointment-time display site -- Lucy\'s found-value, the scheduling details modal, and Chen\'s scheduled view all call it on the same slot.starts_at field, never a separate reformat', () => {
  const occurrences = [...referralSource.matchAll(/\{formatSubmittedAt\(slot\.starts_at\)\}/g)]
  assert.ok(occurrences.length >= 3, 'expected at least 3 call sites (Lucy, SchedulingDetailsModal, Chen) all using the same formatter on the same field')
})
