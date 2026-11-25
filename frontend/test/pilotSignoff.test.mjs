import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { actorText, changeText, correctionText, displayTemplate, eventLabel, historyHighlights, physicianLabel } from '../src/pilotState.ts'

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
  assert.equal(changeText({ field: 'suggested_modality', from: 'unspecified', to: 'econsult', by: 'Dr. Saru', because: null, triggered_by: null, at: '' }),
    'Visit type: unspecified → eConsult (by Dr. Saru)')
  // Cause vs trigger: the rule's author caused it; Front desk only re-ran the check.
  assert.equal(changeText({ field: 'suggested_modality', from: 'econsult', to: 'in_person', by: 'Dr. Avery Testwell',
    because: 'Dr. Avery Testwell updated the Thyroid nodule rule (v4)', triggered_by: 'Front desk', at: '' }),
  'Visit type: eConsult → in-person, because Dr. Avery Testwell updated the Thyroid nodule rule (v4) · re-checked by Front desk')
  assert.equal(changeText({ field: 'fit', from: 'possible', to: 'strong', by: 'Rivera FM', because: 'the referring office sent new information', triggered_by: null, at: '' }),
    'Fit: possible fit → strong practice fit, because the referring office sent new information')
  assert.equal(actorText({ event_type: 'recommendation_changed', autonomy: 'automatic', actor_name: 'Lamina',
    metadata: { cause: { text: 'Dr. A updated the X rule (v2)', trigger_differs: true }, requested_by_name: 'Front desk' } }),
  'Lamina, because Dr. A updated the X rule (v2) · re-checked by Front desk')
  assert.equal(correctionText({ field: 'suggested_priority', from: 'routine', to: 'soon', actor_name: 'Dr. Avery Testwell' }),
    'Priority: routine → soon (by Dr. Avery Testwell)')
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
  // Rationale is rendered for each reader by the server from structured parts (no display-time
  // rewriting of stored sentences): the page shows `text`, flagging older physician wording.
  assert.doesNotMatch(source('pilotState.ts'), /export function thirdPerson/)
  assert.match(pilot, /\{item\.text \?\? item\.statement\}\{item\.worded_for_physician &&/)
  assert.match(pilot, /placeholder: physician \? 'Ask or teach your agent…' : `Ask about a referral, or suggest something for \$\{doctor\} to confirm…`/)
  assert.match(agent, /`Suggest how \$\{doctor\}’s agent should handle referrals\./)
  assert.doesNotMatch(agent, /Only the physician can teach the agent or confirm what it learned/, 'no contradictory Train intro')
})

test('a referral with received values lands on Verify as the primary action', () => {
  const detail = slice(pilot, 'function ReferralDetailPage', 'function ProfilePage')
  // The standing (heading, still open, readiness) comes from the server: one source of truth
  // shared with Home and Patients (backend/pilot/standing.py; tests/test_pilot_followup.py).
  assert.match(detail, /const standing = detail\.standing \?\?/)
  assert.match(detail, /className="button-primary" disabled=\{busy\} onClick=\{\(\) => void act\(\(\) => verifyReferralItem\(referral\.id, item\.key\)\)\}>Verify \{item\.label\}/)
})

test('layout fixes: join header, sender notice spacing, setup button spacing', () => {
  // The join page now lives in PilotAccess.tsx: every state renders in Panel, which hides the physician links.
  const access = source('PilotAccess.tsx')
  assert.match(slice(access, 'function Panel', '\n}\n'), /<ClaimShell navigate=\{navigate\} physicianLinks=\{false\}>/)
  assert.doesNotMatch(slice(access, 'export function JoinPracticePage', '\n}\n'), /<ClaimShell/, 'every join-page state uses Panel')
  assert.match(source('PublicPages.tsx'), /public-sender-notice/)
  assert.match(source('PilotSetup.tsx'), /pilot-setup-staff-actions/)
  const css = source('styles.css')
  assert.match(css, /\.public-sender-notice \{ margin: 18px 0 22px;/)
  assert.match(css, /\.pilot-setup-staff-actions \{ margin-top: 24px; \}/)
})

test('one statement of where a referral stands, from the server', () => {
  // Heading, "Still open" and readiness wording are computed once on the server and shared by
  // the referral page, Home and Patients (backend/pilot/standing.py, tested in
  // tests/test_pilot_followup.py); the page renders them and never recomputes them.
  assert.match(pilot, /const nextStepHeading = standing\.heading/)
  assert.match(pilot, /\{!closed && standing\.still_open && <p className="pilot-still-open">\{standing\.still_open\}<\/p>\}/)
  assert.match(pilot, /const readiness = recommendation \? standing\.readiness_text : null/)
  assert.doesNotMatch(source('pilotState.ts'), /export function referralStanding/)
})

test('history keeps request, reply and decision events with what they were about', () => {
  const at = '2026-01-01T00:00:00Z'
  const history = [
    { event_type: 'referral_received', created_at: at }, { event_type: 'missing_information_request_sent', created_at: at },
    ...Array.from({ length: 12 }, () => ({ event_type: 'referral_triaged', created_at: at })),
    { event_type: 'sender_response_received', created_at: at },
  ]
  const shown = historyHighlights(history).map((event) => event.event_type)
  assert.ok(shown.includes('missing_information_request_sent') && shown.includes('sender_response_received'))
  assert.equal(shown.length, 8)
  assert.match(pilot, /\{event\.summary && <p className="timeline-summary">\{event\.summary\}<\/p>\}/)
})

test('a correction that a newer rule disagrees with is shown with keep / apply choices', async () => {
  const { conflictText } = await import('../src/pilotState.ts')
  const conflict = { field: 'suggested_modality', corrected_value: 'econsult', rule_value: 'in_person', referral_type: 'Thyroid nodule', rule_id: 'r', rule_version: 5,
    corrected_by_name: 'Dr. Avery Testwell', rule_by_name: 'Dr. Avery Testwell', corrected_by_you: true, rule_by_you: true }
  assert.equal(conflictText(conflict), 'Visit type: your earlier correction (eConsult) differs from your updated rule (in-person, Thyroid nodule v5)')
  assert.equal(conflictText({ ...conflict, corrected_by_you: false, rule_by_you: false }),
    'Visit type: Dr. Avery Testwell’s earlier correction (eConsult) differs from Dr. Avery Testwell’s updated rule (in-person, Thyroid nodule v5)')
  assert.match(conflictText({ ...conflict, rule_by_you: false, rule_by_name: null }), /the updated rule \(author not recorded\)/)
  assert.match(pilot, /resolveCorrectionConflict\(referral\.id, conflict\.field, 'keep_correction'\)\)\}>\{conflictWording\(conflict, physician, doctor\)\.keep\}/, 'the keep label names whose correction it is')
  assert.match(pilot, /resolveCorrectionConflict\(referral\.id, conflict\.field, 'apply_rule'\)\)\}>Apply the rule/)
  assert.match(pilot, /\{physician && <div className="pilot-actions">\s*<button className="button-secondary" disabled=\{busy\} onClick=\{\(\) => void act\(\(\) => resolveCorrectionConflict/, 'only physicians choose')
})
