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
