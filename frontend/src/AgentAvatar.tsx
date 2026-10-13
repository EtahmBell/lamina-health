import type { PhysicianIdentity } from './api.ts'

export type AgentAvatarTone = 'blue' | 'blue-light' | 'copper' | 'copper-light'

/** The one canonical physician-agent identity mark, used everywhere a
 * physician's agent appears (sidebar anchor, My Agent hero, chat rails, feed
 * posts, "Ask Dr. X's Agent"). A single solid-color circle (dark outline,
 * `tone` sets the fill) with a simple white-line smiley face -- the same
 * face geometry across every physician's agent, never a bespoke character
 * per physician. Background color is the only thing that varies, and it
 * varies by role (see `agentTone`), not by whim. */
export function AgentAvatar({ tone = 'blue' }: { tone?: AgentAvatarTone }) {
  return <span className={`agent-avatar agent-avatar-${tone}`} aria-hidden="true">
    <svg viewBox="0 0 32 32" width="100%" height="100%" preserveAspectRatio="xMidYMid meet">
      <circle cx="16" cy="16" r="14.4" fill="currentColor" stroke="var(--text-primary)" strokeWidth="2.2" />
      <circle cx="11.5" cy="13.5" r="1.7" fill="#fff" />
      <circle cx="20.5" cy="13.5" r="1.7" fill="#fff" />
      <path d="M10.5 19.5c2.2 2.4 8.8 2.4 11 0" stroke="#fff" strokeWidth="1.8" strokeLinecap="round" fill="none" />
    </svg>
  </span>
}

/** A coherent two-family mapping, not a bespoke color per physician: Lucy
 * (the PCP) and a real signed-in owner's own agent use the blue/mineral
 * family; every specialist/receiving-side persona -- Iain, Chen, and any
 * future one -- uses copper. Physicians appearing in a shared feed/chat
 * context alongside several *other* physicians (see Engagement.tsx's
 * toneForAgent) are a separate concern and keep their own hash-based
 * rotation across the same four tones. */
export function agentTone(personaId: PhysicianIdentity): AgentAvatarTone {
  return personaId === 'lucy' || personaId === 'owner' ? 'blue' : 'copper'
}
