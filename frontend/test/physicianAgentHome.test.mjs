import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { answerWorkspaceQuestion, DOCK_SUGGESTED_PROMPTS } from '../src/agentConversation.ts'
import { CHEN_ID, JORDAN_ID, MARIA_ID, TONJIT_ID } from '../src/demoIdentity.ts'
import { DEMO_PATIENTS } from '../src/demoPatients.ts'
import { briefingText, buildBriefing, buildPhysicianQueue, dashboardNeeds, DASHBOARD_NEEDS_LIMIT } from '../src/physicianQueue.ts'

/* Physician-agent home pass: Dashboard / For you / docked agent conversation. */

const app = readFileSync(new URL('../src/App.tsx', import.meta.url), 'utf8')
const home = readFileSync(new URL('../src/AgentHome.tsx', import.meta.url), 'utf8')
const queueSource = readFileSync(new URL('../src/physicianQueue.ts', import.meta.url), 'utf8')
const conversationSource = readFileSync(new URL('../src/agentConversation.ts', import.meta.url), 'utf8')
const styles = readFileSync(new URL('../src/styles.css', import.meta.url), 'utf8')
const slice = (source, from, to) => source.slice(source.indexOf(from), source.indexOf(to))
const physicianShell = () => slice(app, 'function PhysicianShell', 'function LandingPage')

const LUCY_PATIENTS = DEMO_PATIENTS.filter((patient) => patient.implemented && patient.owner !== 'chen')
const NOW = new Date(2026, 10, 6, 14, 30)
const TODAY = new Date(2026, 10, 6, 10, 0).toISOString()
const LAST_WEEK = new Date(2026, 9, 28, 10, 0).toISOString()

const clarification = { id: 'clar-1', case_family: 'renal', title: 'When you want nephrology before changing a renal regimen', body: '', clarifying_question: '', supporting_text: '' }
const record = (patientId, specialty, physician, completedAt = LAST_WEEK, id = 1) => ({
  id, patient_id: patientId, completed_at: completedAt,
  result: { recommended_physician: { physician_name: `${physician} (synthetic)`, specialty }, consultation: [], messages: [] },
})
const referral = (patientId, status, extra = {}) => ({
  id: 7, patient_id: patientId, referring_physician_id: 'agent-lucy-saruhashi', receiving_physician_id: CHEN_ID,
  specialty: 'Endocrinology', referral_question: '', urgency: 'routine', priority: 'soon', modality: 'in_person', status,
  created_at: TODAY, updated_at: TODAY, packet: { items: [] }, receiving_requirements: [], requirement_results: [],
  coordination_events: [], previous_referral_id: null, ...extra,
})
const build = (overrides = {}) => buildPhysicianQueue({
  patients: LUCY_PATIENTS, records: [], referrals: new Map(), handoffViewedAt: new Map(),
  clarifications: [clarification], clarificationPath: (id) => `/agent?tab=train&focus=${id}`,
  deferred: new Set(), now: NOW, ...overrides,
})

/* ---------------------------------------------------------------- sidebar */

