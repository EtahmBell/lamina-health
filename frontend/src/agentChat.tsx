/** Shared physician-agent chat behavior (chat UX polish pass): the one
 * typing indicator and "bring the active exchange into view" scrolling used
 * by every agent chat surface (My Agent -> Test, Ask an agent inside a
 * specialty-care episode, the Network Ask Agent drawer, the public-profile
 * preview rail). Each surface keeps its own messages; this module only
 * standardizes how a pending answer looks and how the conversation follows
 * it. Pure logic lives in chatFollow.ts. */

import { useCallback, useEffect, useRef, type RefObject } from 'react'
import { AgentAvatar, type AgentAvatarTone } from './AgentAvatar.tsx'
import { FollowState, revealDelta, scrollBehaviorFor } from './chatFollow.ts'

export { MIN_TYPING_MS, withMinimumTyping } from './chatFollow.ts'

/** The pending agent message -- rendered in the exact slot its answer will
 * replace, with the same identity treatment as a normal agent message. The
 * dots are decorative; the status label is what is announced. */
export function AgentTypingIndicator({ agentName, tone, className = 'chat-message agent typing' }: {
  agentName: string; tone: AgentAvatarTone; className?: string
}) {
  return <div className={className} data-agent-typing="true">
    <span className="chat-agent-label"><AgentAvatar tone={tone} /> {agentName}</span>
    <p className="chat-typing-dots" role="status" aria-label={`${agentName} is responding`}>
      <span aria-hidden="true" /><span aria-hidden="true" /><span aria-hidden="true" />
    </p>
  </div>
}

const prefersReducedMotion = () => window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false

/** Height of the sticky product header -- content revealed on the page must
 * clear it. */
const STICKY_HEADER_OFFSET = 76

function scrollParent(element: HTMLElement): HTMLElement | null {
  for (let node = element.parentElement; node && node !== document.body; node = node.parentElement) {
    const overflowY = getComputedStyle(node).overflowY
    if ((overflowY === 'auto' || overflowY === 'scroll') && node.scrollHeight > node.clientHeight) return node
  }
  return null
}

function inFixedLayer(element: HTMLElement): boolean {
  for (let node: HTMLElement | null = element; node; node = node.parentElement) {
    if (getComputedStyle(node).position === 'fixed') return true
  }
  return false
}

/** Container-aware reveal: scrolls the nearest scrolling ancestor first
 * (a chat thread with its own max-height, a drawer body), then -- unless
 * that container lives in a fixed overlay such as a drawer, whose page
 * behind must stay still -- nudges the page just enough to show it. Never
 * scrolls to the document end. */
export function revealElements(elements: HTMLElement[], behavior: ScrollBehavior): void {
  if (elements.length === 0) return
  const rects = elements.map((element) => element.getBoundingClientRect())
  const top = Math.min(...rects.map((rect) => rect.top))
  const bottom = Math.max(...rects.map((rect) => rect.bottom))
  const container = scrollParent(elements[0])
  if (container) {
    const box = container.getBoundingClientRect()
    const delta = revealDelta(top, bottom, box.top, box.bottom)
    if (delta) container.scrollBy({ top: delta, behavior })
    if (inFixedLayer(container)) return
    const outer = container.getBoundingClientRect()
    const pageDelta = revealDelta(outer.top, outer.bottom, STICKY_HEADER_OFFSET, window.innerHeight)
    if (pageDelta) window.scrollBy({ top: pageDelta, behavior })
    return
  }
  if (inFixedLayer(elements[0])) return
  const delta = revealDelta(top, bottom, STICKY_HEADER_OFFSET, window.innerHeight)
  if (delta) window.scrollBy({ top: delta, behavior })
}

/** A composer outside a thread's own scroll area (e.g. below a bounded
 * episode thread) is revealed with the page, not with the thread. */
function scrollParentDiffers(thread: HTMLElement, composer: HTMLElement): boolean {
  const first = thread.firstElementChild as HTMLElement | null
  return (first ? scrollParent(first) : null) !== scrollParent(composer)
}

const MANUAL_SCROLL_UP_KEYS = new Set(['ArrowUp', 'PageUp', 'Home'])
const REVEAL_AFTER_COMMIT_MS = 32

/** Normal chat etiquette for one thread (see FollowState). `begin()` on
 * send brings the new question + typing indicator into view; `complete()`
 * once the answer has replaced the indicator reveals the beginning of the
 * answer -- unless the physician deliberately scrolled up meanwhile. */
export function useConversationFollow(threadRef: RefObject<HTMLElement | null>, composerRef?: RefObject<HTMLElement | null>) {
  const state = useRef(new FollowState())

  useEffect(() => {
    const scrolledUp = () => state.current.manualScrollUp()
    const onWheel = (event: WheelEvent) => { if (event.deltaY < 0) scrolledUp() }
    const onKey = (event: KeyboardEvent) => { if (MANUAL_SCROLL_UP_KEYS.has(event.key)) scrolledUp() }
    window.addEventListener('wheel', onWheel, { passive: true, capture: true })
    window.addEventListener('touchmove', scrolledUp, { passive: true, capture: true })
    window.addEventListener('keydown', onKey, { capture: true })
    return () => {
      window.removeEventListener('wheel', onWheel, { capture: true })
      window.removeEventListener('touchmove', scrolledUp, { capture: true })
      window.removeEventListener('keydown', onKey, { capture: true })
    }
  }, [])

  /** Reveal the last `count` thread items after React has committed them
   * (plus the composer when it fits -- the reveal always keeps the first
   * element's top in view, so the composer can never push the answer off). */
  const revealLast = useCallback((count: number, withComposer: boolean) => {
    // A short timer rather than animation frames: React has committed by
    // then, and timers are not paused/throttled the way rAF can be.
    window.setTimeout(() => {
      const thread = threadRef.current
      if (!thread) return
      const targets = Array.from(thread.children).slice(-count) as HTMLElement[]
      const composer = withComposer ? composerRef?.current : null
      if (composer && !scrollParentDiffers(thread, composer)) targets.push(composer)
      revealElements(targets, scrollBehaviorFor(prefersReducedMotion()))
    }, REVEAL_AFTER_COMMIT_MS)
  }, [threadRef, composerRef])

  const begin = useCallback(() => { if (state.current.begin()) revealLast(2, false) }, [revealLast]) // question + typing indicator
  const complete = useCallback(() => { if (state.current.complete()) revealLast(1, true) }, [revealLast]) // the answer, its controls, the composer
  const fail = useCallback(() => state.current.fail(), [])

  return { begin, complete, fail }
}
