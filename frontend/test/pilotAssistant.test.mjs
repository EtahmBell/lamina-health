import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { dockMessagesFrom, setReferralPrefill, takeReferralPrefill } from '../src/pilotState.ts'
import { notifyPilotDataChanged, pilotDataVersion, subscribePilotData } from '../src/pilotSync.ts'

/* Step 15: the persistent conversational practice agent. The model interprets and
 * prepares; the backend controls; the browser only renders and relays human clicks. */

const source = (name) => readFileSync(new URL(`../src/${name}`, import.meta.url), 'utf8')
const pilot = source('Pilot.tsx')
const ui = source('pilotUi.tsx')
const api = source('pilotApi.ts')
const slice = (text, from, to) => text.slice(text.indexOf(from), to ? text.indexOf(to, text.indexOf(from)) : undefined)

test('the dock talks to the assistant endpoint, not the teaching endpoint', () => {
  const dock = slice(pilot, 'function PracticeAgentDock', '/* ------------------------------------------------------------- referrals')
  assert.match(dock, /sendAssistantMessage\(text, context\?\.referralId\)/)
  assert.doesNotMatch(dock, /teachAgent/, 'ordinary chat is never sent straight to teaching')
  assert.match(dock, /loadHistory: \(\) => getAssistant\(\)/, 'history comes from the server')
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


/* ------------------------------------------- follow-up: reactive state + patient context */

test('one invalidation signal: every successful pilot write notifies, reads never do', () => {
  const wrapper = slice(api, 'async function apiRequest<T>', 'const json =')
  assert.match(wrapper, /const result = await baseApiRequest<T>\(path, init\)/)
  assert.match(wrapper, /if \(init\?\.method && init\.method\.toUpperCase\(\) !== 'GET'\) notifyPilotDataChanged\(\)/)
  assert.ok(wrapper.indexOf('await baseApiRequest') < wrapper.indexOf('notifyPilotDataChanged'), 'only after the write succeeded')
  assert.match(slice(api, 'export async function uploadReferralDocument', 'export async function openReferralDocument'), /notifyPilotDataChanged\(\)/)
  assert.doesNotMatch(source('pilotSync.ts'), /localStorage|sessionStorage|indexedDB/)
})

test('the sync module notifies subscribers and bumps the version', () => {
  const before = pilotDataVersion()
  let calls = 0
  const off = subscribePilotData(() => { calls += 1 })
  notifyPilotDataChanged()
  notifyPilotDataChanged()
  off()
  notifyPilotDataChanged()
  assert.equal(calls, 2, 'unsubscribed listeners stop')
  assert.equal(pilotDataVersion(), before + 3)
})

test('Home, Patients, referral detail, Your Agent, Network, and the dock re-read on change', () => {
  assert.match(slice(pilot, 'function useHomeData', 'function NeedRow'), /useOnPilotDataChange\(load\)/)
  assert.match(slice(pilot, 'function PatientsPage', 'function NewReferralPage'), /useOnPilotDataChange\(load\)/)
  assert.match(slice(pilot, 'function ReferralDetailPage', '/* -------------------------------------------------------------- profile'), /useOnPilotDataChange\(\(\) => void load\(\)\)/)
  assert.match(source('PilotAgent.tsx'), /useOnPilotDataChange\(\(\) => \{ reload\(\);/)
  assert.match(source('PilotNetwork.tsx'), /useOnPilotDataChange\(load\)/)
  assert.match(slice(pilot, 'function PracticeAgentDock', '/* ------------------------------------------------------------- referrals'), /refreshKey: dataVersion/)
})

test('cards render the backend state; resolved cards offer no action and history never re-executes', () => {
  const dock = slice(ui, 'export function AgentDock', "/** My Agent Overview")
  assert.match(ui, /const ACTIONABLE = new Set\(\[undefined, 'ready', 'pending'\]\)/)
  assert.match(dock, /resolved \|\| local === 'done'\s*\? \(card\.path && card\.state !== 'unavailable'/)
  assert.match(dock, /\(card\.state_label \?\? card\.detail\)/)
  // History loading only reads and renders; runCard is reachable from onClick alone.
  const history = slice(dock, 'const loadedKey', 'useEffect(() => { const body')
  assert.doesNotMatch(history, /runCard|onCard/)
  assert.equal((dock.match(/runCard\(/g) ?? []).length, 1, 'called once: from the button')
})

test('the referral page passes explicit structured context to the same dock', () => {
  const detail = slice(pilot, 'function ReferralDetailPage', '/* -------------------------------------------------------------- profile')
  assert.match(detail, /<PracticeAgentDock key=\{referral\.id\} status=\{status\} navigate=\{navigate\}\s*context=\{\{ referralId: referral\.id, patientName: referral\.patient\.name, referralType: referral\.referral_type \}\} \/>/)
  assert.match(pilot, /section="patients" agentDock><ReferralDetailPage/)
  const dock = slice(pilot, 'function PracticeAgentDock', '/* ------------------------------------------------------------- referrals')
  for (const prompt of ['Why did you recommend this?', 'What’s missing?', 'Prepare a request for the missing information.', 'Summarize what happened.']) assert.ok(dock.includes(prompt), prompt)
  // One conversational system: no second chat component or endpoint.
  assert.equal((pilot.match(/<AgentDock /g) ?? []).length, 2, 'the same AgentDock, with or without context')
  assert.equal((api.match(/\/api\/me\/practice\/assistant/g) ?? []).length, 3)
})
