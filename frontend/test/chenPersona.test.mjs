import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'

const app = readFileSync(new URL('../src/App.tsx', import.meta.url), 'utf8')
const engagement = readFileSync(new URL('../src/Engagement.tsx', import.meta.url), 'utf8')
const demoIdentity = readFileSync(new URL('../src/demoIdentity.ts', import.meta.url), 'utf8')
const api = readFileSync(new URL('../src/api.ts', import.meta.url), 'utf8')

const slice = (source, from, to) => source.slice(source.indexOf(from), to !== undefined ? source.indexOf(to) : undefined)
const routing = () => slice(app, 'export default function App', app.length)
const perspectiveSwitch = () => slice(app, 'function PerspectiveSwitch', 'function ProductShell')

/* ------------------------------------------------------- Part A: the switcher */

test('Chen is a real DemoPhysicianPerspective value, alongside lucy and iain', () => {
  assert.match(api, /export type DemoPhysicianPerspective = 'lucy' \| 'iain' \| 'chen'/)
})

test('the demo perspective switcher list (SWITCHABLE_DEMO_PERSPECTIVES) exposes Dr. Noah Chen', () => {
  assert.match(app, /const SWITCHABLE_DEMO_PERSPECTIVES = DEMO_PERSPECTIVES\.filter\(\(item\) => item\.id !== 'specialist'\)/)
  assert.match(app, /id: 'chen' as const, name: CHEN_NAME, role: 'Receiving specialist'/)
  const switchControl = perspectiveSwitch()
  assert.match(switchControl, /SWITCHABLE_DEMO_PERSPECTIVES\.map/, 'the rendered dropdown list must use the filtered set, not the full one')
})

test('Iain (the old "specialist" entry) is no longer in the switchable list, but the full DEMO_PERSPECTIVES lookup still resolves his pill correctly if his own pages are open', () => {
  assert.doesNotMatch(app, /SWITCHABLE_DEMO_PERSPECTIVES = \[[^\]]*specialist/s)
  assert.match(app, /const current = DEMO_PERSPECTIVES\.find\(\(item\) => item\.id === perspective\)/, 'pill lookup uses the full list, so visiting an Iain page still shows his real name/initials')
})

test('replacing Iain in the switcher does not touch his own routes, data, or the specialist perspective type', () => {
  assert.match(app, /perspective: 'pcp' \| 'specialist' \| 'chen'/)
  assert.match(routing(), /path === '\/specialist' \|\| path === '\/specialist\/home'/)
  assert.match(routing(), /path === '\/specialist\/patients'/)
  assert.match(routing(), /path === '\/specialist\/network'/)
  assert.match(routing(), /perspective="specialist"/)
})

/* --------------------------------------------------- Part D/F: Chen workspace */

test('switching to Chen lands on his real Dashboard, and Profile is reached the same way Lucy\'s and Iain\'s are (via profilePath, not a new nav system)', () => {
  assert.match(app, /id: 'chen' as const, name: CHEN_NAME, role: 'Receiving specialist', initials: 'NC', path: '\/chen\/home', profilePath: '\/chen\/profile'/)
  assert.match(app, /const CHEN_NAV_ITEMS = \[\s*\n\s*\{ id: 'chen-home', title: 'Dashboard'/)
})

test('Chen Profile, Agent, and Network routes are registered in the SPA dispatcher, reusing the shared shells', () => {
  const dispatch = routing()
  assert.match(dispatch, /path === '\/chen\/profile'[\s\S]{0,160}ProfessionalProfilePage personaId="chen"/)
  assert.match(dispatch, /path === '\/chen\/agent'\)[\s\S]{0,160}ChenAgentPage/)
  assert.match(dispatch, /path === '\/chen\/agent\/train'[\s\S]{0,200}TrainingPage personaId="chen"/)
  assert.match(dispatch, /path === '\/chen\/network'\)[\s\S]{0,160}ChenNetworkPage/)
})

