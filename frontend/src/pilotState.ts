import type { Lifecycle, RepresentationItem, RepresentationType, ScopeChoice, SetupStageId, SetupStageStatus, StatementKind, Fit, IntakeStatus, Modality, NewReferral, NextStep, PilotNextStep, PilotStatus, PracticeRule, Priority, PracticeRuleInput, ReferralAction, ReferralDetail, ReferralSummary, RequirementState, RuleRequirement, TriageChange, TriageCorrection, CorrectionConflict } from './pilotApi.ts'

/** Pure presentation + routing helpers for the real practice pilot. Everything here is
 * a projection of backend state; nothing is persisted client-side. */

export const pilotPaths = {
  home: '/me/home',
  forYou: '/me/for-you',
  onboarding: '/me/onboarding',
  join: '/me/join',
  /** Patients is the general clinical workspace (demo parity). `/me/referrals` stays a
   * working alias, and a received referral keeps its own episode URL below. */
  patients: '/me/patients',
  referrals: '/me/patients',
  network: '/me/network',
  newReferral: '/me/referrals/new',
  referral: (id: string) => `/me/referrals/${encodeURIComponent(id)}`,
  practice: '/me/practice',
  rules: '/me/rules',
  agent: '/me/agent',
  /** Guided initialization (Step 17): stages A–E, resumable. */
  setup: (stage?: string) => (stage ? `/me/setup?stage=${encodeURIComponent(stage)}` : '/me/setup'),
  agentTab: (tab: AgentTab) => (tab === 'overview' ? '/me/agent' : tab === 'rules' ? '/me/rules' : `/me/agent?tab=${tab}`),
  publicProfile: '/me/public',
  metrics: '/me/metrics',
  publicPage: (slug: string) => `/p/${encodeURIComponent(slug)}`,
  publicRefer: (slug: string) => `/p/${encodeURIComponent(slug)}/refer`,
  sender: (token: string) => `/r/${encodeURIComponent(token)}`,
} as const

export type PilotRoute =
  | { kind: 'home' } | { kind: 'for_you' } | { kind: 'onboarding' } | { kind: 'join' }
  | { kind: 'patients' } | { kind: 'network' } | { kind: 'new_referral' } | { kind: 'referral'; id: string }
  | { kind: 'practice' } | { kind: 'rules' } | { kind: 'agent' } | { kind: 'public_settings' } | { kind: 'metrics' } | { kind: 'setup' }
  | { kind: 'public_profile'; slug: string } | { kind: 'public_refer'; slug: string } | { kind: 'sender'; token: string }
  | { kind: 'auth'; page: 'sign-in' | 'sign-up' }
  | { kind: 'redirect'; to: string }

/** The ONLY routes that resolve in pilot mode. Every demo path (Lucy, Chen, Iain,
 * synthetic patients, consultations, demo network, claim directory) redirects home.
 * `/me/network` is the pilot's own Network page, which reads no demo roster. */
