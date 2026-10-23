/* Routing + specialist worklist + learning UX consolidation pass.
 *
 * Behavioral tests for the pure worklist/explanation modules, plus source
 * checks for the UI surfaces they drive. */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { EVIDENCE_CATEGORY_LABELS, matchEvidence, whyThisMatch } from '../src/matchExplanation.ts'
import {
  attentionOrder, CHEN_SEEDED_NEXT_STEPS, daysRemaining, handledByAgentOrStaff, referralReviewStep,
  acceptedReferralStep, SERVICE_TARGET_DAYS, serviceTargetDays, topAttention,
} from '../src/specialistWorklist.ts'

const app = readFileSync(new URL('../src/App.tsx', import.meta.url), 'utf8')
const referralSource = readFileSync(new URL('../src/Referral.tsx', import.meta.url), 'utf8')
const engagement = readFileSync(new URL('../src/Engagement.tsx', import.meta.url), 'utf8')
const preferences = readFileSync(new URL('../src/ReferralPreferences.tsx', import.meta.url), 'utf8')
const styles = readFileSync(new URL('../src/styles.css', import.meta.url), 'utf8')
const slice = (source, from, to) => source.slice(source.indexOf(from), to === undefined ? undefined : source.indexOf(to, source.indexOf(from)))

const NOW = new Date('2026-10-22T12:00:00Z')
const daysAgo = (days) => new Date(NOW.getTime() - days * 86_400_000).toISOString()

/** A submitted, ready Tonjit-shaped referral with one auto-resolved item. */
function tonjitReferral(overrides = {}) {
  return {
    id: 7, patient_id: 'patient-t2dm-003', referring_physician_id: 'agent-lucy', receiving_physician_id: 'physician-chen',
    specialty: 'Endocrinology', referral_question: 'q', urgency: 'Soon', priority: 'soon', modality: 'in_person',
    status: 'submitted', created_at: daysAgo(0), updated_at: daysAgo(0), packet: { items: [] },
    receiving_requirements: [], requirement_results: [{ key: 'recent_renal_function', label: 'Recent renal function', status: 'satisfied' }],
    coordination_events: [{ event_type: 'information_attached' }],
    ...overrides,
  }
}

const chenFit = {
  physician_id: 'physician-chen', physician_name: 'Dr. Noah Chen', clinical_fit: 'strong', receiving_fit: 'strong',
  similar_case_patterns: ['Progressive type 2 diabetes despite oral medication escalation'],
  econsult_policy: 'possible_not_preferred',
  evidence: [
    { category: 'specialty_scope', summary: 'Endocrinology / complex diabetes', source: 'Physician profile · specialty and practice focus' },
    { category: 'referral_preference', summary: "This presentation matches cases Dr. Chen's representation identifies as appropriate for the practice.", source: 'Explicit practice rule (synthetic practice footprint)' },
    { category: 'similar_case_experience', summary: "Dr. Chen's practice history includes comparable patients: progressive type 2 diabetes despite oral medication escalation. A fit signal, not a quality measure.", source: 'Practice history · privacy-preserving case patterns (synthetic)' },
    { category: 'modality_policy', summary: 'Dr. Chen prefers in-person evaluation for this presentation; e-consult remains possible.', source: 'Practice representation' },
  ],
}
const chenVisit = {
  physician_id: 'physician-chen', physician_name: 'Dr. Noah Chen', specialty: 'Endocrinology', modality: 'in_person',
  fit_label: 'strong', evidence_confidence: 'high', network_participation: 'integrated_network', recommended: true, rationale: 'r',
  access: { in_person_wait_days: 10, in_person_wait_label: 'Approximately 10 days', econsult_available: true, econsult_response_days: 2, econsult_response_label: 'Approximately 2 business days', access_confidence: 'high' },
  route_evidence: [{ category: 'access_capacity', summary: 'Expected visit access ~10 days -- within the soon window.', source: 'Visit capacity (synthetic access profile)' }],
}

/* ------------------------------------------------------- "Why Dr. Chen?" */

