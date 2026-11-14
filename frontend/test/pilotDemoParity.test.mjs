import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import {
  accountIdentity, countWord, historyLabel, matchesReferral, patientInitials, patientWorkSections, pilotPaths, practicePortrait, proposalLines,
  receivedReferralWorkItem, referralGroups, referralNextStep, referringClinicians, resolveAgentTab, resolvePilotRoute, statusTone,
} from '../src/pilotState.ts'

/* Step 14: the authenticated pilot renders the polished demo's design system and page
 * structures over real pilot data. These guard the parity contract and the role rules. */

const source = (name) => readFileSync(new URL(`../src/${name}`, import.meta.url), 'utf8')
const pilot = source('Pilot.tsx')
const agent = source('PilotAgent.tsx')
const ui = source('pilotUi.tsx')
const network = source('PilotNetwork.tsx')
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

test('pilot nav is the demo general physician nav: Home, For you, Patients, Network, Your Agent', () => {
  const nav = slice(pilot, 'const NAV: NavEntry[]', ']\n')
  assert.deepEqual([...nav.matchAll(/title: '([^']+)'/g)].map((match) => match[1]), ['Home', 'For you', 'Patients', 'Network', 'Your Agent'])
  assert.doesNotMatch(nav, /'Referrals'/)
  // The Network glyph is the demo's exact people mark.
  for (const path of ['M2 19c0-3.3 2.7-6 6-6s6 2.7 6 6', 'M14.3 13.1c.7-.26 1.5-.4 2.2-.4 2.8 0 5 2.1 5 5.3']) {
    assert.ok(ui.includes(path), path)
    assert.ok(app.includes(path), `demo still defines ${path}`)
  }
})

test('Network uses the demo page structure and shows no fictional colleagues or connections', () => {
  for (const cls of ['physician-directory-page', 'directory-hero', 'network-hero', 'network-colleagues-layout', 'network-section-title', 'lam-row connection-row', 'active-network-rail']) assert.ok(network.includes(cls), cls)
  // Only real pilot data: the practice's own referrals. No demo roster, suggestions, or network API.
  for (const forbidden of ['getAgentNetwork', 'addNetworkMember', 'searchProviders', 'CURATED_SUGGESTIONS', 'Add a colleague', 'Ask their agent', '/api/workspace', 'demoIdentity', 'PhysicianNetwork', 'Engagement', 'localStorage']) {
    assert.ok(!network.includes(forbidden), `Network references ${forbidden}`)
  }
  assert.match(network, /listReferrals\(\)/)
  assert.match(network, /not Lamina network connections/)
  assert.match(network, /\{physician && <button className="button-primary" onClick=\{\(\) => navigate\(pilotPaths\.publicProfile\)\}/, 'public-profile action is physician-only')
})

test('physician-only destinations and controls are hidden for staff, never shown disabled', () => {
  const shell = slice(pilot, 'function PilotShell', '/* ------------------------------------------------------------------ home')
  assert.match(shell, /\.\.\.\(physician \? \[\{ label: 'Public physician profile'/)
  // Step 15: the conversational agent is for every member; teaching stays physician-only
  // server-side, and the dock only offers the teaching prompt to physicians.
  assert.match(pilot, /section="home" agentDock>/)
  assert.match(pilot, /suggestions=\{physician\s*\? \[[^\]]*eConsult/)
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

test('Patients and referral detail reuse the demo Patients worklist and Patient Detail structure', () => {
  const list = slice(pilot, 'function PatientsPage', 'function NewReferralPage')
  // Step 16: "Previous care" was misleading for newly accepted referrals (the visit isn't booked).
  // Same demo section treatment, honest operational section names.
  for (const cls of ['selector-page', 'selector-header', 'patient-search', 'home-section-heading', 'empty-state specialist-empty', 'Active patients', 'Accepted — awaiting scheduling', 'Closed referrals']) assert.ok(list.includes(cls), cls)
  assert.ok(!list.includes('Previous care'), 'accepted referrals are not presented as previous care')
  const rows = slice(pilot, 'function PatientWorkRows', 'function PatientsPage')
  assert.match(rows, /lam-list patient-worklist/)
  assert.doesNotMatch(rows, /referral|Referral/, 'the reusable row knows nothing referral-specific')
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

const summaryOf = (id, status, extra = {}) => ({ id, status, patient_name: 'Sam Rivera', referral_type: 'Diabetes management', sender_name: 'Dr. Ref', sender_practice: 'Clinic', received_at: `2026-11-0${id}T00:00:00Z`, fit: 'possible', priority: 'routine', next_step: 'physician_review', requires_physician: false, missing_items: [], escalated: false, decided: false, ...extra })

test('patient work items keep each referral episode distinct and carry its real state', () => {
  const items = [summaryOf('1', 'triaged'), summaryOf('2', 'needs_information'), summaryOf('3', 'accepted'), summaryOf('4', 'triaged', { priority: 'urgent' })].map(receivedReferralWorkItem)
  // Same patient name on four referrals: four episodes, never merged into one identity.
  assert.equal(new Set(items.map((item) => item.key)).size, 4)
  assert.equal(items[0].kind, 'received_referral')
  assert.equal(items[0].path, '/me/referrals/1', 'episode keeps its referral URL')
  assert.equal(items[1].nextStep, 'Waiting on the referring office')
  assert.equal(items[1].status.tone, 'slate')
  assert.equal(items[3].flag, 'Urgent')
  const { active, awaitingScheduling, closed } = patientWorkSections(items)
  assert.deepEqual(active.map((item) => item.key), ['received_referral:4', 'received_referral:1', 'received_referral:2'], 'needs-review (urgent first) before waiting')
  // Accepted = awaiting scheduling (no appointment data exists), never "previous care" or "scheduled".
  assert.deepEqual(awaitingScheduling.map((item) => item.key), ['received_referral:3'])
  assert.equal(items[2].status.label, 'Accepted — awaiting scheduling')
  assert.equal(items[2].nextStep, 'Schedule in your scheduling system')
  assert.deepEqual(closed, [])
  const declined = receivedReferralWorkItem(summaryOf('5', 'declined'))
  assert.equal(patientWorkSections([declined]).closed.length, 1)
  assert.equal(patientWorkSections(items, 'nephrology').active.length, 0)
  assert.equal(patientWorkSections(items, 'clinic').active.length, 3)
})

test('routes: Patients and Network resolve; /me/referrals stays a working alias', () => {
  assert.deepEqual(resolvePilotRoute('/me/patients'), { kind: 'patients' })
  assert.deepEqual(resolvePilotRoute('/me/referrals'), { kind: 'patients' })
  assert.deepEqual(resolvePilotRoute('/me/network'), { kind: 'network' })
  assert.deepEqual(resolvePilotRoute('/network'), { kind: 'redirect', to: pilotPaths.home }, 'demo network paths still redirect')
  assert.equal(pilotPaths.referral('abc'), '/me/referrals/abc')
})

test('referring clinicians come only from received referrals, exact-name grouped', () => {
  const rows = referringClinicians([
    { sender_name: 'Dr. Ref', sender_practice: 'Clinic', received_at: '2026-11-01T00:00:00Z' },
    { sender_name: 'dr. ref', sender_practice: 'clinic ', received_at: '2026-11-05T00:00:00Z' },
    { sender_name: 'Dr. Ref', sender_practice: 'Other Clinic', received_at: '2026-11-03T00:00:00Z' },
    { sender_name: '  ', sender_practice: null, received_at: '2026-11-03T00:00:00Z' },
  ])
  assert.equal(rows.length, 2, 'same name at a different practice stays separate; blank senders are skipped')
  assert.equal(rows[0].count, 2)
  assert.equal(rows[0].lastAt, '2026-11-05T00:00:00Z')
  assert.equal(rows[0].initials, 'R')
  assert.deepEqual(referringClinicians([]), [])
})

test('general physician wording: no endocrine-only prompts or specialist-only fallbacks', () => {
  for (const [name, text] of [['Pilot.tsx', pilot], ['PilotAgent.tsx', agent], ['PilotNetwork.tsx', network], ['PublicPages.tsx', source('PublicPages.tsx')]]) {
    assert.doesNotMatch(text, /[Tt]hyroid|\bTSH\b|[Ii]nsulin pump|'Specialty practice'|specialty practices/, name)
  }
  assert.match(agent, /<p className="eyebrow">Your physician agent<\/p>/)
  assert.match(practicePortrait({ name: 'P', specialty: null }, []), /^Your practice\./)
})
