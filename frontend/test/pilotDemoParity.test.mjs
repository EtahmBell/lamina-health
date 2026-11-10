import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import {
  accountIdentity, countWord, historyLabel, matchesReferral, patientInitials, pilotPaths, practicePortrait, proposalLines,
  referralGroups, referralNextStep, resolveAgentTab, resolvePilotRoute, statusTone,
} from '../src/pilotState.ts'

/* Step 14: the authenticated pilot renders the polished demo's design system and page
 * structures over real pilot data. These guard the parity contract and the role rules. */

const source = (name) => readFileSync(new URL(`../src/${name}`, import.meta.url), 'utf8')
const pilot = source('Pilot.tsx')
const agent = source('PilotAgent.tsx')
const ui = source('pilotUi.tsx')
const app = source('App.tsx')
const slice = (text, from, to) => text.slice(text.indexOf(from), to ? text.indexOf(to, text.indexOf(from)) : undefined)

test('pilot shell is the demo physician shell: same classes, nav glyphs, account pill, status pill', () => {
  assert.match(ui, /className=\{`app-shell physician-shell pilot-shell \$\{agentDock \? 'has-agent-dock' : ''\}`\}/)
  assert.match(ui, /<p className="brand-subtitle">Specialty Care Network<\/p>/)
  assert.match(ui, /className="perspective-switch sidebar-account"/)
  assert.match(ui, /<div className="synthetic-status"><span \/>\{status\}<\/div>/)
  // Glyphs are the demo's exact SVG paths (the demo's own copies stay test-pinned in App.tsx).
  for (const path of ['M2.5 8.25 9 2.75l6.5 5.5', 'M2 10.5l2-7h10l2 7v4a1 1 0 0 1-1 1H3a1 1 0 0 1-1-1z', 'M9 1.75l1.7 4.55 4.55 1.7-4.55 1.7L9 14.25l-1.7-4.55L2.75 8l4.55-1.7z']) {
    assert.ok(ui.includes(path), path)
    assert.ok(app.includes(path), `demo still defines ${path}`)
  }
})

