import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'

const avatar = readFileSync(new URL('../src/AgentAvatar.tsx', import.meta.url), 'utf8')
const app = readFileSync(new URL('../src/App.tsx', import.meta.url), 'utf8')
const specialist = readFileSync(new URL('../src/Specialist.tsx', import.meta.url), 'utf8')
const referralSource = readFileSync(new URL('../src/Referral.tsx', import.meta.url), 'utf8')
const engagement = readFileSync(new URL('../src/Engagement.tsx', import.meta.url), 'utf8')
const styles = readFileSync(new URL('../src/styles.css', import.meta.url), 'utf8')

const slice = (source, from, to) => source.slice(source.indexOf(from), to !== undefined ? source.indexOf(to) : undefined)

/* ------------------------------------------------------- canonical face */

test('AgentAvatar\'s face is ported from the old "YouAvatar" geometry (Noah\'s current style) -- same eye/smile coordinates, now white-on-tone instead of currentColor-on-background', () => {
  assert.match(avatar, /<circle cx="11\.5" cy="13\.5" r="1\.7" fill="#fff" \/>/)
  assert.match(avatar, /<circle cx="20\.5" cy="13\.5" r="1\.7" fill="#fff" \/>/)
  assert.match(avatar, /<path d="M10\.5 19\.5c2\.2 2\.4 8\.8 2\.4 11 0" stroke="#fff" strokeWidth="1\.8" strokeLinecap="round" fill="none" \/>/)
})

test('the canonical face keeps the background-circle + dark-outline structure (so tone/background can vary while the face stays identical)', () => {
  assert.match(avatar, /<circle cx="16" cy="16" r="14\.4" fill="currentColor" stroke="var\(--text-primary\)" strokeWidth="2\.2" \/>/)
})

test('no legacy "YouAvatar" component or ".you-avatar" CSS remains anywhere -- one shared icon system, not two', () => {
  assert.doesNotMatch(app, /function YouAvatar/)
  assert.doesNotMatch(app, /<YouAvatar/)
  assert.doesNotMatch(styles, /\.you-avatar/)
})

/* -------------------------------------------------------------- tone mapping */

test('agentTone() is a coherent two-family mapping, not a bespoke color per physician: lucy/owner -> blue, everyone else -> copper', () => {
  assert.match(avatar, /export function agentTone\(personaId: PhysicianIdentity\): AgentAvatarTone \{\s*\n\s*return personaId === 'lucy' \|\| personaId === 'owner' \? 'blue' : 'copper'\s*\n\s*\}/)
})

test('the blue and copper CSS tones were already Lamina-palette (mineral / agent-copper) and are unchanged', () => {
  assert.match(styles, /\.agent-avatar-blue \{ color: var\(--mineral\); \}/)
  assert.match(styles, /\.agent-avatar-copper \{ color: var\(--agent-copper\); \}/)
})

/* ------------------------------------------------------------ sidebar anchors */

test('Iain\'s and Chen\'s sidebar "My Agent" anchors now render the unified AgentAvatar with copper tone, not the old YouAvatar mark', () => {
  const shell = slice(app, 'function ProductShell', 'function LandingPage')
  assert.match(shell, /navigate\('\/specialist\/agent'\)[\s\S]{0,160}<AgentAvatar tone=\{agentTone\('iain'\)\} \/>/)
  assert.match(shell, /navigate\('\/chen\/agent'\)[\s\S]{0,160}<AgentAvatar tone=\{agentTone\('chen'\)\} \/>/)
})

test('Lucy\'s own sidebar "My Agent" anchor is unchanged (still the default AgentAvatar, implicitly blue)', () => {
  const shell = slice(app, 'function ProductShell', 'function LandingPage')
  assert.match(shell, /navigate\('\/agent\?tab=overview'\)[\s\S]{0,160}<AgentAvatar \/>/)
})

/* ---------------------------------------------------------- My Agent hero */

test('Iain\'s My Agent hero now uses the unified copper AgentAvatar instead of the generic NetworkMark logo', () => {
  const hero = slice(specialist, 'export function SpecialistAgentPage', specialist.length)
  assert.match(hero, /<div className="agent-hero-mark"><AgentAvatar tone=\{agentTone\('iain'\)\} \/><\/div>/)
})

test('Chen\'s My Agent hero now uses the unified copper AgentAvatar instead of the generic LaminaMark logo', () => {
  const hero = slice(referralSource, 'export function ChenAgentPage', 'export function ChenNetworkPage')
  assert.match(hero, /<div className="agent-hero-mark"><AgentAvatar tone=\{agentTone\('chen'\)\} \/><\/div>/)
})

test('Lucy\'s My Agent hero is unchanged', () => {
  assert.match(app, /<section className="agent-hero"><div className="agent-hero-mark"><AgentAvatar \/><\/div>/)
})

/* -------------------------------------------------------------------- Test tab */

test('the My Agent Test tab derives its own-agent avatar tone from personaId -- Chen\'s/Iain\'s chat bubble is copper, not hardcoded blue', () => {
  const chatTab = slice(engagement, 'export function ChatTab', engagement.length)
  assert.match(chatTab, /const tone = agentTone\(personaId\)/)
  assert.match(chatTab, /<ChatMessageBubble key=\{message\.key \?\? message\.id\} message=\{message\} agentName=\{agentName\} tone=\{tone\}/)
  // The typing indicator is rendered by the bubble itself with the same tone.
  assert.match(engagement, /if \(message\.pending\) return <AgentTypingIndicator agentName=\{agentName\} tone=\{tone\} \/>/)
})

test('ChatMessageBubble accepts and renders the passed-in tone, never its own hardcoded default', () => {
  const bubble = slice(engagement, 'function ChatMessageBubble', 'export function ChatTab')
  assert.match(bubble, /tone: AgentAvatarTone/)
  assert.match(bubble, /<AgentAvatar tone=\{tone\} \/>/)
})

/* -------------------------------------------------------- identity consistency */

test('Dr. Iain Jung\'s agent-authored feed post is now copper, matching his own sidebar/My Agent tone -- no more mismatched blue', () => {
  assert.doesNotMatch(engagement, /name: "Dr\. Iain Jung's Agent"[\s\S]{0,400}agentTone: 'blue'/)
  assert.match(engagement, /representedPhysicianName: 'Dr\. Iain Jung', agentTone: 'copper'/)
})

test('the hash-based toneForAgent rotation (for feed/chat-rail contexts showing many different physicians at once) is untouched -- a separate, already-coherent mechanism', () => {
  assert.match(engagement, /const CHAT_AVATAR_TONES: AgentAvatarTone\[\] = \['blue', 'copper-light', 'blue-light', 'copper'\]/)
  assert.match(engagement, /function toneForAgent\(id: string\): AgentAvatarTone/)
})

/* ---------------------------------------------- unrelated avatars untouched */

test('physician identity (initials-circle) avatars are untouched -- this pass only changed agent icons', () => {
  assert.match(app, /className="clinician-avatar large"/)
  assert.match(engagement, /className="directory-avatar large"/)
})
