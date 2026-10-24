/* Chat UX polish pass: every agent chat surface shows a typing indicator in
 * the slot its answer replaces, keeps it at least briefly, brings the active
 * exchange into view (container-aware), and respects manual scrolling. */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { FollowState, MIN_TYPING_MS, revealDelta, scrollBehaviorFor, withMinimumTyping } from '../src/chatFollow.ts'

const read = (path) => readFileSync(new URL(path, import.meta.url), 'utf8').replaceAll(String.fromCharCode(13), '')
const engagement = read('../src/Engagement.tsx')
const referral = read('../src/Referral.tsx')
const agentChat = read('../src/agentChat.tsx')
const slice = (source, from, to) => source.slice(source.indexOf(from), to === undefined ? undefined : source.indexOf(to, source.indexOf(from)))
const chatTab = () => slice(engagement, 'export function ChatTab', 'const agentPracticePath')
const drawer = () => slice(engagement, 'export function NetworkAskAgentModal', 'export function NetworkPhysicianProfilePage')
const episodeChat = () => slice(referral, 'export function CoordinationChatCard', '/* ============================================================ RECEIVING SIDE')

/* ---------------------------------------------------------- behavior (pure) */

test('a fast answer keeps the typing state for the minimum beat; a slow one is never delayed further', async () => {
  assert.ok(MIN_TYPING_MS >= 250 && MIN_TYPING_MS <= 500)
  let start = performance.now()
  assert.equal(await withMinimumTyping(Promise.resolve('fast'), 60), 'fast')
  assert.ok(performance.now() - start >= 55)
  start = performance.now()
  const slow = new Promise((resolve) => setTimeout(() => resolve('slow'), 120))
  assert.equal(await withMinimumTyping(slow, 60), 'slow')
  assert.ok(performance.now() - start < 120 + 50, 'the minimum runs alongside the request, not after it')
})

test('a failed request rejects immediately, so the typing state can never outlive an error', async () => {
  const start = performance.now()
  await assert.rejects(withMinimumTyping(Promise.reject(new Error('down')), 400), /down/)
  assert.ok(performance.now() - start < 200)
})

test('reveal scrolls just enough, and the beginning of a tall answer wins', () => {
  assert.equal(revealDelta(200, 300, 76, 800), 0, 'already visible')
  assert.equal(revealDelta(700, 900, 76, 800), 112, 'scroll down just enough to show the bottom')
  assert.equal(revealDelta(700, 2000, 76, 800), 612, 'too tall: align its top under the sticky header')
  assert.equal(revealDelta(20, 120, 76, 800), -68, 'above the view: scroll up to it')
})

test('sending always follows; an answer follows unless the physician scrolled up while waiting', () => {
  const follow = new FollowState()
  assert.equal(follow.begin(), true)
  assert.equal(follow.complete(), true, 'near the conversation: reveal the answer')
  follow.begin()
  follow.manualScrollUp()
  assert.equal(follow.complete(), false, 'scrolled up during generation: keep their position')
  follow.manualScrollUp() // not pending -- reading history is never "fighting" a response
  assert.equal(follow.begin(), true, 'a new send follows again')
})

test('reduced motion scrolls immediately instead of animating', () => {
  assert.equal(scrollBehaviorFor(true), 'auto')
  assert.equal(scrollBehaviorFor(false), 'smooth')
  assert.match(agentChat, /scrollBehaviorFor\(prefersReducedMotion\(\)\)/)
})

/* ------------------------------------------------- shared typing indicator */

test('the typing indicator carries the agent identity and announces "is responding" without reading the dots', () => {
  const indicator = slice(agentChat, 'export function AgentTypingIndicator', 'const prefersReducedMotion')
  assert.match(indicator, /<span className="chat-agent-label"><AgentAvatar tone=\{tone\} \/> \{agentName\}<\/span>/)
  assert.match(indicator, /role="status" aria-label=\{`\$\{agentName\} is responding`\}/)
  assert.equal((indicator.match(/<span aria-hidden="true" \/>/g) ?? []).length, 3)
})

