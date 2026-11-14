import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import {
  AUTONOMY_LABELS, pilotPaths, representationGroups, representationPortrait, resolvePilotRoute, resolveSetupStage,
  ruleFormFrom, ruleInput, SCOPE_CHOICE_LABELS, setupProgressLine, STATEMENT_KIND_EFFECT, STATEMENT_KIND_LABELS,
} from '../src/pilotState.ts'

/* Step 17: physician initialization and practice representation (UI side). */

const source = (name) => readFileSync(new URL(`../src/${name}`, import.meta.url), 'utf8')
const setup = source('PilotSetup.tsx')
const agent = source('PilotAgent.tsx')
const pilot = source('Pilot.tsx')
const api = source('pilotApi.ts')
const slice = (text, from, to) => text.slice(text.indexOf(from), to ? text.indexOf(to, text.indexOf(from)) : undefined)

test('setup is a resumable, staged route', () => {
  assert.deepEqual(resolvePilotRoute('/me/setup'), { kind: 'setup' })
  assert.equal(pilotPaths.setup('scope'), '/me/setup?stage=scope')
  assert.equal(resolveSetupStage('delegation'), 'delegation')
  assert.equal(resolveSetupStage('nonsense'), 'identity')
  assert.match(pilot, /case 'setup': return <PilotGate/)
})

test('progress is by stage with honest time, never a score or percentage', () => {
  const line = setupProgressLine({ stages: [{ status: 'done' }, { status: 'skipped' }, { status: 'not_started' }, { status: 'not_started' }, { status: 'not_started' }], minutes_remaining: 6 })
  assert.equal(line, '1 of 5 stages done · 1 skipped · about 6 min left')
  for (const text of [setup, agent]) {
    assert.doesNotMatch(text, /%\s*complete|completeness score|quality score|agent score/i)
    assert.doesNotMatch(text, /understands you|knows you|\bsmart\b/i, 'say represents / confirmed / learned')
  }
})

test('every stage can be skipped and Unknown is always an answer', () => {
  for (const stage of ['IdentityStage', 'ScopeStage', 'RequirementsStage', 'DelegationStage']) {
    const start = setup.indexOf(`function ${stage}`)
    const body = setup.slice(start, setup.indexOf('\nfunction ', start + 1))
    assert.match(body, /onSkip|Skip for now/, stage)
  }
  assert.equal(SCOPE_CHOICE_LABELS.unknown, 'Unknown')
  assert.match(setup, /Suggested — not confirmed/)
  assert.match(setup, /suggested, not confirmed/)
})

test('delegation offers no autonomous decisions or sending', () => {
  assert.deepEqual(Object.keys(AUTONOMY_LABELS), ['off', 'observe', 'prepare_drafts', 'ask_before_acting'])
  const stage = slice(setup, 'function DelegationStage', 'function ReviewStage')
  assert.match(stage, /every capability stays in shadow/)
  assert.doesNotMatch(stage, /autonomous|send automatically|decide for me/i)
})

test('review confirms nothing implicitly and shows unknowns honestly', () => {
  const review = slice(setup, 'function ReviewStage')
  assert.match(review, /confirmRepresentation\(\)/)
  assert.match(review, /Items still waiting stay unconfirmed/)
  assert.match(review, /Leave unknown/)
  assert.match(review, /Still unknown/)
  assert.match(review, /<ProposalCard /, 'confirm / edit / reject reuse the existing proposal card')
})

test('statement kinds are labelled with what they drive', () => {
  assert.equal(STATEMENT_KIND_EFFECT.hard_requirement, 'Decides whether a referral is complete')
  assert.equal(STATEMENT_KIND_EFFECT.soft_preference, 'Suggested only — never blocks a referral')
  assert.equal(STATEMENT_KIND_LABELS.exception, 'Exception — kept as a note')
  const type = { referral_type: 'Type A', aliases: [], scope_policy: 'accept', layers: ['practice'], unknown_topics: [], items: [
    { kind: 'hard_requirement', text: 'Lab', status: 'confirmed', rule_id: 'r1', version: 2, layer: 'practice', source: 'x', confirmed_at: null },
    { kind: 'scope_policy', text: 'Out', status: 'proposed', rule_id: 'r2', version: 1, layer: 'practice', source: 'x', confirmed_at: null },
  ] }
  const groups = representationGroups(type)
  assert.equal(groups.confirmed.length, 1)
  assert.equal(groups.proposed.length, 1)
  assert.equal(representationPortrait({ name: 'P', specialty: 'Endocrinology' }, { types: [type] }), 'Endocrinology practice — sees Type A.')
  assert.match(representationPortrait(null, { types: [] }), /Nothing is confirmed yet/)
})

test('edits never drop a statement kind', () => {
  const form = ruleFormFrom({ referral_type: 'Type A', content: { good_fit: [], redirect: [], required: [], helpful: [], urgent_signals: [], modality: 'unspecified', modality_notes: null, scope_policy: 'case_by_case', preferences: ['p'], exceptions: ['e'], judgment: ['j'], make_optional: ['k'], answered_topics: ['scope'] } })
  const input = ruleInput(form)
  assert.equal(input.scope_policy, 'case_by_case')
  assert.deepEqual([input.preferences, input.exceptions, input.judgment, input.make_optional, input.answered_topics], [['p'], ['e'], ['j'], ['k'], ['scope']])
})

test('Your Agent: one source for learning counts, honest lifecycle, resume entry', () => {
  const overview = slice(agent, 'function AgentOverview', 'function PracticeRepresentation')
  assert.match(overview, /counts\.confirmed_this_week/)
  assert.match(overview, /counts\.pending_learnings/)
  assert.match(overview, /counts\.open_questions/)
  assert.doesNotMatch(overview, /rules\.filter\(\(rule\) => rule\.confirmed_at/, 'no second, client-side count')
  assert.match(overview, /lifecycle\.state === 'initializing'/)
  assert.match(overview, /Continue setup/)
  const page = slice(agent, 'export function AgentPage', 'function AgentOverview')
  assert.match(page, /summary\.counts\.pending_learnings \+ summary\.counts\.open_questions/, 'Train badge reads the same summary')
  assert.match(agent, /teach: 'Train'/)
  assert.match(api, /'\/summary'/)
})

test('staff see an explanation, not the setup flow', () => {
  assert.match(setup, /Only the physician sets up their agent/)
})
