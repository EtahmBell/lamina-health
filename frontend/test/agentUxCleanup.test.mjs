/* My Agent + Network UX cleanup pass: shared form typography, editable
 * confirmed learnings, Overview semantics, and Ask the Network result cards. */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'

const read = (path) => readFileSync(new URL(path, import.meta.url), 'utf8').replaceAll(String.fromCharCode(13), '')
const engagement = read('../src/Engagement.tsx')
const networkQuery = read('../src/NetworkQuery.tsx')
const preferences = read('../src/ReferralPreferences.tsx')
const api = read('../src/api.ts')
const styles = read('../src/styles.css')
const slice = (source, from, to) => source.slice(source.indexOf(from), to === undefined ? undefined : source.indexOf(to, source.indexOf(from)))
const train = () => slice(engagement, 'export function TrainTab', '/* ------------------------------------------------------------------ My Agent: Chat */')
const overview = () => slice(engagement, 'export function AgentOverviewPanel', 'export type AgentActivityRow')

/* ---------------------------------------------------------------- typography 1-4 */

test('Train, clarification, and edit textareas share the exact Ask the Network typography rule', () => {
  const rule = slice(styles, '.ask-network-card textarea, .ask-network-card select,\n.referral-preference-section textarea.lamina-textarea', '}')
  for (const selector of ['.ask-network-card textarea', '.referral-preference-section textarea.lamina-textarea', '.post-flow-dialog textarea.lamina-textarea', 'textarea.lamina-textarea']) {
    assert.ok(rule.includes(selector), selector)
  }
  assert.match(rule, /font-family: var\(--font-ui\); font-size: \.74rem; line-height: 1\.5; font-weight: 400/)
})

test('the shared rule out-ranks the `font: inherit` rules that caused the mismatch', () => {
  // .referral-preference-section textarea / .post-flow-dialog textarea are (0,1,1);
  // the shared selectors add the .lamina-textarea class, making them (0,2,1).
  assert.match(styles, /\.referral-preference-section textarea \{[^}]*font: inherit/)
  assert.match(styles, /\.post-flow-dialog input, \.post-flow-dialog textarea \{[^}]*font: inherit/)
  assert.ok(styles.indexOf('.referral-preference-section textarea.lamina-textarea') > styles.indexOf('.referral-preference-section textarea {'))
})

