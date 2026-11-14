import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { actorText, changeText, correctionText, displayTemplate, eventLabel, physicianLabel, thirdPerson } from '../src/pilotState.ts'

/* Sign-off model and staff walkthrough fixes: the physician's decision is the sign-off, staff do
 * the paperwork, and every action names who did it. */

const source = (name) => readFileSync(new URL(`../src/${name}`, import.meta.url), 'utf8')
const pilot = source('Pilot.tsx')
const agent = source('PilotAgent.tsx')
const slice = (text, from, to) => text.slice(text.indexOf(from), to ? text.indexOf(to, text.indexOf(from)) : undefined)

test('attribution names the actor, never "your team"', () => {
  assert.equal(actorText({ actor_name: 'Front desk (TEST)', autonomy: 'human' }), 'Front desk (TEST)')
  assert.equal(actorText({ actor_name: 'Dr. Avery Testwell', autonomy: 'human' }), 'Dr. Avery Testwell')
  assert.equal(actorText({ autonomy: 'automatic' }), 'Lamina')
  const detail = slice(pilot, 'function ReferralDetailPage', 'function ProfilePage')
  assert.doesNotMatch(detail, /[Bb]y your team/)
  assert.doesNotMatch(slice(pilot, 'const sentViaText', 'function InformationRequestPanel'), /your team/)
})

test('a change note says who changed what, and what prompted an agent change', () => {
  assert.equal(changeText({ field: 'suggested_modality', from: 'unspecified', to: 'econsult', by: 'Dr. Saru', after: null, at: '' }),
    'visit type unspecified → eConsult (by Dr. Saru)')
  assert.equal(changeText({ field: 'fit', from: 'possible', to: 'strong', by: 'Lamina', after: 'Front desk', at: '' }),
    'fit possible fit → strong practice fit (by Lamina, after Front desk’s update)')
  assert.equal(correctionText({ field: 'suggested_priority', from: 'routine', to: 'soon', actor_name: 'Dr. Avery Testwell' }),
    'priority routine → soon (by Dr. Avery Testwell)')
})

test('retired approvals are labelled honestly; a staff review is not a physician sign-off', () => {
  assert.match(eventLabel({ event_type: 'recommendation_accepted', metadata: { role: 'staff' } }), /Staff reviewed triage .*not a physician sign-off/)
  assert.match(eventLabel({ event_type: 'recommendation_accepted', metadata: { role: 'physician' } }), /earlier approval step/)
  assert.equal(eventLabel({ event_type: 'referral_marked_ready', metadata: {} }), 'Marked ready for the physician')
})

test('the secure link placeholder says it is included when sent and not stored', () => {
  assert.equal(displayTemplate('{status_link}'), '[Secure link included when sent (not stored)]')
})

test('staff read the physician’s agent in the third person', () => {
  assert.equal(physicianLabel('Dr. Avery Testwell'), 'Dr. Avery Testwell')
  assert.equal(physicianLabel(null), 'the physician')
  assert.equal(thirdPerson('Your rule sets the default modality to econsult.', 'Dr. A'), 'Dr. A’s rule sets the default modality to econsult.')
  assert.match(pilot, /placeholder: physician \? 'Ask or teach your agent…' : `Ask about a referral, or suggest something for \$\{doctor\} to confirm…`/)
  assert.match(agent, /`Suggest how \$\{doctor\}’s agent should handle referrals\./)
  assert.doesNotMatch(agent, /Only the physician can teach the agent or confirm what it learned/, 'no contradictory Train intro')
})

test('a referral with received values lands on Verify as the primary action', () => {
  const detail = slice(pilot, 'function ReferralDetailPage', 'function ProfilePage')
  assert.match(detail, /toVerify\.length \? 'Verify what the referring office sent'/)
  assert.match(detail, /className="button-primary" disabled=\{busy\} onClick=\{\(\) => void act\(\(\) => verifyReferralItem\(referral\.id, item\.key\)\)\}>Verify \{item\.label\}/)
})

test('layout fixes: join header, sender notice spacing, setup button spacing', () => {
  assert.match(slice(pilot, 'function JoinPracticePage', 'function ProfilePage'), /<ClaimShell navigate=\{navigate\} physicianLinks=\{false\}>/)
  assert.doesNotMatch(slice(pilot, 'function JoinPracticePage', '\n}\n'), /<ClaimShell navigate=\{navigate\}>/, 'every join-page shell hides it')
  assert.match(source('PublicPages.tsx'), /public-sender-notice/)
  assert.match(source('PilotSetup.tsx'), /pilot-setup-staff-actions/)
  const css = source('styles.css')
  assert.match(css, /\.public-sender-notice \{ margin: 18px 0 22px;/)
  assert.match(css, /\.pilot-setup-staff-actions \{ margin-top: 24px; \}/)
})
