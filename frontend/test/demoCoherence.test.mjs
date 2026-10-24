/**
 * Demo coherence + training UX pass: a single shared training modal for
 * every persona, three parallel teaching modes, the "what your agent
 * learned this week" card, visible case context, and no internal
 * ontology language in physician-facing copy.
 */

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'

const engagement = readFileSync(new URL('../src/Engagement.tsx', import.meta.url), 'utf8')
const owner = readFileSync(new URL('../src/Owner.tsx', import.meta.url), 'utf8')
const referral = readFileSync(new URL('../src/Referral.tsx', import.meta.url), 'utf8')
const specialist = readFileSync(new URL('../src/Specialist.tsx', import.meta.url), 'utf8')
const app = readFileSync(new URL('../src/App.tsx', import.meta.url), 'utf8')

const slice = (source, from, to) => source.slice(source.indexOf(from), source.indexOf(to))

// ---------------------------------------------------------------- shared training modal

test('Lucy, Chen, Iain, and Owner all pass a real personaId into TrainTab -- the same shared component, never a persona-specific fork', () => {
  assert.match(app, /<TrainTab trainProjection=\{trainProjection\} navigate=\{navigate\} trainPath=\{trainingPath\('lucy'\)\} personaId="lucy"/)
  assert.match(owner, /<TrainTab trainProjection=\{trainProjection\} navigate=\{navigate\} trainPath=\{ownerTrainPath\} personaId="owner"/)
  assert.match(referral, /<TrainTab trainProjection=\{trainProjection\} navigate=\{navigate\} trainPath=\{trainingPath\('chen'\)\} personaId="chen"/)
  assert.match(specialist, /<TrainTab trainProjection=\{trainProjection\} navigate=\{navigate\} trainPath=\{trainingPath\('iain'\)\} personaId="iain"/)
  assert.doesNotMatch(engagement, /function ChenTrainTab|function LucyTrainTab/)
})

