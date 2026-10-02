import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  LIFECYCLE_COPY,
  canActivate,
  canDemoVerify,
  canDisable,
  canReactivate,
  canSubmitVerification,
  lifecycleChip,
  lifecycleSteps,
} from '../src/claimLifecycle.ts'

const ALL_STATUSES = ['reserved', 'claimed', 'verification_pending', 'verified', 'active', 'disabled']

test('every lifecycle status has calm, explicit, non-overclaiming copy', () => {
  for (const status of ALL_STATUSES) assert.ok(LIFECYCLE_COPY[status], `missing copy for ${status}`)
  assert.equal(LIFECYCLE_COPY.reserved.label, 'Reserved Lamina identity')
  assert.equal(LIFECYCLE_COPY.claimed.label, 'Claim started')
  assert.equal(LIFECYCLE_COPY.verification_pending.label, 'Verification pending')
  assert.equal(LIFECYCLE_COPY.verified.label, 'Identity verified')
  assert.equal(LIFECYCLE_COPY.active.label, 'Agent active')
  assert.equal(LIFECYCLE_COPY.disabled.label, 'Agent disabled')
  for (const status of ALL_STATUSES) {
    assert.doesNotMatch(LIFECYCLE_COPY[status].detail, /\bI speak for\b|on behalf of the physician/i)
  }
})

test('the stepper never marks Verification complete while it is only pending', () => {
  const pending = lifecycleSteps('verification_pending')
  const verification = pending.find((step) => step.id === 'verification')
  assert.equal(verification.state, 'current')
  const claimed = lifecycleSteps('claimed')
  assert.equal(claimed.find((step) => step.id === 'verification').state, 'current')
  assert.equal(claimed.find((step) => step.id === 'claim').state, 'complete')
})

test('reserved shows Identity complete and everything after locked except Claim', () => {
  const steps = lifecycleSteps('reserved')
  assert.deepEqual(steps.map((step) => [step.id, step.state]), [
    ['identity', 'complete'], ['claim', 'current'], ['verification', 'locked'], ['agent', 'locked'],
  ])
})

test('verified marks Identity/Claim/Verification complete and Agent current', () => {
  const steps = lifecycleSteps('verified')
  assert.deepEqual(steps.map((step) => [step.id, step.state]), [
    ['identity', 'complete'], ['claim', 'complete'], ['verification', 'complete'], ['agent', 'current'],
  ])
})

test('active and disabled both read as a fully complete lifecycle', () => {
  for (const status of ['active', 'disabled']) {
    const steps = lifecycleSteps(status)
    assert.ok(steps.every((step) => step.state === 'complete'), `${status} should show every step complete`)
  }
})

test('every status produces exactly the four canonical steps in order', () => {
  for (const status of ALL_STATUSES) {
    assert.deepEqual(lifecycleSteps(status).map((step) => step.id), ['identity', 'claim', 'verification', 'agent'])
  }
})

test('search/list chips use calm copy and never claim/pending differently for an owned claim', () => {
  assert.equal(lifecycleChip('reserved', false), 'Reserved Lamina identity')
  assert.equal(lifecycleChip('claimed', true), 'Claim started')
  assert.equal(lifecycleChip('claimed', false), 'Claim started')
  assert.equal(lifecycleChip('verification_pending', true), 'Verification pending')
  assert.equal(lifecycleChip('active', false), 'Agent active')
})

test('demo verification is reachable only for a synthetic identity awaiting verification', () => {
  assert.equal(canDemoVerify(true, 'verification_pending'), true)
  assert.equal(canDemoVerify(false, 'verification_pending'), false, 'a real NPPES identity must never see this control')
  assert.equal(canDemoVerify(true, 'claimed'), false)
  assert.equal(canDemoVerify(true, 'verified'), false)
})

test('submit-verification is only offered to the claim owner while claimed or pending', () => {
  assert.equal(canSubmitVerification(true, 'claimed'), true)
  assert.equal(canSubmitVerification(true, 'verification_pending'), true)
  assert.equal(canSubmitVerification(false, 'claimed'), false)
  assert.equal(canSubmitVerification(true, 'verified'), false)
  assert.equal(canSubmitVerification(true, null), false)
})

test('activation requires an owned, verified, not-already-active claim', () => {
  assert.equal(canActivate(true, 'verified', false), true)
  assert.equal(canActivate(true, 'verified', true), false, 'already active')
  assert.equal(canActivate(false, 'verified', false), false, 'not the owner')
  assert.equal(canActivate(true, 'claimed', false), false, 'not verified')
  assert.equal(canActivate(true, 'verification_pending', false), false)
})

test('disable requires an owned, verified, currently-active claim', () => {
  assert.equal(canDisable(true, 'verified', true), true)
  assert.equal(canDisable(true, 'verified', false), false, 'nothing to disable')
  assert.equal(canDisable(false, 'verified', true), false, 'not the owner')
})

test('reactivation is offered only to the owner of a disabled, verified identity', () => {
  assert.equal(canReactivate(true, 'verified', 'disabled'), true)
  assert.equal(canReactivate(true, 'verified', 'active'), false, 'already active')
  assert.equal(canReactivate(false, 'verified', 'disabled'), false, 'not the owner')
  assert.equal(canReactivate(true, 'claimed', 'disabled'), false, 'claim record disagrees with the lifecycle status')
})
