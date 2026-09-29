import assert from 'node:assert/strict'
import { test } from 'node:test'
import { activityPath, agentActivity, calibrationPath, consultationActivity, learningKeyForPatient } from '../src/agentActivity.ts'

const PCP = 'agent-pcp-lianne-cha'
const message = (consultationId, sequence, type, senderAgent, senderName, recipient, summary) => ({
  id: `${consultationId}-message-${String(sequence).padStart(2, '0')}`,
  consultation_id: consultationId, sequence, message_type: type,
  sender_agent_id: senderAgent, sender_name: senderName, sender_role: 'demo',
  recipient_agent_id: recipient, summary, evidence: [], related_patient_facts: [], metadata: {},
})

const jordan = {
  id: 7, patient_id: 'patient-ckd-htn-001', completed_at: '2026-09-25T22:59:00+00:00',
  result: {
    consultation_id: 'consult-jordan', consultation: [{}, {}, {}, {}, {}],
    recommended_physician: { physician_id: 'physician-jung', physician_name: 'Dr. Iain Jung (synthetic)', specialty: 'Nephrology' },
    messages: [
      message('consult-jordan', 1, 'consult_request', PCP, 'Dr. Lucy Saru Agent', 'network', 'Requests specialty guidance'),
      message('consult-jordan', 2, 'fit_response', 'agent-9900000001', 'Dr. Iain Jung Agent', PCP, 'Accepts progressive CKD'),
      message('consult-jordan', 5, 'redirect', 'agent-9900000002', 'Dr. Matthew Onadeko Agent', PCP, 'Nephrology should evaluate first'),
      message('consult-jordan', 8, 'follow_up_question', PCP, 'Dr. Lucy Saru Agent', 'agent-9900000002', 'Does progressive renal dysfunction alter acceptance?'),
      message('consult-jordan', 9, 'follow_up_answer', 'agent-9900000002', 'Dr. Matthew Onadeko Agent', PCP, 'Nephrology first remains appropriate'),
    ],
  },
}
const maria = {
  id: 5, patient_id: 'patient-ida-002', completed_at: '2026-09-21T18:06:00+00:00',
  result: {
    consultation_id: 'consult-maria', consultation: [{}, {}, {}, {}, {}],
    recommended_physician: { physician_id: 'physician-alvarez', physician_name: 'Dr. Sofia Alvarez (synthetic)', specialty: 'Gastroenterology' },
    messages: [
      message('consult-maria', 1, 'consult_request', PCP, 'Dr. Lucy Saru Agent', 'network', 'Requests sequencing guidance'),
      message('consult-maria', 3, 'fit_response', 'agent-9900000006', 'Dr. Sofia Alvarez Agent', PCP, 'Persistent iron deficiency warrants source evaluation'),
      message('consult-maria', 7, 'follow_up_question', 'agent-9900000006', 'Dr. Sofia Alvarez Agent', PCP, 'Is any prior colonoscopy or upper endoscopy documented?'),
      message('consult-maria', 8, 'follow_up_answer', PCP, 'Dr. Lucy Saru Agent', 'agent-9900000006', 'No prior endoscopy is documented'),
    ],
  },
}

test('a consultation yields one milestone and interaction rows for its structured exchanges', () => {
  const events = consultationActivity(jordan)
  assert.deepEqual(events.map((event) => event.kind), ['milestone', 'interaction', 'interaction'])
  const [resolved, clarification, consulted] = events
  assert.equal(resolved.title, 'Consultation resolved')
  assert.equal(resolved.detail, 'Nephrology recommended')
  assert.equal(resolved.eventId, undefined, 'consultation milestones open the consultation, not one event')
  assert.equal(clarification.title, "Dr. Lucy Saru's Agent → Dr. Matthew Onadeko's Agent")
  assert.equal(clarification.eventId, 'consult-jordan-message-08')
  assert.equal(consulted.title, "Dr. Lucy Saru's Agent → Dr. Iain Jung's Agent")
  assert.equal(consulted.detail, 'Requested specialty guidance for Jordan Lee')
  assert.equal(consulted.eventId, 'consult-jordan-message-02', 'targets the recommended agent fit response')
})

test('a specialist-initiated clarification is attributed to the specialist agent', () => {
  const events = consultationActivity(maria)
  const clarification = events.find((event) => event.eventId === 'consult-maria-message-07')
  assert.equal(clarification.title, "Dr. Sofia Alvarez's Agent → Dr. Lucy Saru's Agent")
  assert.equal(clarification.detail, 'Is any prior colonoscopy or upper endoscopy documented?')
  assert.equal(events[0].detail, 'Gastroenterology recommended first')
})

test('activity is newest first and every event carries a timestamp and patient', () => {
  const events = agentActivity([maria, jordan])
  assert.deepEqual(events.slice(0, 3).map((event) => event.patientLabel), ['Jordan Lee', 'Jordan Lee', 'Jordan Lee'])
  assert.ok(events.every((event) => event.time && event.patientLabel && event.recordId))
  assert.equal(events.at(-1).patientLabel, 'Maria Santos')
})

test('interaction rows deep-link to one event; milestones open the consultation', () => {
  const [resolved, clarification] = consultationActivity(jordan)
  assert.equal(activityPath(resolved), '/consultations/7')
  assert.equal(activityPath(clarification), '/consultations/7?event=consult-jordan-message-08')
})

test('recommendation corrections route into the existing calibration learnings', () => {
  assert.equal(learningKeyForPatient('patient-ckd-htn-001'), 'renal')
  assert.equal(learningKeyForPatient('patient-ida-002'), 'anaemia')
  assert.equal(learningKeyForPatient('patient-syncope-003'), null)
  assert.equal(
    calibrationPath('renal', 'patient-ckd-htn-001', 7),
    '/agent?tab=calibration&learning=renal&case=patient-ckd-htn-001&record=7',
  )
  assert.equal(calibrationPath(), '/agent?tab=calibration')
})
