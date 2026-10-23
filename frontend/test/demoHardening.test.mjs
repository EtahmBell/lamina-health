/* Final demo hardening pass: clarification summary + modal, one source of
 * truth for the clarification count, NLP field hygiene, and the frontend
 * double-submit guard for Start referral. */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { CHEN_SEEDED_NEXT_STEPS, referralReviewStep, topAttention } from '../src/specialistWorklist.ts'

const app = readFileSync(new URL('../src/App.tsx', import.meta.url), 'utf8')
const referralSource = readFileSync(new URL('../src/Referral.tsx', import.meta.url), 'utf8')
const engagement = readFileSync(new URL('../src/Engagement.tsx', import.meta.url), 'utf8')
const preferences = readFileSync(new URL('../src/ReferralPreferences.tsx', import.meta.url), 'utf8')
const styles = readFileSync(new URL('../src/styles.css', import.meta.url), 'utf8')
const slice = (source, from, to) => source.slice(source.indexOf(from), to === undefined ? undefined : source.indexOf(to, source.indexOf(from)))
const train = () => slice(engagement, 'export function TrainTab', '/* ------------------------------------------------------------------ My Agent: Chat */')
const modal = () => slice(engagement, 'function ClarificationModal', 'const PREFERENCE_HISTORY_LABELS')

/* -------------------------------------------------------- clarification UX */

test('Train shows a compact "From your recent work" summary, not the full clarification card inline', () => {
  const fn = train()
  assert.match(fn, /<p className="section-label" id="train-recent-work">From your recent work<\/p>/)
  assert.match(fn, /<div className="clarification-summary">/)
  assert.doesNotMatch(fn, /clarifying_question|Why Lamina is asking/, 'the card itself lives in the modal')
})