test('Why this match shows clinical fit, similar-patient experience, receiving fit, and the route -- from structured evidence only', () => {
  const lines = whyThisMatch(chenFit, chenVisit, 'Tonjit')
  assert.deepEqual(lines.map((line) => line.label), ['Strong clinical fit', 'Experience with similar patients', 'Receiving fit', 'Route'])
  assert.equal(lines[0].detail, 'Endocrinology / complex diabetes')
  assert.match(lines[1].detail, /^Dr\. Chen's practice history includes comparable patients: progressive type 2 diabetes despite oral medication escalation\.$/)
  assert.match(lines[2].detail, /^Tonjit's presentation matches cases Dr\. Chen's representation identifies as appropriate/)
  assert.equal(lines[3].detail, 'In-person appropriate for this presentation · Expected visit access ~10 days')
})

test('a physician with no similar-case history or confirmed receiving preferences is described honestly, never fabricated', () => {
  const maya = { ...chenFit, physician_id: 'physician-ramanathan', physician_name: 'Dr. Maya Ramanathan', receiving_fit: 'unknown', similar_case_patterns: [], evidence: chenFit.evidence.filter((item) => item.category === 'specialty_scope') }
  const lines = whyThisMatch(maya, undefined, 'Tonjit')
  assert.equal(lines.find((line) => line.key === 'similar').detail, 'No similar-case history on record yet.')
  assert.match(lines.find((line) => line.key === 'receiving').detail, /^Not yet established/)
  assert.doesNotMatch(JSON.stringify(lines), /\d+ (similar|comparable)/)
})

test('detailed match evidence carries provenance for every reason and labels each evidence category', () => {
  const evidence = matchEvidence(chenFit, chenVisit)
  assert.ok(evidence.every((item) => item.source))
  assert.ok(evidence.some((item) => item.category === 'similar_case_experience'))
  assert.ok(evidence.some((item) => item.category === 'access_capacity'))
  for (const category of ['specialty_scope', 'similar_case_experience', 'case_interest', 'referral_preference', 'modality_policy', 'access_capacity', 'continuity', 'network_relationship']) {
    assert.ok(EVIDENCE_CATEGORY_LABELS[category])
  }
  const view = slice(app, 'function RecommendationView', 'function ReceivingReferralCard')
  assert.match(view, /<small className="match-evidence-source">Source: \{item\.source\}<\/small>/)
  assert.match(view, /<p className="section-label">Why this match<\/p>/)
  assert.doesNotMatch(readFileSync(new URL('../src/matchExplanation.ts', import.meta.url), 'utf8'), /score/i, 'no numeric physician score anywhere in the explanation')
  assert.doesNotMatch(JSON.stringify(whyThisMatch(chenFit, chenVisit, 'Tonjit')), /score|\d+\s*\/\s*100/i)
})

test('the care path shows Endocrinology, the clinician-confirmable priority, in-person as appropriate, and e-consult as an alternative for other cases', () => {
  const view = slice(app, 'function RecommendationView', 'function ReceivingReferralCard')
  assert.match(view, /'In-person is appropriate for this presentation'/)
  assert.match(view, /E-consult remains an alternative modality for other appropriate cases\./)
  assert.match(view, /<PriorityChipRow priority=\{priority\} onChange=\{setPriority\} \/>/)
  assert.match(view, /Suggested by your agent/)
})

/* ---------------------------------------------- Patients with next steps */

test('one worklist holds a new referral, existing patients, and an e-consult together', () => {
  const steps = [referralReviewStep(tonjitReferral(), NOW, 'Dr. Lucy Saruhashi'), ...CHEN_SEEDED_NEXT_STEPS]
  const kinds = new Set(attentionOrder(steps).map((item) => item.kind))
  assert.ok(kinds.has('review_referral'))
  assert.ok(kinds.has('review_results'))
  assert.ok(kinds.has('respond_econsult'))
  const review = steps[0]
  assert.equal(review.action, 'Review referral')
  assert.equal(review.detail, 'Endocrinology referral from Dr. Lucy Saruhashi · 1 missing item resolved automatically')
})

test('Tonjit leads the top three because of his clinician-defined Soon priority, readiness, and required review -- the e-consult and an existing patient follow', () => {
  const top = topAttention([referralReviewStep(tonjitReferral(), NOW, 'Dr. Lucy Saruhashi'), ...CHEN_SEEDED_NEXT_STEPS])
  assert.equal(top.length, 3)
  assert.equal(top[0].patientId, 'patient-t2dm-003')
  assert.deepEqual(top.map((item) => item.kind), ['review_referral', 'respond_econsult', 'review_results'])
})

test('top-three ordering uses time remaining to the service target, not static priority alone', () => {
  const freshSoon = referralReviewStep(tonjitReferral(), NOW, 'Dr. Lucy Saruhashi')
  const agedRoutine = { ...CHEN_SEEDED_NEXT_STEPS.find((item) => item.kind === 'review_results'), id: 'aged', patientId: 'patient-aged', ageDays: 6 }
  assert.equal(daysRemaining(agedRoutine), 1)
  assert.equal(daysRemaining(freshSoon), 2)
  assert.equal(attentionOrder([freshSoon, agedRoutine])[0].id, 'aged', 'a Routine case near its target rises above a fresh Soon case')
})

test('Routine cases cannot starve: as they age they eventually outrank any newly arriving non-urgent case', () => {
  const routine = { ...CHEN_SEEDED_NEXT_STEPS.find((item) => item.kind === 'review_results'), id: 'routine', patientId: 'patient-routine' }
  const freshSoon = { ...referralReviewStep(tonjitReferral(), NOW, 'x'), id: 'soon' }
  const ranks = [0, 2, 4, 6, 8].map((age) => attentionOrder([{ ...routine, ageDays: age }, freshSoon])[0].id)
  assert.equal(ranks[0], 'soon')
  assert.equal(ranks.at(-1), 'routine')
  assert.ok(daysRemaining({ ...routine, ageDays: 9 }) < 0, 'an overdue step is visibly past its target')
})

test('urgent stays first: it is the exceptional escalation path, never displaced by an aging non-urgent case', () => {
  const urgent = { ...referralReviewStep(tonjitReferral({ priority: 'urgent' }), NOW, 'x'), id: 'urgent' }
  const overdueRoutine = { ...CHEN_SEEDED_NEXT_STEPS[1], id: 'overdue', ageDays: 30 }
  assert.equal(attentionOrder([overdueRoutine, urgent])[0].id, 'urgent')
})

test('agent- or staff-resolvable administrative steps never take a top-three slot', () => {
  const steps = [referralReviewStep(tonjitReferral(), NOW, 'x'), ...CHEN_SEEDED_NEXT_STEPS]
  const admin = handledByAgentOrStaff(steps)
  assert.ok(admin.length >= 2)
  assert.ok(topAttention(steps, 10).every((item) => item.physicianJudgment))
  const scheduled = acceptedReferralStep(tonjitReferral({ status: 'scheduled' }), { encounterDocumented: false, handoffStatus: null, handoffDraftedAt: null }, NOW)
  assert.equal(scheduled.physicianJudgment, false)
  const handoff = acceptedReferralStep(tonjitReferral({ status: 'consult_returned' }), { encounterDocumented: true, handoffStatus: 'draft', handoffDraftedAt: daysAgo(0) }, NOW)
  assert.equal(handoff.kind, 'review_handoff')
  assert.equal(handoff.physicianJudgment, true)
  assert.equal(acceptedReferralStep(tonjitReferral({ status: 'consult_returned' }), { encounterDocumented: true, handoffStatus: 'sent', handoffDraftedAt: null }, NOW), null)
})

test('an incomplete referral still being resolved does not displace an action-ready one', () => {
  const resolving = { ...referralReviewStep(tonjitReferral({ requirement_results: [{ key: 'k', label: 'l', status: 'missing_from_packet' }], created_at: daysAgo(3) }), NOW, 'x'), id: 'resolving' }
  assert.equal(resolving.ready, false)
  const ready = CHEN_SEEDED_NEXT_STEPS.find((item) => item.kind === 'review_results')
  assert.equal(attentionOrder([resolving, ready])[0].id, ready.id)
})

test('e-consult and visit work keep separate, modality-specific service targets', () => {
  const econsult = CHEN_SEEDED_NEXT_STEPS.find((item) => item.kind === 'respond_econsult')
  assert.equal(serviceTargetDays(econsult), SERVICE_TARGET_DAYS.econsult_response.routine)
  assert.notEqual(SERVICE_TARGET_DAYS.econsult_response.routine, SERVICE_TARGET_DAYS.referral_review.routine)
  const capacity = slice(referralSource, 'function ChenCapacityCards', 'export const CHEN_AUTO_ROUTED_PATIENT_IDS')
  assert.match(capacity, />Visits</)
  assert.match(capacity, />E-consults</)
})

test('Chen Dashboard has exactly one "Patients with next steps" worklist and no separate "Needs your review" section', () => {
  const home = slice(referralSource, 'export function ChenHomePage', '/* ===================================================================== Part B/D')
  assert.equal((home.match(/<h2>Patients with next steps<\/h2>/g) ?? []).length, 1)
  assert.doesNotMatch(home, /Needs your review|dashboard-needs-you/)
  assert.match(home, /\{agentHandledCount\} administrative step/)
})

test('Lucy\'s Dashboard keeps the same "Patients with next steps" concept', () => {
  assert.match(app, /<h2>Patients with next steps<\/h2>/)
})

/* ------------------------------------------------------------- Learning */

test('ordinary Train never shows "Question 1 of 10", and the question bank is internal tooling', () => {
  const train = slice(engagement, 'export function TrainTab', '/* ------------------------------------------------------------------ My Agent: Chat */')
  assert.doesNotMatch(train, /Question \d+ of \d+|Question \{/)
  assert.match(train, /Internal demo tooling/)
  assert.doesNotMatch(slice(engagement, 'function QuickTrainingModal', 'export function TrainingPage'), /Question \{Math\.min/)
})

test('clarification cards (in the modal) show where they came from and why Lamina is asking', () => {
  const modal = slice(engagement, 'function ClarificationModal', 'const PREFERENCE_HISTORY_LABELS')
  assert.match(modal, /<span className="clarification-source">\{opportunity\.source_label \?\? 'From recent work'\}<\/span>/)
  assert.match(modal, /Why Lamina is asking/)
  assert.match(modal, /<div className="clarification-card in-modal">/)
})

test('Yes/No allow optional context; Depends opens "What does it depend on?" with a natural-language field', () => {
  const flow = slice(engagement, 'function ClarificationAnswerFlow', 'function ClarificationModal')
  assert.match(flow, /\(\['yes', 'no', 'depends'\] as const\)/)
  assert.match(flow, /if \(value === 'depends'\) setContextOpen\(true\)/)
  assert.match(flow, /answer && !depends && !contextOpen && <button type="button" className="text-button clarification-add-context"/)
  assert.match(flow, />Add context <span>→<\/span>/)
  assert.match(flow, /opportunity\.depends_prompt \?\? 'What does it depend on\?'/)
  assert.match(flow, /'Add context \(optional\)'/)
  assert.match(flow, /disabled=\{!answer \|\| !composed \|\| busy\}/, 'Depends cannot continue without the natural-language detail')
})

test('a clarification answer is interpreted, shown as a proposed learning, and only operational after confirmation', () => {
  const flow = slice(engagement, 'function ClarificationAnswerFlow', 'function ClarificationModal')
  assert.match(flow, /interpretReferralPreference\(personaId, composed, 'modality'\)/)
  assert.match(flow, /<PreferenceDraftReview personaId=\{personaId\} draft=\{draft\}/)
  assert.match(flow, /Nothing changes until you confirm the proposed learning\./)
  const review = slice(preferences, 'export function PreferenceDraftReview', 'export const TEACHING_PLACEHOLDER')
  assert.match(review, /await confirmReferralPreference\(personaId, draft\.id\)/)
  assert.match(review, />Looks right</)
})

test('the "Tell your agent something" box exists, is optional, reuses the existing NLP pipeline, and is empty with a placeholder', () => {
  const train = slice(engagement, 'export function TrainTab', '/* ------------------------------------------------------------------ My Agent: Chat */')
  assert.match(train, /heading="Tell your agent something"/)
  assert.match(train, /intro="Optional\./)
  assert.match(preferences, /const \[sourceText, setSourceText\] = useState\(''\)/)
  assert.match(preferences, /placeholder=\{placeholder\}/)
  assert.match(preferences, /export const TEACHING_PLACEHOLDER = 'Type here…'/)
  assert.doesNotMatch(preferences, /useState\('For diabetes/)
  assert.match(preferences, /className="referral-pref-example"/)
})

test('Test is a non-mutating sandbox; "Not quite" routes a correction through the existing proposed-learning flow', () => {
  const chat = slice(engagement, 'export function ChatTab', 'const agentPracticePath')
  assert.match(chat, /Testing never changes your agent; only a correction you confirm does\./)
  const composer = slice(engagement, 'function CorrectionComposer', 'function ChatMessageBubble')
  assert.match(composer, /interpretReferralPreference\(personaId, text\.trim\(\)\)/)
  assert.match(composer, /<PreferenceDraftReview/)
  assert.doesNotMatch(composer, /confirmReferralPreference/)
  assert.match(engagement, /submitAgentChatFeedback\(personaId, message\.id, value\)/, 'the feedback itself is still recorded as evidence')
})

test('Overview and Dashboard Review open Train with the clarification modal already open -- no hunting for the card', () => {
  assert.match(engagement, /export const clarificationFocusPath = \(trainPath: string, clarificationId: string\) => `\$\{agentTrainTabPath\(trainPath\)\}&focus=\$\{encodeURIComponent\(clarificationId\)\}`/)
  const train = slice(engagement, 'export function TrainTab', '/* ------------------------------------------------------------------ My Agent: Chat */')
  assert.match(train, /if \(!focusId \|\| focusHandled\.current \|\| open\.length === 0 \|\| !canTeach\) return/)
  assert.match(train, /setModalItems\(open\)/)
  for (const source of [app, referralSource]) assert.match(source, /focusId=\{params(\?)?\.get\('focus'\)/)
})

/* -------------------------------------------------------------------- UX */

test('the clarification modal stays over the current page with a dimmed, blurred, visible background, and dismisses via X, backdrop, and Escape', () => {
  const modal = slice(engagement, 'function ClarificationModal', 'const PREFERENCE_HISTORY_LABELS')
  assert.match(modal, /<ModalPortal><div className="post-flow-overlay"/)
  assert.match(modal, /if \(event\.target === event\.currentTarget && !busy\) onClose\(\)/)
  assert.match(modal, /if \(event\.key === 'Escape' && !busy\) onClose\(\)/)
  assert.match(modal, /aria-label="Close">×<\/button>/)
  assert.doesNotMatch(modal, /navigate\(trainPath\)|TrainingPage/)
  assert.match(styles, /\.post-flow-overlay \{[^}]*background: rgb\(36 30 24 \/ 38%\);[^}]*backdrop-filter: blur\(3px\)/)
  assert.match(styles, /\.clarification-dialog \{[^}]*opacity: 1/)
  assert.match(slice(engagement, 'function QuickTrainingModal', 'export function TrainingPage'), /<ModalPortal><div className="post-flow-overlay"/)
})

test('form controls use Lamina typography', () => {
  assert.match(styles, /^input, textarea, select \{ font: inherit; font-family: var\(--font-ui\); color: inherit; \}$/m)
  assert.match(styles, /^input::placeholder, textarea::placeholder \{ font: inherit;/m)
  assert.match(styles, /\.lamina-textarea \{[^}]*font: inherit/)
  assert.match(styles, /\.ask-network-card textarea, \.ask-network-card select/)
})

test('the Dashboard agent CTA never launches the legacy mandatory 10-question sequence', () => {
  const card = slice(engagement, 'export function HomeAgentCard', '/** INTERNAL DEMO TOOLING ONLY')
  assert.doesNotMatch(card, /QuickTrainingModal|startTrainingSession|Continue setup/)
})
