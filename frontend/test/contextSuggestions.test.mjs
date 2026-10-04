import assert from 'node:assert/strict'
import { test } from 'node:test'
import { accessSuggestions, specialtySuggestion } from '../src/contextSuggestions.ts'
import { JORDAN_ID, MARIA_ID } from '../src/demoIdentity.ts'

const basePatient = {
  location: 'Oakland, CA',
  insurance: 'Lamina Demo PPO',
}

/* ----------------------------------------------------------------- access */

test('derives a location chip from the patient location field', () => {
  const suggestions = accessSuggestions(basePatient)
  const location = suggestions.find((item) => item.id === 'location')
  assert.equal(location.text, 'Prefer Oakland-area options')
  assert.equal(location.sourced, true)
})

test('derives an in-network chip from the patient insurance field', () => {
  const suggestions = accessSuggestions(basePatient)
  const insurance = suggestions.find((item) => item.id === 'insurance')
  assert.equal(insurance.text, 'Keep in-network options')
  assert.equal(insurance.sourced, true)
})

test('includes one generic, clearly non-data-sourced access suggestion', () => {
  const suggestions = accessSuggestions(basePatient)
  const generic = suggestions.filter((item) => item.sourced === false)
  assert.equal(generic.length, 1)
})

test('never invents telehealth, transportation, scheduling, or goals preferences', () => {
  const suggestions = accessSuggestions(basePatient)
  const text = suggestions.map((item) => item.text).join(' ').toLowerCase()
  assert.doesNotMatch(text, /telehealth|transport|schedul|goal/)
})

test('omits location/insurance chips when the field is missing', () => {
  const suggestions = accessSuggestions({ location: '', insurance: '' })
  assert.equal(suggestions.find((item) => item.id === 'location'), undefined)
  assert.equal(suggestions.find((item) => item.id === 'insurance'), undefined)
  assert.equal(suggestions.length, 1)
})

/* -------------------------------------------------------------- specialty */

test('Jordan gets a nephrology vs cardiology specialty suggestion', () => {
  const suggestion = specialtySuggestion(JORDAN_ID)
  assert.equal(suggestion.text, 'Compare nephrology vs cardiology')
  assert.equal(suggestion.sourced, false)
})

test('Maria gets a gastroenterology vs haematology specialty suggestion', () => {
  const suggestion = specialtySuggestion(MARIA_ID)
  assert.equal(suggestion.text, 'Compare gastroenterology vs haematology')
  assert.equal(suggestion.sourced, false)
})

test('unsupported patients get no fabricated specialty suggestion', () => {
  assert.equal(specialtySuggestion('patient-syncope-003'), null)
  assert.equal(specialtySuggestion('patient-diabetes-004'), null)
  assert.equal(specialtySuggestion('some-unknown-id'), null)
})
