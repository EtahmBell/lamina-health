import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'

const app = readFileSync(new URL('../src/App.tsx', import.meta.url), 'utf8')
const engagement = readFileSync(new URL('../src/Engagement.tsx', import.meta.url), 'utf8')
const specialist = readFileSync(new URL('../src/Specialist.tsx', import.meta.url), 'utf8')
const network = readFileSync(new URL('../src/PhysicianNetwork.tsx', import.meta.url), 'utf8')
const styles = readFileSync(new URL('../src/styles.css', import.meta.url), 'utf8')
const slice = (source, from, to) => source.slice(source.indexOf(from), source.indexOf(to))

const routing = () => slice(app, 'export default function App', app.length)
const trainingPageFn = () => slice(engagement, 'export function TrainingPage', '/* ------------------------------------------------------------- Profile: shared */')
const profilePageFn = () => slice(engagement, 'export function ProfessionalProfilePage', 'export function NetworkPhysicianProfilePage')
const homePageFn = () => slice(app, 'function HomePage', 'function PatientSelector')
const myAgentPageFn = () => slice(app, 'function MyAgentPage', 'function DemoResetControl')

/* ------------------------------------------------------------------- nav */

test('unified navigation: Lucy nav now reads Cases instead of Consultations', () => {
  assert.match(app, /id: 'consultations', title: 'Cases', icon: '◫', path: '\/consultations'/)
})

test('specialist nav now matches the unified physician app, including Profile as a 6th item (Pass 5B)', () => {
  const navBlock = slice(app, 'const SPECIALIST_NAV_ITEMS', 'function ProfileControl')
  assert.deepEqual(navBlock.match(/title: '[^']+'/g), ["title: 'Home'", "title: 'Patients'", "title: 'Cases'", "title: 'My Agent'", "title: 'Physician Network'", "title: 'Profile'"])
})

/* --------------------------------------------------------------- routing */

test('training routes exist for both personas, wrapped in the shared shell with nav intact', () => {
  const dispatch = routing()
  assert.match(dispatch, /path === '\/agent\/train'/)
  assert.match(dispatch, /personaId="lucy" agentName=\{PCP_AGENT_NAME\}/)
  assert.match(dispatch, /path === '\/specialist\/agent\/train'/)
  assert.match(dispatch, /personaId="iain" agentName=\{SPECIALIST_AGENT_NAME\}/)
})

test('professional profile routes exist for both personas', () => {
  const dispatch = routing()
  assert.match(dispatch, /path === '\/profile\/professional'/)
  assert.match(dispatch, /path === '\/specialist\/profile'/)
})

test('specialist patients page is an honest empty state, not a fabricated panel', () => {
  const dispatch = routing()
  assert.match(dispatch, /path === '\/specialist\/patients'/)
  assert.match(specialist, /No patient panel connected in this specialist demo/)
  assert.match(specialist, /Cases where your agent participates appear under Cases\./)
})

test('specialist network page is derived from the feed, never Lucy\'s private roster endpoint', () => {
  const dispatch = routing()
  assert.match(dispatch, /path === '\/specialist\/network'/)
  const networkPage = slice(specialist, 'export function SpecialistNetworkPage', specialist.length)
  assert.match(networkPage, /getNetworkFeed\('iain'\)/)
  assert.doesNotMatch(networkPage, /getAgentNetwork/)
})

/* ---------------------------------------------------------------- training */

test('training never auto-answers: it starts a real session (with mode) and reads unanswered questions from it', () => {
  const page = trainingPageFn()
  assert.match(page, /startTrainingSession\(personaId, \{ mode: modeParam \}\)/)
  assert.match(page, /const remaining = \(started\.questions \?\? \[\]\)\.filter\(\(item\) => !answeredIds\.has\(item\.id\)\)/)
})

test('each answer is persisted via the canonical response endpoint before advancing', () => {
  const page = trainingPageFn()
  assert.match(page, /await answerTrainingQuestion\(personaId, session\.id, current\.id, skipped \? \{ skipped: true \} : \{ answer: answer \?\? undefined \}\)/)
})

test('skip is always available and distinct from answering', () => {
  const page = trainingPageFn()
  assert.match(page, /onClick=\{\(\) => submit\(null, true\)\}>Skip</)
})

test('desktop keyboard support: left arrow = No, right arrow = Yes, down arrow = Depends only when it exists', () => {
  const page = trainingPageFn()
  assert.match(page, /event\.key === 'ArrowLeft'\) void submit\('No', false\)/)
  assert.match(page, /event\.key === 'ArrowRight'\) void submit\('Yes', false\)/)
  assert.match(page, /event\.key === 'ArrowDown' && current\.question_type === 'yes_no_depends'\) void submit\('Depends', false\)/)
})

