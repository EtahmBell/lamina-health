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

test('ordinary training opens the shared QuickTrainingModal, never a navigation to the legacy full-screen TrainingPage', () => {
  const fn = slice(engagement, 'export function TrainTab', 'export function ChatTab')
  assert.match(fn, /setQuickTrainingOpen\(true\)/)
  assert.doesNotMatch(fn, /navigate\(`\$\{trainPath\}\?mode=daily`\)/, 'ordinary quick training no longer navigates away')
  assert.match(fn, /<QuickTrainingModal personaId=\{personaId\} onClose=\{\(\) => setQuickTrainingOpen\(false\)\} onFinished=\{\(\) => setQuickTrainingOpen\(false\)\} initializationNeeded=\{initializationNeeded\} \/>/)
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

test('Train reframes around three parallel teaching modes, never "Question 1 of 10" as the primary concept', () => {
  const fn = slice(engagement, 'export function TrainTab', 'export function ChatTab')
  assert.match(fn, /From recent work/)
  assert.match(fn, /Quick questions/)
  assert.match(fn, /Describe your practice/)
  assert.doesNotMatch(fn, /Question \d+ of \d+/)
})

test('"Describe your practice" reuses ReferralPreferenceModal -- the existing NLP pipeline, never a duplicated backend', () => {
  const fn = slice(engagement, 'export function TrainTab', 'export function ChatTab')
  assert.match(fn, /<ReferralPreferenceModal personaId=\{personaId\} navigate=\{navigate\} onClose=\{\(\) => setDescribeOpen\(false\)\} \/>/)
  assert.match(fn, /personaId === 'chen' && <div className="train-mode-card">/)
})

test('"From recent work" surfaces at most the one real clarification opportunity, never a fabricated backlog', () => {
  const fn = slice(engagement, 'export function TrainTab', 'export function ChatTab')
  assert.match(fn, /learningOpportunities\.length > 0 && <div className="train-mode-card train-mode-recent-work">/)
  assert.match(fn, /\{learningOpportunities\[0\]\.title\}/)
  assert.doesNotMatch(fn, /14 signals|11 resolved|fabricat/i)
})

test('clicking Clarify opens the shared NLP modal, pre-framed with the real clarifying question -- never silently operationalizing anything', () => {
  const fn = slice(engagement, 'export function TrainTab', 'export function ChatTab')
  assert.match(fn, /heading=\{clarifyOpportunity\.clarifying_question\}/)
  assert.match(fn, /intro=\{clarifyOpportunity\.supporting_text\}/)
})

// ---------------------------------------------------------------- "what your agent learned this week"

test('the learned-this-week card sits above the practice-representation detail, and never shows a fake aggregate score', () => {
  const fn = slice(engagement, 'export function AgentOverviewPanel', 'export type AgentActivityRow')
  const learnedIndex = fn.indexOf('What your agent learned this week')
  const detailIndex = fn.indexOf('How your agent currently represents your practice')
  assert.ok(learnedIndex > -1 && detailIndex > -1 && learnedIndex < detailIndex)
  assert.match(fn, /1 thing needs your judgment/)
  assert.doesNotMatch(fn, /[Aa]gent [Ss]core/)
})

test('the overview Clarify button opens the same ReferralPreferenceModal, scoped to the one real opportunity', () => {
  const fn = slice(engagement, 'export function AgentOverviewPanel', 'export type AgentActivityRow')
  assert.match(fn, /const opportunity = overview\.learning_opportunities\[0\] \?\? null/)
  assert.match(fn, /onClick=\{\(\) => setClarifyOpportunity\(opportunity\)\}>Review/)
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
  for (const [label, source, fn] of [
    ['Lucy', app, slice(app, 'function LucyNetworkPage', 'function HomePage')],
    ['Iain', specialist, slice(specialist, 'export function SpecialistNetworkPage', specialist.length)],
    ['Chen', referral, slice(referral, 'export function ChenNetworkPage', referral.length)],
  ]) {
    assert.match(fn, /tabParam === 'feed' \? 'feed' : 'my-network'/, `${label} Network page defaults to Colleagues`)
  }
})

test('Chen\'s Colleagues tab gets the same ActiveNetworkRail as Lucy\'s, not a persona-specific fork', () => {
  const chenTab = slice(referral, 'function ChenMyNetworkTab', 'export function ChenNetworkPage')
  assert.match(chenTab, /<ActiveNetworkRail navigate=\{navigate\} onViewInFeed=\{/)
})