test('routing consolidation pass, Part O/S: the structured question bank is internal demo tooling only -- never the primary Train workflow, and never a navigation to the legacy full-screen TrainingPage', () => {
  const fn = slice(engagement, 'export function TrainTab', 'export function ChatTab')
  assert.match(fn, /<details className="train-internal-tools">/)
  assert.match(fn, /<summary>Internal demo tooling<\/summary>/)
  assert.doesNotMatch(fn, /navigate\(`\$\{trainPath\}\?mode=daily`\)/)
  assert.match(fn, /\{toolingOpen && personaId && <QuickTrainingModal/)
})

test('the one-time mandatory initialization sequence still works -- the SAME modal, told to use the standard track', () => {
  const modal = slice(engagement, 'function QuickTrainingModal', 'export function TrainingPage')
  assert.match(modal, /getTrainingHistory\(personaId, initializationNeeded \? 'standard' : 'quick'\)/)
  assert.match(modal, /startTrainingSession\(personaId, initializationNeeded \? \{ mode: 'initialization' \} : \{ mode: 'quick', limit: 3 \}\)/)
})

test('the training modal backdrop dims the page, never the modal content itself (no opacity/filter on the dialog)', () => {
  const quickModal = slice(engagement, 'function QuickTrainingModal', 'export function TrainingPage')
  assert.match(quickModal, /return <div className="post-flow-overlay" role="presentation"/)
  assert.match(quickModal, /<div className="training-modal" role="dialog"/)
  // The dialog itself carries no opacity/filter rule in CSS (checked structurally: the overlay, not .training-modal, owns the dim background).
  const styles = readFileSync(new URL('../src/styles.css', import.meta.url), 'utf8')
  const trainingModalRule = styles.slice(styles.indexOf('.training-modal {'), styles.indexOf('.training-modal {') + 400)
  assert.doesNotMatch(trainingModalRule, /opacity:\s*0?\.\d|filter:\s*opacity/)
})

// ---------------------------------------------------------------- three teaching modes

test('Train is a learning control center -- From your recent work, Tell your agent something, Learning history -- never "Question 1 of 10" or quick-question homework', () => {
  const fn = slice(engagement, 'export function TrainTab', 'export function ChatTab')
  const order = ['>From your recent work<', 'heading="Tell your agent something"', '>Learning history<']
  const positions = order.map((marker) => fn.indexOf(marker))
  assert.ok(positions.every((position) => position >= 0), 'all three sections present')
  assert.deepEqual([...positions].sort((a, b) => a - b), positions, 'in this order')
  assert.doesNotMatch(fn, /Question \d+ of \d+|Question \{/)
  assert.doesNotMatch(fn, /Quick questions|Answer a few questions/)
})

test('"Tell your agent something" reuses ReferralPreferenceSection -- the existing NLP interpret/confirm pipeline, never a duplicated backend -- and is optional', () => {
  const fn = slice(engagement, 'export function TrainTab', 'export function ChatTab')
  assert.match(fn, /<ReferralPreferenceSection\s+personaId=\{personaId\}/)
  assert.match(fn, /intro="Optional\. Describe a preference, case interest, referral requirement, or how you handle a type of case\."/)
  assert.match(fn, /canTeach && personaId && <section className="train-section train-teach-section">/)
})

test('From your recent work summarizes only real unresolved clarifications -- a count and Review, never the full card inline, never a fabricated backlog', () => {
  const fn = slice(engagement, 'export function TrainTab', 'export function ChatTab')
  assert.match(fn, /const open = learningOpportunities\.filter/)
  assert.match(fn, /<p>\{clarificationCountLabel\(open\.length\)\}<\/p>/)
  assert.match(fn, /onClick=\{\(\) => setModalItems\(open\)\}>Review/)
  assert.doesNotMatch(fn, /className=\{`clarification-card /)
  assert.doesNotMatch(fn, /14 signals|11 resolved|fabricat/i)
})

test('Review opens the ClarificationModal over the current page with the real question -- nothing is operational until the physician confirms', () => {
  const fn = slice(engagement, 'export function TrainTab', 'export function ChatTab')
  assert.match(fn, /<ClarificationModal\s+personaId=\{personaId\}\s+opportunities=\{modalItems\}/)
  const modal = slice(engagement, 'function ClarificationModal', 'const PREFERENCE_HISTORY_LABELS')
  assert.match(modal, /<ModalPortal>/)
  assert.match(modal, /\{opportunity\.clarifying_question\}/)
  const flow = slice(engagement, 'function ClarificationAnswerFlow', 'function ClarificationModal')
  assert.match(flow, /interpretReferralPreference\(personaId, composed, 'modality'\)/)
  assert.doesNotMatch(flow, /confirmReferralPreference/)
  assert.match(flow, /<PreferenceDraftReview/)
})

// ---------------------------------------------------------------- "what your agent learned this week"

test('the learned-this-week card sits above the practice-representation detail, and never shows a fake aggregate score', () => {
  const fn = slice(engagement, 'export function AgentOverviewPanel', 'export type AgentActivityRow')
  const learnedIndex = fn.indexOf('What your agent learned this week')
  const detailIndex = fn.indexOf('How your agent currently represents your practice')
  assert.ok(learnedIndex > -1 && detailIndex > -1 && learnedIndex < detailIndex)
  assert.match(fn, /\{clarificationCountLabel\(overview\.learning_opportunities\.length\)\}/)
  assert.doesNotMatch(fn, /[Aa]gent [Ss]core/)
})

test('the Overview "What your agent learned this week" Review CTA opens Train focused on the one real clarification', () => {
  const fn = slice(engagement, 'export function AgentOverviewPanel', 'export type AgentActivityRow')
  assert.match(fn, /const opportunity = overview\.learning_opportunities\[0\] \?\? null/)
  assert.match(fn, /onClick=\{\(\) => navigate\(clarificationFocusPath\(trainPath, opportunity\.id\)\)\}>Review/)
  assert.doesNotMatch(fn, /ReferralPreferenceModal/)
})

// ---------------------------------------------------------------- case context / language cleanup

test('a visible CASE CONTEXT block renders whenever a question carries one, in both the modal and the legacy page', () => {
  const modal = slice(engagement, 'function QuickTrainingModal', 'export function TrainingPage')
  assert.match(modal, /current\.case_context && <div className="training-case-context">/)
  const legacy = slice(engagement, 'export function TrainingPage', '/* ----------------------------------------------------------------- My Agent: Train */')
  assert.match(legacy, /current\.case_context && <div className="training-case-context">/)
})

test('readiness copy is never hardcoded to claim the agent is untrained', () => {
  assert.doesNotMatch(engagement, /has not been trained/i)
})

// ---------------------------------------------------------------- Network default + Chen parity

test('every persona\'s Network page defaults to Colleagues, never Feed, on a fresh visit', () => {
  // Physician UX consistency pass: one shared page, so one default.
  const shared = readFileSync(new URL('../src/PhysicianNetwork.tsx', import.meta.url), 'utf8')
  assert.match(slice(shared, 'export function PhysicianNetworkPage', shared.length), /tabParam === 'feed' \? 'feed' : 'my-network'/)
  for (const perspective of ['lucy', 'iain', 'chen']) {
    assert.match(app, new RegExp(`<PhysicianNetworkPage perspective="${perspective}" navigate=\\{navigate\\} params=\\{params\\} />`), `${perspective} Network uses the shared page`)
  }
})

test('Chen\'s Colleagues tab gets the same ActiveNetworkRail as Lucy\'s, not a persona-specific fork', () => {
  const shared = readFileSync(new URL('../src/PhysicianNetwork.tsx', import.meta.url), 'utf8')
  assert.doesNotMatch(referral, /function ChenMyNetworkTab/)
  assert.match(slice(shared, 'export function MyNetworkTab', 'export function PhysicianNetworkPage'), /<ActiveNetworkRail navigate=\{navigate\} perspective=\{perspective\} onViewInFeed=\{/)
})