test('keyboard hints are subtle, not prominent, and every choice has a real button equivalent', () => {
  const page = trainingPageFn()
  assert.match(page, /className="training-keyboard-hint"/)
  assert.match(page, /<button className="training-choice no"/)
  assert.match(page, /<button className="training-choice yes"/)
  assert.match(page, /<button className="training-choice depends"/)
})

test('card transition respects reduced motion', () => {
  const page = trainingPageFn()
  assert.match(page, /const calm = prefersReducedMotion\(\)/)
  assert.ok(styles.includes('@media (prefers-reduced-motion: reduce) { .training-card { transition: none; }'))
})

test('no gamified mechanics in the training surface', () => {
  assert.doesNotMatch(engagement, /streak|confetti|leaderboard|points earned|level up/i)
})

test('finishing a session never silently converts answers into truth: it calls finish and shows proposed learnings for explicit review', () => {
  const page = trainingPageFn()
  assert.match(page, /const result = await finishTrainingSession\(personaId, activeSession\.id\)/)
  assert.match(page, /setLearnings\(result\.proposed_learnings \?\? \[\]\)/)
  assert.match(page, /Training complete/)
  assert.match(page, /Review what your agent learned\./)
})

test('the session summary is grounded in actual answered-question counts, never a ranking or score claim', () => {
  const page = trainingPageFn()
  assert.match(page, /is better prepared to answer \{answeredCount\} referral question/)
  assert.doesNotMatch(engagement, /ranking increased|more discoverable|score improved|referral score/i)
})

test('question source labeling matches the four documented categories', () => {
  assert.match(engagement, /tag: 'From your network'/)
  assert.match(engagement, /tag: 'From a recent case'/)
  assert.match(engagement, /tag: 'Practice profile'/)
  assert.match(engagement, /tag: 'Referral guidance'/)
})

/* -------------------------------------------------------- improve-agent card */

test('Improve your agent never shows a referral score, ranking, or quality metric', () => {
  const card = slice(engagement, 'export function ImproveAgentCard', 'const FEED_TYPE_LABELS')
  assert.doesNotMatch(card, /score|ranking|quality/i)
  assert.match(card, /practice area/)
  assert.match(card, /question/)
})

test('Home (both personas) surfaces Improve your agent, including resume-session awareness', () => {
  assert.match(homePageFn(), /<ImproveAgentCard representation=\{representation\} queueSummary=\{queueSummary\} resumeSessionId=\{resumeSessionId\} navigate=\{navigate\} trainPath=\{trainingPath\('lucy'\)\} \/>/)
  const specialistHome = slice(specialist, 'export function SpecialistHomePage', '/* --------------------------------------------------------------------- Cases */')
  assert.match(specialistHome, /<ImproveAgentCard representation=\{representation\} queueSummary=\{queueSummary\} resumeSessionId=\{resumeSessionId\} navigate=\{navigate\} trainPath=\{trainingPath\('iain'\)\} \/>/)
})

/* -------------------------------------------------------------- My Agent */

test('My Agent gained a Train tab additively, preserving the existing four tabs and their deep links', () => {
  assert.match(app, /const AGENT_TABS = \['overview', 'knowledge', 'train', 'calibration', 'activity'\] as const/)
  assert.match(myAgentPageFn(), /learningParam = params\.get\('learning'\)/)
  assert.match(myAgentPageFn(), /recordParam = params\.get\('record'\)/)
})