export function resolvePilotRoute(path: string): PilotRoute {
  const clean = path.replace(/\/+$/, '') || '/'
  if (clean === '/me' || clean === '/me/home') return { kind: 'home' }
  if (clean === '/me/for-you') return { kind: 'for_you' }
  if (clean === '/me/onboarding') return { kind: 'onboarding' }
  if (clean === '/me/join') return { kind: 'join' }
  if (clean === '/me/patients' || clean === '/me/referrals') return { kind: 'patients' }
  if (clean === '/me/network') return { kind: 'network' }
  if (clean === '/me/referrals/new') return { kind: 'new_referral' }
  const referral = clean.match(/^\/me\/referrals\/([A-Za-z0-9_-]+)$/)?.[1]
  if (referral) return { kind: 'referral', id: referral }
  if (clean === '/me/practice') return { kind: 'practice' }
  if (clean === '/me/rules') return { kind: 'rules' }
  if (clean === '/me/agent') return { kind: 'agent' }
  if (clean === '/me/setup') return { kind: 'setup' }
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

/* ---------------------------------------------------------- accounts & access */

/** Invitations expire after a week (server-enforced; this is only the copy). */
export const INVITATION_DAYS = 7
/** Session safety: sign out after this long without activity, with a warning before. */
export const IDLE_TIMEOUT_MINUTES = 30
export const IDLE_WARNING_MINUTES = 2

/** The invitation link an admin shares (shown once; the token is never stored client-side). */
export const invitationLink = (origin: string, token: string) => `${origin}${pilotPaths.join}?invite=${encodeURIComponent(token)}`

/** An authenticator setup key, in groups of four for typing by hand. */
export const formatSetupKey = (secret: string) => secret.replace(/\s+/g, '').toUpperCase().match(/.{1,4}/g)?.join(' ') ?? ''

/** A TOTP code as typed: digits only, at most six. */
export const normalizeTotpInput = (value: string) => value.replace(/\D/g, '').slice(0, 6)

/** 'active' | 'warning' (sign-out is close) | 'expired' (sign out now), from the last activity. */
export function idleState(lastActivity: number, now: number, timeoutMinutes = IDLE_TIMEOUT_MINUTES, warningMinutes = IDLE_WARNING_MINUTES): 'active' | 'warning' | 'expired' {
  const idle = now - lastActivity
  if (idle >= timeoutMinutes * 60_000) return 'expired'
  if (idle >= (timeoutMinutes - warningMinutes) * 60_000) return 'warning'
  return 'active'
}

/** What an invitation means for the person accepting it. */
export function invitationCopy(preview: { kind: 'practice' | 'new_practice'; role: 'physician' | 'staff'; practice_name: string | null; practice_specialty?: string | null }): { title: string; body: string } {
  if (preview.kind === 'new_practice') return {
    title: 'Set up your practice on Lamina',
    body: 'The Lamina team invited you to set up a new practice. Next you’ll set up two-step sign-in, then confirm your professional profile (NPI).',
  }
  const practice = preview.practice_name ?? 'the practice'
  return preview.role === 'physician' ? {
    title: `Join ${practice}`,
    body: 'You’ll join as a physician. Next you’ll set up two-step sign-in and confirm your own professional profile (NPI) — only you can. You’ll have your own agent, and you won’t be a practice admin unless an admin makes you one.',
  } : {
    title: `Join ${practice}`,
    body: `You’ll join as staff${preview.practice_specialty ? ` · ${preview.practice_specialty}` : ''}. Staff enter and review referrals; physicians make the final decisions. Next you’ll set up two-step sign-in.`,
  }
}

/** Which gate screen a non-workspace account sees. Workspace routes render only on 'workspace'. */
export const gateScreen = (step: PilotNextStep) => step

export const STATUS_LABELS: Record<IntakeStatus, string> = {
  received: 'Received',
  triaged: 'Triaged — needs review',
  needs_information: 'Needs information',
  ready_for_review: 'Ready for physician review',
  // Lamina holds no appointment data: an accepted referral is awaiting scheduling. It is never
  // shown as "Scheduled" or "Completed" without real workflow evidence for that state.
  accepted: 'Accepted — awaiting scheduling',
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
  review_sender_information: 'Verify what the referring office sent',
  confirm_referral_type: 'Confirm the referral type',
}
/** The staff "Ready" check: required items not yet in hand, split into still missing and
 * received but not yet verified (the office reported it, or it may be in a document). */
export type ReadyCheck = { missing: string[]; unverified: string[]; all: string[] }
const UNVERIFIED_STATES: RequirementState[] = ['sender_reported', 'proposed_from_document']
export function readyCheck(requirements: Array<{ label: string; required: boolean; state: RequirementState }>): ReadyCheck {
  const open = requirements.filter((item) => item.required && item.state !== 'satisfied')
  const unverified = open.filter((item) => UNVERIFIED_STATES.includes(item.state)).map((item) => item.label)
  const missing = open.filter((item) => !UNVERIFIED_STATES.includes(item.state)).map((item) => item.label)
  return { missing, unverified, all: [...missing, ...unverified] }
}

/** What the physician will see when staff mark it ready anyway: names both kinds. */
export function readyAnywayLine(check: ReadyCheck, doctor: string): string {
  const parts = [
    check.missing.length ? `${check.missing.join(', ')} ${check.missing.length === 1 ? 'is' : 'are'} still missing` : '',
    check.unverified.length ? `${check.unverified.join(', ')} ${check.unverified.length === 1 ? 'was' : 'were'} received but not verified` : '',
  ].filter(Boolean)
  return `Mark ready anyway — ${doctor} will see that ${parts.join(' and ')}`
}

export const REQUIREMENT_STATE_LABELS: Record<RequirementState, string> = {
  satisfied: 'Satisfied',
  proposed_from_document: 'Possibly in a document — confirm',
  sender_reported: 'Received — not yet verified',
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
  if (item.missing_items.length) parts.push(`missing ${item.missing_items.join(', ')}`)
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

export type RuleForm = {
  referralType: string; aliases: string; goodFit: string; outsideScope: string; required: string; helpful: string; urgent: string
  modality: Modality; note: string
  /** Step 17 kinds. Carried through edits so editing never drops a statement. */
  scopePolicy: '' | 'accept' | 'out_of_scope' | 'case_by_case'; preferences: string; exceptions: string; judgment: string
  makeOptional: string[]; answeredTopics: string[]
}
export const emptyRuleForm = (): RuleForm => ({
  referralType: '', aliases: '', goodFit: '', outsideScope: '', required: '', helpful: '', urgent: '', modality: 'unspecified', note: '',
  scopePolicy: '', preferences: '', exceptions: '', judgment: '', makeOptional: [], answeredTopics: [],
})

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
    aliases: splitLines(form.aliases ?? ''),
    good_fit: splitLines(form.goodFit),
    outside_scope: splitLines(form.outsideScope),
    required: parseRequirementLines(form.required, true),
    helpful: parseRequirementLines(form.helpful, false),
    urgent_signals: splitLines(form.urgent),
    modality: form.modality,
    note: form.note.trim() || null,
    publishable: false,
    scope_policy: form.scopePolicy || null,
    preferences: splitLines(form.preferences ?? ''),
    exceptions: splitLines(form.exceptions ?? ''),
    judgment: splitLines(form.judgment ?? ''),
    make_optional: form.makeOptional ?? [],
    answered_topics: form.answeredTopics ?? [],
  }
}

export function ruleFormFrom(rule: { referral_type: string; content: { good_fit: string[]; redirect: string[]; required: RuleRequirement[]; helpful: RuleRequirement[]; urgent_signals: string[]; modality: Modality; modality_notes: string | null; aliases?: string[]; scope_policy?: 'accept' | 'out_of_scope' | 'case_by_case' | null; preferences?: string[]; exceptions?: string[]; judgment?: string[]; make_optional?: string[]; answered_topics?: string[] } }): RuleForm {
  const lines = (items: RuleRequirement[]) => items.map((item) => item.freshness_days ? `${item.label} | ${item.freshness_days}` : item.label).join('\n')
  return {
    referralType: rule.referral_type,
    aliases: (rule.content.aliases ?? []).join('\n'),
    goodFit: rule.content.good_fit.join('\n'),
    outsideScope: rule.content.redirect.join('\n'),
    required: lines(rule.content.required),
    helpful: lines(rule.content.helpful),
    urgent: rule.content.urgent_signals.join('\n'),
    modality: rule.content.modality,
    note: rule.content.modality_notes ?? '',
    scopePolicy: rule.content.scope_policy ?? '',
    preferences: (rule.content.preferences ?? []).join('\n'),
    exceptions: (rule.content.exceptions ?? []).join('\n'),
    judgment: (rule.content.judgment ?? []).join('\n'),
    makeOptional: rule.content.make_optional ?? [],
    answeredTopics: rule.content.answered_topics ?? [],
  }
}

