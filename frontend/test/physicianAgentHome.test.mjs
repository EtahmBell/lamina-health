import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { answerWorkspaceQuestion, DOCK_SUGGESTED_PROMPTS } from '../src/agentConversation.ts'
import { CHEN_ID, JORDAN_ID, MARIA_ID, PCP_NAME, TONJIT_ID } from '../src/demoIdentity.ts'
import { DEMO_PATIENTS } from '../src/demoPatients.ts'
import { briefingText, buildBriefing, buildPhysicianQueue, buildSpecialistQueue, dashboardNeeds, DASHBOARD_NEEDS_LIMIT } from '../src/physicianQueue.ts'
import { CHEN_SEEDED_NEXT_STEPS, specialistNextSteps } from '../src/specialistWorklist.ts'

/* Physician-agent home pass: Dashboard / For you / docked agent conversation,
 * for the referring physician (Lucy) and the receiving specialist (Chen). */

const app = readFileSync(new URL('../src/App.tsx', import.meta.url), 'utf8')
const home = readFileSync(new URL('../src/AgentHome.tsx', import.meta.url), 'utf8')
const referralSource = readFileSync(new URL('../src/Referral.tsx', import.meta.url), 'utf8')
const queueSource = readFileSync(new URL('../src/physicianQueue.ts', import.meta.url), 'utf8')
const conversationSource = readFileSync(new URL('../src/agentConversation.ts', import.meta.url), 'utf8')
const styles = readFileSync(new URL('../src/styles.css', import.meta.url), 'utf8')
const slice = (source, from, to) => source.slice(source.indexOf(from), to ? source.indexOf(to) : undefined)
const physicianShell = () => slice(app, 'function PhysicianShell', 'function LandingPage')
const titles = (block) => block.match(/title: '[^']+'/g)

const LUCY_PATIENTS = DEMO_PATIENTS.filter((patient) => patient.implemented && patient.owner !== 'chen')
const NOW = new Date(2026, 10, 6, 14, 30)
const TODAY = new Date(2026, 10, 6, 10, 0).toISOString()
const LAST_WEEK = new Date(2026, 9, 28, 10, 0).toISOString()
const nameOf = (id) => DEMO_PATIENTS.find((patient) => patient.id === id)?.name ?? id

/* Lucy's seeded, still-unanswered practice-representation questions (the
 * backend's synthetic fixtures for a fresh demo workspace). */
const LUCY_SEEDED_QUESTIONS = [
  { id: 'lucy-progressive-ckd-routing', prompt: 'Does progressive CKD with resistant hypertension usually lead you to nephrology first?', priority: 70 },
  { id: 'lucy-ida-routing', prompt: 'For persistent iron deficiency without source evaluation, do you usually refer to gastroenterology first?', priority: 60 },
]
const clarification = { id: 'clar-1', case_family: 'renal', title: 'When you want nephrology before changing a renal regimen', body: '', clarifying_question: '', supporting_text: '' }
const record = (patientId, specialty, physician, completedAt = LAST_WEEK, id = 1) => ({
  id, patient_id: patientId, completed_at: completedAt,
  result: { recommended_physician: { physician_name: `${physician} (synthetic)`, specialty }, consultation: [], messages: [] },
})
const event = (sequence, event_type, actor, autonomy, summary, metadata = {}) => ({ sequence, event_type, actor, autonomy, summary, metadata, created_at: TODAY })
const referral = (patientId, status, extra = {}) => ({
  id: 7, patient_id: patientId, referring_physician_id: 'agent-lucy-saruhashi', receiving_physician_id: CHEN_ID,
  specialty: 'Endocrinology', referral_question: '', urgency: 'routine', priority: 'soon', modality: 'in_person', status,
  created_at: TODAY, updated_at: TODAY, packet: { items: [] }, receiving_requirements: [], requirement_results: [],
  coordination_events: [], previous_referral_id: null, ...extra,
})
const buildLucy = (overrides = {}) => buildPhysicianQueue({
  patients: LUCY_PATIENTS, records: [], referrals: new Map(), handoffViewedAt: new Map(),
  clarifications: [], clarificationPath: (id) => `/agent?tab=train&focus=${id}`,
  practiceQuestions: LUCY_SEEDED_QUESTIONS, practiceQuestionsPath: '/agent/train',
  deferred: new Set(), now: NOW, ...overrides,
})

