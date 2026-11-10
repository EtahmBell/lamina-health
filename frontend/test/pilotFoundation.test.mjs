import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { resolveProductMode } from '../src/productMode.ts'
import {
  briefingLines, emptyReferralForm, homeBuckets, parseRequirementLines, pilotPaths, referralFormErrors,
  referralPayload, resolvePilotRoute, ruleFormFrom, ruleInput, triageHeadline,
} from '../src/pilotState.ts'

const source = (name) => readFileSync(new URL(`../src/${name}`, import.meta.url), 'utf8')
const app = source('App.tsx')
const pilot = source('Pilot.tsx')
const pilotApi = source('pilotApi.ts')
const pilotState = source('pilotState.ts')
const onboarding = source('Onboarding.tsx')

/* --------------------------------------------------------------- mode */

test('product mode defaults to demo and only an explicit "pilot" switches it', () => {
  assert.equal(resolveProductMode(undefined), 'demo')
  assert.equal(resolveProductMode(''), 'demo')
  assert.equal(resolveProductMode('production'), 'demo')
  assert.equal(resolveProductMode(' PILOT '), 'pilot')
})

test('App renders PilotApp before any demo route in pilot mode', () => {
  const pilotBranch = app.indexOf("if (productMode === 'pilot') return <PilotApp")
  assert.ok(pilotBranch > 0, 'pilot branch exists')
  assert.ok(pilotBranch < app.indexOf("if (path === '/') return <LandingPage"), 'pilot branch precedes every demo route')
})

test('pilot routes resolve only onboarding, join, auth, and /me pilot pages', () => {
  assert.deepEqual(resolvePilotRoute('/me'), { kind: 'home' })
  assert.deepEqual(resolvePilotRoute('/me/home/'), { kind: 'home' })
  assert.deepEqual(resolvePilotRoute('/me/onboarding'), { kind: 'onboarding' })
  assert.deepEqual(resolvePilotRoute('/me/join'), { kind: 'join' })
  assert.deepEqual(resolvePilotRoute('/me/referrals/new'), { kind: 'new_referral' })
  assert.deepEqual(resolvePilotRoute('/me/referrals/ref_abc-123'), { kind: 'referral', id: 'ref_abc-123' })
  assert.deepEqual(resolvePilotRoute('/claim/sign-in'), { kind: 'auth', page: 'sign-in' })
  for (const demo of ['/', '/home', '/for-you', '/patients', '/patients/patient-ckd-htn-001', '/chen', '/chen/patients/tonjit',
    '/specialist', '/consultations/3', '/network', '/agent', '/claim', '/me/profile', '/me/agent/train', '/p/Bad_Slug', '/r/short', '/settings/agent-evaluations']) {
    assert.deepEqual(resolvePilotRoute(demo), { kind: 'redirect', to: pilotPaths.home }, demo)
  }
})

test('pilot UI never imports demo personas, patients, or demo surfaces', () => {
  for (const [name, text] of [['Pilot.tsx', pilot], ['pilotApi.ts', pilotApi], ['pilotState.ts', pilotState]]) {
    for (const forbidden of ['demoIdentity', 'demoPatients', 'AgentHome', "from './Referral", 'Specialist', 'Engagement', 'PhysicianNetwork', 'DEMO_PATIENTS', 'CHEN_', 'LUCY', 'TONJIT', '/api/workspace', '/api/patients']) {
      assert.ok(!text.includes(forbidden), `${name} references ${forbidden}`)
    }
  }
})