test('Train tab previews unresolved questions and unconfirmed rules without duplicating the calibration UI', () => {
  const page = myAgentPageFn()
  const trainBlock = slice(page, "tab === 'train'", "tab === 'calibration'")
  assert.match(trainBlock, /train-tab-preview/)
  assert.doesNotMatch(trainBlock, /learning-actions/, 'the train tab links to calibration rather than re-implementing confirm/edit/reject')
})

/* ----------------------------------------------------------- profile editing */

test('profile items are saved through the canonical upsert endpoint with a client-generated id for new items', () => {
  const page = profilePageFn()
  assert.match(engagement, /onSave=\{\(fields\) => save\(`item-\$\{crypto\.randomUUID\(\)\}`, fields\)\}/)
  assert.match(engagement, /await updateProfessionalProfileItem\(personaId, itemId, \{ category, title: fields\.title, detail: fields\.detail \|\| undefined, shareable: fields\.shareable \}\)/)
  void page
})

test('profile distinguishes itself from My Agent referral preferences', () => {
  assert.match(engagement, /Your professional profile helps Lamina understand your background and expertise\. Explicit referral preferences are managed separately in My Agent\./)
})

test('profile completeness is framed as representation only, never a ranking score', () => {
  const page = profilePageFn()
  assert.match(page, /sections completed/)
  assert.doesNotMatch(page, /score|rank|top \d+%/i)
})

test('provenance is honest: never claims Verified for a synthetic demo item', () => {
  assert.doesNotMatch(engagement, /'Verified'/)
  assert.match(engagement, /'Added by you'/)
  assert.match(engagement, /'Synthetic demo profile'/)
})

/* --------------------------------------------------------- posts & updates */

test('agent-drafted posts are framed as a suggestion, not an autonomous post, and start as drafts', () => {
  assert.match(engagement, /post\.drafted_by === 'lamina_agent' && <span className="practice-update-agent-drafted">Drafted with your Lamina agent<\/span>/)
  assert.doesNotMatch(engagement, /[Yy]our agent posted/)
})

test('publishing is always an explicit physician action, never automatic', () => {
  assert.match(engagement, /await publishProfessionalPost\(personaId, Number\(post\.id\)\)/)
  assert.doesNotMatch(engagement, /publishProfessionalPost\([^)]*\)[\s\S]{0,40}useEffect/)
})

/* ------------------------------------------------------------- network feed */

test('the network feed renders chronologically and never computes its own popularity ordering', () => {
  const section = slice(engagement, 'export function NetworkFeedSection', '/* ---------------------------------------------------- Practice representation */')
  assert.doesNotMatch(section, /\.sort\(/, 'ordering comes from the backend (chronological_only), not a client-side re-sort')
})

test('feed cards offer professional actions only — no likes, comments, or follower counts', () => {
  const card = slice(engagement, 'function FeedCard', 'export function NetworkFeedSection')
  assert.match(card, /View profile/)
  assert.doesNotMatch(card, /like|heart|comment|follower|repost/i)
})

/* ------------------------------------------------------- Physician Network */

test('Lucy\'s physician directory links to a professional profile only for known engagement personas', () => {
  assert.match(network, /ENGAGEMENT_PERSONA_BY_NPI\[profile\.npi\] && <section className="professional-profile-link-card"/)
})

/* ------------------------------------------------------------ regression */

test('specialist review/calibration endpoints are untouched by the engagement additions', () => {
  assert.match(specialist, /markSpecialistCaseReviewed\(recordId\)/)
  assert.match(specialist, /updateSpecialistCalibration\(recordId, detail\.calibration\.key, action, statement\)/)
})

test('the PCP referral flow and demo perspectives remain exactly as before this pass', () => {
  assert.match(app, /Consult network for referral/)
  assert.doesNotMatch(app, /id: 'specialist' as const, name: SPECIALIST_NAME.*path: '\/specialist\/cases'/)
})