export const PILOT_ERROR_COPY: Record<string, string> = {
  practice_required: 'Set up or join a practice first.',
  pilot_access_pending: 'The Lamina team reviews each new practice first. You can set it up once your request is approved.',
  invitation_email_mismatch: 'This invitation was sent to a different email address. Sign in with that address, or ask for a new invitation.',
  staff_account: 'This is a staff account. A staff account can’t claim a physician identity — physicians use their own account.',
  already_invited: 'This account already accepted an invitation to join as a physician.',
  mfa_required: 'Finish two-step sign-in to continue.',
  session_revoked: 'You were signed out on this device. Sign in again.',
  invalid_email: 'Enter a valid email address.',
  cannot_deactivate_self: 'You can’t deactivate yourself. Ask another admin.',
  last_admin: 'A practice needs at least one admin. Make someone else an admin first.',
  practice_creation_unavailable: 'This account can’t start a new practice. Ask the Lamina team.',
  member_not_found: 'That member is no longer active in this practice.',
  practice_not_approved: 'This practice is awaiting Lamina pilot approval.',
  physician_required: 'Only a physician in this practice can do that.',
  invitation_unavailable: 'This invitation link is invalid, expired, revoked, or already used. Ask for a new one.',
  physician_account: 'This account holds a confirmed physician profile, so it cannot join as staff.',
  already_in_practice: 'This account already belongs to a practice.',
  stale_referral: 'This referral changed while you were working. It has been refreshed — please try again.',
  already_decided: 'Someone already reviewed this triage. It has been refreshed.',
  invalid_transition: 'That action isn’t available for this referral right now.',
  document_rejected: 'That file could not be accepted.',
  document_too_large: 'Files must be 15 MB or smaller.',
}
export const pilotErrorCopy = (code: string | null | undefined, fallback: string) => (code && PILOT_ERROR_COPY[code]) || fallback

/** Human label for a submitted item key: the requirement / request label the practice used,
 * never the internal key ("recent_tsh" → "Recent TSH"). Falls back to a readable key. */
export function itemLabel(key: string, detail: Pick<ReferralDetail, 'recommendation' | 'information_requests'>, fallback?: string | null): string {
  const fromRequests = (detail.information_requests ?? []).flatMap((request) => request.items).find((item) => item.key === key)?.label
  const fromTriage = detail.recommendation?.requirements.find((item) => item.key === key)?.label
  const label = fallback || fromRequests || fromTriage
  if (label) return label
  const words = key.replace(/_/g, ' ').trim()
  return words ? words[0].toUpperCase() + words.slice(1) : key
}

/* --------------------------------------------------- demo-parity presentation */

/** My Agent sections, in the demo's tab order (Overview first). Rules live under the
 * agent because they ARE the agent's confirmed representation of the practice. */
export const AGENT_TABS = ['overview', 'teach', 'rules', 'readiness'] as const
export type AgentTab = typeof AGENT_TABS[number]
export const resolveAgentTab = (value: string | null | undefined): AgentTab =>
  value && (AGENT_TABS as readonly string[]).includes(value) ? (value as AgentTab) : 'overview'

