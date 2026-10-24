/** Chat UX polish pass: the framework-free half of shared agent-chat
 * behavior (see agentChat.tsx for the React pieces) -- the minimum typing
 * beat, container-aware reveal geometry, and the follow/manual-scroll state
 * machine. Plain functions so they can be tested directly. */

/** A synthetic/offline answer can arrive within a frame; holding the typing
 * state this long makes the hand-off perceptible. Never added on top of a
 * slower real response (the timer runs alongside the request), and a failed
 * request rejects immediately. */
export const MIN_TYPING_MS = 350

export async function withMinimumTyping<T>(request: Promise<T>, minimumMs = MIN_TYPING_MS): Promise<T> {
  const [result] = await Promise.all([request, new Promise((resolve) => setTimeout(resolve, minimumMs))])
  return result
}

/** The smallest scroll that shows [top, bottom] inside [viewTop, viewBottom]
 * -- when it cannot all fit, the TOP wins (the beginning of the answer). */
export function revealDelta(top: number, bottom: number, viewTop: number, viewBottom: number, margin = 12): number {
  if (top < viewTop + margin) return top - viewTop - margin
  if (bottom > viewBottom - margin) return Math.min(bottom - viewBottom + margin, top - viewTop - margin)
  return 0
}

/** Immediate scrolling when the physician asked for reduced motion. */
export const scrollBehaviorFor = (reducedMotion: boolean): ScrollBehavior => (reducedMotion ? 'auto' : 'smooth')

/** Whether to bring the conversation into view. Sending always does (the
 * physician just acted); an answer arriving does only if the physician did
 * not deliberately scroll up while waiting -- then their position is kept. */
export class FollowState {
  private pending = false
  private following = true

  /** Sending a message: reveal the question + typing indicator. */
  begin(): boolean {
    this.pending = true
    this.following = true
    return true
  }

  /** Wheel-up / touch / scroll-up keys while an answer is pending. */
  manualScrollUp(): void {
    if (this.pending) this.following = false
  }

  /** The answer replaced the typing indicator: reveal it? */
  complete(): boolean {
    this.pending = false
    return this.following
  }

  /** The request failed: the indicator is gone, nothing to follow. */
  fail(): void {
    this.pending = false
  }
}