test('the pilot client never asserts identity, practice, scope, or role', () => {
  assert.doesNotMatch(pilotApi, /user_id|practice_id|owner_scope_id|storage_scope_id|role: 'physician'/)
  assert.match(pilotApi, /Authorization', `Bearer \$\{token\}`/)
  assert.doesNotMatch(pilotApi, /localStorage|sessionStorage/)
  assert.doesNotMatch(pilot, /localStorage|sessionStorage/)
})

test('onboarding offers name search and avoids identity-proofing language', () => {
  assert.match(onboarding, /Confirm your professional profile/)
  assert.match(onboarding, /searchPhysicianByName\(searchName\.trim\(\), searchLocation\.trim\(\)\)/)
  assert.match(onboarding, /This is me/)
  assert.match(onboarding, /lookupOnboardingNpi\(facts\.npi\)/, 'a search pick goes through the same exact-NPI lookup + confirm step')
  assert.match(onboarding, /Already linked to an account/)
})

/* ------------------------------------------------------------- home */

const item = (id, status, extra = {}) => ({
  id, status, patient_name: `Patient ${id}`, referral_type: 'Diabetes', sender_name: 'Dr. R', sender_practice: null,
  received_at: '2026-11-01T00:00:00Z', fit: 'strong', priority: 'routine', next_step: 'physician_review',
  requires_physician: false, missing_items: [], escalated: false, decided: false, ...extra,
})

test('home buckets put each referral in exactly one place and the briefing counts them', () => {
  const buckets = homeBuckets([item('a', 'triaged'), item('b', 'needs_information'), item('c', 'ready_for_review'), item('d', 'accepted'), item('e', 'received')])
  assert.deepEqual(buckets.attention.map((entry) => entry.id), ['a', 'e'])
  assert.deepEqual(buckets.missing.map((entry) => entry.id), ['b'])
  assert.deepEqual(buckets.ready.map((entry) => entry.id), ['c'])
  assert.deepEqual(buckets.closed.map((entry) => entry.id), ['d'])
  assert.deepEqual(briefingLines(buckets, 'physician'), [
    '2 new referrals have a triage ready for your review.',
    '1 referral is waiting on missing information.',
    '1 referral is ready for your decision.',
  ])
  assert.equal(briefingLines(buckets, 'staff')[2], '1 referral is ready for the physician.')
  assert.deepEqual(briefingLines(homeBuckets([]), 'staff'), [])
})

test('triage headline is concrete and quiet for closed referrals', () => {
  assert.equal(triageHeadline(item('a', 'triaged', { missing_items: ['Renal function'], priority: 'urgent' })), 'Strong practice fit · missing renal function · urgent priority')
  assert.equal(triageHeadline(item('a', 'declined')), 'Declined')
})

/* ------------------------------------------------------------ forms */

test('referral form validates and builds a payload without a patient lookup', () => {
  const empty = emptyReferralForm()
  assert.equal(referralFormErrors(empty).length, 4)
  const form = { ...empty, senderName: ' Dr. Rivera ', patientName: 'Alex', referralType: 'Diabetes management', reason: 'A1c high', senderNpi: '123',
    items: [{ key: 'recent_a1c', value: ' 8.9% ', observedDate: '2026-10-01' }, { key: 'renal', value: '', observedDate: '' }] }
  assert.deepEqual(referralFormErrors(form), ['A referring NPI is exactly 10 digits.', 'Each provided item needs a value.'])
  const payload = referralPayload({ ...form, senderNpi: '', items: form.items.slice(0, 1) }, true)
  assert.equal(payload.source, 'upload')
  assert.equal(payload.sender.name, 'Dr. Rivera')
  assert.equal(payload.sender.npi, null)
  assert.deepEqual(payload.submitted_items, [{ key: 'recent_a1c', value: '8.9%', observed_date: '2026-10-01' }])
  assert.ok(!('patient_id' in payload) && !('practice_id' in payload))
})

test('rule form parses requirement lines with optional recency and round-trips', () => {
  assert.deepEqual(parseRequirementLines('Recent HbA1c | 180\n\nCurrent medication list', true), [
    { key: 'recent_hba1c', label: 'Recent HbA1c', required: true, freshness_days: 180 },
    { key: 'current_medication_list', label: 'Current medication list', required: true, freshness_days: null },
  ])
  const input = ruleInput({ referralType: ' Diabetes ', goodFit: 'A\nB', outsideScope: 'C', required: 'Recent HbA1c | 180', helpful: 'Log', urgent: 'DKA', modality: 'in_person', note: '' })
  assert.equal(input.referral_type, 'Diabetes')
  assert.deepEqual(input.outside_scope, ['C'])
  assert.equal(input.helpful[0].required, false)
  assert.equal(input.publishable, false, 'nothing is published from the rule editor')
  const form = ruleFormFrom({ referral_type: 'Diabetes', content: { good_fit: ['A'], redirect: ['C'], required: input.required, helpful: input.helpful, urgent_signals: ['DKA'], modality: 'in_person', modality_notes: null } })
  assert.equal(form.required, 'Recent HbA1c | 180')
  assert.equal(form.outsideScope, 'C')
})

test('review card exposes the four triage actions plus physician-only disposition', () => {
  for (const label of ['Approve triage', 'Edit', 'Request information', 'Needs physician review', 'Triage is wrong', 'Accept referral', 'Redirect', 'Decline']) {
    assert.ok(pilot.includes(label), label)
  }
  assert.match(pilot, /physician && canUse\(actions, 'accept'\)/, 'disposition renders only for physicians')
  assert.match(pilot, /nothing is sent until you review and approve it/)
  assert.match(pilot, /<summary>Why<\/summary>/)
})
