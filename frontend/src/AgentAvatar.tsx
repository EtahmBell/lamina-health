export type AgentAvatarTone = 'blue' | 'blue-light' | 'copper' | 'copper-light'

/** A simplified, agent-specific identity mark -- distinct from the Lamina network
 * logo (connected orbs). One solid-color orb per agent with a dark outline and a
 * small white smiley tucked toward the upper-left, per design_references/
 * agent_profile_picture_example.png. `tone` is fill-only (the dark outline stays
 * constant) and picks from four restrained Lamina-palette variants -- e.g. the
 * Feed assigns a different tone per agent-authored post so several agents
 * reading in one stream stay visually distinct without any of them going loud.
 * Dr. Lucy Saruhashi's own agent identity stays the default 'blue'. */
export function AgentAvatar({ tone = 'blue' }: { tone?: AgentAvatarTone }) {
  return <span className={`agent-avatar agent-avatar-${tone}`} aria-hidden="true">
    <svg viewBox="0 0 32 32" width="100%" height="100%" preserveAspectRatio="xMidYMid meet">
      <circle cx="16" cy="16" r="14.4" fill="currentColor" stroke="var(--text-primary)" strokeWidth="2.2" />
      <circle cx="10.8" cy="11" r="1.9" fill="#fff" />
      <circle cx="15.6" cy="11" r="1.9" fill="#fff" />
      <path d="M9.6 15.6c1.7 2.2 5.7 2.2 7.4 0" stroke="#fff" strokeWidth="1.5" strokeLinecap="round" fill="none" />
    </svg>
  </span>
}
