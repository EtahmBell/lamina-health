import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { clinicalTrends, labLabel, labUnit } from '../src/clinicalTrends.ts'
import { DEMO_PATIENTS } from '../src/demoPatients.ts'

const demoIdentity = readFileSync(new URL('../src/demoIdentity.ts', import.meta.url), 'utf8')
const app = readFileSync(new URL('../src/App.tsx', import.meta.url), 'utf8')

const TONJIT_ID = 'patient-t2dm-003'

/** Mirrors backend/synthetic_data/fixtures.py's Tonjit labs, used here only to
 * exercise the shared frontend trend/label logic against his exact shape. */
const TONJIT_LABS = [
  { date: '2025-03-10', test: 'HbA1c', value: 7.1, unit: '%' },
  { date: '2025-09-08', test: 'HbA1c', value: 7.8, unit: '%' },
  { date: '2026-03-16', test: 'HbA1c', value: 8.7, unit: '%' },
  { date: '2026-09-05', test: 'HbA1c', value: 9.6, unit: '%' },
  { date: '2025-03-10', test: 'fasting_glucose', value: 128, unit: 'mg/dL' },
  { date: '2025-09-08', test: 'fasting_glucose', value: 154, unit: 'mg/dL' },
  { date: '2026-03-16', test: 'fasting_glucose', value: 183, unit: 'mg/dL' },
  { date: '2026-09-05', test: 'fasting_glucose', value: 214, unit: 'mg/dL' },
  { date: '2026-09-05', test: 'weight', value: 91, unit: 'kg' },
  { date: '2026-07-20', test: 'creatinine', value: 0.9, unit: 'mg/dL' },
  { date: '2026-07-20', test: 'eGFR', value: 97, unit: 'mL/min/1.73m2' },
  { date: '2026-07-20', test: 'urine_albumin', value: 18, unit: 'mg/g' },
]

test('Tonjit appears in the demo patient roster as a real, implemented case', () => {
  const tonjit = DEMO_PATIENTS.find((item) => item.id === TONJIT_ID)
  assert.ok(tonjit, 'Tonjit should be present in DEMO_PATIENTS')
  assert.equal(tonjit.implemented, true)
  assert.equal(tonjit.name, 'Tonjit Askarov')
  assert.equal(tonjit.age, 52)
  assert.equal(tonjit.location, 'Fremont, CA')
  assert.match(tonjit.reason, /diabetes/i)
})

test('TONJIT_ID is exported and matches the roster entry id', () => {
  assert.match(demoIdentity, /export const TONJIT_ID = 'patient-t2dm-003'/)
})

test('the Patient Detail routing gate serves Tonjit the real PatientWorkspace, not the unfinished fallback', () => {
  assert.match(app, /patientId === JORDAN_ID \|\| patientId === MARIA_ID \|\| patientId === TONJIT_ID/)
})

test('HbA1c and fasting glucose trend chronologically and chart as a paired stack', () => {
  const trends = clinicalTrends(TONJIT_LABS)
  const hba1c = trends.series.find((item) => item.test === 'HbA1c')
  const glucose = trends.series.find((item) => item.test === 'fasting_glucose')
  assert.ok(hba1c && glucose, 'both HbA1c and fasting glucose should be charted trends')
  assert.deepEqual(hba1c.points.map((point) => point.value), [7.1, 7.8, 8.7, 9.6])
  assert.deepEqual(glucose.points.map((point) => point.value), [128, 154, 183, 214])
  const dates = hba1c.points.map((point) => point.date)
  assert.deepEqual(dates, [...dates].sort())
  assert.equal(trends.series.length, 2, 'weight, creatinine, eGFR, and urine albumin are single points, not charted')
})

test('renal function and weight render as structured latest results with correct units, not only prose', () => {
  const trends = clinicalTrends(TONJIT_LABS)
  const creatinine = trends.latest.find((item) => item.test === 'creatinine')
  const egfr = trends.latest.find((item) => item.test === 'eGFR')
  const weight = trends.latest.find((item) => item.test === 'weight')
  assert.equal(creatinine.value, 0.9)
  assert.equal(egfr.value, 97)
  assert.equal(weight.value, 91)
  assert.equal(labUnit(creatinine.unit), 'mg/dL')
  assert.equal(labUnit(egfr.unit), 'mL/min/1.73m²')
  assert.equal(labUnit(weight.unit), 'kg')
  assert.equal(labLabel('HbA1c'), 'HbA1c')
  assert.equal(labLabel('fasting_glucose'), 'Fasting glucose')
})

test('Jordan and Maria retain their own demo identity constants unchanged', () => {
  assert.match(demoIdentity, /export const JORDAN_ID = 'patient-ckd-htn-001'/)
  assert.match(demoIdentity, /export const MARIA_ID = 'patient-ida-002'/)
})
