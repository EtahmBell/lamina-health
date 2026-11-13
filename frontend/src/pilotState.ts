import type { Fit, IntakeStatus, Modality, NewReferral, NextStep, PilotNextStep, PilotStatus, PracticeRule, Priority, PracticeRuleInput, ReferralAction, ReferralDetail, ReferralSummary, RequirementState, RuleRequirement } from './pilotApi.ts'

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
  | { kind: 'practice' } | { kind: 'rules' } | { kind: 'agent' } | { kind: 'public_settings' } | { kind: 'metrics' }
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
export const AGENT_TABS = ['overview', 'teach', 'rules'] as const
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
export function statusTone(status: IntakeStatus): 'copper' | 'slate' | 'quiet' | 'success' {
  if (status === 'accepted') return 'success'
  if (status === 'redirected' || status === 'declined') return 'quiet'
  if (status === 'needs_information') return 'slate'
  return 'copper'
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
  staff_entered: 'Referral entered by your team',
  referral_triaged: 'Lamina triaged the referral',
  recommendation_generated: 'Lamina prepared a triage recommendation',
  recommendation_accepted: 'Triage approved',
  recommendation_edited: 'Triage edited',
  recommendation_rejected: 'Triage rejected',
  missing_information_detected: 'Missing information detected',
  document_uploaded: 'Document attached',
  document_confirmed: 'Document evidence confirmed',
  document_viewed: 'Document opened',
  referral_item_recorded: 'Information recorded',
  referral_escalated: 'Flagged for physician review',
  information_requested: 'Information requested',
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
export function proposalLines(content: Pick<PracticeRule['content'], 'required' | 'helpful' | 'good_fit' | 'redirect' | 'urgent_signals' | 'modality' | 'modality_notes'>): string[] {
  const lines: string[] = []
  if (content.required.length) lines.push(`Require before review: ${content.required.map((item) => item.freshness_days ? `${item.label} (within ${item.freshness_days} days)` : item.label).join(', ')}`)
  if (content.helpful.length) lines.push(`Helpful: ${content.helpful.map((item) => item.label).join(', ')}`)
  if (content.good_fit.length) lines.push(`Good fit: ${content.good_fit.join('; ')}`)
  if (content.redirect.length) lines.push(`Outside your scope: ${content.redirect.join('; ')}`)
  if (content.urgent_signals.length) lines.push(`Treat as urgent: ${content.urgent_signals.join('; ')}`)
  if (content.modality !== 'unspecified') lines.push(`Default modality: ${MODALITY_LABELS[content.modality]}${content.modality_notes ? ` — ${content.modality_notes}` : ''}`)
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
  status: { label: string; tone: 'copper' | 'slate' | 'quiet' | 'success' }
  nextStep: string; flag: string
  /** Active work vs. previous care (the demo Patients page's two sections). */
  active: boolean; urgency: number; searchText: string
}

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
    status: { label: STATUS_LABELS[item.status], tone: statusTone(item.status) },
    nextStep: referralNextStep(item),
    flag: item.escalated ? 'Flagged for physician' : item.priority === 'urgent' ? 'Urgent' : '',
    active: !closed,
    // Needs-review work before waiting-on-others; urgent first within each.
    urgency: (item.status === 'needs_information' ? 3 : 0) + (item.priority === 'urgent' ? 0 : item.priority === 'soon' ? 1 : 2),
    searchText: `${item.patient_name} ${item.referral_type} ${item.sender_name} ${item.sender_practice ?? ''}`.toLowerCase(),
  }
}

/** Splits work items into the demo's "Active patients" / "Previous care" sections. */
export function patientWorkSections(items: PatientWorkItem[], query = ''): { active: PatientWorkItem[]; previous: PatientWorkItem[] } {
  const q = query.trim().toLowerCase()
  const visible = q ? items.filter((item) => item.searchText.includes(q)) : items
  const newestFirst = (a: PatientWorkItem, b: PatientWorkItem) => b.episode.at.localeCompare(a.episode.at)
  return {
    active: visible.filter((item) => item.active).sort((a, b) => a.urgency - b.urgency || newestFirst(a, b)),
    previous: visible.filter((item) => !item.active).sort(newestFirst),
  }
}

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
