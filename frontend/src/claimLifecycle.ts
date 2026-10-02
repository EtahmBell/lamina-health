import type { AgentStatus, ClaimStatus } from './api.ts'

/**
 * The frontend's only copy of claim/verification/activation lifecycle copy and
 * step projection. Mirrors backend/provider_network/lifecycle.py's precedence
 * (disabled > active > verified > verification_pending > claimed > reserved)
 * without re-deriving it — the backend-supplied `lifecycle_status` is always
 * the source of truth; this module only turns that enum into calm UI copy.
 */

export type LifecycleCopy = { label: string; detail: string }

export const LIFECYCLE_COPY: Record<AgentStatus, LifecycleCopy> = {
  reserved: {
    label: 'Reserved Lamina identity',
    detail: 'Sourced from the national provider directory. This physician has not claimed or activated this identity.',
  },
  claimed: {
    label: 'Claim started',
    detail: 'An identity claim has started. Verification has not been submitted yet.',
  },
  verification_pending: {
    label: 'Verification pending',
    detail: 'Lamina must verify that you are the physician associated with this NPI before the agent can be activated.',
  },
  verified: {
    label: 'Identity verified',
    detail: 'Your Lamina identity is verified. Your physician agent is not active yet.',
  },
  active: {
    label: 'Agent active',
    detail: 'Your physician agent is active.',
  },
  disabled: {
    label: 'Agent disabled',
    detail: 'Identity remains verified. The agent is not currently active.',
  },
}

export type LifecycleStepId = 'identity' | 'claim' | 'verification' | 'agent'
export type LifecycleStepState = 'complete' | 'current' | 'locked'
export type LifecycleStep = { id: LifecycleStepId; label: string; state: LifecycleStepState }

const STEP_LABELS: Record<LifecycleStepId, string> = {
  identity: 'Identity', claim: 'Claim', verification: 'Verification', agent: 'Agent',
}

/**
 * Four-step projection shared by every claim surface. Verification is never
 * marked complete for `verification_pending` — only `verified` and beyond do that.
 */
export function lifecycleSteps(status: AgentStatus): LifecycleStep[] {
  const state = (id: LifecycleStepId, s: LifecycleStepState): LifecycleStep => ({ id, label: STEP_LABELS[id], state: s })
  switch (status) {
    case 'reserved':
      return [state('identity', 'complete'), state('claim', 'current'), state('verification', 'locked'), state('agent', 'locked')]
    case 'claimed':
      return [state('identity', 'complete'), state('claim', 'complete'), state('verification', 'current'), state('agent', 'locked')]
    case 'verification_pending':
      return [state('identity', 'complete'), state('claim', 'complete'), state('verification', 'current'), state('agent', 'locked')]
    case 'verified':
      return [state('identity', 'complete'), state('claim', 'complete'), state('verification', 'complete'), state('agent', 'current')]
    case 'active':
    case 'disabled':
      return [state('identity', 'complete'), state('claim', 'complete'), state('verification', 'complete'), state('agent', 'complete')]
  }
}

/** Search-result and list-row status chip copy (no ownership metadata). */
export function lifecycleChip(status: AgentStatus, claimedByMe: boolean): string {
  if (claimedByMe && status === 'claimed') return 'Claim started'
  if (claimedByMe && status === 'verification_pending') return 'Verification pending'
  return LIFECYCLE_COPY[status].label
}

/** A real NPPES identity may never see a demo-verification control. */
export const canDemoVerify = (synthetic: boolean, status: AgentStatus) => synthetic && status === 'verification_pending'

export const canSubmitVerification = (claimedByMe: boolean, myClaimStatus: ClaimStatus | null) =>
  claimedByMe && (myClaimStatus === 'claimed' || myClaimStatus === 'verification_pending')

export const canActivate = (claimedByMe: boolean, myClaimStatus: ClaimStatus | null, agentActive: boolean) =>
  claimedByMe && myClaimStatus === 'verified' && !agentActive

export const canDisable = (claimedByMe: boolean, myClaimStatus: ClaimStatus | null, agentActive: boolean) =>
  claimedByMe && myClaimStatus === 'verified' && agentActive

export const canReactivate = (claimedByMe: boolean, myClaimStatus: ClaimStatus | null, status: AgentStatus) =>
  claimedByMe && myClaimStatus === 'verified' && status === 'disabled'
