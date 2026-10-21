/**
 * Active physician-agent network pass (Part H-U): Ask the Network, the
 * Ask Their Agent drawer, Colleagues row actions, and Feed-focus
 * navigation. No new top-level navigation item, no Feed redesign.
 */

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'

const api = readFileSync(new URL('../src/api.ts', import.meta.url), 'utf8')
const networkQuery = readFileSync(new URL('../src/NetworkQuery.tsx', import.meta.url), 'utf8')
const physicianNetwork = readFileSync(new URL('../src/PhysicianNetwork.tsx', import.meta.url), 'utf8')
const engagement = readFileSync(new URL('../src/Engagement.tsx', import.meta.url), 'utf8')
const app = readFileSync(new URL('../src/App.tsx', import.meta.url), 'utf8')

const slice = (source, from, to) => source.slice(source.indexOf(from), source.indexOf(to))

test('the API client calls one narrow, structured Ask the Network endpoint -- never an arbitrary prose response', () => {
  assert.match(api, /export const askNetwork = \(question: string, patientId\?: string\) => request<AskNetworkResult>\('\/api\/workspace\/network\/ask'/)
  assert.match(api, /physician_agents: NetworkPhysicianAgentMatch\[\]/)
  assert.match(api, /broadcasts: NetworkBroadcastMatch\[\]/)
  assert.match(api, /routing: NetworkRoutingEvidence \| null/)
})

test('Ask the Network never invents a magic numeric physician score', () => {
  assert.doesNotMatch(networkQuery, /score|Score/, 'no physician-score concept anywhere in this surface')
})

test('patient context is optional and explicitly scoped -- "None" by default, with the purpose-bound disclosure only once a patient is selected', () => {
  assert.match(networkQuery, /<option value="">None<\/option>/)
  assert.match(networkQuery, /Only information relevant to this question is used to consult physician agents\./)
})

test('a physician-agent result offers Ask their agent and View profile, never a dead/fabricated action', () => {
  const card = slice(networkQuery, 'function PhysicianAgentResultCard', 'function BroadcastResultCard')
  assert.match(card, /onClick=\{\(\) => onAskAgent\(match\)\}>Ask her\/his agent/)
  assert.match(card, /onClick=\{\(\) => navigate\(networkProfilePath\('lucy', personaId\)\)\}>View profile/)
})

test('a broadcast result offers View in Feed, grounded in a real post id', () => {
  const card = slice(networkQuery, 'function BroadcastResultCard', 'export function AskNetworkCard')
  assert.match(card, /onClick=\{\(\) => onViewInFeed\(broadcast\.post_id\)\}>View in Feed/)
})

test('Ask Their Agent reuses a right-side drawer, never navigating away from the page', () => {
  const modal = slice(engagement, 'export function NetworkAskAgentModal', 'return <ModalPortal>')
  assert.match(engagement, /className="post-flow-overlay drawer-overlay"/)
  assert.match(engagement, /className="post-flow-dialog network-ask-agent-dialog drawer-dialog"/)
})

test('the drawer shows a restrained "Grounded in" list and never hidden chain-of-thought', () => {
  const modal = slice(engagement, 'export function NetworkAskAgentModal', 'export function NetworkPhysicianProfilePage')
  assert.match(modal, /groundedIn && groundedIn\.length > 0/)
  assert.match(modal, /<p className="section-label">Grounded in<\/p>/)
  assert.doesNotMatch(engagement, /chain.of.thought|reasoning_trace|scratchpad/i)
})

test('Colleagues keeps its existing layout and gains a restrained right rail, never a giant hero banner', () => {
  const tab = slice(physicianNetwork, 'export function MyNetworkTab', 'function PhysicianProfilePage')
  assert.match(tab, /<div className="network-colleagues-layout">/)
  assert.match(tab, /<ActiveNetworkRail navigate=\{navigate\} onViewInFeed=\{/)
  // The existing hero/suggestions/roster content is still rendered, not replaced.
  assert.match(tab, /<NetworkHero onAdd=\{/)
  assert.match(tab, /Most connected in your network/)
})

test('"View in Feed" switches the Network tab to Feed and clears focus after use, never a separate detail route', () => {
  const page = slice(app, 'function LucyNetworkPage', 'function HomePage')
  assert.match(page, /const viewInFeed = \(postId: string\) => \{ setFocusPostId\(postId\); selectTab\('feed'\) \}/)
  assert.doesNotMatch(app, /function FeedPostDetailPage|\/feed\/:postId/)
})

test('the focused Feed post gets a one-shot subtle highlight, scrolled into view, then normal Feed behavior resumes', () => {
  const feedTab = slice(engagement, 'export function NetworkFeedTab', 'function questionSource')
  assert.match(feedTab, /scrollIntoView\(\{ behavior: 'smooth', block: 'center' \}\)/)
  assert.match(feedTab, /window\.setTimeout\(\(\) => onFocused\?\.\(\), 2600\)/)
  assert.match(feedTab, /focused=\{item\.id === focusPostId\}/)
})

test('no new top-level navigation item was introduced for this pass', () => {
  const navItemsBlock = slice(app, 'const navItems = [', ']')
  assert.doesNotMatch(navItemsBlock, /ask-the-network|Ask the Network/i)
})
