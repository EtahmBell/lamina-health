import assert from 'node:assert/strict'
import { test } from 'node:test'
import { contextSuggestions } from '../src/contextSuggestions.ts'

const basePatient = {
  location: 'Oakland, CA',
  insurance: 'Lamina Demo PPO',
}

test('derives a location chip from the patient location field', () => {
  const suggestions = contextSuggestions(basePatient)
  const location = suggestions.find((item) => item.id === 'location')
  assert.equal(location.text, 'Prefer Oakland-area options')
  assert.equal(location.sourced, true)
})

test('derives an in-network chip from the patient insurance field', () => {
  const suggestions = contextSuggestions(basePatient)
  const insurance = suggestions.find((item) => item.id === 'insurance')
  assert.equal(insurance.text, 'Keep in-network options')
  assert.equal(insurance.sourced, true)
})

test('includes one generic, clearly non-data-sourced suggestion', () => {
  const suggestions = contextSuggestions(basePatient)
  const generic = suggestions.filter((item) => item.sourced === false)
  assert.equal(generic.length, 1)
})

test('never invents telehealth, transportation, scheduling, or goals preferences', () => {
  const suggestions = contextSuggestions(basePatient)
  const text = suggestions.map((item) => item.text).join(' ').toLowerCase()
  assert.doesNotMatch(text, /telehealth|transport|schedul|goal/)
})

test('omits location/insurance chips when the field is missing', () => {
  const suggestions = contextSuggestions({ location: '', insurance: '' })
  assert.equal(suggestions.find((item) => item.id === 'location'), undefined)
  assert.equal(suggestions.find((item) => item.id === 'insurance'), undefined)
  assert.equal(suggestions.length, 1)
})
