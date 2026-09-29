import assert from 'node:assert/strict'
import { test } from 'node:test'
import { groupConsultationsByPatient } from '../src/consultationGrouping.ts'

const record = (id, patientId, completedAt, physicianName, specialty) => ({
  id, patient_id: patientId, completed_at: completedAt,
  result: { recommended_physician: { physician_id: 'physician-x', physician_name: physicianName, specialty } },
})

const HISTORY = [
  record(7, 'patient-ckd-htn-001', '2026-09-25T22:59:00+00:00', 'Dr. Iain Jung (synthetic)', 'Nephrology'),
  record(6, 'patient-ida-002', '2026-09-21T18:06:00+00:00', 'Dr. Sofia Alvarez (synthetic)', 'Gastroenterology'),
  record(5, 'patient-ckd-htn-001', '2026-09-21T18:05:00+00:00', 'Dr. Iain Jung (synthetic)', 'Nephrology'),
  record(4, 'patient-ida-002', '2026-09-20T09:00:00+00:00', 'Dr. Sofia Alvarez (synthetic)', 'Gastroenterology'),
  record(3, 'patient-ckd-htn-001', '2026-09-19T11:30:00+00:00', 'Dr. Iain Jung (synthetic)', 'Nephrology'),
]

test('repeated consultations collapse into one top-level row per patient', () => {
  const groups = groupConsultationsByPatient(HISTORY)
  assert.deepEqual(groups.map((group) => group.patientLabel), ['Jordan Lee', 'Maria Santos'])
  assert.deepEqual(groups.map((group) => group.count), [3, 2])
  assert.equal(new Set(groups.map((group) => group.patientId)).size, groups.length)
})

test('each group reports its latest consultation and outcome', () => {
  const [jordan] = groupConsultationsByPatient(HISTORY)
  assert.equal(jordan.latest.id, 7)
  assert.equal(jordan.latestPhysician, 'Dr. Iain Jung')
  assert.equal(jordan.latestSpecialty, 'Nephrology')
  assert.equal(jordan.initials, 'JL')
  assert.deepEqual(jordan.records.map((item) => item.id), [7, 5, 3], 'per-patient history is most recent first')
})

test('an empty workspace produces no groups', () => {
  assert.deepEqual(groupConsultationsByPatient([]), [])
})
