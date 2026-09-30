import assert from 'node:assert/strict'
import { test } from 'node:test'
import { axisDate, clinicalTrends, formatTick, labFlowsheet, labUnit, valueTicks } from '../src/clinicalTrends.ts'

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
})

test('every measurement contributes a latest value, charted or not', () => {
  const jordan = clinicalTrends(JORDAN_LABS)
  assert.deepEqual(jordan.latest.map((item) => [item.label, item.value, item.trended]), [
    ['Creatinine', 1.8, true],
    ['eGFR', 41, true],
  ])
  const maria = clinicalTrends(MARIA_LABS)
  assert.deepEqual(maria.latest.map((item) => item.test), [
    'hemoglobin', 'ferritin', 'serum_iron', 'TIBC', 'transferrin_saturation', 'MCV', 'WBC', 'platelets',
  ])
  assert.equal(maria.latest.find((item) => item.test === 'hemoglobin').value, 9.5)
  assert.equal(maria.latest.find((item) => item.test === 'ferritin').value, 7)
  assert.deepEqual(maria.latest.filter((item) => item.trended).map((item) => item.test), ['hemoglobin'])
})

test('Maria charts only hemoglobin; one-off iron studies are never plotted', () => {
  const trends = clinicalTrends(MARIA_LABS)
  assert.deepEqual(trends.series.map((item) => item.test), ['hemoglobin'])
  assert.deepEqual(trends.series[0].points.map((point) => point.value), [10.8, 10.1, 9.5])
  assert.deepEqual(trends.series[0].points.map((point) => point.date), ['2025-10-10', '2026-03-13', '2026-08-28'])
})

test('a single measurement never becomes a fabricated trend', () => {
  const trends = clinicalTrends([{ date: '2026-08-28', test: 'ferritin', value: 7, unit: 'ng/mL' }])
  assert.deepEqual(trends.series, [])
  assert.equal(trends.domain, null)
  assert.deepEqual(trends.latest.map((item) => [item.value, item.trended]), [[7, false]])
})

test('repeated readings on one date are still a single value, not a trend', () => {
  const trends = clinicalTrends([
    { date: '2026-08-28', test: 'hemoglobin', value: 9.5, unit: 'g/dL' },
    { date: '2026-08-28', test: 'hemoglobin', value: 9.6, unit: 'g/dL' },
  ])
  assert.deepEqual(trends.series, [])
  assert.deepEqual(trends.latest.map((item) => item.value), [9.6])
})

test('axis ticks are rounded, few, and always contain the observed values', () => {
  const creatinine = valueTicks([1.1, 1.3, 1.6, 1.8])
  assert.deepEqual(creatinine.ticks, [1, 1.5, 2])
  const egfr = valueTicks([68, 59, 48, 41])
  assert.deepEqual(egfr.ticks, [40, 50, 60, 70])
  const hemoglobin = valueTicks([10.8, 10.1, 9.5])
  assert.deepEqual(hemoglobin.ticks, [9.5, 10, 10.5, 11])
  for (const [values, axis] of [[[1.1, 1.8], creatinine], [[41, 68], egfr], [[9.5, 10.8], hemoglobin]]) {
    assert.ok(axis.lo <= Math.min(...values) && axis.hi >= Math.max(...values), 'bounds must contain the data')
    assert.ok(axis.ticks.length >= 3 && axis.ticks.length <= 4, `${axis.ticks.length} ticks`)
  }
})

test('tick labels carry the precision of their step', () => {
  assert.deepEqual([1, 1.5, 2].map((value) => formatTick(value, 0.5)), ['1.0', '1.5', '2.0'])
  assert.deepEqual([40, 50].map((value) => formatTick(value, 10)), ['40', '50'])
})

test('axis dates show the year only when it changes along the axis', () => {
  assert.equal(axisDate('2025-01-12'), "Jan 12 '25")
  assert.equal(axisDate('2025-05-16', '2025-01-12'), 'May 16')
  assert.equal(axisDate('2026-01-09', '2025-05-16'), "Jan 9 '26")
  assert.equal(axisDate('2026-08-21', '2026-01-09'), 'Aug 21')
})

test('units render typographically without altering the recorded value', () => {
  assert.equal(labUnit('mL/min/1.73m2'), 'mL/min/1.73m²')
  assert.equal(labUnit('10*3/uL'), '×10³/µL')
  assert.equal(labUnit('mg/dL'), 'mg/dL')
})

test('the flowsheet is one chronological row per date with a column per measurement', () => {
  const jordan = labFlowsheet(JORDAN_LABS)
  assert.deepEqual(jordan.columns.map((column) => column.label), ['Creatinine', 'eGFR'])
  assert.deepEqual(jordan.rows.map((row) => row.date), ['2025-01-12', '2025-05-16', '2026-01-09', '2026-08-21'])
  assert.deepEqual(jordan.rows.map((row) => row.cells), [[1.1, 68], [1.3, 59], [1.6, 48], [1.8, 41]])
  assert.equal(jordan.rows.flatMap((row) => row.cells).filter((cell) => cell !== null).length, JORDAN_LABS.length)
})

test('missing results stay empty instead of being carried forward', () => {
  const maria = labFlowsheet(MARIA_LABS)
  assert.deepEqual(maria.rows.map((row) => row.date), ['2025-10-10', '2026-03-13', '2026-08-28'])
  assert.deepEqual(maria.rows[0].cells, [10.8, null, null, null, null, null, null, null])
  assert.deepEqual(maria.rows[2].cells, [9.5, 7, 28, 410, 7, 74, 6.4, 318])
  assert.equal(maria.rows.flatMap((row) => row.cells).filter((cell) => cell !== null).length, MARIA_LABS.length)
})
