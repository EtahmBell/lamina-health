import type { Fit, IntakeStatus, Modality, NewReferral, NextStep, PilotNextStep, Priority, PracticeRuleInput, ReferralAction, ReferralSummary, RequirementState, RuleRequirement } from './pilotApi.ts'

/** Pure presentation + routing helpers for the real practice pilot. Everything here is
 * a projection of backend state; nothing is persisted client-side. */

export const pilotPaths = {
  home: '/me/home',
  onboarding: '/me/onboarding',
  join: '/me/join',
  referrals: '/me/referrals',
  newReferral: '/me/referrals/new',
  referral: (id: string) => `/me/referrals/${encodeURIComponent(id)}`,
  practice: '/me/practice',
  rules: '/me/rules',
  agent: '/me/agent',
  publicProfile: '/me/public',
  metrics: '/me/metrics',
  publicPage: (slug: string) => `/p/${encodeURIComponent(slug)}`,
  publicRefer: (slug: string) => `/p/${encodeURIComponent(slug)}/refer`,
  sender: (token: string) => `/r/${encodeURIComponent(token)}`,
} as const

export type PilotRoute =
  | { kind: 'home' } | { kind: 'onboarding' } | { kind: 'join' }
  | { kind: 'referrals' } | { kind: 'new_referral' } | { kind: 'referral'; id: string }
  | { kind: 'practice' } | { kind: 'rules' } | { kind: 'agent' } | { kind: 'public_settings' } | { kind: 'metrics' }
  | { kind: 'public_profile'; slug: string } | { kind: 'public_refer'; slug: string } | { kind: 'sender'; token: string }
  | { kind: 'auth'; page: 'sign-in' | 'sign-up' }
  | { kind: 'redirect'; to: string }

/** The ONLY routes that resolve in pilot mode. Every demo path (Lucy, Chen, Iain,
 * synthetic patients, consultations, network, claim directory) redirects home. */
export function resolvePilotRoute(path: string): PilotRoute {
  const clean = path.replace(/\/+$/, '') || '/'
  if (clean === '/me' || clean === '/me/home') return { kind: 'home' }
  if (clean === '/me/onboarding') return { kind: 'onboarding' }
  if (clean === '/me/join') return { kind: 'join' }
  if (clean === '/me/referrals') return { kind: 'referrals' }
  if (clean === '/me/referrals/new') return { kind: 'new_referral' }
  const referral = clean.match(/^\/me\/referrals\/([A-Za-z0-9_-]+)$/)?.[1]
  if (referral) return { kind: 'referral', id: referral }
  if (clean === '/me/practice') return { kind: 'practice' }
  if (clean === '/me/rules') return { kind: 'rules' }
  if (clean === '/me/agent') return { kind: 'agent' }
  if (clean === '/me/public') return { kind: 'public_settings' }
  if (clean === '/me/metrics') return { kind: 'metrics' }
  const publicSlug = clean.match(/^\/p\/([a-z0-9-]{3,60})$/)?.[1]
  if (publicSlug) return { kind: 'public_profile', slug: publicSlug }
  const referSlug = clean.match(/^\/p\/([a-z0-9-]{3,60})\/refer$/)?.[1]
  if (referSlug) return { kind: 'public_refer', slug: referSlug }
  const senderToken = clean.match(/^\/r\/([A-Za-z0-9_-]{20,200})$/)?.[1]
  if (senderToken) return { kind: 'sender', token: senderToken }
  if (clean === '/claim/sign-in') return { kind: 'auth', page: 'sign-in' }
  if (clean === '/claim/sign-up') return { kind: 'auth', page: 'sign-up' }
  return { kind: 'redirect', to: pilotPaths.home }
}

/** Which gate screen a non-workspace account sees. Workspace routes render only on 'workspace'. */
export const gateScreen = (step: PilotNextStep) => step

