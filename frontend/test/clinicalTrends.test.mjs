import assert from 'node:assert/strict'
import { test } from 'node:test'
import { clinicalTrends } from '../src/clinicalTrends.ts'

/** Exactly the synthetic fixture readings in backend/synthetic_data/fixtures.py. */
const JORDAN_LABS = [
  { date: '2025-01-12', test: 'creatinine', value: 1.1, unit: 'mg/dL' },
  { date: '2025-05-16', test: 'creatinine', value: 1.3, unit: 'mg/dL' },
  { date: '2026-01-09', test: 'creatinine', value: 1.6, unit: 'mg/dL' },
  { date: '2026-08-21', test: 'creatinine', value: 1.8, unit: 'mg/dL' },
  { date: '2025-01-12', test: 'eGFR', value: 68, unit: 'mL/min/1.73m2' },
  { date: '2025-05-16', test: 'eGFR', value: 59, unit: 'mL/min/1.73m2' },
  { date: '2026-01-09', test: 'eGFR', value: 48, unit: 'mL/min/1.73m2' },
  { date: '2026-08-21', test: 'eGFR', value: 41, unit: 'mL/min/1.73m2' },
]
const MARIA_LABS = [
  { date: '2025-10-10', test: 'hemoglobin', value: 10.8, unit: 'g/dL' },
  { date: '2026-03-13', test: 'hemoglobin', value: 10.1, unit: 'g/dL' },
  { date: '2026-08-28', test: 'hemoglobin', value: 9.5, unit: 'g/dL' },
  { date: '2026-08-28', test: 'ferritin', value: 7, unit: 'ng/mL' },
  { date: '2026-08-28', test: 'serum_iron', value: 28, unit: 'ug/dL' },
  { date: '2026-08-28', test: 'TIBC', value: 410, unit: 'ug/dL' },
  { date: '2026-08-28', test: 'transferrin_saturation', value: 7, unit: '%' },
  { date: '2026-08-28', test: 'MCV', value: 74, unit: 'fL' },
  { date: '2026-08-28', test: 'WBC', value: 6.4, unit: '10*3/uL' },
  { date: '2026-08-28', test: 'platelets', value: 318, unit: '10*3/uL' },
]

test('Jordan charts creatinine and eGFR from the existing readings on one shared axis', () => {
  const trends = clinicalTrends(JORDAN_LABS)
  assert.deepEqual(trends.series.map((item) => item.test), ['creatinine', 'eGFR'])
  assert.deepEqual(trends.series[0].points.map((point) => point.value), [1.1, 1.3, 1.6, 1.8])
  assert.deepEqual(trends.series[1].points.map((point) => point.value), [68, 59, 48, 41])
  assert.equal(trends.series[0].unit, 'mg/dL')
  assert.equal(trends.series[1].unit, 'mL/min/1.73m2')
  assert.deepEqual(
    trends.series[0].points.map((point) => point.date),
    trends.series[1].points.map((point) => point.date),
  )
  assert.deepEqual(trends.domain, [
    new Date('2025-01-12T12:00:00').getTime(),
    new Date('2026-08-21T12:00:00').getTime(),
  ])
  assert.deepEqual(trends.latest, [], 'every Jordan lab is longitudinal, so no raw value grid remains')
})

test('Maria charts only hemoglobin; one-off iron studies stay single values', () => {
  const trends = clinicalTrends(MARIA_LABS)
  assert.deepEqual(trends.series.map((item) => item.test), ['hemoglobin'])
  assert.deepEqual(trends.series[0].points.map((point) => point.value), [10.8, 10.1, 9.5])
  assert.deepEqual(
    trends.latest.map((item) => item.test),
    ['ferritin', 'serum_iron', 'TIBC', 'transferrin_saturation', 'MCV', 'WBC', 'platelets'],
  )
  assert.equal(trends.latest.find((item) => item.test === 'ferritin').value, 7)
})

test('a single measurement never becomes a fabricated trend', () => {
  const trends = clinicalTrends([{ date: '2026-08-28', test: 'ferritin', value: 7, unit: 'ng/mL' }])
  assert.deepEqual(trends.series, [])
  assert.equal(trends.domain, null)
  assert.deepEqual(trends.latest.map((item) => item.value), [7])
})

test('repeated readings on one date are still a single value, not a trend', () => {
  const trends = clinicalTrends([
    { date: '2026-08-28', test: 'hemoglobin', value: 9.5, unit: 'g/dL' },
    { date: '2026-08-28', test: 'hemoglobin', value: 9.6, unit: 'g/dL' },
  ])
  assert.deepEqual(trends.series, [])
  assert.deepEqual(trends.latest.map((item) => item.value), [9.6])
})
