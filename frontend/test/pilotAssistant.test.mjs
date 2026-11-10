import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { dockMessagesFrom, setReferralPrefill, takeReferralPrefill } from '../src/pilotState.ts'

/* Step 15: the persistent conversational practice agent. The model interprets and
 * prepares; the backend controls; the browser only renders and relays human clicks. */

const source = (name) => readFileSync(new URL(`../src/${name}`, import.meta.url), 'utf8')
const pilot = source('Pilot.tsx')
const ui = source('pilotUi.tsx')
const api = source('pilotApi.ts')
const slice = (text, from, to) => text.slice(text.indexOf(from), to ? text.indexOf(to, text.indexOf(from)) : undefined)

test('the dock talks to the assistant endpoint, not the teaching endpoint', () => {
  const dock = slice(pilot, 'function PracticeAgentDock', '/* ------------------------------------------------------------- referrals')
  assert.match(dock, /sendAssistantMessage\(text\)/)
  assert.doesNotMatch(dock, /teachAgent/, 'ordinary chat is never sent straight to teaching')
  assert.match(dock, /loadHistory=\{\(\) => getAssistant\(\)/, 'history comes from the server')
  assert.match(api, /'\/api\/me\/practice\/assistant\/messages'/)
})

test('cards only act on a human click, through existing endpoints', () => {
  const dock = slice(pilot, 'function PracticeAgentDock', '/* ------------------------------------------------------------- referrals')
  const onCard = slice(dock, 'const onCard', 'return <AgentDock')
  assert.match(onCard, /requestInformation\(action\.referral_id, action\.items, ''\)/)
  assert.match(onCard, /escalateReferral\(action\.referral_id, ''\)/)
  assert.match(onCard, /setReferralPrefill\(action\.draft\); navigate\(pilotPaths\.newReferral\)/)
  for (const forbidden of ['decideReferral', 'sendInformationRequest', 'approveTriage', 'confirmProposal', 'updatePractice']) {
    assert.ok(!dock.includes(forbidden), `the agent dock never calls ${forbidden}`)
  }
  // The dock component runs a card only from its button's onClick.
  assert.match(ui, /onClick=\{\(\) => void runCard\(key, card\)\}/)
  assert.doesNotMatch(slice(ui, 'export function AgentDock', "/** My Agent Overview"), /useEffect\([^)]*runCard/)
})

test('the dock keeps the demo chat markup and stores nothing in the browser', () => {
  const dock = slice(ui, 'export function AgentDock', "/** My Agent Overview")
  for (const cls of ['agent-dock', 'agent-dock-head', 'agent-dock-body', 'agent-msg agent', 'agent-msg me', 'agent-msg-card', 'agent-btn', 'agent-dock-input', 'agent-typing']) assert.ok(dock.includes(cls), cls)
  for (const forbidden of ['localStorage', 'sessionStorage', 'indexedDB']) assert.ok(!ui.includes(forbidden), forbidden)
})

test('an agent referral draft prefills the form exactly once', () => {
  setReferralPrefill({ patient_name: 'Jordan Sample', patient_dob: '1981-03-04', referral_type: 'Diabetes management', reason: 'A1c rising', sender_name: '' })
  assert.deepEqual(takeReferralPrefill(), { patientName: 'Jordan Sample', patientDob: '1981-03-04', referralType: 'Diabetes management', reason: 'A1c rising' })
  assert.equal(takeReferralPrefill(), null, 'taken once')
  setReferralPrefill({ patient_dob: 'March 4' })
  assert.deepEqual(takeReferralPrefill(), {}, 'invalid dates are dropped, not guessed')
  assert.match(pilot, /useState<ReferralForm>\(\(\) => \(\{ \.\.\.emptyReferralForm\(\), \.\.\.\(takeReferralPrefill\(\) \?\? \{\}\) \}\)\)/)
})

test('stored history maps to dock messages without reinterpretation', () => {
  const card = { label: 'L', detail: 'D', action: 'Open', path: '/me/patients' }
  assert.deepEqual(dockMessagesFrom([
    { id: 'm1', role: 'user', text: 'Hello', reply: null },
    { id: 'm2', role: 'agent', text: 'Hi', reply: { paragraphs: ['Hi.'], cards: [card] } },
    { id: 'm3', role: 'agent', text: 'Fallback text', reply: null },
  ]), [
    { id: 'm1', role: 'physician', text: 'Hello' },
    { id: 'm2', role: 'agent', reply: { paragraphs: ['Hi.'], cards: [card] } },
    { id: 'm3', role: 'agent', reply: { paragraphs: ['Fallback text'] } },
  ])
})
