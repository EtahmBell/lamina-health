import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { specialtiesConsulted } from '../src/agentActivity.ts'

const app = readFileSync(new URL('../src/App.tsx', import.meta.url), 'utf8')
const network = readFileSync(new URL('../src/PhysicianNetwork.tsx', import.meta.url), 'utf8')
const styles = readFileSync(new URL('../src/styles.css', import.meta.url), 'utf8')
const slice = (source, from, to) => source.slice(source.indexOf(from), source.indexOf(to))
const directory = () => slice(network, 'export function MyNetworkTab', 'export function PhysicianProfilePage')
const profile = () => slice(app, 'function SettingsPage', 'function UnfinishedPatient')

/* ---------------------------------------------------------- network hero */

test('the network page leads with relationships; the visualization is gone entirely, not merely collapsed (Dashboard+Network polish pass)', () => {
  assert.match(directory(), /Your network/)
  assert.match(directory(), /networkRoster\(network\)/)
  assert.match(directory(), /network-specialty-group/)
  assert.doesNotMatch(directory(), /Network visualization|network-visual-section|NetworkGraph|AgentDetail/)
})

test('physicians are grouped by real specialty with their own relationship row', () => {
  assert.match(directory(), /groups\.map\(\(group\) => .*group\.specialty/s)
  assert.match(directory(), /<NetworkRelationshipRow key=\{member\.npi\} member=\{member\} navigate=\{navigate\} \/>/)
  const row = slice(network, 'function NetworkRelationshipRow', 'const graphRoster')
  assert.match(row, /membershipLabel\(member\.source\)/)
  assert.match(row, /Last recommended \$\{interactionDate\(member\.lastRecommendation\)\}/)
  assert.doesNotMatch(row, /member\.consultationCount/, 'synthetic run volume is not primary row copy')
})

test('the redundant Recently consulted block is gone and marketing copy with it', () => {
  assert.doesNotMatch(network, /Care moves through agents/)
  assert.doesNotMatch(network, /network-recent-section|Recently consulted|Relevant demo agents/)
  assert.doesNotMatch(network, /Supporting directory/)
})

test('one reserved-identity notice covers the page and states what adding does not do', () => {
  const notices = directory().match(/network-boundary-notice/g) || []
  assert.equal(notices.length, 1, 'the disclaimer must appear once')
  assert.match(directory(), /Directory identities are sourced from NPPES/)
  assert.match(directory(), /does not imply that the physician participates in Lamina/)
  assert.match(directory(), /records your relationship — it does not activate their agent/)
})

/* ------------------------------------------------------- add to network */

test('a directory result can be added to, and removed from, the network', () => {
  const result = slice(network, 'function DirectoryResult', 'function NetworkRelationshipRow')
  assert.match(result, /Add colleague/)
  assert.match(result, /inNetwork[\s\S]*Remove colleague/)
  assert.match(directory(), /addNetworkMember\(profile\.npi\)/)
  assert.match(directory(), /removeNetworkMember\(profile\.npi\)/)
  assert.match(directory(), /await action\(\); await loadNetwork\(\)/, 'membership reloads canonical state')
})

test('membership is canonical workspace state, never a local presentation cache', () => {
  for (const forbidden of [/localStorage/, /sessionStorage/, /indexedDB/]) {
    assert.doesNotMatch(network, forbidden)
    assert.doesNotMatch(app, forbidden)
  }
  const api = readFileSync(new URL('../src/api.ts', import.meta.url), 'utf8')
  assert.match(api, /'\/api\/workspace\/network\/members'/)
  assert.match(api, /method: 'DELETE'/)
})

test('a directory row keeps the human avatar and the separate agent status badge', () => {
  const result = slice(network, 'function DirectoryResult', 'function NetworkRelationshipRow')
  assert.match(result, /className="lam-row-mark directory-avatar">\{initials\}/)
  assert.match(result, /<StatusBadge status=\{profile\.agent\.status\} \/>/)
  assert.doesNotMatch(result, /LaminaMark|NetworkGlyph/, 'a physician row is not an agent mark')
})

/* -------------------------------------------------------------- my agent */

test('My Agent uses the consolidated post-8B tab set (Overview/Train/Test), with no separate visualization dashboard', () => {
  assert.match(app, /const AGENT_TABS = \['overview', 'train', 'test'\] as const/)
  assert.doesNotMatch(app, /function ConsultationFootprint/, 'the specialties-consulted chart was removed as part of the My Agent simplification')
})

test('case-raised preferences still confirm/edit/reject without a separate Calibration tab; activity now links via the one deep-link helper on the Dashboard', () => {
  assert.match(app, /Proposed · needs confirmation/)
  assert.match(app, /navigate\(activityPath\(item\)\)/)
})

test('specialty counts come from the recommended specialty of each record', () => {
  const record = (specialty) => ({ result: { recommended_physician: { specialty } } })
  assert.deepEqual(
    specialtiesConsulted([record('Nephrology'), record('Gastroenterology'), record('Nephrology')]),
    [{ specialty: 'Nephrology', count: 2 }, { specialty: 'Gastroenterology', count: 1 }],
  )
  assert.deepEqual(specialtiesConsulted([]), [])
})

/* --------------------------------------------------------------- profile */

test('Settings & demo keeps the physician identity as the hero (Pass 5B: promotional agent/profile cards moved to their own primary-nav destinations)', () => {
  assert.match(profile(), /className="clinician-avatar large">LS<\/span>/)
  assert.match(profile(), /<h1>\{agent\.physician\}<\/h1>/)
  assert.match(profile(), /Settings &amp; demo/)
  assert.doesNotMatch(profile(), /profile-agent-card/, 'the My Agent promotional card now lives only on its own nav destination')
})

test('Profile shows only real fields and no fake settings chrome', () => {
  assert.match(profile(), /getMyAgent\(\)/)
  for (const field of ['agent.specialty', 'agent.location', 'agent.physician', 'agent.id', 'agent.synthetic']) {
    assert.ok(profile().includes(field), `Profile should read ${field} from the workspace agent`)
  }
  assert.match(profile(), /access\('Patient clinical context'\)/)
  for (const fake of [/type="checkbox"/, /type="password"/, /<input/, /toggle/i, /notification/i, /Save changes/i]) {
    assert.doesNotMatch(profile(), fake)
  }
  assert.doesNotMatch(profile(), /@[a-z]+\.(com|org|health)/i, 'no invented email address')
  assert.doesNotMatch(profile(), /← Home/, 'sidebar navigation already covers this')
})

/* ----------------------------------------------------------------- scope */

test('no analytics dashboard leaked into Pass 2 (specialist mode arrived deliberately in later passes)', () => {
  assert.match(styles, /\.agent-footprint/)
  assert.doesNotMatch(styles, /\.kpi-|\.metric-tile/)
})
