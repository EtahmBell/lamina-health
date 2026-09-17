import assert from 'node:assert/strict'
import { test } from 'node:test'
import { groupConsultationMessages } from '../src/consultationPresentation.ts'

const event = (sequence, message_type) => ({ id: `event-${sequence}`, sequence, message_type })

test('Jordan stages preserve every backend event in sequence', () => {
  const messages = [
    event(1, 'consult_request'),
    ...[2, 3, 4, 5, 6].map((sequence) => event(sequence, sequence === 5 ? 'redirect' : 'fit_response')),
    event(7, 'referral_requirement'), event(8, 'follow_up_question'),
    event(9, 'follow_up_answer'), event(10, 'synthesis'),
  ]
  const stages = groupConsultationMessages([...messages].reverse())
  assert.deepEqual(stages.map((stage) => stage.kind), ['case', 'responses', 'requirements', 'clarification', 'synthesis'])
  assert.deepEqual(stages.flatMap((stage) => stage.messages.map((message) => message.id)), messages.map((message) => message.id))
})

test('Maria clarification and acceptance remain distinct, with no fabricated events', () => {
  const messages = [
    event(1, 'consult_request'),
    ...[2, 3, 4, 5, 6].map((sequence) => event(sequence, 'fit_response')),
    event(7, 'follow_up_question'), event(8, 'follow_up_answer'),
    event(9, 'referral_requirement'), event(10, 'synthesis'),
  ]
  const stages = groupConsultationMessages(messages)
  assert.deepEqual(stages.map((stage) => stage.kind), ['case', 'responses', 'clarification', 'requirements', 'synthesis'])
  assert.deepEqual(stages.flatMap((stage) => stage.messages.map((message) => message.id)), messages.map((message) => message.id))
  assert.equal(new Set(stages.flatMap((stage) => stage.messages.map((message) => message.id))).size, messages.length)
})