test('zero clarifications renders a clean empty state with no button', () => {
  const fn = train()
  assert.match(fn, /\{open\.length === 0\s*\n\s*\? <p className="agent-empty-note">Nothing needs your input right now\.<\/p>/)
})

test('the count comes from the real unresolved opportunities, phrased by one shared helper', () => {
  assert.match(engagement, /export const clarificationCountLabel = \(count: number, fromRecentWork = false\) =>/)
  assert.match(train(), /clarificationCountLabel\(open\.length\)/)
  assert.match(train(), /const open = learningOpportunities\.filter\(\(item\) => !resolvedIds\.has\(item\.id\)\)/)
  assert.doesNotMatch(engagement, /One clarification needs your input|'1 clarification needs your input/)
})

test('Overview, Train, and Dashboard read the same source: AgentOverview.learning_opportunities', () => {
  const overview = slice(engagement, 'export function AgentOverviewPanel', 'export type AgentActivityRow')
  const card = slice(engagement, 'export function HomeAgentCard', '/** INTERNAL DEMO TOOLING ONLY')
  assert.match(overview, /clarificationCountLabel\(overview\.learning_opportunities\.length\)/)
  assert.match(card, /clarificationCountLabel\(overview\.learning_opportunities\.length, true\)/)
  const referral = readFileSync(new URL('../src/Referral.tsx', import.meta.url), 'utf8')
  assert.match(referral, /learningOpportunities=\{overview\.learning_opportunities\}/)
  assert.match(app, /learningOpportunities=\{overview\?\.learning_opportunities \?\? \[\]\}/)
})

test('Review opens a modal over the current page: card view with "i of N", previous/next, and Answer', () => {
  const fn = modal()
  assert.match(fn, /<ModalPortal><div className="post-flow-overlay"/)
  assert.match(fn, /Clarifications from your recent work/)
  assert.match(fn, /\{Math\.min\(index, unanswered\.length - 1\) \+ 1\} of \{unanswered\.length\}/)
  assert.match(fn, />← Previous</)
  assert.match(fn, />Next →</)
  assert.match(fn, /onClick=\{\(\) => setAnswering\(true\)\}>Answer/)
  assert.match(fn, /if \(event\.key === 'Escape' && !busy\) onClose\(\)/)
  assert.match(fn, /if \(event\.target === event\.currentTarget && !busy\) onClose\(\)/)
  assert.match(fn, /aria-label="Close">×<\/button>/)
  assert.doesNotMatch(fn, /navigate\(trainPath\)|TrainingPage|Question \d+ of/)
})

test('confirming the last clarification still shows its success state (the modal holds a snapshot, never unmounts mid-flow)', () => {
  assert.match(train(), /const \[modalItems, setModalItems\] = useState<LearningOpportunity\[\] \| null>\(null\)/)
  assert.match(train(), /\{modalItems && personaId && <ClarificationModal/)
  assert.match(modal(), /✓ Added to how your agent represents your practice\./)
})

test('Dashboard Review goes straight to the clarification modal; without one, the card says the agent is learning', () => {
  const card = slice(engagement, 'export function HomeAgentCard', '/** INTERNAL DEMO TOOLING ONLY')
  assert.match(card, /navigate\(clarificationFocusPath\(trainPath, pendingClarification\.id\)\)/)
  assert.match(train(), /focusHandled\.current = true\s*\n\s*setModalItems\(open\)/)
  assert.match(card, /<h3>Your agent<\/h3>\s*\n\s*<p className="agent-banner-support">Your agent is learning from your work\.<\/p>/)
  assert.doesNotMatch(card, /Continue setup/)
})

/* ---------------------------------------------------------------------- NLP */

test('the Tell your agent textarea is empty, uses "Type here…", and the example is not its value', () => {
  assert.match(preferences, /const \[sourceText, setSourceText\] = useState\(''\)/)
  assert.match(preferences, /value=\{sourceText\}/)
  assert.match(preferences, /export const TEACHING_PLACEHOLDER = 'Type here…'/)
  assert.match(preferences, /\{example && <p className="referral-pref-example">/)
  assert.doesNotMatch(preferences, /useState\(example|useState\(DEFAULT_TEACHING_EXAMPLE|value=\{example/)
  const fn = train()
  assert.ok(fn.indexOf('>From your recent work<') < fn.indexOf('heading="Tell your agent something"'), 'teaching box sits beneath the summary')
})

test('form controls on the targeted surfaces use the app UI font explicitly', () => {
  assert.match(styles, /^input, textarea, select \{ font: inherit; font-family: var\(--font-ui\); color: inherit; \}$/m)
  for (const selector of ['.ask-network-card textarea', '.ask-network-card select', '.train-tab-v2 textarea', '.clarification-dialog textarea', '.chat-tab-grid input', '.referral-preference-section textarea']) {
    assert.ok(styles.includes(selector), selector)
  }
})

/* ------------------------------------------------------ referral idempotency */

test('Start referral shares one in-flight create per patient + physician and is disabled while switching', () => {
  const guard = slice(referralSource, 'const referralCreationsInFlight', 'export function ReferralCoordinationSurface')
  assert.match(guard, /const pending = referralCreationsInFlight\.get\(key\)\s*\n\s*if \(pending\) return pending/)
  assert.match(guard, /\.finally\(\(\) => referralCreationsInFlight\.delete\(key\)\)/)
  assert.match(referralSource, /const created = await createReferralOnce\(/)
  assert.match(referralSource, /cancelled\.current = false/)
  const view = slice(app, 'function RecommendationView', 'function ReceivingReferralCard')
  assert.match(view, /if \(startingReferral\) return/)
  assert.match(view, /disabled=\{startingReferral\} onClick=\{startReferral\}/)
})

test('one submitted Tonjit referral yields exactly one Tonjit row in Patients with next steps', () => {
  const referral = {
    id: 1, patient_id: 'patient-t2dm-003', referring_physician_id: 'agent-lucy', receiving_physician_id: 'physician-chen',
    specialty: 'Endocrinology', referral_question: 'q', urgency: 'Soon', priority: 'soon', modality: 'in_person', status: 'submitted',
    created_at: new Date().toISOString(), updated_at: new Date().toISOString(), packet: { items: [] }, receiving_requirements: [],
    requirement_results: [], coordination_events: [{ event_type: 'information_attached' }],
  }
  const top = topAttention([referralReviewStep(referral, new Date(), 'Dr. Lucy Saruhashi'), ...CHEN_SEEDED_NEXT_STEPS])
  assert.equal(top.filter((item) => item.patientId === 'patient-t2dm-003').length, 1)
  assert.equal(top[0].patientId, 'patient-t2dm-003')
})
