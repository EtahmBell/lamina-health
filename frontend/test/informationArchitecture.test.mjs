import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'

const source = readFileSync(new URL('../src/App.tsx', import.meta.url), 'utf8')

test('sidebar uses the final four-item navigation model', () => {
  const navigation = source.slice(source.indexOf('const navItems'), source.indexOf('function ProfileControl'))
  assert.doesNotMatch(navigation, /title: 'Home'/)
  for (const title of ['Patients', 'Consultations', 'My Agent', 'Physician Network']) {
    assert.match(navigation, new RegExp(`title: '${title}'`))
  }
})

test('referral brief and progressive source disclosure remain present', () => {
  assert.match(source, /Specialty care referral brief/)
  assert.match(source, /View full clinical record/)
  assert.match(source, /Is there anything your agent should know\?/)
})

test('My Agent exposes the four requested inspectable layers', () => {
  assert.match(source, /\['overview', 'knowledge', 'calibration', 'activity'\]/)
  assert.match(source, /Dr\. Lucy Saru/)
})
