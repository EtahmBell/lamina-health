import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { pilotPaths, resolvePilotRoute } from '../src/pilotState.ts'

const source = (name) => readFileSync(new URL(`../src/${name}`, import.meta.url), 'utf8')
const pilot = source('Pilot.tsx')
const agent = source('PilotAgent.tsx')
const publicPages = source('PublicPages.tsx')
const api = source('pilotApi.ts')
const slice = (text, from, to) => text.slice(text.indexOf(from), to ? text.indexOf(to, text.indexOf(from)) : undefined)

test('agent, public, metrics, and account-free public routes resolve', () => {
  assert.deepEqual(resolvePilotRoute('/me/agent'), { kind: 'agent' })
  assert.deepEqual(resolvePilotRoute('/me/public'), { kind: 'public_settings' })
  assert.deepEqual(resolvePilotRoute('/me/metrics'), { kind: 'metrics' })
  assert.deepEqual(resolvePilotRoute('/p/smith-endocrinology'), { kind: 'public_profile', slug: 'smith-endocrinology' })
  assert.deepEqual(resolvePilotRoute('/p/smith-endocrinology/refer'), { kind: 'public_refer', slug: 'smith-endocrinology' })
  const token = 'a'.repeat(43)
  assert.deepEqual(resolvePilotRoute(`/r/${token}`), { kind: 'sender', token })
  assert.equal(pilotPaths.sender(token), `/r/${token}`)
})

test('public pages render outside the authenticated gate', () => {
  const app = slice(pilot, 'export function PilotApp', '/* ------------------------------------------------------------------ gate')
  for (const kind of ['public_profile', 'public_refer', 'sender']) {
    const line = app.split('\n').find((row) => row.includes(`case '${kind}'`))
    assert.ok(line && !line.includes('PilotGate'), `${kind} must not require sign-in`)
  }
})

test('public API calls never attach the signed-in token or cookies', () => {
  const publicSection = slice(api, '/* ------------------------------------------------- public (no account needed) */')
  assert.doesNotMatch(publicSection, /apiRequest|authHeaders|getAccessToken/)
  assert.match(publicSection, /credentials: 'omit'/)
})

test('missing-information sending always requires a human click', () => {
  const panel = slice(pilot, 'function InformationRequestPanel', 'type Panel =')
  assert.match(panel, /Approve &amp; email/)
  assert.match(panel, /Approve — I’ll fax\/send it/)
  assert.match(panel, /sendInformationRequest\(request\.id, 'send'\)/)
  assert.match(panel, /Shown once/)
  assert.doesNotMatch(pilot, /useEffect\([^)]*sendInformationRequest/, 'never sent from an effect')
})

test('Home shows the four agent-first sections from the server projection only', () => {
  const home = slice(pilot, 'function PilotHomePage', '/* ------------------------------------------------------------- referrals')
  for (const title of ['Needs you', 'Prepared for you', 'Waiting on others', 'While you were away']) assert.ok(home.includes(title), title)
  assert.match(home, /getHome\(\)/)
  assert.match(home, /Teach your agent/)
})

test('teaching shows the interpretation and offers confirm, edit, reject, and clarification', () => {
  for (const label of ['Confirm', 'Edit', 'Reject', 'I understood:', 'not active until you confirm', 'Or name a new referral type']) {
    assert.ok(agent.includes(label), label)
  }
  const question = slice(agent, 'export function QuestionCard', 'export function AgentPage')
  for (const label of ['Yes', 'Edit', 'Not always / Depends', 'Ignore', 'at most one question like this a day']) assert.ok(question.includes(label), label)
})

test('public profile preview and page share one renderer fed only by the snapshot', () => {
  assert.match(agent, /<PublicProfileView profile=\{preview\.draft_snapshot\}/)
  assert.match(publicPages, /getPublicProfile\(slug\)/)
  assert.match(publicPages, /Start a referral/)
  assert.match(publicPages, /Ask about this practice/)
  assert.match(publicPages, /Not medical advice/)
  assert.match(publicPages, /public-honeypot/)
  assert.match(publicPages, /it won’t be shown again/)
})

test('metrics never claim time saved', () => {
  assert.match(agent, /doesn’t estimate “time saved”/)
  assert.doesNotMatch(agent, /time_saved/)
})

test('email confirmation returns to this origin and keeps only a safe relative return path', async () => {
  const { confirmationRedirectUrl } = await import('../src/authClient.ts').catch(() => ({}))
  assert.equal(typeof confirmationRedirectUrl, 'function')
  const at = (search) => confirmationRedirectUrl({ origin: 'http://127.0.0.1:5173', search })
  assert.equal(at('?return=%2Fme%2Fjoin%3Finvite%3Dabc'), 'http://127.0.0.1:5173/me/join?invite=abc')
  assert.equal(at('?return=https%3A%2F%2Fevil.example'), 'http://127.0.0.1:5173/me')
  assert.equal(at('?return=%2F%2Fevil.example'), 'http://127.0.0.1:5173/me')
  assert.equal(at(''), 'http://127.0.0.1:5173/me')
})

test('signup passes the confirmation redirect to Supabase', () => {
  const auth = source('authClient.ts')
  assert.match(auth, /auth\.signUp\(\{ email, password, options: \{ emailRedirectTo: confirmationRedirectUrl\(\) \} \}\)/)
})

test('publishing includes on-screen public-page edits and rule toggles keep them', () => {
  const settings = slice(agent, 'export function PublicSettingsPage', '/* ----------------------------------------------------------------- metrics')
  assert.match(settings, /const saveThenPublish = async \(\) => \{ if \(unsaved\) await saveSettings\(\); return publishPublicProfile\(\) \}/)
  assert.match(settings, /onClick=\{\(\) => void run\(saveThenPublish\)\}/)
  assert.match(settings, /setRulePublishable\(rule\.id, event\.target\.checked\), true\)/)
  assert.match(settings, /Unsaved changes/)
})

test('sender replies show the practice label, never the internal item key', async () => {
  const { itemLabel } = await import('../src/pilotState.ts')
  const detail = {
    recommendation: { requirements: [{ key: 'recent_tsh', label: 'Recent TSH' }] },
    information_requests: [{ items: [{ key: 'thyroid_ultrasound', label: 'Thyroid ultrasound' }] }],
  }
  assert.equal(itemLabel('recent_tsh', detail), 'Recent TSH')
  assert.equal(itemLabel('thyroid_ultrasound', detail), 'Thyroid ultrasound')
  assert.equal(itemLabel('free_t4', { recommendation: null }), 'Free t4')
  assert.equal(itemLabel('tsh', detail, 'Recent TSH'), 'Recent TSH')
  assert.doesNotMatch(pilot, /item\.key\.replace\(\/_\/g, ' '\)/)
})