/* Tonjit's referral exactly as Chen receives it after Lucy submits: Chen's
 * agent required recent renal function, Lucy's agent found and attached it. */
const tonjitSubmitted = (overrides = {}) => referral(TONJIT_ID, 'submitted', {
  receiving_requirements: [
    { key: 'recent_hba1c', label: 'Recent HbA1c', required: true, freshness_days: 180 },
    { key: 'recent_renal_function', label: 'Recent renal function', required: true, freshness_days: 180 },
  ],
  requirement_results: [
    { key: 'recent_hba1c', label: 'Recent HbA1c', required: true, status: 'satisfied' },
    { key: 'recent_renal_function', label: 'Recent renal function', required: true, status: 'satisfied' },
  ],
  coordination_events: [
    event(3, 'requirement_checked', 'receiving_agent', null, 'Checked the packet against Endocrinology requirements.'),
    event(4, 'information_requested', 'receiving_agent', null, 'Endocrinology requires recent renal function before review and it is not included in the referral packet.', { requirement: 'recent_renal_function' }),
    event(6, 'record_found', 'referring_agent', 'automatic', 'Found recent renal function in the patient record dated 2026-09-12.', { requirement: 'recent_renal_function' }),
    event(7, 'information_attached', 'referring_agent', 'automatic', 'Attached recent renal function to the referral packet.', { requirement: 'recent_renal_function' }),
    event(9, 'referral_submitted', 'referring_agent', 'physician_required', 'Referral submitted.'),
  ],
  ...overrides,
})
const buildChen = ({ incoming = [], accepted = [], careState = new Map(), referrals = [...incoming, ...accepted], deferred = new Set(), clarifications = [] } = {}) => buildSpecialistQueue({
  steps: specialistNextSteps(incoming, accepted, careState, NOW, PCP_NAME),
  referrals, careState, patientName: nameOf, patientPath: (id) => `/chen/patients/${id}`, referringName: PCP_NAME,
  clarifications, clarificationPath: (id) => `/chen/agent?tab=train&focus=${id}`,
  standingLog: [{ id: 'chen-auto-routed', time: '', text: 'Routed 3 routine requests automatically: 2 visits, 1 e-consult', path: '/chen/patients?highlight=x' }],
  deferred, now: NOW,
})

/* ================================================================ shell */

test('Lucy and Chen each get exactly the same five primary destinations, in order', () => {
  const five = ["title: 'Home'", "title: 'For you'", "title: 'Patients'", "title: 'Network'", "title: 'Your Agent'"]
  const lucy = slice(app, 'const navItems', 'const SPECIALIST_NAV_ITEMS')
  const chen = slice(app, 'const CHEN_NAV_ITEMS', 'const DEMO_PERSPECTIVES')
  assert.deepEqual(titles(lucy), five)
  assert.deepEqual(titles(chen), five)
  for (const path of ["path: '/for-you'", "path: '/agent?tab=overview'"]) assert.ok(lucy.includes(path), path)
  for (const path of ["path: '/chen/home'", "path: '/chen/for-you'", "path: '/chen/patients'", "path: '/chen/network'", "path: '/chen/agent?tab=overview'"]) assert.ok(chen.includes(path), path)
  assert.ok(physicianShell().includes('const items = perspective === \'chen\' ? CHEN_NAV_ITEMS : navItems'))
})

