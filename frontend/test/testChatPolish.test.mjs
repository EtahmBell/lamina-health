/* Test chat + proposed-learning polish pass: the interpretation is the
 * proposal's content (not a "We interpreted this as" headline), and My
 * Agent -> Test is a bounded chat panel whose case questions always carry
 * their synthetic case. */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { CASE_QUESTION, caseRefOf, caseSwitchEvent, turnRequest } from '../src/testChatTurns.ts'

const read = (path) => readFileSync(new URL(path, import.meta.url), 'utf8').replaceAll(String.fromCharCode(13), '')
const preferences = read('../src/ReferralPreferences.tsx')
const engagement = read('../src/Engagement.tsx')
const agentChat = read('../src/agentChat.tsx')
const styles = read('../src/styles.css')
const slice = (source, from, to) => source.slice(source.indexOf(from), to === undefined ? undefined : source.indexOf(to, source.indexOf(from)))
const review = () => slice(preferences, 'export function PreferenceDraftReview', '/** Placeholder and example')
const chatTab = () => slice(engagement, 'export function ChatTab', 'const agentPracticePath')
const bubble = () => slice(engagement, 'function ChatMessageBubble', 'const VISIBLE_STARTER_PROMPT_COUNT')

const FOCUSED = { id: 'chen-focused', title: 'Focused diabetes medication question', facts: ['61-year-old with type 2 diabetes', 'Recent HbA1c available'], intended_domain: 'type_2_diabetes' }
const THYROID = { id: 'chen-thyroid', title: 'Suspected endocrine condition, diagnosis not yet confirmed', facts: ['Abnormal thyroid studies'], intended_domain: 'thyroid' }

/* ------------------------------------------------- PROPOSED LEARNING 1-7 */

test('"We interpreted this as" is no longer rendered at all, let alone as the heading', () => {
  assert.doesNotMatch(review(), /<h3>We interpreted this as<\/h3>/)
  assert.doesNotMatch(review().replace(/\/\/.*$/gm, ''), />\s*We interpreted this as/)
  assert.doesNotMatch(review(), /<h[1-6]/, 'no headline element competes with the interpretation')
})

