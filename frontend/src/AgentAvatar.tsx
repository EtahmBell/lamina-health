/** A simplified, agent-specific identity mark -- distinct from the Lamina network
 * logo (connected orbs). One solid-color orb per agent with a dark outline and a
 * small white smiley tucked toward the upper-left, per design_references/
 * agent_profile_picture_example.png. `tone` lets a future second demo agent use a
 * different palette color (fill only -- the dark outline stays constant). */
export function AgentAvatar({ tone = 'blue' }: { tone?: 'blue' }) {
  return <span className={`agent-avatar agent-avatar-${tone}`} aria-hidden="true">
    <svg viewBox="0 0 32 32" width="100%" height="100%" preserveAspectRatio="xMidYMid meet">
      <circle cx="16" cy="16" r="14.4" fill="currentColor" stroke="var(--text-primary)" strokeWidth="2.2" />
      <circle cx="11.2" cy="11.6" r="2.1" fill="#fff" />
      <circle cx="16.6" cy="10" r="2.1" fill="#fff" />
      <path d="M9.8 15.2c1.7 2 5.4 2 7.1 0" stroke="#fff" strokeWidth="1.6" strokeLinecap="round" fill="none" />
    </svg>
  </span>
}