test('the For you nav item carries the live Needs-you count from that physician\'s own queue', () => {
  assert.ok(physicianShell().includes('const needsCount = useNeedsCount(persona)'))
  assert.ok(physicianShell().includes("item.id.endsWith('for-you') && needsCount > 0"))
  assert.ok(home.includes('return useWorkspaceSnapshot(persona).queue.needs.length'))
})

test('the physician account/profile control sits at the bottom-left of the sidebar, not in the top bar, for Lucy and Chen', () => {
  const shell = physicianShell()
  const navEnd = shell.indexOf('</nav>')
  const account = shell.indexOf('<PerspectiveSwitch navigate={navigate} perspective={perspective} placement="sidebar" />')
  assert.ok(navEnd > 0 && account > navEnd && account < shell.indexOf('</aside>'), 'account control follows the nav inside the sidebar')
  assert.ok(shell.includes('<header className="workspace-bar"><div className="workspace-bar-actions"><SyntheticStatus /></div></header>'))
  assert.ok(styles.includes('.sidebar-account .perspective-menu { top: auto; bottom: calc(100% + 8px);'), 'the account menu opens upward')
  assert.ok(app.includes("onClick={() => { setOpen(false); navigate(current.profilePath) }}>Profile</button>"), 'Profile stays reachable')
  assert.ok(app.includes("if (perspective === 'pcp' || perspective === 'chen') return <PhysicianShell"))
})

test('only the specialist (Iain) workspace keeps the older shell', () => {
  const shell = slice(app, 'function ProductShell', 'function PhysicianShell')
  assert.ok(shell.includes('const items = SPECIALIST_NAV_ITEMS'))
  assert.ok(shell.includes('<PerspectiveSwitch navigate={navigate} perspective={perspective} />'))
})

/* ======================================================== Lucy: briefing */