export const STATUS_LABELS: Record<IntakeStatus, string> = {
  received: 'Received',
  triaged: 'Triaged — needs review',
  needs_information: 'Needs information',
  ready_for_review: 'Ready for physician review',
  accepted: 'Accepted',
  redirected: 'Redirected',
  declined: 'Declined',
}
export const FIT_LABELS: Record<Fit, string> = {
  strong: 'Strong practice fit',
  possible: 'Possible fit',
  outside_scope: 'Outside stated scope',
  unknown: 'Fit unknown — no rule yet',
}
export const PRIORITY_LABELS: Record<Priority, string> = { routine: 'Routine', soon: 'Soon', urgent: 'Urgent' }
export const MODALITY_LABELS: Record<Modality, string> = {
  in_person: 'In-person visit', econsult: 'eConsult', either: 'Either', unspecified: 'Not specified',
}
export const NEXT_STEP_LABELS: Record<NextStep, string> = {
  request_information: 'Request missing information',
  confirm_document_evidence: 'Confirm what the documents show',
  physician_review: 'Physician review',
  consider_redirect: 'Consider redirecting',
}
export const REQUIREMENT_STATE_LABELS: Record<RequirementState, string> = {
  satisfied: 'Present',
  proposed_from_document: 'Possibly in a document — confirm',
  missing: 'Missing',
  optional_missing: 'Not provided (helpful)',
}
const TERMINAL: IntakeStatus[] = ['accepted', 'redirected', 'declined']
export const isClosed = (status: IntakeStatus) => TERMINAL.includes(status)

/** A short, concrete sentence for the agent's summary of a referral. */
export function triageHeadline(item: Pick<ReferralSummary, 'status' | 'fit' | 'missing_items' | 'priority' | 'next_step'>): string {
  if (isClosed(item.status)) return STATUS_LABELS[item.status]
  const parts: string[] = []
  if (item.fit) parts.push(FIT_LABELS[item.fit])
  if (item.missing_items.length) parts.push(`missing ${item.missing_items.join(', ').toLowerCase()}`)
  if (item.priority && item.priority !== 'routine') parts.push(`${PRIORITY_LABELS[item.priority].toLowerCase()} priority`)
  return parts.join(' · ') || STATUS_LABELS[item.status]
}

export type HomeBuckets = { attention: ReferralSummary[]; missing: ReferralSummary[]; ready: ReferralSummary[]; closed: ReferralSummary[] }

/** Groups referrals into what needs the team now. A referral appears in one bucket only. */
export function homeBuckets(items: ReferralSummary[]): HomeBuckets {
  const buckets: HomeBuckets = { attention: [], missing: [], ready: [], closed: [] }
  for (const item of items) {
    if (isClosed(item.status)) buckets.closed.push(item)
    else if (item.status === 'ready_for_review') buckets.ready.push(item)
    else if (item.status === 'needs_information') buckets.missing.push(item)
    else buckets.attention.push(item)
  }
  return buckets
}

const plural = (count: number, one: string, many: string) => `${count} ${count === 1 ? one : many}`
export function briefingLines(buckets: HomeBuckets, role: 'physician' | 'staff'): string[] {
  const lines: string[] = []
  if (buckets.attention.length) lines.push(`${plural(buckets.attention.length, 'new referral has', 'new referrals have')} a triage ready for your review.`)
  if (buckets.missing.length) lines.push(`${plural(buckets.missing.length, 'referral is', 'referrals are')} waiting on missing information.`)
  if (buckets.ready.length) lines.push(role === 'physician'
    ? `${plural(buckets.ready.length, 'referral is', 'referrals are')} ready for your decision.`
    : `${plural(buckets.ready.length, 'referral is', 'referrals are')} ready for the physician.`)
  return lines
}

export const canUse = (actions: ReferralAction[], action: ReferralAction) => actions.includes(action)

/* ------------------------------------------------------------------- forms */

export type ReferralForm = {
  senderName: string; senderPractice: string; senderContact: string; senderNpi: string
  patientName: string; patientDob: string; patientPhone: string; patientInsurance: string; patientExternalId: string
  referralType: string; reason: string; clinicalContext: string; senderPriority: '' | Priority; receivedAt: string
  items: Array<{ key: string; value: string; observedDate: string }>
}
export const emptyReferralForm = (): ReferralForm => ({
  senderName: '', senderPractice: '', senderContact: '', senderNpi: '',
  patientName: '', patientDob: '', patientPhone: '', patientInsurance: '', patientExternalId: '',
  referralType: '', reason: '', clinicalContext: '', senderPriority: '', receivedAt: '', items: [],
})

export function referralFormErrors(form: ReferralForm): string[] {
  const errors: string[] = []
  if (!form.senderName.trim()) errors.push('Enter the referring clinician.')
  if (!form.patientName.trim()) errors.push('Enter the patient’s name.')
  if (!form.referralType.trim()) errors.push('Choose or enter a referral type.')
  if (!form.reason.trim()) errors.push('Enter the reason for referral.')
  if (form.senderNpi.trim() && !/^\d{10}$/.test(form.senderNpi.trim())) errors.push('A referring NPI is exactly 10 digits.')
  if (form.receivedAt && new Date(form.receivedAt).getTime() > Date.now()) errors.push('The received date cannot be in the future.')
  for (const item of form.items) if (item.key && !item.value.trim()) errors.push('Each provided item needs a value.')
  return errors
}