test('the case family, guidance type, and interpreted items carry the hierarchy; the status stays a quiet eyebrow', () => {
  const card = review()
  assert.match(card, /<p className=\{`eyebrow referral-pref-status-\$\{draft\.status\}`\}>\{draft\.status === 'draft' \? 'Proposed learning · not yet operational'/)
  assert.match(card, /<p className="referral-pref-case-family">\{CASE_FAMILY_LABELS\[draft\.case_family\]\}<\/p>/)
  assert.match(card, /<ReadOnlyInterpretation rules=\{added\} \/>/)
  assert.match(preferences, /<p className="section-label">Helpful when available<\/p>/)
  assert.match(preferences, /<RequirementRow key=\{item\.key\} item=\{item\} \/>/)
  assert.match(styles, /\.referral-pref-case-family \{[^}]*text-transform: uppercase;/)
  assert.match(styles, /\.referral-pref-review-card \.referral-pref-interpretation \.referral-pref-group > \.section-label \{[^}]*text-transform: none;/)
  assert.match(styles, /\.referral-pref-review-card \.referral-pref-interpretation \.referral-pref-requirement-row \{[^}]*font-size: \.8rem;/)
})

test('Looks right / Edit interpretation / Start over are unchanged', () => {
  const card = review()
  assert.match(card, /\{!nothingToConfirm && <button type="button" className="button-primary" disabled=\{busy\} onClick=\{\(\) => void confirm\(\)\}>Looks right<\/button>\}/)
  assert.match(card, /onClick=\{\(\) => setEditing\(true\)\}>Edit interpretation<\/button>/)
  assert.match(card, /onClick=\{\(\) => void startOver\(\)\}>Start over<\/button>/)
})

test('the family\'s existing guidance is shown as staying in place when there is any', () => {
  assert.match(review(), /<span>Your existing guidance stays in place:<\/span> \{existingLabels\.join\(' · '\)\}/)
  assert.match(preferences, /const existingLabels = \[/)
})

/* ---------------------------------------------- CASE CONTEXT (behavior) 13-18 */

test('a case question is bound to the active case id and carries a compact case reference', () => {
  const request = turnRequest(CASE_QUESTION, FOCUSED)
  assert.equal(request.mode, 'synthetic_case')
  assert.equal(request.controlled_test_case_id, 'chen-focused')
  assert.deepEqual(request.caseRef, { id: 'chen-focused', title: 'Focused diabetes medication question', domain: 'type_2_diabetes' })
})

test('a general practice question inherits no case context, even while a case is active', () => {
  const request = turnRequest('What have you learned about how I practice?', null)
  assert.equal(request.mode, 'practice_question')
  assert.equal(request.caseRef, undefined)
  assert.ok(!('controlled_test_case_id' in request))
  // In the component, general prompts and typed questions always pass null.
  assert.match(chatTab(), /void send\(prompt, null\)/)
  assert.match(chatTab(), /void send\(input, null\)/)
})

test('switching cases adds a context event; re-asking about the active case does not', () => {
  const first = caseSwitchEvent(null, FOCUSED, 'e1')
  assert.equal(first.role, 'case')
  assert.equal(first.text, FOCUSED.title)
  assert.deepEqual(first.caseFacts, FOCUSED.facts)
  assert.equal(caseSwitchEvent('chen-focused', FOCUSED, 'e2'), null)
  const switched = caseSwitchEvent('chen-focused', THYROID, 'e3')
  assert.deepEqual(switched.caseRef, caseRefOf(THYROID))
})

test('the transcript keeps every earlier turn: new turns are only ever appended', () => {
  const send = slice(chatTab(), 'const send = async', 'const selectCase')
  assert.match(send, /setMessages\(\(prev\) => \[\.\.\.prev,\s*\n\s*\.\.\.\(contextEvent \? \[contextEvent\] : \[\]\),/)
  assert.doesNotMatch(chatTab(), /setMessages\(\[\]\)/, 'selecting a case never clears the conversation')
  assert.match(chatTab(), /const event = caseSwitchEvent\(activeCase\?\.id \?\? null, testCase, `case-\$\{crypto\.randomUUID\(\)\}`\)\s*\n\s*setActiveCase\(testCase\)\s*\n\s*void send\(CASE_QUESTION, testCase, event\)/)
})

test('the request sent for a case question is the selected case\'s id', () => {
  assert.match(chatTab(), /\.\.\.\(request\.mode === 'synthetic_case' \? \{ controlled_test_case_id: request\.controlled_test_case_id \} : \{\}\)/)
  assert.match(chatTab(), /onClick=\{\(\) => void send\(CASE_QUESTION, activeCase\)\}/)
})

test('user turns show their case reference; switches render as an explicit "New synthetic case" event', () => {
  assert.match(bubble(), /\{message\.caseRef && <span className="chat-case-ref" aria-label=\{`About synthetic case: \$\{message\.caseRef\.title\}`\}>Regarding: \{message\.caseRef\.title\}<\/span>\}/)
  assert.match(bubble(), /<p className="chat-case-event-divider"><span>New synthetic case<\/span><\/p>/)
})

/* -------------------------------------------------- BOUNDED PANEL 8-12, 19-26 */

test('Test is a bounded, viewport-aware chat panel with an internally scrolling transcript', () => {
  assert.match(styles, /\.test-chat-panel \{ display: flex; flex-direction: column; height: clamp\(340px, calc\(100vh - 440px\), 720px\);[^}]*overflow: hidden;/)
  assert.match(styles, /\.chat-thread\.test-chat-history \{ flex: 1 1 auto; min-height: 0;[^}]*overflow-y: auto;/)
  assert.match(styles, /@media \(max-width: 960px\) \{\s*\n\s*\.test-chat-panel \{ height: clamp\(420px, 72vh, 640px\); \}/)
  assert.doesNotMatch(slice(styles, '.test-chat-panel {', '}'), /position: fixed/)
})

test('the panel is header / scrolling history / footer, with the prompts and composer inside the panel', () => {
  const panel = slice(chatTab(), '<section className="test-chat-panel"', '</section>')
  const header = panel.indexOf('<header className="test-chat-active-case">')
  const history = panel.indexOf('<div className="chat-thread test-chat-history" role="log" aria-live="polite" aria-label="Conversation" ref={threadRef}>')
  const footer = panel.indexOf('<footer className="test-chat-footer">')
  assert.ok(header > -1 && history > header && footer > history)
  const footerBlock = panel.slice(footer)
  assert.match(footerBlock, /<div className="chat-starter-prompts">/)
  assert.match(footerBlock, /<form className="chat-composer"/)
  assert.doesNotMatch(chatTab(), /\{messages\.length > 0 && <div className="chat-thread"/, 'the history container always exists inside the panel')
})

test('the typing indicator renders inside the history container and is replaced in place', () => {
  const panel = slice(chatTab(), '<div className="chat-thread test-chat-history"', '</div>')
  assert.match(panel, /<ChatMessageBubble key=\{message\.key \?\? message\.id\}/)
  assert.match(bubble(), /if \(message\.pending\) return <AgentTypingIndicator agentName=\{agentName\} tone=\{tone\} \/>/)
  assert.match(chatTab(), /prev\.map\(\(item\) => \(item\.id === pendingId \? \{ id: response\.response_id, key: pendingId/)
})

test('following targets the transcript element only -- never the page', () => {
  assert.match(chatTab(), /useConversationFollow\(threadRef, undefined, \{ containWithinThread: true \}\)/)
  assert.match(agentChat, /revealElements\(targets, scrollBehaviorFor\(prefersReducedMotion\(\)\), containWithinThread \? thread : null\)/)
  const contained = slice(agentChat, '  if (within) {', '    return\n  }')
  assert.match(contained, /within\.scrollBy\(\{ top: delta, behavior \}\)/)
  assert.doesNotMatch(contained, /window\./)
})

test('manual scroll-up inside the transcript is respected (wheel/touch/keys anywhere stop following)', () => {
  assert.match(agentChat, /if \(event\.deltaY < 0\) scrolledUp\(\)/)
  assert.match(agentChat, /const complete = useCallback\(\(\) => \{ if \(state\.current\.complete\(\)\) revealLast\(1, true\) \}/)
})

test('feedback controls live inside each agent response bubble', () => {
  const agent = slice(bubble(), "return <div className=\"chat-message agent\">", '\n}')
  assert.match(agent, /Does this reflect how you would practice\?/)
  assert.match(agent, /Yes, that's right/)
  assert.match(agent, /Not quite/)
})

test('the active case is identifiable without color: header title, "Active case" tag, and aria-pressed', () => {
  assert.match(chatTab(), /<span className="section-label">Active synthetic case<\/span>\s*\n\s*<strong>\{activeCase\.title\}<\/strong>/)
  assert.match(chatTab(), /aria-pressed=\{activeCase\?\.id === item\.id\}/)
  assert.match(chatTab(), /\{activeCase\?\.id === item\.id && <em className="chat-case-panel-active">Active case<\/em>\}/)
  assert.match(chatTab(), /<summary>View details<\/summary>/)
})

test('Test stays non-mutating', () => {
  assert.doesNotMatch(chatTab(), /confirmReferralPreference|interpretReferralPreference|createReferral/)
})