test('deterministic demo state, Lucy: exactly two things need her, Tonjit first, then the agent\'s open question about her practice', () => {
  const queue = buildLucy()
  assert.deepEqual(queue.needs.map((item) => item.id), [`attention-${TONJIT_ID}`, 'practice-questions'])
  assert.equal(
    briefingText(buildBriefing(queue.needs)),
    "Two things need you today. The most important is Tonjit Askarov, whose diabetes has continued to worsen and may need specialist input. I'm keeping an eye on the rest.",
  )
  const question = queue.needs[1]
  assert.equal(question.title, 'Two questions about how you practise')
  assert.equal(question.path, '/agent/train', 'answers in the existing Train flow')
  assert.match(question.detail, /^Does progressive CKD with resistant hypertension usually lead you to nephrology first\? I can't answer this for you/)
})

test('Lucy\'s practice questions come from her real practice representation, not a demo constant', () => {
  assert.ok(home.includes("getPracticeRepresentation('lucy')"))
  assert.ok(home.includes("(representation?.gaps.unanswered_questions ?? [])"))
  assert.ok(home.includes("practiceQuestionsPath: trainingPath('lucy')"))
  assert.ok(!home.includes('lucy-progressive-ckd-routing'))
})

test('briefing stays at most two sentences for one or zero items', () => {
  assert.equal(briefingText(buildBriefing([])), "Nothing needs you right now. I'm keeping an eye on things and will tell you if that changes.")
  const one = buildLucy({ practiceQuestions: [] })
  assert.equal(briefingText(buildBriefing(one.needs)), "One thing needs you today. It's Tonjit Askarov, whose diabetes has continued to worsen and may need specialist input. I'm keeping an eye on the rest.")
})

test('Dashboard renders greeting, agent status, briefing, Needs you, then While you were away -- in that order', () => {
  const dashboard = slice(home, 'export function AgentDashboard', '/* --------------------------------------------------------------- For you */')
  const order = ['timeAwareGreeting(config.firstName)', 'className="agent-status"', 'className="agent-brief"', '>Needs you</h2>', 'While you were away']
  const positions = order.map((token) => dashboard.indexOf(token))
  assert.ok(positions.every((position) => position > 0), `missing one of ${order.join(', ')}`)
  assert.deepEqual(positions, [...positions].sort((a, b) => a - b))
  assert.ok(dashboard.includes('See what I did'))
  assert.ok(home.includes("firstName: PCP_NAME.split(' ')[1]"), 'Good afternoon, Lucy.')
  assert.ok(home.includes("firstName: CHEN_NAME.split(' ')[1]"), 'Good afternoon, Noah.')
  assert.ok(home.includes("now: 'Reviewing new referrals and network updates…'"))
  assert.ok(home.includes('`Checking ${leadFirstName}\'s referral readiness…`'))
  assert.ok(home.includes(`const FINAL_STATUS = "All caught up. I'll keep watching."`))
})

/* ======================================================= Lucy: Needs you */

test('Dashboard Needs you shows only the top few, with Tonjit leading', () => {
  const queue = buildLucy({ records: [record(JORDAN_ID, 'Nephrology', 'Dr. Iain Jung', LAST_WEEK, 1), record(MARIA_ID, 'Gastroenterology', 'Dr. A', LAST_WEEK, 2)] })
  assert.equal(queue.needs.length, 4)
  const top = dashboardNeeds(queue)
  assert.equal(top.length, DASHBOARD_NEEDS_LIMIT)
  assert.equal(top[0].patientId, TONJIT_ID)
  assert.equal(top[0].detail, 'Worsening type 2 diabetes despite medication escalation')
  assert.equal(top[0].action, 'Review')
  assert.ok(home.includes('See {hidden} more in For you →'))
})

test('network-raised clarifications take precedence over seeded practice questions and open the existing clarification', () => {
  const item = buildLucy({ clarifications: [clarification] }).needs.find((entry) => entry.kind === 'clarification')
  assert.equal(item.path, '/agent?tab=train&focus=clar-1')
  assert.match(item.detail, /can't answer this for you without your input/)
})

test('Tonjit\'s Review on Lucy\'s Dashboard routes to the existing Patient Detail used today', () => {
  assert.equal(buildLucy().needs[0].path, `/patients/${TONJIT_ID}`)
  assert.ok(home.includes('else navigate(item.path)'))
  assert.ok(app.includes('if (patientId === JORDAN_ID || patientId === MARIA_ID || patientId === TONJIT_ID) return <PatientWorkspace patientId={patientId} navigate={navigate} />'))
})

/* ========================================================= Lucy: For you */

test('For you has Needs you, Later and Done today sections over the same queue, for both physicians', () => {
  const forYou = slice(home, 'export function ForYouPage', '/* ------------------------------------------------------- Ask your agent */')
  for (const label of ['aria-label="Needs you"', 'aria-label="Later"', 'aria-label="Done today"']) assert.ok(forYou.includes(label), label)
  assert.ok(forYou.includes('const { needs, later, done } = queue'))
  assert.ok(app.includes("if (path === '/for-you') return <ForYouRoute navigate={navigate} />"))
  assert.ok(app.includes(`if (path === '/chen/for-you') return <ProductShell navigate={navigate} section="chen-for-you" perspective="chen" agentDock><ForYouPage navigate={navigate} persona="chen" /></ProductShell>`))
})

test('not-yet-consulted cases and physician-deferred items go to Later, not Needs you', () => {
  const queue = buildLucy({ deferred: new Set(['practice-questions']) })
  assert.deepEqual(queue.needs.map((item) => item.patientId), [TONJIT_ID])
  const later = queue.later.map((item) => item.id)
  for (const id of ['practice-questions', `not-consulted-${JORDAN_ID}`, `not-consulted-${MARIA_ID}`]) assert.ok(later.includes(id), id)
})

test('conditional readiness for Lucy: in-flight referrals are the agent\'s to watch; a returned consult or blocked referral needs her', () => {
  const submitted = buildLucy({ referrals: new Map([[TONJIT_ID, tonjitSubmitted()]]) })
  assert.ok(!submitted.needs.some((item) => item.patientId === TONJIT_ID))
  assert.match(submitted.waiting[0].detail, /Waiting for Dr\. Noah Chen/)
  assert.deepEqual(submitted.done.map((item) => item.title), ["Sent Tonjit Askarov's referral to Dr. Noah Chen"])

  const blocked = buildLucy({ referrals: new Map([[TONJIT_ID, referral(TONJIT_ID, 'resolving', {
    requirement_results: [{ key: 'a1c', label: 'Recent HbA1c', required: true, status: 'missing_from_packet' }],
    coordination_events: [event(4, 'physician_action_required', 'referring_agent', 'physician_required', 'Needs physician')],
  })]]) })
  assert.equal(blocked.needs[0].kind, 'physician_action')

  const returned = buildLucy({ referrals: new Map([[TONJIT_ID, referral(TONJIT_ID, 'consult_returned')]]) })
  assert.equal(returned.needs[0].kind, 'returned_consult')
  const reviewed = buildLucy({ referrals: new Map([[TONJIT_ID, referral(TONJIT_ID, 'consult_returned')]]), handoffViewedAt: new Map([[TONJIT_ID, TODAY]]) })
  assert.ok(!reviewed.needs.some((item) => item.patientId === TONJIT_ID))
  assert.equal(reviewed.done.length, 1)
})

/* ================================================ Chen: Dashboard / For you */

test('deterministic demo state, Chen before any referral: nothing needs him -- his established panel is Later or the agent\'s', () => {
  const queue = buildChen()
  assert.equal(queue.needs.length, 0)
  assert.equal(briefingText(buildBriefing(queue.needs)), "Nothing needs you right now. I'm keeping an eye on things and will tell you if that changes.")
  const physicianSeeded = CHEN_SEEDED_NEXT_STEPS.filter((step) => step.physicianJudgment).map((step) => step.id)
  assert.deepEqual(queue.later.map((item) => item.id).sort(), [...physicianSeeded].sort())
  assert.equal(queue.waiting.length, CHEN_SEEDED_NEXT_STEPS.filter((step) => !step.physicianJudgment).length)
})

test('deterministic demo state, Chen after Lucy submits: exactly one thing needs him -- Tonjit, ready for review, with the renal result the agents attached', () => {
  const queue = buildChen({ incoming: [tonjitSubmitted()] })
  assert.equal(queue.needs.length, 1)
  const [tonjit] = queue.needs
  assert.equal(tonjit.title, 'Tonjit Askarov')
  assert.equal(tonjit.detail, 'Endocrinology referral · Ready for review')
  assert.equal(tonjit.action, 'Review')
  assert.equal(tonjit.kind, 'incoming_referral')
  assert.equal(tonjit.referralId, 7)
  assert.equal(
    briefingText(buildBriefing(queue.needs)),
    "One thing needs you. Tonjit Askarov's referral is ready for review; the required recent renal function was found and attached. I'm keeping an eye on the rest.",
  )
})

test('Chen\'s briefing wording comes from the real attached-requirement events, never a Tonjit-specific string', () => {
  const nothingAttached = buildChen({ incoming: [tonjitSubmitted({ coordination_events: [] })] })
  assert.equal(briefingText(buildBriefing(nothingAttached.needs)), "One thing needs you. Tonjit Askarov's referral is ready for review. I'm keeping an eye on the rest.")
  const missing = buildChen({ incoming: [tonjitSubmitted({ requirement_results: [{ key: 'recent_hba1c', label: 'Recent HbA1c', required: true, status: 'missing_from_packet' }] })] })
  assert.equal(missing.needs[0].detail, 'Endocrinology referral · Waiting on missing information')
  assert.doesNotMatch(queueSource, /TONJIT_ID|patient-t2dm-003|renal/i)
})

test('Tonjit appears in Chen\'s For you queue until he accepts it', () => {
  const queue = buildChen({ incoming: [tonjitSubmitted()] })
  assert.deepEqual(queue.needs.map((item) => item.patientId), [TONJIT_ID])
  assert.ok(queue.later.length > 0, 'his established patients remain visible in Later')
})

test('clicking Tonjit on Chen\'s Dashboard or For you opens the existing referral review, and accepting lands on his existing Patient Detail', () => {
  const opener = slice(home, 'function useOpenItem', 'function NeedRow')
  assert.ok(opener.includes("item.kind === 'incoming_referral' ? incoming.find((candidate) => candidate.id === item.referralId)"))
  assert.ok(opener.includes('if (referral) setReviewing(referral)'))
  assert.ok(opener.includes('<RequestReviewModal referral={reviewing} receivingPhysicianName={CHEN_NAME} onAccepted={handleAccepted} onClose={() => setReviewing(null)} />'))
  assert.match(opener, /markReferralJustAccepted\(updated\.patient_id\)\s*\n\s*void loadSnapshot\(persona\)\s*\n\s*navigate\(`\/chen\/patients\/\$\{updated\.patient_id\}`\)/)
  assert.ok(referralSource.includes('export function RequestReviewModal'), 'the same review modal Chen\'s Patients page uses')
  assert.ok(app.includes('chenPatientId === TONJIT_ID || (chenPatientId && CHEN_PATIENT_IDS.includes(chenPatientId))) return <PatientWorkspace patientId={chenPatientId} navigate={navigate} perspective="receiving" />'))
})

test('accepting the referral moves Tonjit out of Needs you, into Done today, and onto the agent\'s waiting list -- from the same referral data', () => {
  const accepted = tonjitSubmitted({ status: 'accepted', coordination_events: [...tonjitSubmitted().coordination_events, event(10, 'referral_accepted', 'receiving_physician', 'physician_required', 'Referral accepted.')] })
  const queue = buildChen({ accepted: [accepted] })
  assert.equal(queue.needs.length, 0)
  assert.deepEqual(queue.done.map((item) => item.title), ["Accepted Tonjit Askarov's referral"])
  assert.ok(queue.waiting.some((item) => item.patientId === TONJIT_ID && /Scheduling in progress/.test(item.detail)))
})

test('a drafted handoff brings Tonjit back to Chen\'s Needs you; sending it clears it and records it as done', () => {
  const scheduled = tonjitSubmitted({ status: 'scheduled' })
  const drafted = buildChen({ accepted: [scheduled], careState: new Map([[7, { encounter: { id: 1 }, handoff: { status: 'draft', drafted_at: TODAY, sent_at: null } }]]) })
  assert.equal(drafted.needs[0].kind, 'handoff_review')
  assert.match(drafted.needs[0].detail, /needs your approval before it goes to Dr\. Lucy Saruhashi/)
  const sent = buildChen({ accepted: [scheduled], careState: new Map([[7, { encounter: { id: 1 }, handoff: { status: 'sent', drafted_at: TODAY, sent_at: TODAY } }]]) })
  assert.equal(sent.needs.length, 0)
  assert.ok(sent.done.some((item) => item.title === "Sent Tonjit Askarov's consultation summary to Dr. Lucy Saruhashi"))
})

test('Chen\'s Dashboard and For you are the shared agent-first pages with his dock', () => {
  assert.ok(app.includes('<ProductShell navigate={navigate} section="chen-home" perspective="chen" agentDock><AgentDashboard navigate={navigate} persona="chen" /></ProductShell>'))
  assert.ok(!referralSource.includes('export function ChenHomePage'))
})

/* ===================================================== While you were away */

test('While you were away lists only work Lamina actually records, never email/calendar/EHR actions', () => {
  const lucy = buildLucy({
    records: [record(JORDAN_ID, 'Nephrology', 'Dr. Iain Jung')],
    referrals: new Map([[TONJIT_ID, tonjitSubmitted()]]),
  })
  const lucyTexts = lucy.log.map((entry) => entry.text)
  assert.ok(lucyTexts.includes('Tonjit Askarov: Attached recent renal function to the referral packet'))
  assert.ok(lucyTexts.includes('Asked the physician network for specialty guidance on Jordan Lee'))
  assert.ok(!lucyTexts.some((text) => text.includes('Referral submitted')), 'a physician action is never the agent handling something')

  const chen = buildChen({ incoming: [tonjitSubmitted()] })
  const chenTexts = chen.log.map((entry) => entry.text)
  assert.ok(chenTexts.includes('Tonjit Askarov: Endocrinology requires recent renal function before review and it is not included in the referral packet'))
  assert.equal(chenTexts.at(-1), 'Routed 3 routine requests automatically: 2 visits, 1 e-consult', 'standing synthetic context comes last, untimed')
  for (const source of [home, queueSource, conversationSource]) {
    assert.doesNotMatch(source, /\b(emails?|inbox|calendar|newsletters?|filed|EHR filing|discharge summar)/i)
  }
})

/* ====================================================== Ask your agent dock */

test('the docked agent conversation appears on Dashboard and For you only, so Patient Detail and the referral flow keep full width', () => {
  assert.equal((app.match(/ agentDock>/g) ?? []).length, 4, 'Lucy and Chen: Dashboard and For you')
  assert.ok(physicianShell().includes('{agentDock && <AgentDock navigate={navigate} persona={persona} />}'))
})

test('the dock opens and collapses like the reference: a full right column, or a pill in the corner; the choice is remembered', () => {
  const dock = slice(home, 'export function AgentDock')
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

const lucySnapshot = (queue) => ({ queue, overview: { portrait_confirmed_facts: ['Wants nephrology input before changing a renal regimen.'], recent_learnings: [], learning_opportunities: [] }, patients: LUCY_PATIENTS, patientPath: (id) => `/patients/${id}`, agentPath: '/agent?tab=overview' })

test('workspace questions are answered from the same queue the page shows; anything else goes to the existing agent chat', () => {
  const snapshot = lucySnapshot(buildLucy({ referrals: new Map([[MARIA_ID, referral(MARIA_ID, 'accepted')]]) }))
  const tonjit = answerWorkspaceQuestion('How is Tonjit doing?', snapshot)
  assert.equal(tonjit.link.path, `/patients/${TONJIT_ID}`)
  assert.equal(tonjit.paragraphs[1], 'Tonjit Askarov, whose diabetes has continued to worsen and may need specialist input.', 'the reason is not repeated twice')
  assert.match(answerWorkspaceQuestion('What needs my attention today?', snapshot).paragraphs[0], /^Two things need you today/)
  assert.deepEqual(answerWorkspaceQuestion('What are you waiting on?', snapshot).bullets, ['Maria Santos: Dr. Noah Chen accepted. Waiting on scheduling.'])
  assert.deepEqual(answerWorkspaceQuestion('What have you learned about my practice?', snapshot).bullets, ['Wants nephrology input before changing a renal regimen.'])
  assert.equal(answerWorkspaceQuestion('How do you usually manage resistant hypertension?', snapshot), null)
  assert.ok(home.includes("chatWithAgent(persona, { mode: 'practice_question', message: trimmed, origin: 'practice' })"))
})

test('Chen\'s agent answers about Tonjit only once Tonjit reaches him through a real referral, and links into his own patient page', () => {
  const chenPanel = DEMO_PATIENTS.filter((patient) => patient.owner === 'chen')
  const snapshot = (queue) => ({ queue, overview: null, patients: chenPanel, patientPath: (id) => `/chen/patients/${id}`, agentPath: '/chen/agent?tab=overview' })
  assert.equal(answerWorkspaceQuestion('How is Tonjit doing?', snapshot(buildChen())), null, 'with no referral, Tonjit is not his patient')
  assert.ok(home.includes('const knownPatients = [...config.patients, ...DEMO_PATIENTS.filter((patient) => queued.has(patient.id)'))
  const queue = buildChen({ incoming: [tonjitSubmitted()] })
  const withReferral = { ...snapshot(queue), patients: [...chenPanel, ...DEMO_PATIENTS.filter((patient) => patient.id === TONJIT_ID)] }
  const reply = answerWorkspaceQuestion('How is Tonjit doing?', withReferral)
  assert.equal(reply.link.path, `/chen/patients/${TONJIT_ID}`)
  assert.match(reply.paragraphs.join(' '), /Endocrinology referral · Ready for review/)
})

test('the sidebar count stays in step while the physician works inside Patient Detail, and the briefing highlight keeps a possessive attached to the name', () => {
  const counter = slice(home, 'const COUNT_REFRESH_MS', 'function BriefingLead')
  assert.ok(counter.includes("if (document.visibilityState === 'visible') void loadSnapshot(persona)"))
  assert.ok(home.includes(`const possessive = lead.rest.startsWith("'s") ? "'s" : ''`))
  assert.ok(home.includes('<span className="agent-ent">{lead.name}{possessive}</span>'))
})

test('visual polish: Home uses an SVG icon on the same grid, size and stroke as For you / Your Agent, and the selected nav item is Lamina blue-grey from existing tokens', () => {
  const icon = slice(app, 'function HomeNavIcon', '/** Inbox glyph')
  assert.ok(icon.includes('viewBox="0 0 18 18" width="17" height="17" fill="none" stroke="currentColor" strokeWidth="1.5"'))
  assert.ok(slice(app, 'function ForYouNavIcon', '/** Sparkle glyph').includes('viewBox="0 0 18 18" width="17" height="17" fill="none" stroke="currentColor" strokeWidth="1.5"'))
  assert.ok(!slice(app, 'const navItems', 'const SPECIALIST_NAV_ITEMS').includes("'⌂'"))
  assert.ok(!slice(app, 'const CHEN_NAV_ITEMS', 'const DEMO_PERSPECTIVES').includes("'⌂'"))
  assert.ok(styles.includes('.physician-shell .nav-icon { display: grid; place-items: center; width: 24px; height: 20px; flex: none; }'))
  assert.ok(styles.includes('.physician-shell .nav-item.active { border-color: rgb(83 110 125 / 22%); background: var(--sage-surface-strong); color: var(--mineral-deep); }'))
  assert.ok(home.includes('<main className="agent-home" aria-label="Home">'))
})

test('visual polish: Home / For you / agent panel accents use Lamina\'s mineral blue-grey tokens -- the same as .button-primary / .text-button -- never copper', () => {
  const block = styles.slice(styles.indexOf('Physician-agent home pass: Dashboard, For you'))
  assert.doesNotMatch(block, /agent-copper|var\(--accent|#f1dfd3|#f7ece5/, 'no copper left in the Home/agent styles')
  for (const rule of [
    '--agent-orb: var(--mineral); --agent-orb-halo: var(--sage-surface-strong); --agent-orb-halo-soft: var(--mineral-surface);',
    '.agent-btn.primary { background: var(--mineral-deep); border-color: var(--mineral-deep); color: #fffaf4; }',
    '.agent-btn.primary:hover { background: var(--mineral-deep-hover); border-color: var(--mineral-deep-hover); }',
    'font-size: 13px; color: var(--mineral-deep); font-weight: 500; text-decoration: underline;',
    'border: 0; border-radius: 7px; background: var(--mineral-deep); color: #fffaf4; cursor: pointer; }',
    '.agent-ent { background: var(--mineral-surface); color: var(--mineral-deep);',
  ]) assert.ok(block.includes(rule), rule)
  assert.match(styles, /\.consult-button, \.button-primary \{[^}]*background: var\(--mineral-deep\)/, 'matches the existing Lamina primary button')
})