test('placeholders inherit the same font', () => {
  assert.match(styles, /\.lamina-textarea::placeholder, \.ask-network-card textarea::placeholder, \.chat-composer input::placeholder \{ font: inherit;/)
})

test('every learning textarea uses the shared class', () => {
  assert.match(preferences, /className="lamina-textarea"/)
  for (const fn of ['function ClarificationAnswerFlow', 'function EditLearningModal', 'function CorrectionComposer']) {
    const start = engagement.indexOf(fn)
    const body = engagement.slice(start, engagement.indexOf('\nfunction ', start + fn.length))
    assert.match(body, /className="lamina-textarea"/, fn)
  }
})

/* --------------------------------------------------------- learning history 5-10 */

test('Learning History lists only real preference artifacts; only the confirmed version is editable', () => {
  const fn = train()
  assert.match(fn, /\{item\.status === 'confirmed' && <button type="button" className="text-button train-history-edit" onClick=\{\(\) => setEditingPreferenceId\(item\.id\)\}>Edit →<\/button>\}/)
  const historySection = slice(fn, 'id="train-history">Learning history', '{personaId && <details className="train-internal-tools">')
  assert.doesNotMatch(historySection, /Structured questions|sessions\.map/)
})

test('question-bank sessions live under Internal demo tooling, not physician Learning History', () => {
  const tooling = slice(train(), '<details className="train-internal-tools">', '</details>')
  assert.match(tooling, /Question-bank sessions/)
  assert.match(tooling, /sessions\.map/)
})

test('Edit runs the existing interpreter as a revision draft and requires confirmation', () => {
  const modal = slice(engagement, 'function EditLearningModal', '/** Physicians whose agent has a receiving-physician representation')
  assert.match(modal, /interpretReferralPreference\(personaId, text\.trim\(\), undefined, preference\.id\)/)
  assert.match(modal, /<PreferenceDraftReview/)
  assert.doesNotMatch(modal, /confirmReferralPreference/)
  assert.match(modal, /Your agent keeps using this version until you confirm an edit\./)
  assert.match(modal, /The previous version is kept in your learning history\./)
  assert.match(modal, /<ModalPortal>/)
  assert.match(modal, /if \(event\.key === 'Escape' && !busy\) onClose\(\)/)
  assert.match(api, /\.\.\.\(revises \? \{ revises \} : \{\}\)/)
})

/* ------------------------------------------------------------------ overview 11-15 */

test('Overview has no Practice Rules section, and rules are placed into structured sections', () => {
  assert.doesNotMatch(engagement, /Practice rules<\/h3>|practice-section-rules/)
  const practice = slice(engagement, 'export function PracticeTab', '/* ----------------------------------------------------------------- My Agent: Train */')
  assert.match(practice, /const fitGood = \[\.\.\.new Set\(\[\.\.\.goodFit, \.\.\.ruleGoodFit\]\)\]/)
  assert.match(practice, /Care pathway/)
})

test('What your agent learned this week renders backend representation learnings, each with Review / Edit', () => {
  const fn = overview()
  assert.match(fn, /\(overview\.recent_learnings \?\? \[\]\)\.map\(\(learning\) =>/)
  assert.match(fn, /onClick=\{\(\) => setEditingPreferenceId\(learning\.preference_id\)\}>Review \/ Edit →/)
  assert.doesNotMatch(fn, /renal|Tonjit/i)
})

test('Overview orders network activity, then learning, then the durable representation', () => {
  const fn = overview()
  const network = fn.indexOf('<NetworkActivityList')
  const learned = fn.indexOf('What your agent learned this week')
  const representation = fn.indexOf('How your agent currently represents your practice')
  assert.ok(network > -1 && network < learned && learned < representation)
})

test('network activity shows real coordination and labels the synthetic fixture', () => {
  const list = slice(engagement, 'function NetworkActivityList', 'const patientsPathFor')
  assert.match(list, /Recent activity/)
  assert.match(list, /\{item\.synthetic_fixture && <small className="network-activity-synthetic">Synthetic demo activity<\/small>\}/)
  assert.match(list, />View coordination →</)
  assert.match(list, />View activity →</)
})

/* ------------------------------------------------------------ ask the network 19-26 */

test('Ask the Network result cards render WHY THIS MATCH as labeled reasons, not bullet walls', () => {
  const card = slice(networkQuery, 'function PhysicianAgentResultCard', 'export function AskNetworkCard')
  assert.match(card, /Why this match/)
  assert.match(card, /<span className="ask-network-reason-label">\{reason\.label\}<\/span>/)
  assert.match(card, /<span className="ask-network-reason-detail">\{reason\.detail\}<\/span>/)
  assert.match(card, /'Strong match' : 'Relevant match'/)
  assert.doesNotMatch(card, /className="ask-network-reasons"/)
  assert.doesNotMatch(card, /score|\/100/i)
})

test('the generic Relevant network updates block is gone; grounding appears only inside a physician result', () => {
  assert.doesNotMatch(networkQuery, /Relevant network updates|result\.broadcasts\.map/)
  assert.match(networkQuery, /Grounded in “\{post\.title\}”/)
})

test('Ask agent is neutral and only offered for physicians with a Lamina agent persona', () => {
  const card = slice(networkQuery, 'function PhysicianAgentResultCard', 'export function AskNetworkCard')
  assert.match(card, /\{personaId && <button type="button" className="text-button" onClick=\{\(\) => onAskAgent\(match\)\}>Ask agent →<\/button>\}/)
  assert.doesNotMatch(networkQuery, /Ask her|Ask his|her\/his/)
})

test('result card text uses Lamina font tokens', () => {
  assert.match(styles, /\.ask-network-agent-name \{[^}]*font-family: var\(--font-display\)/)
  for (const cls of ['.ask-network-agent-specialty', '.ask-network-strength', '.ask-network-grounding']) {
    assert.match(styles, new RegExp(`\\${cls} \\{[^}]*font-family: var\\(--font-ui\\)`), cls)
  }
})

/* ------------------------------------------------------------------------- NLP 27 */

test('proactive teaching stays optional and empty by default', () => {
  assert.match(train(), /intro="Optional\./)
  assert.match(preferences, /const \[sourceText, setSourceText\] = useState\(''\)/)
})