test('Lucy\'s sidebar has exactly five primary destinations, in order', () => {
  const navigation = slice(app, 'const navItems', 'const SPECIALIST_NAV_ITEMS')
  assert.deepEqual(navigation.match(/title: '[^']+'/g), ["title: 'Dashboard'", "title: 'For you'", "title: 'Patients'", "title: 'Network'", "title: 'Your Agent'"])
  assert.ok(navigation.includes("path: '/for-you'"))
  assert.ok(navigation.includes("path: '/agent?tab=overview'"))
  assert.ok(physicianShell().includes('navItems.map'))
})

test('the For you nav item carries the live Needs-you count from the same queue', () => {
  assert.ok(physicianShell().includes('const needsCount = useNeedsCount()'))
  assert.ok(physicianShell().includes("item.id === 'for-you' && needsCount > 0"))
  assert.ok(home.includes('return useWorkspaceSnapshot().queue.needs.length'))
})

test('the physician account/profile control sits at the bottom-left of the sidebar, not in the top bar', () => {
  const shell = physicianShell()
  const navEnd = shell.indexOf('</nav>')
  const account = shell.indexOf('<PerspectiveSwitch navigate={navigate} perspective="pcp" placement="sidebar" />')
  const asideEnd = shell.indexOf('</aside>')
  assert.ok(navEnd > 0 && account > navEnd && account < asideEnd, 'account control follows the nav inside the sidebar')
  assert.ok(shell.includes('<header className="workspace-bar"><div className="workspace-bar-actions"><SyntheticStatus /></div></header>'), 'the top bar no longer carries the account control for Lucy')
  assert.ok(styles.includes('.sidebar-account .perspective-menu { top: auto; bottom: calc(100% + 8px);'), 'the account menu opens upward from the sidebar bottom')
  assert.ok(app.includes("onClick={() => { setOpen(false); navigate(current.profilePath) }}>Profile</button>"), 'Profile stays reachable from the account menu')
})

test('the specialist and Chen workspaces keep their existing shell', () => {
  const shell = slice(app, 'function ProductShell', 'function PhysicianShell')
  assert.ok(shell.includes("if (perspective === 'pcp') return <PhysicianShell"))
  assert.ok(shell.includes('<PerspectiveSwitch navigate={navigate} perspective={perspective} />'))
})

/* ---------------------------------------------------------------- briefing */

test('Dashboard briefing at the start of the demo: two things, Tonjit first, the agent watching the rest', () => {
  const queue = build()
  assert.equal(
    briefingText(buildBriefing(queue.needs)),
    "Two things need you today. The most important is Tonjit Askarov, whose diabetes has continued to worsen and may need specialist input. I'm keeping an eye on the rest.",
  )
})

test('briefing stays at most two sentences for one or zero items', () => {
  assert.equal(briefingText(buildBriefing([])), "Nothing needs you right now. I'm keeping an eye on things and will tell you if that changes.")
  const one = build({ clarifications: [] })
  assert.equal(briefingText(buildBriefing(one.needs)), "One thing needs you today. It's Tonjit Askarov, whose diabetes has continued to worsen and may need specialist input. I'm keeping an eye on the rest.")
})

test('Dashboard renders greeting, agent status, briefing, Needs you, then While you were away -- in that order', () => {
  const dashboard = slice(home, 'export function AgentDashboard', '/* --------------------------------------------------------------- For you */')
  const order = ["timeAwareGreeting('Lucy')", 'className="agent-status"', 'className="agent-brief"', '>Needs you</h2>', 'While you were away']
  const positions = order.map((token) => dashboard.indexOf(token))
  assert.ok(positions.every((position) => position > 0), `missing one of ${order.join(', ')}`)
  assert.deepEqual(positions, [...positions].sort((a, b) => a - b))
  assert.ok(dashboard.includes('See what I did'))
  assert.ok(home.includes("'Reviewing new referrals and network updates…'"))
  assert.ok(home.includes('`Checking ${leadFirstName}\'s referral readiness…`'))
  assert.ok(home.includes(`"All caught up. I'll keep watching."`))
})

/* ------------------------------------------------------------- Needs you */

test('Dashboard Needs you shows only the top few, with Tonjit leading', () => {
  const queue = build({ records: [record(JORDAN_ID, 'Nephrology', 'Dr. Iain Jung', LAST_WEEK, 1), record(MARIA_ID, 'Gastroenterology', 'Dr. A', LAST_WEEK, 2)], clarifications: [clarification, { ...clarification, id: 'clar-2' }] })
  assert.equal(queue.needs.length, 4)
  const top = dashboardNeeds(queue)
  assert.equal(top.length, DASHBOARD_NEEDS_LIMIT)
  assert.equal(top[0].patientId, TONJIT_ID)
  assert.equal(top[0].title, 'Tonjit Askarov')
  assert.equal(top[0].detail, 'Worsening type 2 diabetes despite medication escalation')
  assert.equal(top[0].action, 'Review')
  assert.ok(home.includes('See {hidden} more in For you →'))
})

test('the agent\'s missing physician-specific knowledge surfaces as a Needs-you item that opens the existing clarification', () => {
  const item = build().needs.find((entry) => entry.kind === 'clarification')
  assert.ok(item)
  assert.equal(item.action, 'Answer')
  assert.equal(item.path, '/agent?tab=train&focus=clar-1')
  assert.match(item.detail, /can't answer this for you without your input/)
  assert.ok(home.includes('clarificationFocusPath(trainingPath(\'lucy\'), id)'), 'reuses the existing clarification deep link')
})

test('Tonjit\'s Review routes to the existing Patient Detail used today', () => {
  const tonjit = build().needs[0]
  assert.equal(tonjit.path, `/patients/${TONJIT_ID}`)
  assert.ok(home.includes('onClick={() => navigate(item.path)}'))
  assert.ok(app.includes('if (patientId === JORDAN_ID || patientId === MARIA_ID || patientId === TONJIT_ID) return <PatientWorkspace patientId={patientId} navigate={navigate} />'))
})

/* --------------------------------------------------------------- For you */

test('For you has Needs you, Later and Done today sections over the same queue', () => {
  const forYou = slice(home, 'export function ForYouPage', '/* ------------------------------------------------------- Ask your agent */')
  for (const label of ['aria-label="Needs you"', 'aria-label="Later"', 'aria-label="Done today"']) assert.ok(forYou.includes(label), label)
  assert.ok(forYou.includes('const { needs, later, done } = queue'))
  assert.ok(forYou.includes("Everything I can't or shouldn't finish without you."))
  assert.ok(app.includes("if (path === '/for-you') return <ForYouRoute navigate={navigate} />"))
})

test('not-yet-consulted cases and physician-deferred items go to Later, not Needs you', () => {
  const queue = build({ deferred: new Set(['clarification-clar-1']) })
  assert.deepEqual(queue.needs.map((item) => item.patientId), [TONJIT_ID])
  const later = queue.later.map((item) => item.id)
  assert.ok(later.includes('clarification-clar-1'))
  assert.ok(later.includes(`not-consulted-${JORDAN_ID}`))
  assert.ok(later.includes(`not-consulted-${MARIA_ID}`))
  assert.equal(queue.later.find((item) => item.id === 'clarification-clar-1').deferred, true)
})

test('conditional readiness: in-flight referrals are the agent\'s to watch; a returned consult or a blocked referral needs the physician', () => {
  const submitted = build({ referrals: new Map([[TONJIT_ID, referral(TONJIT_ID, 'submitted')]]) })
  assert.ok(!submitted.needs.some((item) => item.patientId === TONJIT_ID))
  assert.deepEqual(submitted.waiting.map((item) => item.patientId), [TONJIT_ID])
  assert.match(submitted.waiting[0].detail, /Waiting for Dr\. Noah Chen/)
  assert.deepEqual(submitted.done.map((item) => item.title), ["Sent Tonjit Askarov's referral to Dr. Noah Chen"])

  const blocked = build({ referrals: new Map([[TONJIT_ID, referral(TONJIT_ID, 'resolving', {
    requirement_results: [{ key: 'a1c', label: 'Recent HbA1c', required: true, status: 'missing_from_packet' }],
    coordination_events: [{ sequence: 4, event_type: 'physician_action_required', actor: 'referring_agent', autonomy: 'physician_required', summary: 'Needs physician', metadata: {}, created_at: TODAY }],
  })]]) })
  assert.equal(blocked.needs[0].kind, 'physician_action')
  assert.match(blocked.needs[0].detail, /recent hba1c/)

  const returned = build({ referrals: new Map([[TONJIT_ID, referral(TONJIT_ID, 'consult_returned')]]) })
  assert.equal(returned.needs[0].kind, 'returned_consult')
  const reviewed = build({ referrals: new Map([[TONJIT_ID, referral(TONJIT_ID, 'consult_returned')]]), handoffViewedAt: new Map([[TONJIT_ID, TODAY]]) })
  assert.ok(!reviewed.needs.some((item) => item.patientId === TONJIT_ID))
  assert.equal(reviewed.done.length, 1)
})

test('a completed network consult becomes a Review-options item for that patient', () => {
  const queue = build({ records: [record(JORDAN_ID, 'Nephrology', 'Dr. Iain Jung')] })
  const jordan = queue.needs.find((item) => item.patientId === JORDAN_ID)
  assert.equal(jordan.kind, 'review_options')
  assert.equal(jordan.detail, 'Network consult complete. Nephrology with Dr. Iain Jung looks like the best fit.')
})

/* ----------------------------------------------------- While you were away */

test('While you were away lists only work Lamina actually records, never email/calendar/EHR actions', () => {
  const queue = build({
    records: [record(JORDAN_ID, 'Nephrology', 'Dr. Iain Jung')],
    referrals: new Map([[TONJIT_ID, referral(TONJIT_ID, 'submitted', { coordination_events: [
      { sequence: 1, event_type: 'packet_assembled', actor: 'referring_agent', autonomy: 'automatic', summary: 'Assembled the referral packet.', metadata: {}, created_at: TODAY },
      { sequence: 2, event_type: 'referral_submitted', actor: 'receiving_physician', autonomy: 'physician_required', summary: 'Not the agent.', metadata: {}, created_at: TODAY },
    ] })]]),
  })
  const texts = queue.log.map((entry) => entry.text)
  assert.ok(texts.includes('Tonjit Askarov: Assembled the referral packet'))
  assert.ok(texts.includes('Asked the physician network for specialty guidance on Jordan Lee'))
  assert.ok(!texts.some((text) => text.includes('Not the agent')), 'only automatic referring-agent events count as the agent handling something')
  for (const source of [home, queueSource, conversationSource]) {
    assert.doesNotMatch(source, /\b(emails?|inbox|calendar|newsletters?|filed|EHR filing|discharge summar)/i)
  }
})

/* ------------------------------------------------------ Ask your agent dock */

test('the docked agent conversation appears on Dashboard and For you only, so Patient Detail and the referral flow keep full width', () => {
  assert.ok(app.includes('<ProductShell navigate={navigate} section="home" agentDock>'))
  assert.ok(app.includes('<ProductShell navigate={navigate} section="for-you" agentDock>'))
  assert.equal((app.match(/ agentDock>/g) ?? []).length, 2)
  assert.ok(physicianShell().includes('{agentDock && <AgentDock navigate={navigate} />}'))
})

test('the dock opens and collapses like the reference: a full right column, or a pill in the corner; the choice is remembered', () => {
  const dock = slice(home, 'export function AgentDock', '/** Sidebar "For you" count')
  assert.ok(dock.includes('if (!open) return <aside className="agent-dock collapsed"'))
  assert.ok(dock.includes('aria-label="Open conversation with your agent"'))
  assert.ok(dock.includes('aria-label="Collapse conversation"'))
  assert.ok(dock.includes("window.localStorage.setItem(DOCK_KEY, next ? 'open' : 'collapsed')"))
  assert.ok(dock.includes("document.body.classList.toggle('agent-dock-open', open)"))
  assert.ok(home.includes("const DOCK_WIDE_QUERY = '(min-width: 1101px)'"), 'narrow screens start collapsed')
  assert.ok(styles.includes('body.agent-dock-open .physician-shell.has-agent-dock { padding-right: var(--dock-width, 380px); }'))
  assert.ok(styles.includes('.agent-dock.collapsed { top: auto; bottom: 20px; right: 20px;'))
})

test('suggested prompts come from the existing demo world', () => {
  assert.deepEqual(DOCK_SUGGESTED_PROMPTS, [
    'What did you handle while I was away?',
    'What needs my attention today?',
    'How is Tonjit doing?',
    'What are you waiting on?',
    'What have you learned about my practice?',
  ])
})

test('workspace questions are answered from the same queue the page shows; anything else goes to the existing agent chat', () => {
  const queue = build({ referrals: new Map([[MARIA_ID, referral(MARIA_ID, 'accepted')]]) })
  const snapshot = { queue, overview: { portrait_confirmed_facts: ['Wants nephrology input before changing a renal regimen.'], recent_learnings: [], learning_opportunities: [clarification] }, patients: LUCY_PATIENTS }
  const tonjit = answerWorkspaceQuestion('How is Tonjit doing?', snapshot)
  assert.equal(tonjit.link.path, `/patients/${TONJIT_ID}`)
  assert.match(tonjit.paragraphs.join(' '), /Worsening type 2 diabetes/)
  assert.equal(tonjit.paragraphs[1], 'Tonjit Askarov, whose diabetes has continued to worsen and may need specialist input.', 'the reason is not repeated twice')
  const attention = answerWorkspaceQuestion('What needs my attention today?', snapshot)
  assert.match(attention.paragraphs[0], /^Two things need you today/)
  const waiting = answerWorkspaceQuestion('What are you waiting on?', snapshot)
  assert.deepEqual(waiting.bullets, ['Maria Santos: Dr. Noah Chen accepted. Waiting on scheduling.'])
  const learned = answerWorkspaceQuestion('What have you learned about my practice?', snapshot)
  assert.deepEqual(learned.bullets, ['Wants nephrology input before changing a renal regimen.'])
  assert.equal(answerWorkspaceQuestion('How do you usually manage resistant hypertension?', snapshot), null)
  assert.ok(home.includes("chatWithAgent('lucy', { mode: 'practice_question', message: trimmed, origin: 'practice' })"))
})