test('Chen Patients and Incoming Requests routes still work (now alongside a real Dashboard route)', () => {
  const dispatch = routing()
  assert.match(dispatch, /path === '\/chen' \|\| path === '\/chen\/home'\)[\s\S]{0,160}ChenHomePage/)
  assert.match(dispatch, /path === '\/chen\/patients'\)[\s\S]{0,160}ChenPatientsPage/)
  assert.match(dispatch, /chenPatientId === TONJIT_ID \|\| \(chenPatientId && CHEN_PATIENT_IDS\.includes\(chenPatientId\)\)\) return <PatientWorkspace patientId=\{chenPatientId\} navigate=\{navigate\} perspective="receiving"/)
})

/* --------------------------------------------------------------- Part B/C/E */

test('Chen Profile uses the exact same shared ProfessionalProfilePage component Lucy uses -- no special Chen-only profile page', () => {
  assert.doesNotMatch(app, /function ChenProfilePage/)
  assert.doesNotMatch(engagement, /function ChenProfilePage/)
})

test('"View as others see it" on Chen\'s profile opens his real public profile via the shared preview infrastructure, routed under /chen', () => {
  assert.match(engagement, /export const networkProfilePath = \(perspective: DemoPhysicianPerspective, controlledId: string\) => \(perspective === 'iain' \? `\/specialist\/network\/profile\/\$\{controlledId\}` : perspective === 'chen' \? `\/chen\/network\/profile\/\$\{controlledId\}` : `\/network\/profile\/\$\{controlledId\}`\)/)
  assert.match(engagement, /export const networkProfilePreviewPath = \(perspective: DemoPhysicianPerspective, controlledId: string\) => `\$\{networkProfilePath\(perspective, controlledId\)\}\?preview=1`/)
  const dispatch = routing()
  assert.match(dispatch, /chenNetworkProfileId[\s\S]{0,200}NetworkPhysicianProfilePage controlledId=\{chenNetworkProfileId\}[\s\S]{0,80}perspective="chen"/)
})

test('Back to editing from Chen\'s public-profile preview returns to his real Profile route, not Dashboard and not Lucy\'s profile', () => {
  assert.match(engagement, /export const professionalProfilePath = \(perspective: DemoPhysicianPerspective\) => \(perspective === 'iain' \? '\/specialist\/profile' : perspective === 'chen' \? '\/chen\/profile' : '\/profile'\)/)
  assert.match(engagement, /const backTarget = isPreview \? professionalProfilePath\(perspective\) : backPath/, 'preview back-target is always derived from the real perspective, generic for any persona including chen')
})

test('"View how my agent represents me" from Chen\'s profile routes to his own real agent page, never Lucy\'s', () => {
  assert.match(engagement, /const agentPracticePath = \(perspective: PhysicianIdentity\) => \(perspective === 'iain' \? '\/specialist\/agent' : perspective === 'chen' \? '\/chen\/agent' : perspective === 'owner' \? '\/me\/agent\?tab=practice' : '\/agent\?tab=knowledge'\)/)
})

/* ---------------------------------------------------- Part C: canonical identity */

test('demoIdentity.ts\'s CHEN_ID/CHEN_NAME/CHEN_SPECIALTY match the real canonical backend physician-chen identity, never a duplicated object', () => {
  assert.match(demoIdentity, /export const CHEN_ID = 'physician-chen'/)
  assert.match(demoIdentity, /export const CHEN_NAME = 'Dr\. Noah Chen'/)
  assert.match(demoIdentity, /export const CHEN_SPECIALTY = 'Endocrinology'/)
})

/* ----------------------------------------------- Part G: Lucy's own profile */

test('Lucy\'s own profile/agent/network paths are byte-for-byte unchanged by this pass', () => {
  assert.match(engagement, /export const professionalProfilePath = \(perspective: DemoPhysicianPerspective\) => \(perspective === 'iain' \? '\/specialist\/profile' : perspective === 'chen' \? '\/chen\/profile' : '\/profile'\)/)
  const dispatch = routing()
  assert.match(dispatch, /path === '\/profile' \|\| path === '\/profile\/professional'\)[\s\S]{0,160}ProfessionalProfilePage personaId="lucy"/)
  assert.match(dispatch, /path === '\/agent'\)/)
})