test('pilot nav mirrors the demo order and never shows a fictional network', () => {
  const nav = slice(pilot, 'const NAV: NavEntry[]', ']\n')
  assert.deepEqual([...nav.matchAll(/title: '([^']+)'/g)].map((match) => match[1]), ['Home', 'For you', 'Referrals', 'Your Agent'])
  assert.doesNotMatch(nav, /Network/)
})

test('physician-only destinations and controls are hidden for staff, never shown disabled', () => {
  const shell = slice(pilot, 'function PilotShell', '/* ------------------------------------------------------------------ home')
  assert.match(shell, /\.\.\.\(physician \? \[\{ label: 'Public referral page'/)
  assert.match(pilot, /agentDock=\{status\.role === 'physician'\}/, 'teaching dock is physician-only')
  assert.match(pilot, /\{physician && <TeachDock/)
  assert.match(pilot, /physician && canUse\(actions, 'accept'\)/)
  const profile = slice(pilot, 'function ProfilePage')
  assert.match(profile, /\{physician && !editing && <button className="button-primary" onClick=\{\(\) => setEditing\(true\)\}>Edit practice/)
  assert.match(profile, /\{physician && <section className="profile-section-v2">\s*<div className="profile-section-heading"><h2>Invite staff/)
  const settings = slice(agent, 'export function PublicSettingsPage', '/* ----------------------------------------------------------------- metrics')
  assert.match(settings, /\{physician && <section className="pilot-card">/, 'staff see only the read-only preview')
  assert.doesNotMatch(settings, /disabled=\{!physician/, 'no disabled physician-only inputs')
  const rules = slice(agent, 'function RulesTab', '/* --------------------------------------------------------- public profile')
  assert.match(rules, /\{physician && editing === null && <button/)
})

test('Home and For you use the demo dashboard structure and read only the server projection', () => {
  const home = slice(pilot, 'function PilotHomePage', 'function ForYouPage')
  for (const cls of ['agent-home', 'agent-home-greeting', 'agent-status', 'agent-brief', 'agent-label']) assert.ok(home.includes(cls), cls)
  assert.doesNotMatch(home, /pilot-briefing|lam-list|KPI|kpi/, 'no banner card, KPI row, or old list')
  const forYou = slice(pilot, 'function ForYouPage', 'function NeedRow')
  assert.match(forYou, /className="agent-home for-you"/)
  assert.match(slice(pilot, 'function useHomeData', 'function NeedRow'), /getHome\(\)/)
  // GET /home records a home_viewed event: only Home and For you may call it, never the shell.
  assert.doesNotMatch(slice(pilot, 'function PilotShell', '/* ------------------------------------------------------------------ home'), /getHome/)
  assert.doesNotMatch(agent, /getHome/)
})

test('referral list and detail reuse the demo Patients worklist and Patient Detail structure', () => {
  const list = slice(pilot, 'function ReferralsPage', 'function NewReferralPage')
  for (const cls of ['selector-page', 'selector-header', 'patient-search', 'home-section-heading', 'empty-state specialist-empty']) assert.ok(list.includes(cls), cls)
  assert.match(slice(pilot, 'function ReferralRows', 'function ReferralsPage'), /lam-list patient-worklist/)
  const detail = slice(pilot, 'function ReferralDetailPage', '/* -------------------------------------------------------------- profile')
  for (const cls of ['patient-identity', 'patient-current-issue', 'patient-detail-grid', 'patient-next-step patient-top-card', 'next-step-card', 'patient-history-section', 'clinical-timeline', 'clinical-overview', 'care-context', 'source-record']) assert.ok(detail.includes(cls), cls)
})

test('My Agent follows the demo Overview order with real data only', () => {
  const overview = slice(agent, 'function AgentOverview', 'function PracticeRepresentation')
  const order = ['<TrainingReminderBand', 'agent-portrait-card', 'Your agent at work', 'What your agent learned this week', 'How your agent currently represents your practice']
  const positions = order.map((marker) => overview.indexOf(marker))
  positions.forEach((position, index) => assert.ok(position > 0, order[index]))
  assert.deepEqual([...positions].sort((a, b) => a - b), positions, 'sections in the demo order')
  assert.match(agent, /className="page-shell agent-page pilot-agent-page"/)
  assert.match(agent, /<AgentAvatar tone="copper" \/>/)
})

test('shared pilot UI stays data-free and free of demo modules and client storage', () => {
  for (const [name, text] of [['pilotUi.tsx', ui], ['PilotAgent.tsx', agent]]) {
    for (const forbidden of ['demoIdentity', 'demoPatients', 'AgentHome', "from './Referral", 'Engagement', 'PhysicianNetwork', 'DEMO_PATIENTS', 'CHEN_', 'localStorage', 'sessionStorage', '/api/workspace']) {
      assert.ok(!text.includes(forbidden), `${name} references ${forbidden}`)
    }
  }
})

test('routes: For you and agent tabs resolve; rules stay reachable at /me/rules', () => {
  assert.deepEqual(resolvePilotRoute('/me/for-you'), { kind: 'for_you' })
  assert.deepEqual(resolvePilotRoute('/me/rules'), { kind: 'rules' })
  assert.equal(pilotPaths.agentTab('overview'), '/me/agent')
  assert.equal(pilotPaths.agentTab('teach'), '/me/agent?tab=teach')
  assert.equal(pilotPaths.agentTab('rules'), '/me/rules')
  assert.equal(resolveAgentTab('teach'), 'teach')
  assert.equal(resolveAgentTab('test'), 'overview', 'unknown tab falls back to Overview')
  assert.equal(resolveAgentTab(null), 'overview')
})

const status = (role, identity) => ({ role, physician_onboarding: { confirmed_identity: identity ? { identity, npi: '1234567893', confirmed_at: '2026-11-09T00:00:00Z' } : null } })

test('account identity comes only from the confirmed physician profile', () => {
  const physician = accountIdentity(status('physician', { first_name: 'AVERY', last_name: 'TESTWELL', display_name: 'AVERY TESTWELL, M.D.' }))
  assert.deepEqual(physician, { name: 'Dr. Avery Testwell', firstName: 'Avery', initials: 'AT', role: 'Physician' })
  const staff = accountIdentity(status('staff', null), 'front.desk@example.test')
  assert.equal(staff.name, 'Practice staff')
  assert.equal(staff.firstName, null, 'staff are greeted without an invented name')
  assert.equal(staff.role, 'Staff')
  assert.equal(staff.initials, 'FR')
})

const summary = (id, status, extra = {}) => ({ id, status, patient_name: `Pat ${id}`, referral_type: 'Thyroid nodule', sender_name: 'Dr. Ref', sender_practice: 'Clinic', received_at: `2026-11-0${id}T00:00:00Z`, fit: 'possible', priority: 'routine', next_step: 'physician_review', requires_physician: false, missing_items: [], escalated: false, decided: false, ...extra })

test('referral groups place each referral once and put urgent work first', () => {
  const groups = referralGroups([summary('1', 'triaged'), summary('2', 'needs_information'), summary('3', 'accepted'), summary('4', 'triaged', { priority: 'urgent' }), summary('5', 'ready_for_review')])
  assert.deepEqual(groups.review.map((item) => item.id), ['4', '5', '1'])
  assert.deepEqual(groups.waiting.map((item) => item.id), ['2'])
  assert.deepEqual(groups.closed.map((item) => item.id), ['3'])
  assert.equal(referralNextStep(summary('1', 'needs_information')), 'Waiting on the referring office')
  assert.equal(referralNextStep(summary('1', 'ready_for_review')), 'Physician decision')
  assert.equal(referralNextStep(summary('1', 'declined')), 'View referral')
  assert.equal(referralNextStep(summary('1', 'triaged', { next_step: 'confirm_document_evidence' })), 'Confirm what the documents show')
  assert.equal(statusTone('accepted'), 'success')
  assert.equal(statusTone('needs_information'), 'slate')
  assert.equal(statusTone('declined'), 'quiet')
  assert.equal(statusTone('triaged'), 'copper')
  assert.ok(matchesReferral(summary('1', 'triaged'), 'clinic'))
  assert.ok(!matchesReferral(summary('1', 'triaged'), 'nephrology'))
})

test('portrait, labels, and proposal lines describe only confirmed facts', () => {
  assert.match(practicePortrait({ name: 'P', specialty: 'Endocrinology' }, []), /No referral rules are confirmed yet/)
  assert.equal(practicePortrait({ name: 'P', specialty: 'Endocrinology' }, [{ referral_type: 'Thyroid nodule' }, { referral_type: 'Thyroid nodule' }]),
    'Endocrinology practice. Your agent triages 1 referral type from your confirmed rules: Thyroid nodule.')
  assert.equal(historyLabel('sender_response_received'), 'Referring office replied')
  assert.equal(historyLabel('something_new'), 'Something new')
  assert.equal(patientInitials('Test Patient Beta'), 'TP')
  assert.equal(countWord(2), 'Two')
  assert.equal(countWord(42), '42')
  assert.deepEqual(proposalLines({ required: [{ key: 'tsh', label: 'Recent TSH', required: true, freshness_days: 90 }], helpful: [], good_fit: [], redirect: ['Pump management'], urgent_signals: [], modality: 'econsult', modality_notes: null }),
    ['Require before review: Recent TSH (within 90 days)', 'Outside your scope: Pump management', 'Default modality: eConsult'])
})