test('the reveal is container-aware and never moves the page behind a fixed drawer', () => {
  const reveal = slice(agentChat, 'export function revealElements', 'const MANUAL_SCROLL_UP_KEYS')
  assert.match(reveal, /const container = scrollParent\(elements\[0\]\)/)
  assert.match(reveal, /container\.scrollBy\(\{ top: delta, behavior \}\)/)
  assert.match(reveal, /if \(inFixedLayer\(container\)\) return/)
  assert.doesNotMatch(agentChat, /document\.body\.scrollHeight|scrollTo\(0, document/)
  assert.match(agentChat, /const MANUAL_SCROLL_UP_KEYS = new Set\(\['ArrowUp', 'PageUp', 'Home'\]\)/)
  assert.match(agentChat, /if \(event\.deltaY < 0\) scrolledUp\(\)/)
})

/* ------------------------------------------------------------- surfaces */

for (const [label, source, threadAttr] of [
  ['My Agent Test', chatTab, 'ref={threadRef}'],
  ['Network Ask Agent drawer', drawer, 'ref={threadRef}'],
  ['Recent Specialty Care Ask Agent', episodeChat, 'ref={threadRef}'],
]) {
  test(`${label}: send appends the question AND a pending agent message, then follows`, () => {
    const fn = source()
    assert.match(fn, /const pendingId = /)
    assert.match(fn, /pending: true/)
    assert.match(fn, /follow\.begin\(\)/)
    assert.ok(fn.includes(threadAttr))
  })

  test(`${label}: the answer replaces the SAME pending message in place, and errors remove it`, () => {
    const fn = source()
    assert.match(fn, /await withMinimumTyping\(/)
    assert.match(fn, /prev\.map\(\(item\) => \(item\.id === pendingId \?/)
    assert.match(fn, /follow\.complete\(\)/)
    assert.match(fn, /prev\.filter\(\(item\) => item\.id !== pendingId\)/)
    assert.match(fn, /follow\.fail\(\)/)
    assert.doesNotMatch(fn, /\{busy && <div className="chat-message agent typing">/, 'no separate typing bubble appended after the list')
  })
}

test('My Agent Test: the pending bubble renders the typing indicator under the same React key the answer keeps', () => {
  assert.match(engagement, /if \(message\.pending\) return <AgentTypingIndicator agentName=\{agentName\} tone=\{tone\} \/>/)
  assert.match(chatTab(), /\{ id: response\.response_id, key: pendingId, role: 'agent'/)
  assert.match(chatTab(), /<ChatMessageBubble key=\{message\.key \?\? message\.id\}/)
})

test('My Agent Test: feedback controls stay on the answer, and Test stays non-mutating', () => {
  const bubble = slice(engagement, 'function ChatMessageBubble', 'const VISIBLE_STARTER_PROMPT_COUNT')
  assert.match(bubble, /Does this reflect how you would practice\?/)
  assert.match(bubble, />Yes, that's right</)
  assert.match(bubble, />Not quite</)
  assert.match(bubble, /<CorrectionComposer personaId=\{personaId\} \/>/)
  assert.doesNotMatch(chatTab(), /confirmReferralPreference|interpretReferralPreference/)
})

test('StrictMode cannot leave a chat stuck typing: the cancellation flag resets on every mount', () => {
  for (const fn of [drawer(), episodeChat()]) {
    assert.match(fn, /useEffect\(\(\) => \{ cancelled\.current = false; return \(\) => \{ cancelled\.current = true \} \}, \[\]\)/)
  }
})

test('the drawer is its own scroll container inside a fixed overlay, so revealing never scrolls the Network page', () => {
  const styles = read('../src/styles.css')
  assert.match(styles, /\.post-flow-overlay \{ position: fixed;/)
  assert.match(styles, /\.post-flow-dialog \{[^}]*overflow-y: auto;/)
  assert.match(drawer(), /className="post-flow-overlay drawer-overlay"/)
})

test('a learning confirmed in Train refreshes the Overview representation too, not only the overview stats', () => {
  assert.match(referral, /onLearningChanged=\{\(\) => \{ getAgentOverview\('chen'\)\.then\(setOverview\)\.catch\(\(\) => \{\}\); getPracticeRepresentation\('chen'\)\.then\(setRepresentation\)\.catch\(\(\) => \{\}\) \}\}/)
})

test('the completed answer reveal includes the composer only when it scrolls with the thread', () => {
  assert.match(agentChat, /if \(composer && !scrollParentDiffers\(thread, composer\)\) targets\.push\(composer\)/)
  for (const fn of [chatTab(), drawer(), episodeChat()]) assert.match(fn, /useConversationFollow\(threadRef, composerRef\)/)
})