const titleCase = (value: string) => value.toLowerCase().replace(/(^|[\s'-])(\p{L})/gu, (_, lead: string, char: string) => lead + char.toUpperCase())

/** Who the shell greets and shows in the account pill — only from the server-confirmed
 * physician profile. Staff have no confirmed profile, so they are greeted without a name. */
export function accountIdentity(status: Pick<PilotStatus, 'role' | 'physician_onboarding'>, email?: string | null): { name: string; firstName: string | null; initials: string; role: string } {
  const identity = status.physician_onboarding?.confirmed_identity?.identity
  if (status.role === 'physician' && identity) {
    const first = identity.first_name ? titleCase(identity.first_name) : null
    const last = identity.last_name ? titleCase(identity.last_name) : null
    const name = first && last ? `Dr. ${first} ${last}` : identity.display_name
    const initials = (first && last ? `${first[0]}${last[0]}` : name.replace(/^Dr\.?\s+/i, '').split(/\s+/).map((part) => part[0] ?? '').join('').slice(0, 2)).toUpperCase()
    return { name, firstName: first, initials, role: 'Physician' }
  }
  const local = (email ?? '').split('@')[0] ?? ''
  return { name: status.role === 'physician' ? 'Physician' : 'Practice staff', firstName: null, initials: (local.slice(0, 2) || 'ST').toUpperCase(), role: status.role === 'physician' ? 'Physician' : 'Staff' }
}

export const patientInitials = (name: string) => name.trim().split(/\s+/).map((part) => part[0] ?? '').join('').slice(0, 2).toUpperCase() || '·'

/** The demo worklist's status-chip tones, applied to real intake status. */
/** Copper means "the physician's move" (ready for the decision); triaged work still being
 * checked is slate; waiting on the referring office is an amber outline; closed is quiet. */
export function statusTone(status: IntakeStatus): 'copper' | 'slate' | 'amber' | 'quiet' | 'success' {
  if (status === 'accepted') return 'success'
  if (status === 'redirected' || status === 'declined') return 'quiet'
  if (status === 'needs_information') return 'amber'
  if (status === 'ready_for_review') return 'copper'
  return 'slate'
}

/** The demo Patients page groups by care state ("Active patients" / "Previous care"); the
 * pilot list groups by intake state. Each referral lands in exactly one group. */
export function referralGroups(items: ReferralSummary[]): { review: ReferralSummary[]; waiting: ReferralSummary[]; closed: ReferralSummary[] } {
  const groups = { review: [] as ReferralSummary[], waiting: [] as ReferralSummary[], closed: [] as ReferralSummary[] }
  for (const item of items) {
    if (isClosed(item.status)) groups.closed.push(item)
    else if (item.status === 'needs_information') groups.waiting.push(item)
    else groups.review.push(item)
  }
  const urgency = (item: ReferralSummary) => (item.priority === 'urgent' ? 0 : item.priority === 'soon' ? 1 : 2)
  groups.review.sort((a, b) => urgency(a) - urgency(b) || b.received_at.localeCompare(a.received_at))
  groups.waiting.sort((a, b) => b.received_at.localeCompare(a.received_at))
  groups.closed.sort((a, b) => b.received_at.localeCompare(a.received_at))
  return groups
}

/** The row's "next step" column: what the team does next, or that it's closed. */
export function referralNextStep(item: Pick<ReferralSummary, 'status' | 'next_step'>): string {
  if (item.status === 'accepted') return 'Schedule in your scheduling system'
  if (isClosed(item.status)) return 'View referral'
  if (item.status === 'needs_information') return 'Waiting on the referring office'
  if (item.status === 'ready_for_review') return 'Physician decision'
  return item.next_step ? NEXT_STEP_LABELS[item.next_step] : 'Review triage'
}

export const matchesReferral = (item: ReferralSummary, query: string) =>
  `${item.patient_name} ${item.referral_type} ${item.sender_name} ${item.sender_practice ?? ''}`.toLowerCase().includes(query.trim().toLowerCase())

/** "Your agent currently represents your practice as …" — built only from the practice
 * record and its confirmed rules. Never invents a preference the physician didn't confirm. */
export function practicePortrait(practice: { name: string; specialty: string | null } | null, rules: Pick<PracticeRule, 'referral_type'>[]): string {
  const who = practice?.specialty ? `${practice.specialty} practice` : 'Your practice'
  if (!rules.length) return `${who}. No referral rules are confirmed yet, so your agent can record referrals but can’t judge fit or completeness.`
  const types = [...new Set(rules.map((rule) => rule.referral_type))]
  const list = types.length <= 3 ? types.join(', ') : `${types.slice(0, 3).join(', ')} and ${types.length - 3} more`
  return `${who}. Your agent triages ${plural(types.length, 'referral type', 'referral types')} from your confirmed rules: ${list}.`
}

const HISTORY_LABELS: Record<string, string> = {
  referral_received: 'Referral received',
  staff_entered: 'Referral entered',
  referral_triaged: 'Lamina triaged the referral',
  recommendation_generated: 'Lamina prepared a triage recommendation',
  // The retired approval step: recorded reviews, never a physician sign-off.
  recommendation_accepted: 'Triage reviewed (earlier approval step)',
  recommendation_edited: 'Triage edited (earlier approval step)',
  recommendation_rejected: 'Triage sent to the physician (earlier approval step)',
  recommendation_changed: 'Lamina’s recommendation changed',
  recommendation_changed_after_approval: 'Lamina’s recommendation changed',
  recommendation_approval_carried_forward: 'Earlier review still applied (retired step)',
  triage_corrected: 'Triage corrected',
  referral_marked_ready: 'Marked ready for the physician',
  missing_information_detected: 'Missing information detected',
  document_uploaded: 'Document attached',
  document_confirmed: 'Document evidence confirmed',
  document_viewed: 'Document opened',
  referral_item_recorded: 'Information recorded',
  referral_escalated: 'Flagged for physician review',
  information_requested: 'Information request drafted (not sent)',
  missing_information_request_created: 'Information request drafted',
  missing_information_request_edited: 'Information request edited',
  missing_information_request_sent: 'Information request sent',
  missing_information_request_cancelled: 'Information request cancelled',
  missing_information_resolved: 'Missing information resolved',
  sender_response_received: 'Referring office replied',
  referral_became_ready: 'Ready for physician review',
  referral_status_changed: 'Status changed',
  referral_accepted: 'Referral accepted',
  referral_redirected: 'Referral redirected',
  referral_declined: 'Referral declined',
}
/** Readable label for a pilot event type; unknown types fall back to sentence case. */
export function historyLabel(eventType: string): string {
  if (HISTORY_LABELS[eventType]) return HISTORY_LABELS[eventType]
  const words = eventType.replace(/_/g, ' ').trim()
  return words ? words[0].toUpperCase() + words.slice(1) : eventType
}

/** What the agent understood from a teaching instruction, as plain lines. */
export function proposalLines(content: Pick<PracticeRule['content'], 'required' | 'helpful' | 'good_fit' | 'redirect' | 'urgent_signals' | 'modality' | 'modality_notes'> & Partial<Pick<PracticeRule['content'], 'scope_policy' | 'aliases' | 'preferences' | 'exceptions' | 'judgment' | 'make_optional'>>): string[] {
  const lines: string[] = []
  // Every statement kind is shown — a proposal with only a scope answer must never look empty.
  if (content.scope_policy) lines.push(`Scope: ${{ accept: 'you see these referrals', out_of_scope: 'out of scope', case_by_case: 'you decide these case by case' }[content.scope_policy]}`)
  if (content.aliases?.length) lines.push(`Also called: ${content.aliases.join(', ')}`)
  if (content.make_optional?.length) lines.push(`Make optional (helpful, not required): ${content.make_optional.map((key) => key.replace(/_/g, ' ')).join(', ')}`)
  if (content.required.length) lines.push(`Require before review: ${content.required.map((item) => item.freshness_days ? `${item.label} (within ${item.freshness_days} days)` : item.label).join(', ')}`)
  if (content.helpful.length) lines.push(`Helpful: ${content.helpful.map((item) => item.label).join(', ')}`)
  if (content.good_fit.length) lines.push(`Good fit: ${content.good_fit.join('; ')}`)
  if (content.redirect.length) lines.push(`Outside your scope: ${content.redirect.join('; ')}`)
  if (content.urgent_signals.length) lines.push(`Treat as urgent: ${content.urgent_signals.join('; ')}`)
  if (content.modality !== 'unspecified') lines.push(`Default modality: ${MODALITY_LABELS[content.modality]}${content.modality_notes ? ` — ${content.modality_notes}` : ''}`)
  if (content.preferences?.length) lines.push(`Preference (suggested only): ${content.preferences.join('; ')}`)
  if (content.judgment?.length) lines.push(`You decide: ${content.judgment.join('; ')}`)
  if (content.exceptions?.length) lines.push(`Exception, kept as a note (not applied): ${content.exceptions.join('; ')}`)
  return lines
}

const NUMBER_WORDS = ['No', 'One', 'Two', 'Three', 'Four', 'Five', 'Six', 'Seven', 'Eight', 'Nine', 'Ten']
export const countWord = (count: number) => NUMBER_WORDS[count] ?? String(count)

/* ------------------------------------------------------- patients workspace */

/** What a Patients row is about. Lamina is a general physician-agent product: today the
 * pilot only has received referrals, but the same workspace is meant to carry sent
 * referrals, follow-up responsibilities, and longitudinal patients once those exist.
 * Only kinds the backend actually produces are listed — nothing here is invented. */
export type PatientWorkKind = 'received_referral'

/** One patient-related work item. It is an EPISODE of work (e.g. one referral), never a
 * patient identity: the pilot backend stores patient details per referral and has no
 * patient record to link episodes to, so rows are never merged by name (two different
 * people can share one) and never presented as a longitudinal chart. */
export type PatientWorkItem = {
  key: string; kind: PatientWorkKind; path: string
  /** As recorded on this episode only. */
  patient: { name: string; initials: string }
  episode: { title: string; summary: string; source: string; at: string }
  status: { label: string; tone: 'copper' | 'slate' | 'amber' | 'quiet' | 'success' }
  nextStep: string; flag: string
  /** Which Patients section: open work, accepted and awaiting scheduling, or closed. */
  section: PatientWorkSection
  /** Open work (kept for callers that only need active/inactive). */
  active: boolean; urgency: number; searchText: string
}

export type PatientWorkSection = 'active' | 'awaiting_scheduling' | 'closed'

export const PATIENT_WORK_KIND_LABELS: Record<PatientWorkKind, string> = { received_referral: 'Received referral' }

/** A received referral as a Patients work item. Status, fit, readiness, missing
 * information, and the next action all come straight from the referral summary. */
export function receivedReferralWorkItem(item: ReferralSummary): PatientWorkItem {
  const closed = isClosed(item.status)
  return {
    key: `received_referral:${item.id}`, kind: 'received_referral', path: pilotPaths.referral(item.id),
    patient: { name: item.patient_name, initials: patientInitials(item.patient_name) },
    episode: {
      title: item.referral_type,
      summary: triageHeadline(item),
      source: `From ${item.sender_name}${item.sender_practice ? `, ${item.sender_practice}` : ''}`,
      at: item.received_at,
    },
    status: { label: item.standing?.status_label ?? STATUS_LABELS[item.status], tone: statusTone(item.status) },
    nextStep: referralNextStep(item),
    flag: item.escalated ? 'Flagged for physician' : item.priority === 'urgent' ? 'Urgent' : '',
    section: !closed ? 'active' : item.status === 'accepted' ? 'awaiting_scheduling' : 'closed',
    active: !closed,
    // Needs-review work before waiting-on-others; urgent first within each.
    urgency: (item.status === 'needs_information' ? 3 : 0) + (item.priority === 'urgent' ? 0 : item.priority === 'soon' ? 1 : 2),
    searchText: `${item.patient_name} ${item.referral_type} ${item.sender_name} ${item.sender_practice ?? ''}`.toLowerCase(),
  }
}

/** Splits work items into Patients sections. An accepted referral is NOT "previous care":
 * the visit hasn't been booked, so it waits in its own section until scheduling exists. */
export function patientWorkSections(items: PatientWorkItem[], query = ''): { active: PatientWorkItem[]; awaitingScheduling: PatientWorkItem[]; closed: PatientWorkItem[] } {
  const q = query.trim().toLowerCase()
  const visible = q ? items.filter((item) => item.searchText.includes(q)) : items
  const newestFirst = (a: PatientWorkItem, b: PatientWorkItem) => b.episode.at.localeCompare(a.episode.at)
  return {
    active: visible.filter((item) => item.section === 'active').sort((a, b) => a.urgency - b.urgency || newestFirst(a, b)),
    awaitingScheduling: visible.filter((item) => item.section === 'awaiting_scheduling').sort(newestFirst),
    closed: visible.filter((item) => item.section === 'closed').sort(newestFirst),
  }
}

/** A stored request message is a template; show where the secure link will go instead of
 * the raw placeholder. The link itself is never stored or re-displayed. */
export const displayTemplate = (message: string) => message.replace(/\{status_link\}/g, '[Secure link included when sent (not stored)]')

/** Who did it, by name: the physician, the staff member, the referring office, or Lamina.
 * Never a generic "your team". */
export function actorText(event: Pick<ReferralDetail['history'][number], 'actor_name' | 'autonomy'> & { event_type?: string; metadata?: Record<string, unknown> }): string {
  // A changed recommendation is Lamina's, but credit the cause (a rule update), not the re-check.
  const cause = event.event_type === 'recommendation_changed' ? event.metadata?.cause as { text?: string; trigger_differs?: boolean } | undefined : undefined
  if (cause?.text) {
    const trigger = cause.trigger_differs && typeof event.metadata?.requested_by_name === 'string' ? ` · re-checked by ${event.metadata.requested_by_name}` : ''
    return `Lamina, because ${cause.text}${trigger}`
  }
  if (event.actor_name) return event.actor_name
  return event.autonomy === 'automatic' ? 'Lamina' : 'A practice member'
}

/** History label that is honest about the retired approval step: a staff review is a staff review. */
export function eventLabel(event: Pick<ReferralDetail['history'][number], 'event_type' | 'metadata'> & { actor_name?: string | null }): string {
  // An agent draft names who drafted it in the label itself, and that it wasn't sent.
  if (event.event_type === 'information_requested' && event.metadata?.by_agent) return `Information request drafted by ${event.actor_name ?? 'the agent'} (not sent)`
  if (event.metadata?.role === 'staff' && ['recommendation_accepted', 'recommendation_edited'].includes(event.event_type)) return 'Staff reviewed triage (earlier approval step; not a physician sign-off)'
  // Name the transition (the event records it) rather than a bare "Status changed".
  if (event.event_type === 'referral_status_changed') {
    const from = event.metadata?.from as IntakeStatus | undefined
    const to = event.metadata?.to as IntakeStatus | undefined
    if (from && to && from in STATUS_LABELS && to in STATUS_LABELS) return `Status: ${STATUS_LABELS[from]} → ${STATUS_LABELS[to]}`
  }
  return historyLabel(event.event_type)
}

const CHANGE_FIELD_LABELS: Record<string, string> = {
  fit: 'Fit', suggested_priority: 'Priority', suggested_modality: 'Visit type', requires_physician: 'Physician judgment', rule_type: 'Referral type rule',
}
const CHANGE_MODALITY: Record<string, string> = { in_person: 'in-person', econsult: 'eConsult', either: 'either', unspecified: 'unspecified' }
export function changeValue(field: string, value: unknown): string {
  if (field === 'fit' && typeof value === 'string' && value in FIT_LABELS) return FIT_LABELS[value as Fit].toLowerCase()
  if (field === 'suggested_priority' && typeof value === 'string' && value in PRIORITY_LABELS) return PRIORITY_LABELS[value as Priority].toLowerCase()
  if (field === 'suggested_modality' && typeof value === 'string' && value in CHANGE_MODALITY) return CHANGE_MODALITY[value]
  if (field === 'requires_physician') return value ? 'needed' : 'not needed'
  return value == null || value === '' ? 'none' : String(value)
}
/** Cause, not trigger: "Visit type: eConsult → in-person, because Dr. Avery Testwell updated the
 * Thyroid nodule rule (v4) · re-checked by Front desk". A direct correction: "(by Dr. Saru)". */
export function changeText(change: TriageChange): string {
  const what = `${CHANGE_FIELD_LABELS[change.field] ?? change.field.replace(/_/g, ' ')}: ${changeValue(change.field, change.from)} → ${changeValue(change.field, change.to)}`
  if (!change.because) return `${what} (by ${change.by})`
  return `${what}, because ${change.because}${change.triggered_by ? ` · re-checked by ${change.triggered_by}` : ''}`
}
export function correctionText(correction: Pick<TriageCorrection, 'field' | 'from' | 'to' | 'actor_name'>): string {
  return `${CHANGE_FIELD_LABELS[correction.field]}: ${changeValue(correction.field, correction.from)} → ${changeValue(correction.field, correction.to)} (by ${correction.actor_name})`
}
/** "Visit type: your earlier correction (eConsult) differs from your updated rule (in-person,
 * Thyroid nodule v5)" — in the third person for anyone who isn't the author. */
export function conflictText(conflict: CorrectionConflict): string {
  const field = CHANGE_FIELD_LABELS[conflict.field] ?? conflict.field
  const correction = conflict.corrected_by_you ? 'your earlier correction' : `${conflict.corrected_by_name ?? 'the physician'}’s earlier correction`
  const rule = conflict.rule_by_you ? 'your updated rule' : conflict.rule_by_name ? `${conflict.rule_by_name}’s updated rule` : 'the updated rule (author not recorded)'
  return `${field}: ${correction} (${changeValue(conflict.field, conflict.corrected_value)}) differs from ${rule} (${changeValue(conflict.field, conflict.rule_value)}, ${conflict.referral_type} v${conflict.rule_version})`
}
/** The referral history to show: newest first, every information-request, reply, hand-off,
 * correction, decision and office-notice event kept (they carry named actors), and Lamina's
 * back-to-back bookkeeping ("prepared a recommendation" right after "triaged") folded away. */
const KEY_HISTORY = new Set([
  'missing_information_request_created', 'missing_information_request_sent', 'missing_information_request_cancelled',
  'missing_information_resolved', 'sender_response_received', 'sender_document_received', 'referral_marked_ready',
  'referral_escalated', 'triage_corrected', 'correction_conflict_resolved', 'referral_accepted', 'referral_redirected',
  'referral_declined', 'referring_office_notified', 'referral_item_verified', 'recommendation_changed',
])
export function historyHighlights<T extends { event_type: string; created_at: string }>(history: T[], limit = 8): T[] {
  const newest = [...history].reverse().filter((event, index, all) =>
    !(event.event_type === 'recommendation_generated' && all[index + 1]?.event_type === 'referral_triaged'
      && all[index + 1]?.created_at === event.created_at)
    && !(event.event_type === 'recommendation_generated' && all[index - 1]?.event_type === 'referral_triaged'
      && all[index - 1]?.created_at === event.created_at))
  const keep = new Set(newest.filter((event) => KEY_HISTORY.has(event.event_type)))
  for (const event of newest) {
    if (keep.size >= limit) break
    keep.add(event)
  }
  return newest.filter((event) => keep.has(event))
}
/** The physician staff hand work to, by name when Lamina knows it. */
export const physicianLabel = (name: string | null | undefined) => name || 'the physician'

/** Network: the clinicians who have actually referred to this practice, derived only
 * from received referrals. These are real referral relationships — NOT Lamina network
 * connections, and nothing here claims the clinician is on Lamina. Grouped by the
 * sender name + practice exactly as entered (no fuzzy merging). */
export type ReferringClinician = { key: string; name: string; practice: string | null; initials: string; count: number; lastAt: string }
export function referringClinicians(items: Pick<ReferralSummary, 'sender_name' | 'sender_practice' | 'received_at'>[]): ReferringClinician[] {
  const byKey = new Map<string, ReferringClinician>()
  for (const item of items) {
    const name = item.sender_name.trim()
    if (!name) continue
    const key = `${name.toLowerCase()}|${(item.sender_practice ?? '').trim().toLowerCase()}`
    const existing = byKey.get(key)
    if (existing) {
      existing.count += 1
      if (item.received_at > existing.lastAt) existing.lastAt = item.received_at
    } else {
      byKey.set(key, { key, name, practice: item.sender_practice?.trim() || null, initials: patientInitials(name.replace(/^dr\.?\s+/i, '')), count: 1, lastAt: item.received_at })
    }
  }
  return [...byKey.values()].sort((a, b) => b.count - a.count || b.lastAt.localeCompare(a.lastAt))
}

/* ------------------------------------------------------------ agent handoffs */

/** A referral intake the agent prefilled, handed to the New referral form. Held in
 * module memory for one navigation only (never browser storage); the form takes it once. */
let referralPrefill: Partial<ReferralForm> | null = null
export function setReferralPrefill(draft: Partial<Record<'patient_name' | 'patient_dob' | 'referral_type' | 'reason' | 'sender_name' | 'sender_practice', string>>): void {
  referralPrefill = {
    ...(draft.patient_name ? { patientName: draft.patient_name } : {}),
    ...(draft.patient_dob && /^\d{4}-\d{2}-\d{2}$/.test(draft.patient_dob) ? { patientDob: draft.patient_dob } : {}),
    ...(draft.referral_type ? { referralType: draft.referral_type } : {}),
    ...(draft.reason ? { reason: draft.reason } : {}),
    ...(draft.sender_name ? { senderName: draft.sender_name } : {}),
    ...(draft.sender_practice ? { senderPractice: draft.sender_practice } : {}),
  }
}
export function takeReferralPrefill(): Partial<ReferralForm> | null {
  const value = referralPrefill
  referralPrefill = null
  return value
}

/** The turns asked from one referral's page: each user message whose on-screen context was
 * that referral, plus the agent reply that followed it. Keeps another patient's conversation
 * out of a dock that is labeled with this patient. */
export function turnsForReferral<T extends { role: 'user' | 'agent'; context_referral_id?: string | null }>(messages: T[], referralId: string): T[] {
  const kept: T[] = []
  let keepReply = false
  for (const message of messages) {
    if (message.role === 'user') {
      keepReply = message.context_referral_id === referralId
      if (keepReply) kept.push(message)
    } else if (keepReply) {
      kept.push(message)
      keepReply = false
    }
  }
  return kept
}

/** Stored conversation messages → the dock's message shape (no client-side reinterpretation). */
export function dockMessagesFrom(messages: Array<{ id: string; role: 'user' | 'agent'; text: string; reply: { paragraphs: string[]; bullets?: string[]; cards?: Array<{ label: string; detail: string; action: string; path?: string | null; execute?: unknown }> } | null }>) {
  return messages.map((message) => message.role === 'user'
    ? { id: message.id, role: 'physician' as const, text: message.text }
    : { id: message.id, role: 'agent' as const, reply: message.reply ?? { paragraphs: [message.text] } })
}

/* ---------------------------------------------------- representation (Step 17) */

/** How each kind of statement is named everywhere. Only requirements and scope drive triage. */
export const STATEMENT_KIND_LABELS: Record<StatementKind, string> = {
  hard_requirement: 'Requirement', scope_policy: 'Scope', soft_preference: 'Preference',
  exception: 'Exception — kept as a note', physician_judgment: 'Your judgment', unknown: 'Unknown',
}
export const STATEMENT_KIND_EFFECT: Record<StatementKind, string> = {
  hard_requirement: 'Decides whether a referral is complete',
  scope_policy: 'Decides practice fit',
  soft_preference: 'Suggested only — never blocks a referral',
  exception: 'Not applied automatically',
  physician_judgment: 'Always comes to you',
  unknown: 'Not answered yet',
}
/** Who the copy is addressed to. A physician reads about their own agent ("your judgment");
 * staff read the same thing about the physician ("Dr. X’s judgment"). Copy is chosen per role
 * from structured values — not rewritten from second-person text. */
export type Voice = { physician: boolean; doctor: string }
export const voiceFor = (role: string, physicianName: string | null | undefined): Voice =>
  ({ physician: role === 'physician', doctor: physicianLabel(physicianName) })
const PHYSICIAN_VOICE: Voice = { physician: true, doctor: 'the physician' }

/** The label for one representation item (urgency signals get their own). */
export const itemKindLabel = (item: { kind: StatementKind; subkind?: string }, voice: Voice = PHYSICIAN_VOICE) =>
  item.subkind === 'urgency' ? 'Urgency'
    : item.kind === 'physician_judgment' && !voice.physician ? `${voice.doctor}’s judgment` : STATEMENT_KIND_LABELS[item.kind]
export const itemKindEffect = (item: { kind: StatementKind; subkind?: string }, voice: Voice = PHYSICIAN_VOICE) =>
  item.subkind === 'urgency' ? 'Raises priority'
    : item.kind === 'physician_judgment' && !voice.physician ? `Always comes to ${voice.doctor}` : STATEMENT_KIND_EFFECT[item.kind]
/** Which layer a statement belongs to, in the reader's voice ("just you" / "Dr. X only"). */
export const layerNote = (layer: string | null | undefined, voice: Voice, ownWord: 'just you' | 'your own' = 'just you') =>
  layer === 'physician' ? (voice.physician ? ownWord : `${voice.doctor} only`) : null
/** The representation's fixed scope statements (the server sends these exact values), in the
 * reader's voice. Everything else it sends is already neutral ("Good fit: …", requirement
 * labels) or the physician's own words (judgment notes), which are shown as written. */
export function representationItemText(text: string, voice: Voice): string {
  if (voice.physician) return text
  const d = voice.doctor
  const fixed: Record<string, string> = {
    'You see these referrals': `${d} sees these referrals`,
    'You see these referrals (from your rule)': `${d} sees these referrals (from ${d}’s rule)`,
    'You decide these case by case': `${d} decides these case by case`,
  }
  return fixed[text] ?? text
}
/** The agent's lifecycle line, by state, in the reader's voice. */
export function lifecycleLine(lifecycle: { state: string | null; label: string | null; capabilities_line?: string | null }, voice: Voice): string | null {
  if (!lifecycle.label || voice.physician) return lifecycle.label
  if (lifecycle.capabilities_line) return `${lifecycle.capabilities_line} — ${voice.doctor}’s agent prepares drafts for review; ${voice.doctor} decides.`
  if (lifecycle.state === 'shadow') return `Shadow mode — ${voice.doctor}’s agent recommends; ${voice.doctor} decides. Staff handle intake and paperwork.`
  if (lifecycle.state === 'initializing') return `Setting up — ${voice.doctor}’s agent doesn’t represent the practice yet.`
  return lifecycle.label
}
export const SCOPE_CHOICE_LABELS: Record<ScopeChoice, string> = {
  accept: 'I see these', out_of_scope: 'Out of scope', case_by_case: 'I decide case by case', unknown: 'Unknown',
}
export const TOPIC_LABELS: Record<'scope' | 'requirements' | 'urgency' | 'modality', string> = {
  scope: 'Whether you see these', requirements: 'What you need before review',
  urgency: 'What makes one urgent', modality: 'Preferred visit type',
}
export const HANDLED_BY_LABELS = { physician: 'Me', staff: 'My staff', agent_prepares: 'Agent prepares it for review' } as const
export const AUTONOMY_LABELS = {
  off: 'Off', observe: 'Observe only', prepare_drafts: 'Prepare drafts for review', ask_before_acting: 'Ask me before acting',
} as const
export const SETUP_STAGES: SetupStageId[] = ['identity', 'scope', 'requirements', 'delegation', 'review']
export const resolveSetupStage = (value: string | null | undefined, fallback: SetupStageId = 'identity'): SetupStageId =>
  value && (SETUP_STAGES as readonly string[]).includes(value) ? (value as SetupStageId) : fallback
export const STAGE_STATUS_LABELS: Record<SetupStageStatus, string> = {
  not_started: 'Not started', in_progress: 'In progress', done: 'Done', skipped: 'Skipped — finish later',
}

/** "Setup: 3 of 5 stages · about 4 min left" — progress by stage, never a score. */
export function setupProgressLine(lifecycle: Pick<Lifecycle, 'stages' | 'minutes_remaining'>): string {
  // Skipped is not done: say both, so a skipped stage never reads as finished.
  const done = lifecycle.stages.filter((stage) => stage.status === 'done').length
  const skipped = lifecycle.stages.filter((stage) => stage.status === 'skipped').length
  const left = lifecycle.minutes_remaining
  return `${done} of ${lifecycle.stages.length} stages done${skipped ? ` · ${skipped} skipped` : ''}${left > 0 ? ` · about ${left} min left` : ''}`
}

/** Representation items grouped for display: confirmed first, then proposed, each with its kind. */
export function representationGroups(type: RepresentationType): { confirmed: RepresentationItem[]; proposed: RepresentationItem[] } {
  return {
    confirmed: type.items.filter((item) => item.status === 'confirmed'),
    proposed: type.items.filter((item) => item.status === 'proposed'),
  }
}

/** "Your agent currently represents your practice as …" from the CONFIRMED representation only. */
export function representationPortrait(practice: { name: string; specialty: string | null } | null, representation: { types: RepresentationType[] }): string {
  const who = practice?.specialty ? `${practice.specialty} practice` : 'Your practice'
  const confirmed = representation.types.filter((type) => type.items.some((item) => item.status === 'confirmed'))
  if (!confirmed.length) return `${who}. Nothing is confirmed yet, so your agent can record referrals but can’t judge fit or completeness.`
  const by = (policy: string | null) => confirmed.filter((type) => (type.scope_policy ?? 'accept') === policy).map((type) => type.referral_type)
  const parts = [
    by('accept').length ? `sees ${by('accept').join(', ')}` : '',
    by('case_by_case').length ? `decides ${by('case_by_case').join(', ')} case by case` : '',
    by('out_of_scope').length ? `doesn’t see ${by('out_of_scope').join(', ')}` : '',
  ].filter(Boolean)
  return `${who} — ${parts.join('; ')}.`
}

/** A statements_used `item` as a readable phrase ("accept" → "You see these referrals"). */
export function statementText(item: string, voice: Voice = PHYSICIAN_VOICE): string {
  const fixed: Record<string, string> = voice.physician
    ? { accept: 'You see these referrals', out_of_scope: 'Out of scope', case_by_case: 'You decide these case by case' }
    : { accept: `${voice.doctor} sees these referrals`, out_of_scope: 'Out of scope', case_by_case: `${voice.doctor} decides these case by case` }
  if (fixed[item]) return fixed[item]
  if (item.startsWith('fit: ')) return `Good fit: ${item.slice(5)}`
  if (item.startsWith('outside: ')) return `Not seen: ${item.slice(9)}`
  if (item.startsWith('modality:')) return `Prefers ${item.slice(9).replace('_', '-')}`
  return item.replace(/_/g, ' ').replace(/^./, (c) => c.toUpperCase())
}
