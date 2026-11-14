import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import {
  displayTemplate, NEXT_STEP_LABELS, patientWorkSections, receivedReferralWorkItem, REQUIREMENT_STATE_LABELS,
  ruleFormFrom, ruleInput, STATUS_LABELS,
} from '../src/pilotState.ts'

/* Step 16: referral safety, correctness, and workflow reliability (UI side). */

const source = (name) => readFileSync(new URL(`../src/${name}`, import.meta.url), 'utf8')
const pilot = source('Pilot.tsx')
const agent = source('PilotAgent.tsx')
const pages = source('PublicPages.tsx')
const slice = (text, from, to) => text.slice(text.indexOf(from), to ? text.indexOf(to, text.indexOf(from)) : undefined)

test('stored request text is a template; the secure link is never re-displayed', () => {
  assert.equal(displayTemplate('Upload here: {status_link}\nThanks'), 'Upload here: [secure link — added when sent]\nThanks')
  const panel = slice(pilot, 'function InformationRequestPanel', 'type Panel')
  assert.match(panel, /displayTemplate\(request\.draft_message\)/)
  assert.match(panel, /reissueRequestLink\(request\.id/, 'a lost or exposed link can be replaced')
  assert.match(panel, /Shown once; Lamina doesn’t keep a copy/)
})

test('the sender page never leaks its token-bearing URL as a Referer', () => {
  const sender = slice(pages, 'export function SenderStatusPage')
  assert.match(sender, /meta\.name = 'referrer'; meta\.content = 'no-referrer'/)
  assert.match(sender, /received, the practice will review it/)
  assert.match(sender, /received and checked ✓/)
})

test('sender values are received, not satisfied, until someone verifies them', () => {
  assert.equal(REQUIREMENT_STATE_LABELS.sender_reported, 'Received — not yet verified')
  assert.equal(REQUIREMENT_STATE_LABELS.satisfied, 'Satisfied')
  assert.equal(NEXT_STEP_LABELS.review_sender_information, 'Verify what the referring office sent')
  const row = slice(pilot, 'function RequirementRow', 'const REQUEST_STATUS')
  assert.match(row, /verifyReferralItem\(referralId, requirement\.key\)/)
  assert.match(row, /reported && canVerify/)
})

test('referral type is chosen from the practice types; unknown types are confirmed, wording kept', () => {
  const form = slice(pilot, 'function NewReferralPage', 'function RequirementRow')
  assert.match(form, /<option value="__other__">Other — not one of our types<\/option>/)
  assert.doesNotMatch(form, /<datalist id="pilot-referral-types"/, 'no longer free text only')
  const detail = slice(pilot, 'function ReferralDetailPage', 'function ProfilePage')
  assert.match(detail, /setReferralType\(referral\.id, chosenType\)/)
  assert.match(detail, /Submitted as “\{referral\.submitted_referral_type\}”/)
  assert.equal(NEXT_STEP_LABELS.confirm_referral_type, 'Confirm the referral type')
})

test('rule aliases round-trip through the rule form', () => {
  const form = ruleFormFrom({ referral_type: 'Type A', content: { good_fit: [], redirect: [], required: [], helpful: [], urgent_signals: [], modality: 'unspecified', modality_notes: null, aliases: ['Type A variant'] } })
  assert.equal(form.aliases, 'Type A variant')
  assert.deepEqual(ruleInput({ ...form, aliases: 'One\nTwo' }).aliases, ['One', 'Two'])
  assert.match(agent, /Also called/)
  assert.match(agent, /proposal\.review_notes/, 'what was not turned into a rule is shown before confirming')
})

test('an unchanged recommendation keeps its approval; a changed one says what changed', () => {
  const detail = slice(pilot, 'function ReferralDetailPage', 'function ProfilePage')
  assert.match(detail, /decision\.carried_forward \?/)
  assert.match(detail, /detail\.approval\?\.state === 'needs_review_changed'/)
})

test('accepted referrals await scheduling; nothing is shown as scheduled or completed', () => {
  assert.equal(STATUS_LABELS.accepted, 'Accepted — awaiting scheduling')
  for (const label of Object.values(STATUS_LABELS)) assert.doesNotMatch(label, /Scheduled|Completed/)
  const base = { patient_name: 'Sam', referral_type: 'Type A', sender_name: 'Dr. R', sender_practice: null, received_at: '2026-11-01T00:00:00Z', fit: 'possible', priority: 'routine', next_step: 'physician_review', requires_physician: false, missing_items: [], escalated: false, decided: true }
  const items = ['accepted', 'redirected', 'declined', 'triaged'].map((status, index) => receivedReferralWorkItem({ ...base, id: String(index), status }))
  const sections = patientWorkSections(items)
  assert.deepEqual(sections.awaitingScheduling.map((item) => item.key), ['received_referral:0'])
  assert.equal(sections.closed.length, 2)
  assert.equal(sections.active.length, 1)
  const page = slice(pilot, 'function PatientsPage', 'function NewReferralPage')
  assert.match(page, /scheduling isn’t connected to Lamina yet/)
})
