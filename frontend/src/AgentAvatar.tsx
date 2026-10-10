/** A simplified, agent-specific identity mark -- distinct from the Lamina network
 * logo (connected orbs). One solid-color orb per agent, with a small asymmetric
 * face tucked toward the upper-left, reading as "one node with a presence" rather
 * than a literal portrait photo. `tone` lets a future second demo agent use a
 * different palette color without a second component. */
export function AgentAvatar({ tone = 'blue' }: { tone?: 'blue' }) {
  return <span className={`agent-avatar agent-avatar-${tone}`} aria-hidden="true">
    <svg viewBox="0 0 32 32" width="100%" height="100%">
      <circle cx="16" cy="16" r="16" fill="currentColor" />
      <circle cx="11" cy="11.5" r="1.6" fill="#fff" />
      <circle cx="16.4" cy="9.8" r="1.6" fill="#fff" />
      <path d="M9 15c1.8 2.1 6.4 2.1 8.2 0" stroke="#fff" strokeWidth="1.4" strokeLinecap="round" fill="none" />
    </svg>
  </span>
}
