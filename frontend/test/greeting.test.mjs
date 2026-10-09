import assert from 'node:assert/strict'
import { test } from 'node:test'
import { greetingPrefix, timeAwareGreeting } from '../src/greeting.ts'

test('the portal greeting follows the browser-local time bands', () => {
  for (const hour of [5, 8, 11]) assert.equal(greetingPrefix(hour), 'Good morning')
  for (const hour of [12, 14, 16]) assert.equal(greetingPrefix(hour), 'Good afternoon')
  for (const hour of [17, 21, 23, 0, 4]) assert.equal(greetingPrefix(hour), 'Good evening')
})

test('the greeting names the clinician and is deterministic for a given time', () => {
  assert.equal(timeAwareGreeting('Dr. Lucy Saruhashi', new Date(2026, 8, 29, 9, 12)), 'Good morning, Dr. Lucy Saruhashi.')
  assert.equal(timeAwareGreeting('Dr. Lucy Saruhashi', new Date(2026, 8, 29, 13, 0)), 'Good afternoon, Dr. Lucy Saruhashi.')
  assert.equal(timeAwareGreeting('Dr. Lucy Saruhashi', new Date(2026, 8, 29, 22, 58)), 'Good evening, Dr. Lucy Saruhashi.')
  assert.equal(timeAwareGreeting('Dr. Lucy Saruhashi', new Date(2026, 8, 29, 2, 30)), 'Good evening, Dr. Lucy Saruhashi.')
})
