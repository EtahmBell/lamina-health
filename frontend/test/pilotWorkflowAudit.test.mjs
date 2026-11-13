import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { turnsForReferral } from '../src/pilotState.ts'

/* Workflow-audit UX fixes: each test pins one behavior found while walking the real pilot
 * flows (empty practice, missing information, referral-scoped agent, dev outbox). */

const pilot = readFileSync(new URL('../src/Pilot.tsx', import.meta.url), 'utf8')
const slice = (text, from, to) => text.slice(text.indexOf(from), to ? text.indexOf(to, text.indexOf(from)) : undefined)

test('a referral dock shows only turns asked from that referral, never another patient', () => {
  const messages = [
    { id: '1', role: 'user', context_referral_id: 'ref_alpha' },
    { id: '2', role: 'agent' },
    { id: '3', role: 'user', context_referral_id: null },
    { id: '4', role: 'agent' },
    { id: '5', role: 'user', context_referral_id: 'ref_gamma' },
    { id: '6', role: 'agent' },
  ]
  assert.deepEqual(turnsForReferral(messages, 'ref_gamma').map((m) => m.id), ['5', '6'])
  assert.deepEqual(turnsForReferral(messages, 'ref_alpha').map((m) => m.id), ['1', '2'])
  assert.deepEqual(turnsForReferral(messages, 'ref_none'), [])
  const dock = slice(pilot, 'function PracticeAgentDock', '/* ------------------------------------------------------------- referrals')
  assert.match(dock, /context \? turnsForReferral\(data\.messages, context\.referralId\) : data\.messages/, 'Home keeps the full history')
})

test('an empty practice is told plainly that rules come first', () => {
  const home = slice(pilot, 'function PilotHomePage', 'function ForYouPage')
  assert.match(home, /setupOnly/)
  assert.match(home, /I need your referral criteria before I can triage\./)
  // The generic "prepared what I can" line is reserved for real prepared/pending work.
  assert.match(home, /needs\.length \? 'I’ve prepared what I can\. The rest needs you\.'/)
})

test('an open request changes the next-step heading and hides a second "Request information"', () => {
  const detail = slice(pilot, 'function ReferralDetailPage', 'function ProfilePage')
  assert.match(detail, /'Review and send the information request'/)
  assert.match(detail, /'Waiting on the referring office'/)
  assert.match(detail, /canUse\(actions, 'request_information'\) && !hasDraft/)
  assert.match(detail, /'Modality not specified'/)
})

test('the dev outbox never reads as if the referring office was emailed', () => {
  const sentVia = slice(pilot, 'const sentViaText', 'function InformationRequestPanel')
  assert.match(sentVia, /local test outbox, not delivered to anyone/)
  assert.doesNotMatch(slice(pilot, 'function InformationRequestPanel', 'type Panel'), /via \$\{request\.sent_via\}/)
})

test('pilot pages are titled Lamina, not the demo product name', () => {
  assert.match(slice(pilot, 'export function PilotApp', 'function PilotGate'), /document\.title = 'Lamina'/)
})