const blank = (value: string) => value.trim() || null
export function referralPayload(form: ReferralForm, hasFile: boolean): NewReferral {
  return {
    source: hasFile ? 'upload' : 'manual',
    sender: { name: form.senderName.trim(), practice: blank(form.senderPractice), contact: blank(form.senderContact), npi: blank(form.senderNpi) },
    patient: { name: form.patientName.trim(), date_of_birth: blank(form.patientDob), phone: blank(form.patientPhone), insurance: blank(form.patientInsurance), external_id: blank(form.patientExternalId) },
    referral_type: form.referralType.trim(),
    reason: form.reason.trim(),
    clinical_context: blank(form.clinicalContext),
    sender_priority: form.senderPriority || null,
    received_at: form.receivedAt ? new Date(form.receivedAt).toISOString() : null,
    submitted_items: form.items.filter((item) => item.key && item.value.trim()).map((item) => ({ key: item.key, value: item.value.trim(), observed_date: item.observedDate || null })),
  }
}

export const slugKey = (label: string) => label.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '').slice(0, 80) || 'item'
export const splitLines = (text: string) => text.split('\n').map((line) => line.trim()).filter(Boolean)

export type RuleForm = { referralType: string; goodFit: string; outsideScope: string; required: string; helpful: string; urgent: string; modality: Modality; note: string }
export const emptyRuleForm = (): RuleForm => ({ referralType: '', goodFit: '', outsideScope: '', required: '', helpful: '', urgent: '', modality: 'unspecified', note: '' })

/** "Recent HbA1c | 180" → { label: 'Recent HbA1c', freshness_days: 180 }. */
export function parseRequirementLines(text: string, required: boolean): RuleRequirement[] {
  return splitLines(text).map((line) => {
    const [label, days] = line.split('|').map((part) => part.trim())
    const freshness = days && /^\d+$/.test(days) ? Number(days) : null
    return { key: slugKey(label), label, required, freshness_days: freshness }
  })
}

export function ruleInput(form: RuleForm): PracticeRuleInput {
  return {
    referral_type: form.referralType.trim(),
    good_fit: splitLines(form.goodFit),
    outside_scope: splitLines(form.outsideScope),
    required: parseRequirementLines(form.required, true),
    helpful: parseRequirementLines(form.helpful, false),
    urgent_signals: splitLines(form.urgent),
    modality: form.modality,
    note: form.note.trim() || null,
    publishable: false,
  }
}

export function ruleFormFrom(rule: { referral_type: string; content: { good_fit: string[]; redirect: string[]; required: RuleRequirement[]; helpful: RuleRequirement[]; urgent_signals: string[]; modality: Modality; modality_notes: string | null } }): RuleForm {
  const lines = (items: RuleRequirement[]) => items.map((item) => item.freshness_days ? `${item.label} | ${item.freshness_days}` : item.label).join('\n')
  return {
    referralType: rule.referral_type,
    goodFit: rule.content.good_fit.join('\n'),
    outsideScope: rule.content.redirect.join('\n'),
    required: lines(rule.content.required),
    helpful: lines(rule.content.helpful),
    urgent: rule.content.urgent_signals.join('\n'),
    modality: rule.content.modality,
    note: rule.content.modality_notes ?? '',
  }
}

export const PILOT_ERROR_COPY: Record<string, string> = {
  practice_required: 'Set up or join a practice first.',
  pilot_access_pending: 'Your physician profile is awaiting Lamina pilot approval.',
  practice_not_approved: 'This practice is awaiting Lamina pilot approval.',
  physician_required: 'Only a physician in this practice can do that.',
  invitation_unavailable: 'This invitation link is invalid, expired, or already used. Ask the practice for a new one.',
  physician_account: 'This account holds a confirmed physician profile, so it cannot join as staff.',
  already_in_practice: 'This account already belongs to a practice.',
  stale_referral: 'This referral changed while you were working. It has been refreshed — please try again.',
  already_decided: 'Someone already reviewed this triage. It has been refreshed.',
  invalid_transition: 'That action isn’t available for this referral right now.',
  document_rejected: 'That file could not be accepted.',
  document_too_large: 'Files must be 15 MB or smaller.',
}
export const pilotErrorCopy = (code: string | null | undefined, fallback: string) => (code && PILOT_ERROR_COPY[code]) || fallback
