import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import {
  intakeFormFrom, intakeSourceLine, parsePageRanges, pilotPaths, regionStyle, resolvePilotRoute, conflictDecider,
} from '../src/pilotState.ts'

const source = (name) => readFileSync(new URL(`../src/${name}`, import.meta.url), 'utf8')
const intake = source('PilotIntake.tsx')
const pilot = source('Pilot.tsx')
const agent = source('PilotAgent.tsx')

test('intake and patient pages have their own routes', () => {
  assert.deepEqual(resolvePilotRoute('/me/intake'), { kind: 'intake' })
  assert.deepEqual(resolvePilotRoute('/me/patients/pat_abc123'), { kind: 'patient', id: 'pat_abc123' })
  assert.deepEqual(resolvePilotRoute('/me/patients'), { kind: 'patients' })
  assert.equal(pilotPaths.intakeItem('itm_1'), '/me/intake?item=itm_1')
})

test('the referral form is prefilled from proposals, never from anything unread', () => {
  const form = intakeFormFrom({ fields: {
    patient_name: { value: 'Robin Lumen-Synthetic' }, date_of_birth: { value: '1968-03-14' }, referring_clinician: { value: 'Dr. Casey Placeholder' },
    contact: { value: '(555) 010-0199' }, referral_question: { value: 'Incidental thyroid nodule' }, referral_type: { value: 'thyroid nodules' },
  } }, 'Thyroid nodule')
  assert.equal(form.patientName, 'Robin Lumen-Synthetic')
  assert.equal(form.patientDob, '1968-03-14')
  assert.equal(form.referralType, 'Thyroid nodule', 'the practice type the server matched wins')
  assert.equal(form.senderPractice, '', 'nothing proposed, nothing filled')
  assert.equal(intakeFormFrom({ fields: { date_of_birth: { value: '03/14/1968' } } }, null).patientDob, '', 'only a valid ISO date')
})

test('splitting needs every page in exactly one range', () => {
  assert.deepEqual(parsePageRanges('1-2, 3-4', 4), [[1, 2], [3, 4]])
  assert.deepEqual(parsePageRanges('3-4,1-2', 4), [[1, 2], [3, 4]])
  assert.deepEqual(parsePageRanges('1, 2-3', 3), [[1, 1], [2, 3]])
  for (const bad of ['1-4', '1-2, 4', '1-3, 3-4', '0-1, 2-4', 'a-b, 3-4', '']) assert.equal(parsePageRanges(bad, 4), null, bad)
})

test('source lines and regions', () => {
  assert.equal(intakeSourceLine({ channel: 'fax', from_address: '(555) 010-0199', subject: null }), 'Fax from (555) 010-0199')
  assert.equal(intakeSourceLine({ channel: 'email', from_address: 'office@x.test', subject: 'Referral' }), 'Email from office@x.test · “Referral”')
  assert.equal(intakeSourceLine({ channel: 'upload', from_address: null, subject: null }), 'Uploaded by your team')
  assert.deepEqual(regionStyle([0.1, 0.2, 0.5, 0.01]), { left: '10%', top: '20%', width: '50%', height: '2%' })
})

test('Intake: physicians are read-only until they choose to act; every action is a person\'s', () => {
  assert.match(intake, /const \[acting, setActing\] = useState\(!physician\)/)
  assert.match(intake, /Act on this item/)
  assert.match(intake, /const canAct = item\.can_act && acting && open/)
  // Proposals are labelled as proposals; results stay documents a person confirms.
  assert.match(intake, /proposals — check before using/)
  assert.match(intake, /Results stay documents/)
  // A matched patient is only used when a person chooses it; the default is a new record.
  assert.match(intake, /checked=\{!patientId\}.*A new patient record/s)
  // Dismissed items are restorable; dismissing needs a reason (and a note for "other").
  assert.match(intake, /Restore to Intake/)
  assert.match(intake, /reason === 'other' && !note\.trim\(\)/)
  // Merges are confirmed, and can be undone.
  assert.match(intake, /Confirm: merge this record into/)
  assert.match(intake, /Undo merge/)
  assert.match(pilot, /\{ id: 'intake', title: 'Intake', icon: <IntakeNavIcon \/>, path: pilotPaths\.intake \}/)
})

test('run-3 follow-ups: decider wording, rule phrases, teach hint, evidence window', () => {
  assert.equal(conflictDecider({ corrected_by_name: 'Dr. Avery Testwell' }),
    'Only Dr. Avery Testwell (who made this correction) or an admin physician can keep it or apply the rule.')
  assert.match(pilot, /<p className="practice-subheading">Relied on these confirmed statements<\/p>/)
  assert.doesNotMatch(pilot, /Relied on your confirmed representation/)
  assert.match(agent, />Avoid patient names or identifiers\.<\/p>/)
  assert.match(pilot, /requirement\.window_status === 'outside' && <p className="pilot-window-flag" role="note"><strong>Outside the window\.<\/strong> This result is older than the rule allows/)
  assert.match(pilot, /useState\(requirement\.evidence_date \?\? ''\)/, 'a dated proposal starts the confirm form with its date')
})
