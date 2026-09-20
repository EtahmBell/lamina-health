import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'

const source = readFileSync(new URL('../src/App.tsx', import.meta.url), 'utf8')

test('root remains the portal and the portal circle enters Home', () => {
  assert.match(source, /if \(path === '\/'\) return <LandingPage navigate=\{navigate\} \/>/)
  const portal = source.slice(source.indexOf('function LandingPage'), source.indexOf('function relativeTime'))
  assert.match(portal, /Who are we helping today\?/)
  assert.match(portal, /navigate\('\/home'\)/)
  assert.match(portal, /Enter workspace/)
  assert.doesNotMatch(portal, /getConsultationHistory/)
})

test('workspace sidebar keeps Home as a dashboard destination', () => {
  const navigation = source.slice(source.indexOf('const navItems'), source.indexOf('function ProfileControl'))
  for (const title of ['Home', 'Patients', 'Consultations', 'My Agent', 'Physician Network']) {
    assert.match(navigation, new RegExp(`title: '${title}'`))
  }
  assert.match(navigation, /title: 'Home'.*path: '\/home'/s)
})

test('workspace logo returns every shell screen to the portal', () => {
  const shell = source.slice(source.indexOf('function ProductShell'), source.indexOf('function LandingPage'))
  assert.match(shell, /className="brand-button" onClick=\{\(\) => navigate\('\/'\)\}/)
  assert.match(shell, /aria-label="Return to Lamina portal"/)
})

test('workspace header keeps right controls without a generic page label', () => {
  const shell = source.slice(source.indexOf('function ProductShell'), source.indexOf('function LandingPage'))
  assert.match(shell, /className="workspace-bar-actions"><SyntheticStatus \/><ProfileControl navigate=\{navigate\} \/>/)
  assert.doesNotMatch(shell, /section === 'home'/)
  assert.doesNotMatch(shell, /trail/)
})

test('Home actions target the expected routes', () => {
  assert.match(source, /className="button-primary home-start" onClick=\{\(\) => navigate\('\/patients'\)\}/)
  assert.match(source, /navigate\('\/agent\?tab=calibration'\)/)
  assert.match(source, /navigate\(`\/patients\/\$\{patient\.id\}`\)/)
})

test('Home derives attention and activity from existing workspace state', () => {
  const home = source.slice(source.indexOf('function HomePage'), source.indexOf('function PatientSelector'))
  assert.match(home, /getConsultationHistory\(\)/)
  assert.match(home, /getPatientActivity\(\)/)
  assert.match(home, /getMyAgent\(\)/)
  assert.match(home, /Needs your attention/)
  assert.match(home, /Recent activity/)
  assert.match(home, /Recent patients/)
  assert.match(home, /follow_up_question/)
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
