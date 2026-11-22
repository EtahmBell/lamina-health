import { ApiError, apiBaseUrl, apiRequest as baseApiRequest, parseErrorDetail, type NppesIdentity, type OnboardingStatus } from './api.ts'
import { getAccessToken } from './authClient.ts'
import { notifyPilotDataChanged } from './pilotSync.ts'

/** Client for the real, authenticated practice pilot (`/api/me/practice/*`).
 * The client never sends a user id, practice id, owner scope, or role: the backend
 * derives all of them from the verified Supabase token. */

/** Every successful pilot WRITE tells the app its server state changed, so each view
 * re-reads from the backend (see pilotSync.ts). Reads never notify. */
async function apiRequest<T>(path: string, init?: RequestInit): Promise<T> {
  const result = await baseApiRequest<T>(path, init)
  if (init?.method && init.method.toUpperCase() !== 'GET') notifyPilotDataChanged()
  return result
}

const json = (body: unknown): RequestInit => ({
  method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
})

/* --------------------------------------------------------------- onboarding */

export type NameSearchResult = { identity: NppesIdentity; claim_available: boolean }
export const searchPhysicianByName = (name: string, location = '') =>
  apiRequest<{ results: NameSearchResult[]; result_count: number; truncated: boolean }>(
    '/api/me/onboarding/npi/search', json({ name, location }),
  )

/* ----------------------------------------------------------------- practice */

export type PracticeRole = 'physician' | 'staff'
export type PilotNextStep = 'physician_onboarding' | 'practice_setup' | 'pilot_pending' | 'practice_pending' | 'workspace' | 'unavailable'
export type Practice = {
  id: string; name: string; specialty: string | null; website: string | null; address: string | null
  phone: string | null; contact_email: string | null; status: 'active' | 'archived'; created_at: string
}
export type PracticeFields = Pick<Practice, 'name' | 'specialty' | 'website' | 'address' | 'phone' | 'contact_email'>
export type PilotStatus = {
  next_step: PilotNextStep
  role: PracticeRole | null
  /** Practice admin: membership and practice settings (not clinical authority). */
  is_admin?: boolean
  /** Whose agent this is ("Dr. X"); lets staff copy name the physician. */
  physician_name?: string | null
  practice: Practice | null
  physician_onboarding: OnboardingStatus
  practice_defaults: (Partial<PracticeFields> & { source: string }) | null
}
export type PracticeMember = { id: string; role: PracticeRole; label: string | null; is_you: boolean; is_admin?: boolean; joined_at: string }
export type PracticeInvitation = { id: string; role: 'staff'; label: string | null; state: 'pending' | 'accepted' | 'revoked' | 'expired'; created_at: string; expires_at: string }

export const getPilotStatus = () => apiRequest<PilotStatus>('/api/me/practice/status')
export const createPractice = (fields: PracticeFields) => apiRequest<Practice>('/api/me/practice', json(fields))
export const updatePractice = (fields: PracticeFields) => apiRequest<Practice>('/api/me/practice', { ...json(fields), method: 'PUT' })
export const getPracticeMembers = () => apiRequest<{ members: PracticeMember[]; invitations: PracticeInvitation[] }>('/api/me/practice/members')
export const inviteStaff = (label: string) => apiRequest<{ id: string; token: string; expires_at: string; label: string | null }>('/api/me/practice/invitations', json({ role: 'staff', label: label || null }))
export const revokeInvitation = (id: string) => apiRequest<void>(`/api/me/practice/invitations/${encodeURIComponent(id)}`, { method: 'DELETE' })
export const setMemberAdmin = (id: string, isAdmin: boolean) => apiRequest<{ members: PracticeMember[]; invitations: PracticeInvitation[] }>(`/api/me/practice/members/${encodeURIComponent(id)}/admin`, { ...json({ is_admin: isAdmin }), method: 'PUT' })
export const removeStaffMember = (id: string) => apiRequest<void>(`/api/me/practice/members/${encodeURIComponent(id)}`, { method: 'DELETE' })
export const previewInvitation = (token: string) => apiRequest<{ practice_name: string | null; practice_specialty: string | null; role: string; expires_at: string }>('/api/me/practice/invitations/preview', json({ token }))
export const acceptInvitation = (token: string) => apiRequest<PilotStatus>('/api/me/practice/invitations/accept', json({ token }))

/* -------------------------------------------------------------------- rules */

export type RuleRequirement = { key: string; label: string; required: boolean; freshness_days: number | null }
export type Modality = 'in_person' | 'econsult' | 'either' | 'unspecified'
export type PracticeRuleInput = {
  referral_type: string; good_fit: string[]; outside_scope: string[]
  required: RuleRequirement[]; helpful: RuleRequirement[]; urgent_signals: string[]
  modality: Modality; note: string | null; publishable: boolean
  /** Physician-controlled other names for this referral type. */
  aliases?: string[]
  scope_policy?: 'accept' | 'out_of_scope' | 'case_by_case' | null
  preferences?: string[]; exceptions?: string[]; judgment?: string[]; make_optional?: string[]; answered_topics?: string[]
  layer?: 'practice' | 'physician'
}
export type PracticeRule = {
  id: string; referral_type: string; version: number; supersedes_id: string | null
  operational_status: 'inferred' | 'inferred_active' | 'confirmed' | 'superseded' | 'rejected'
  physician_confirmed: boolean; confidence: number | null; source: string; publishable: boolean
  created_at: string; confirmed_at: string | null
  content: {
    good_fit: string[]; redirect: string[]; required: RuleRequirement[]; helpful: RuleRequirement[]
    urgent_signals: string[]; modality: Modality; modality_notes: string | null
    aliases?: string[]
    scope_policy?: 'accept' | 'out_of_scope' | 'case_by_case' | null
    preferences?: string[]; exceptions?: string[]; judgment?: string[]; make_optional?: string[]; answered_topics?: string[]
  }
  layer?: 'practice' | 'physician'
}
export const getPracticeRules = (includeHistory = false) => apiRequest<PracticeRule[]>(`/api/me/practice/rules${includeHistory ? '?include_history=true' : ''}`)
export const createPracticeRule = (rule: PracticeRuleInput) => apiRequest<PracticeRule>('/api/me/practice/rules', json(rule))
export const revisePracticeRule = (id: string, rule: PracticeRuleInput) => apiRequest<PracticeRule>(`/api/me/practice/rules/${encodeURIComponent(id)}`, { ...json(rule), method: 'PUT' })
export const retirePracticeRule = (id: string) => apiRequest<PracticeRule>(`/api/me/practice/rules/${encodeURIComponent(id)}/retire`, { method: 'POST' })

/* ---------------------------------------------------------------- referrals */

export type IntakeStatus = 'received' | 'triaged' | 'needs_information' | 'ready_for_review' | 'accepted' | 'redirected' | 'declined'
export type Fit = 'strong' | 'possible' | 'outside_scope' | 'unknown'
export type Priority = 'routine' | 'soon' | 'urgent'
export type NextStep = 'request_information' | 'confirm_document_evidence' | 'physician_review' | 'consider_redirect'
  | 'review_sender_information' | 'confirm_referral_type'
/** sender_reported: the referring office supplied it; nobody has verified it yet (not satisfied). */
export type RequirementState = 'satisfied' | 'proposed_from_document' | 'sender_reported' | 'missing' | 'optional_missing'
export type TypeMatch = {
  kind: 'exact' | 'normalized' | 'alias' | 'ambiguous' | 'none'; submitted: string
  rule_type: string | null; matched_alias?: string | null; suggestions: string[]
}
export type RationaleSource = {
  kind: 'practice_rule' | 'document' | 'submitted_item' | 'requirement_logic' | 'no_rule' | 'referral_type'
  rule_id: string | null; rule_version: number | null; document_id: string | null
  page: number | null; quote: string | null; item_key: string | null
}
export type RequirementAssessment = {
  key: string; label: string; required: boolean; freshness_days: number | null; state: RequirementState
  rule_id: string; rule_version: number; evidence: RationaleSource | null; detail: string
}
export type TriageRecommendation = {
  id: string; fit: Fit; readiness: 'ready' | 'missing_information' | 'unknown'
  requirements: RequirementAssessment[]; missing_items: string[]
  suggested_priority: Priority; suggested_modality: Modality; requires_physician: boolean
  next_step: NextStep; rationale: RationaleItem[]
  generator: 'deterministic' | 'deterministic+llm_extraction'; model_id: string | null
  rules_snapshot_id: string; created_at: string
  type_match?: TypeMatch | null
  /** Step 17: the representation statements relied on, and any layer conflicts. */
  statements_used?: Array<{ kind: StatementKind; rule_id: string; version: number; layer: 'practice' | 'physician'; referral_type: string; item: string; label?: string | null; drives: boolean }>
  conflicts?: Array<{ kind: string; referral_type: string }>
  representation_version_id?: string | null
}
export type EffectiveTriage = Pick<TriageRecommendation, 'fit' | 'suggested_priority' | 'suggested_modality' | 'requires_physician' | 'next_step'>
export type SubmittedItem = {
  key: string; label?: string | null; value: string; observed_date?: string | null; source?: string
  document_id?: string | null; page?: number | null; recorded_by?: string | null
  verified_by?: string | null; verified_at?: string | null
}
export type ReferralDocument = { id: string; filename: string; content_type: string; size_bytes: number; uploaded_at: string; extraction_status: 'extracted' | 'unsupported' | 'failed' | 'empty'; page_count: number | null }
export type IntakeReferral = {
  id: string; status: IntakeStatus; source: 'manual' | 'upload' | 'public_form'
  sender: { name: string; practice: string | null; contact: string | null; npi: string | null }
  patient: { name: string; date_of_birth: string | null; sex: string | null; phone: string | null; insurance: string | null; external_id: string | null }
  referral_type: string; reason: string; clinical_context: string | null; sender_priority: Priority | null
  /** The referral type exactly as submitted (kept when the team confirms a practice type). */
  submitted_referral_type?: string | null
  submitted_items: SubmittedItem[]; received_at: string; entered_at: string
  escalated_at: string | null; escalation_note: string | null
  information_request: { items: string[]; draft_message: string; sent: boolean; prepared_at: string } | null
  disposition: { decision: 'accept' | 'redirect' | 'decline'; reason: string | null; redirect_to: string | null; at: string } | null
  /** Staff paperwork hand-off to the physician. */
  handoff?: { kind: 'ready' | 'flag'; note: string | null; by: string; role: PracticeRole; at: string } | null
  documents: ReferralDocument[]
}
/** No separate "approve triage": the physician's accept/redirect/decline is the sign-off.
 * `correct` = physician changes fit/priority/visit type; `mark_ready` = staff hand-off. */
export type ReferralAction = 'upload_document' | 'record_item' | 'retriage' | 'correct' | 'mark_ready' | 'request_information' | 'escalate' | 'accept' | 'redirect' | 'decline' | 'verify_item' | 'set_referral_type'
export type ActorRole = 'physician' | 'staff' | 'referring_office' | 'lamina' | 'system'
export type CorrectableField = 'fit' | 'suggested_priority' | 'suggested_modality'
export type TriageCorrection = { id: string; field: CorrectableField; from: string; to: string; agent_value: string; reason: string | null; actor_name: string; actor_role: PracticeRole; created_at: string }
/** `by` caused it; `because` says how (e.g. a rule update); `triggered_by` only re-ran the check. */
export type CorrectionConflict = {
  field: CorrectableField; corrected_value: string; rule_value: string; referral_type: string; rule_id: string; rule_version: number
  corrected_by_name: string | null; rule_by_name: string | null; corrected_by_you: boolean; rule_by_you: boolean
}
export type TriageChange = { field: string; from: unknown; to: unknown; by: string; because: string | null; triggered_by: string | null; at: string }
/** One line of triage rationale. `text` is rendered by the server for this reader from the
 * structured `code` + `params`; `statement` is the stored physician wording. A recommendation
 * stored before structured rationale has no code: its text is shown as written. */
export type RationaleItem = {
  statement: string; source: RationaleSource; code?: string | null; params?: Record<string, unknown>
  text?: string; worded_for_physician?: boolean
}
/** Where a referral stands -- ONE statement shared by the referral page, Home and Patients. */
export type ReferralStanding = {
  heading: string; still_open: string | null; readiness_text: string; complete: boolean; no_requirements: boolean
  open_items: string[]; unverified_items: string[]; waiting_on_office: boolean; has_draft: boolean
}
/** Decline / redirect: has a person told the referring office (outside Lamina)? */
export type OfficeNotification = { state: 'not_sent' | 'sent'; by_name: string | null; at: string | null; draft: string | null }
export type ReferralDetail = {
  referral: IntakeReferral
  recommendation: TriageRecommendation | null
  rules_snapshot: { rules: Array<{ rule_id: string; version: number; referral_type: string }> } | null
  /** The physician whose referrals these are ("Dr. X"), when known. */
  physician_name?: string | null
  /** A review from the retired approval step. A staff review is never physician agreement. */
  legacy_review?: { kind: 'staff_review' | 'physician_review'; decision: 'accepted' | 'edited' | 'rejected'; actor_name: string; actor_role: PracticeRole; created_at: string; reason: string | null } | null
  corrections?: TriageCorrection[]
  signoff?: { id: string; decision: 'accept' | 'redirect' | 'decline'; actor_name: string; actor_role: PracticeRole; created_at: string } | null
  /** Clinical changes by someone else (or Lamina) since you last opened this referral. */
  changes_since_seen?: TriageChange[]
  /** A physician's earlier correction that a newer rule version disagrees with. */
  correction_conflicts?: CorrectionConflict[]
  effective_triage: EffectiveTriage | null
  history: Array<{ event_type: string; actor: string; actor_name?: string; actor_role?: ActorRole; autonomy: 'automatic' | 'human'; metadata: Record<string, unknown>; created_at: string; summary?: string }>
  allowed_actions: ReferralAction[]
  standing?: ReferralStanding
  office_notification?: OfficeNotification | null
  information_requests?: InformationRequest[]
  sender_responses?: SenderResponse[]
}
export type ReferralSummary = {
  id: string; status: IntakeStatus; patient_name: string; referral_type: string
  sender_name: string; sender_practice: string | null; received_at: string
  fit: Fit | null; priority: Priority | null; next_step: NextStep | null; requires_physician: boolean | null
  missing_items: string[]; escalated: boolean; decided: boolean; handoff?: 'ready' | 'flag' | null
  standing?: ReferralStanding; has_conflict?: boolean; handoff_by_name?: string | null; office_notified?: boolean
}
export type NewReferral = {
  source: 'manual' | 'upload'
  sender: { name: string; practice?: string | null; contact?: string | null; npi?: string | null }
  patient: { name: string; date_of_birth?: string | null; phone?: string | null; insurance?: string | null; external_id?: string | null }
  referral_type: string; reason: string; clinical_context?: string | null
  sender_priority?: Priority | null; received_at?: string | null; submitted_items: SubmittedItem[]
}

const referralPath = (id: string, action = '') => `/api/me/practice/referrals/${encodeURIComponent(id)}${action ? `/${action}` : ''}`
export const listReferrals = () => apiRequest<ReferralSummary[]>('/api/me/practice/referrals')
export const getReferral = (id: string) => apiRequest<ReferralDetail>(referralPath(id))
export const createReferral = (referral: NewReferral) => apiRequest<ReferralDetail>('/api/me/practice/referrals', json(referral))
export const retriageReferral = (id: string) => apiRequest<ReferralDetail>(referralPath(id, 'triage'), { method: 'POST' })
/** Physician only: correct fit, priority or visit type before deciding (recorded, not a sign-off). */
export const correctTriage = (id: string, changes: Partial<Pick<EffectiveTriage, CorrectableField>> & { reason?: string | null }) => apiRequest<ReferralDetail>(referralPath(id, 'correct'), json(changes))
/** Staff: the paperwork is done; ready for the physician's decision. */
export const markReferralReady = (id: string, note: string) => apiRequest<ReferralDetail>(referralPath(id, 'mark-ready'), json({ note: note || null }))
/** Physician: keep the earlier correction, or apply the newer rule. The choice is recorded. */
export const resolveCorrectionConflict = (id: string, field: CorrectableField, choice: 'keep_correction' | 'apply_rule') =>
  apiRequest<ReferralDetail>(referralPath(id, 'correction-conflicts'), json({ field, choice }))
export const markReferralSeen = (id: string) => apiRequest<{ seen_at: string }>(referralPath(id, 'seen'), { method: 'POST' })
export const requestInformation = (id: string, items: string[], note: string) => apiRequest<ReferralDetail>(referralPath(id, 'request-information'), json({ items, note: note || null }))
export const escalateReferral = (id: string, note: string) => apiRequest<ReferralDetail>(referralPath(id, 'escalate'), json({ note: note || null }))
export const markOfficeNotified = (id: string) => apiRequest<ReferralDetail>(referralPath(id, 'office-notified'), json({}))
export const verifyReferralItem = (id: string, key: string) => apiRequest<ReferralDetail>(referralPath(id, `items/${encodeURIComponent(key)}/verify`), json({}))
export const setReferralType = (id: string, referralType: string) => apiRequest<ReferralDetail>(referralPath(id, 'referral-type'), json({ referral_type: referralType }))
export const recordReferralItem = (id: string, item: { key: string; value: string; observed_date?: string | null; document_id?: string | null; page?: number | null }) => apiRequest<ReferralDetail>(referralPath(id, 'items'), json(item))
export const decideReferral = (id: string, decision: 'accept' | 'redirect' | 'decline', reason: string, redirectTo: string) =>
  apiRequest<ReferralDetail>(referralPath(id, 'disposition'), json({ decision, reason: reason || null, redirect_to: redirectTo || null }))

async function authHeaders(extra: Record<string, string> = {}): Promise<Headers> {
  const headers = new Headers(extra)
  const token = await getAccessToken()
  if (token) headers.set('Authorization', `Bearer ${token}`)
  return headers
}

async function raise(response: Response): Promise<never> {
  const body = await response.json().catch(() => null) as { detail?: unknown } | null
  const { message, code } = parseErrorDetail(body?.detail, response.status)
  throw new ApiError(message, response.status, code)
}

/** Raw-body upload: the file never passes through a public URL or browser storage. */
export async function uploadReferralDocument(id: string, file: File): Promise<ReferralDetail> {
  const response = await fetch(`${apiBaseUrl}${referralPath(id, 'documents')}`, {
    method: 'POST',
    headers: await authHeaders({ 'Content-Type': file.type || 'application/octet-stream', 'X-Filename': encodeURIComponent(file.name) }),
    body: file,
    credentials: 'include',
  })
  if (!response.ok) return raise(response)
  const detail = await response.json() as ReferralDetail
  notifyPilotDataChanged()
  return detail
}

/** Authenticated download into a short-lived object URL (no bearer token in a link). */
export async function openReferralDocument(documentId: string): Promise<void> {
  const response = await fetch(`${apiBaseUrl}/api/me/practice/documents/${encodeURIComponent(documentId)}`, {
    headers: await authHeaders(), credentials: 'include',
  })
  if (!response.ok) return raise(response)
  const url = URL.createObjectURL(await response.blob())
  window.open(url, '_blank', 'noopener')
  window.setTimeout(() => URL.revokeObjectURL(url), 60_000)
}

/* ---------------------------------------------------- information requests */

export type InformationRequest = {
  id: string; referral_id: string; items: Array<{ label: string; key: string | null }>
  recipient: string | null; channel: 'email' | 'manual'; subject: string; draft_message: string
  status: 'draft' | 'approved' | 'sent' | 'partially_resolved' | 'resolved' | 'cancelled'
  created_by: string; approved_by: string | null; approved_at: string | null; sent_at: string | null
  /** Who drafted / approved it, by name (on referral detail). */
  created_by_name?: string; approved_by_name?: string
  sent_via: string | null; resolved_at: string | null; cancelled_at: string | null
  evidence: Array<{ type: 'document' | 'response'; id: string }>; created_at: string
  /** Present only on the send response: shown once, never stored by the client. */
  status_link?: string
}
export type SenderResponse = { id: string; message: string | null; items: SubmittedItem[]; created_at: string }
const requestPath = (id: string, action = '') => `/api/me/practice/information-requests/${encodeURIComponent(id)}${action ? `/${action}` : ''}`
export const editInformationRequest = (id: string, changes: { message?: string; recipient?: string; subject?: string }) =>
  apiRequest<InformationRequest>(requestPath(id), { ...json(changes), method: 'PUT' })
export const sendInformationRequest = (id: string, mode: 'send' | 'mark_sent') => apiRequest<InformationRequest>(requestPath(id, 'send'), json({ mode }))
/** Revokes the request's current secure link and issues a new one (returned once, never stored). */
export const reissueRequestLink = (id: string, mode: 'send' | 'mark_sent') => apiRequest<InformationRequest>(requestPath(id, 'reissue-link'), json({ mode }))
export const cancelInformationRequest = (id: string) => apiRequest<InformationRequest>(requestPath(id, 'cancel'), { method: 'POST' })
export const resolveInformationRequest = (id: string) => apiRequest<InformationRequest>(requestPath(id, 'resolve'), { method: 'POST' })

/* --------------------------------------------------------------------- home */

export type HomeItem = {
  kind: string; title: string; detail?: string; path: string; action?: string
  referral_id?: string; question_id?: string; proposal_id?: string; at?: string; by_agent?: boolean
}
export type HomeProjection = {
  briefing: { lead: string; detail: string; tail: string; away: string }
  needs_you: HomeItem[]; waiting: HomeItem[]; prepared: HomeItem[]; done: HomeItem[]
  learned: Array<{ referral_type: string; version: number; confirmed_at: string | null }>
  since: string; role: PracticeRole
}
export const getHome = () => apiRequest<HomeProjection>('/api/me/practice/home')

/* ----------------------------------------------------------------- teaching */

export type Proposal = {
  id: string; referral_type: string; source_text: string
  content: PracticeRule['content'] & { interpretation_note?: string | null }
  confidence: number | null; operational_status: PracticeRule['operational_status']; physician_confirmed: boolean
  /** What the proposal is based on, in words ("Seen in 3 of the last 4 … decisions") -- shown, not the number. */
  basis?: string
  source: string; structured: boolean
  clarification: { question: string; options: string[] } | null; interpreter: string | null
  question_id: string | null; created_at: string
  /** What the agent did NOT turn into a rule, and why (negations, exceptions, vague recency). */
  review_notes?: string[]
  layer?: 'practice' | 'physician'; setup_stage?: string | null
  /** A starter referral type Lamina suggested (name only); stays labelled "Suggested". */
  suggested?: boolean
  /** A staff member's suggestion: pending until a physician confirms it. */
  suggested_by_name?: string | null; suggested_by_role?: 'staff' | null
}
export type LearningQuestion = { id: string; question: string; proposal_id: string; evidence_count: number; status: string; created_at: string }
export const getTeaching = () => apiRequest<{ proposals: Proposal[]; question: LearningQuestion | null; referral_types: string[] }>('/api/me/practice/teach')
export const teachAgent = (text: string) => apiRequest<Proposal>('/api/me/practice/teach', json({ text }))
export const clarifyProposal = (id: string, answer: string) => apiRequest<Proposal>(`/api/me/practice/teach/${encodeURIComponent(id)}/clarify`, json({ answer }))
export const confirmProposal = (id: string, edits?: PracticeRuleInput) => apiRequest<{ rule: PracticeRule; proposal_id: string }>(`/api/me/practice/teach/${encodeURIComponent(id)}/confirm`, json({ edits: edits ?? null }))
export const rejectProposal = (id: string, reason?: string) => apiRequest<Proposal>(`/api/me/practice/teach/${encodeURIComponent(id)}/reject`, json({ reason: reason ?? null }))
export const answerLearningQuestion = (id: string, answer: 'yes' | 'edit' | 'depends' | 'ignore', note?: string, edits?: PracticeRuleInput) =>
  apiRequest<unknown>(`/api/me/practice/learning/questions/${encodeURIComponent(id)}/answer`, json({ answer, note: note || null, edits: edits ?? null }))

/* ----------------------------------------------------------- public profile */

export type PublicReferralType = {
  name: string; good_fit: string[]; not_seen: string[]
  required: Array<{ label: string; within_days: number | null }>; helpful: string[]; modality: Modality
}
export type PublicSnapshot = {
  practice: { name: string; specialty: string | null; phone: string | null; website: string | null; contact_email: string | null }
  physicians: Array<{ name: string; specialty: string | null }>; locations: string[]
  intro: string; insurance: string; how_to_refer: string; hours: string
  referral_types: PublicReferralType[]; modalities: Modality[]; accepts_public_referrals: boolean
}
export type PublicSettings = { intro: string; insurance: string; how_to_refer: string; hours: string; locations: string[]; show_physicians: boolean; accepts_public_referrals: boolean }
export type PublicProfilePreview = {
  slug: string; status: 'draft' | 'published' | 'unpublished'; settings: PublicSettings
  draft_snapshot: PublicSnapshot; published_version: { version: number; published_at: string } | null
  unpublished_changes: boolean; rules: Array<{ id: string; referral_type: string; version: number; publishable: boolean }>
}
export const getPublicProfilePreview = () => apiRequest<PublicProfilePreview>('/api/me/practice/public-profile')
export const savePublicProfileSettings = (changes: Partial<PublicSettings> & { slug?: string }) => apiRequest<PublicProfilePreview>('/api/me/practice/public-profile', { ...json(changes), method: 'PUT' })
export const publishPublicProfile = () => apiRequest<PublicProfilePreview>('/api/me/practice/public-profile/publish', { method: 'POST' })
export const unpublishPublicProfile = () => apiRequest<PublicProfilePreview>('/api/me/practice/public-profile/unpublish', { method: 'POST' })
export const setRulePublishable = (id: string, publishable: boolean) => apiRequest<PracticeRule>(`/api/me/practice/rules/${encodeURIComponent(id)}/publishable`, { ...json({ publishable }), method: 'PUT' })

/* ------------------------------------------------------------------ metrics */

export type MetricSection = 'usage' | 'referral_quality' | 'agent_trust' | 'learning' | 'public' | 'operations'
export type PilotMetrics = Record<MetricSection, Record<string, unknown>> & { window_start: string | null }
export const getPilotMetrics = () => apiRequest<{ all_time: PilotMetrics; weekly: { since: string; text: string; metrics: PilotMetrics } }>('/api/me/practice/metrics')

/* ---------------------------------------------------------------- assistant */
/* The practice's conversational agent. It reads and prepares; any card that changes
 * state names an existing endpoint the human triggers by clicking. */

export type AgentReferralDraft = Partial<Record<'patient_name' | 'patient_dob' | 'referral_type' | 'reason' | 'sender_name' | 'sender_practice', string>>
export type AgentCardExecute =
  | { type: 'create_information_request'; referral_id: string; items: string[] }
  | { type: 'escalate'; referral_id: string }
  | { type: 'open_referral_draft'; draft: AgentReferralDraft }
export type AgentCard = {
  kind: 'link' | 'proposal' | 'information_request' | 'physician_review' | 'referral_draft'
  label: string; detail: string; action: string; path?: string | null; proposal_id?: string; execute?: AgentCardExecute
}
export type AgentReplyBody = { paragraphs: string[]; bullets?: string[]; cards?: AgentCard[] }
export type AgentMessage = {
  id: string; role: 'user' | 'agent'; text: string; intent: string | null; reply: AgentReplyBody | null
  interpreter: string | null; focus_referral_id: string | null; context_referral_id?: string | null; created_at: string
}
export const getAssistant = () => apiRequest<{ messages: AgentMessage[]; retention_days: number; model_available: boolean }>('/api/me/practice/assistant')
export const sendAssistantMessage = (text: string, referralId?: string | null) =>
  apiRequest<{ user_message: AgentMessage; reply: AgentMessage }>('/api/me/practice/assistant/messages', json({ text, referral_id: referralId ?? null }))
export const clearAssistantHistory = () => apiRequest<void>('/api/me/practice/assistant/history', { method: 'DELETE' })

/* ------------------------------------------------------- representation (Step 17) */

export type StatementKind = 'hard_requirement' | 'scope_policy' | 'soft_preference' | 'exception' | 'physician_judgment' | 'unknown'
export type ScopeChoice = 'accept' | 'out_of_scope' | 'case_by_case' | 'unknown'
export type SetupStageId = 'identity' | 'scope' | 'requirements' | 'delegation' | 'review'
export type SetupStageStatus = 'not_started' | 'in_progress' | 'done' | 'skipped'
export type Lifecycle = {
  state: 'initializing' | 'shadow' | null; label: string | null; shadow_at?: string | null
  stages: Array<{ id: SetupStageId; label: string; status: SetupStageStatus; minutes: number }>
  next_stage: SetupStageId | null; minutes_remaining: number; setup_complete: boolean; migrated: boolean
}
export type RepresentationItem = {
  kind: StatementKind; text: string; status: 'confirmed' | 'proposed'; rule_id: string; version: number
  layer: 'practice' | 'physician'; source: string; confirmed_at: string | null; key?: string; value?: string
  /** "urgency": an urgency signal (drives priority), shown with its own label. */
  subkind?: 'urgency'
}
export type RepresentationType = {
  referral_type: string; aliases: string[]; scope_policy: Exclude<ScopeChoice, 'unknown'> | null
  layers: string[]; items: RepresentationItem[]; unknown_topics: Array<'scope' | 'requirements' | 'urgency' | 'modality'>
}
export type DelegationAnswer = { handled_by: 'physician' | 'staff' | 'agent_prepares'; autonomy: 'off' | 'observe' | 'prepare_drafts' | 'ask_before_acting' }
export type Representation = {
  types: RepresentationType[]; conflicts: Array<{ kind: string; referral_type: string; [key: string]: unknown }>
  delegation: Record<string, DelegationAnswer>; delegation_tasks: Record<string, string>
  profile: SetupProfile | null; unknowns: string[]; version: { id: string; version: number; created_at: string } | null
  lifecycle: Lifecycle; view: 'physician' | 'staff_practice_level'; is_practice_admin: boolean
}
export type SetupProfile = { specialty: string | null; subspecialty: string | null; locations: string[]; clinical_interests: string[]; sources?: Record<string, string> }
export type SetupView = {
  lifecycle: Lifecycle; profile: SetupProfile | null
  prefill: { specialty: { value: string | null; source: string }; locations: { value: string[]; source: string }; display_name: string | null }
  delegation: Record<string, DelegationAnswer>; delegation_tasks: Array<{ id: string; label: string }>
  referral_types: string[]; starter_suggestions: string[]; is_practice_admin: boolean; pending: Proposal[]
}
export type LearningSummary = {
  since: string
  confirmed_this_week: Array<{ rule_id: string; referral_type: string; version: number; layer: string; confirmed_at: string; source: string }>
  pending_learnings: Proposal[]; setup_pending: Proposal[]
  open_questions: Array<{ id: string; question: string; proposal_rule_id: string; created_at: string }>
  lifecycle: Lifecycle
  /** Pending questions beyond today's one (one question a day); not actionable yet. */
  queued_questions: Array<{ id: string; question: string; proposal_rule_id: string; created_at: string }>
  counts: { confirmed_this_week: number; pending_learnings: number; open_questions: number; queued_questions: number; setup_pending: number }
}
export type RequirementsAnswer = {
  referral_type: string; text?: string | null; required?: Array<{ label: string; freshness_days: number | null }>
  helpful?: Array<{ label: string; freshness_days: number | null }>; urgent_signals?: string[]
  modality?: Modality | null; nothing_required?: boolean; no_urgency_signals?: boolean
}
const representationPath = (suffix = '') => `/api/me/practice/representation${suffix}`
export const getRepresentation = () => apiRequest<Representation>(representationPath())
export const getLearningSummary = () => apiRequest<LearningSummary>(representationPath('/summary'))
export const getSetup = () => apiRequest<SetupView>(representationPath('/setup'))
export const saveSetupIdentity = (profile: SetupProfile) => apiRequest<SetupView>(representationPath('/setup/identity'), { ...json(profile), method: 'PUT' })
export const saveSetupScope = (types: Array<{ referral_type: string; aliases: string[]; policy: ScopeChoice; suggested?: boolean }>) =>
  apiRequest<{ proposals: Proposal[]; setup: SetupView }>(representationPath('/setup/scope'), json({ types }))
export const saveSetupRequirements = (answer: RequirementsAnswer) =>
  apiRequest<{ proposal: Proposal | null; review_notes: string[]; clarification: { question: string; item: string } | null; setup: SetupView }>(representationPath('/setup/requirements'), json(answer))
export const saveSetupDelegation = (answers: Record<string, DelegationAnswer>) => apiRequest<SetupView>(representationPath('/setup/delegation'), { ...json({ answers }), method: 'PUT' })
export const finishSetupStage = (stage: SetupStageId) => apiRequest<SetupView>(representationPath(`/setup/${stage}/finish`), { method: 'POST' })
export const skipSetupStage = (stage: SetupStageId) => apiRequest<SetupView>(representationPath(`/setup/${stage}/skip`), { method: 'POST' })
export const confirmRepresentation = () => apiRequest<{ version: { id: string; version: number }; lifecycle: Lifecycle; representation: Representation }>(representationPath('/confirm'), { method: 'POST' })
export const leaveProposalUnknown = (id: string) => apiRequest<Representation>(representationPath(`/proposals/${encodeURIComponent(id)}/leave-unknown`), { method: 'POST' })

/* ------------------------------------------------- public (no account needed) */

export type PublicAnswer = { answer: string; category: string; in_scope: boolean; suggest_referral: boolean; fit: string | null; disclaimer: string }
export type PublicReferralInput = {
  sender: { name: string; practice?: string | null; contact?: string | null; npi?: string | null }
  patient: { name: string; date_of_birth?: string | null; phone?: string | null; insurance?: string | null }
  referral_type: string; reason: string; clinical_context?: string | null; sender_priority?: Priority | null; website?: string
}
export type SenderView = {
  practice: { name: string; phone: string | null; contact_email: string | null }
  referral: { patient_initials: string; referral_type: string; received_at: string; status: string; closed: boolean }
  requested_items: Array<{ label: string; key: string | null; received: boolean; state?: 'requested' | 'received' | 'verified' }>
  your_uploads: Array<{ filename: string; uploaded_at: string }>
  can_respond: boolean
}
const publicJson = (body: unknown): RequestInit => ({ ...json(body), credentials: 'omit' })
async function publicGet<T>(path: string): Promise<T> {
  const response = await fetch(`${apiBaseUrl}${path}`, { credentials: 'omit' })
  if (!response.ok) return raise(response)
  return response.json() as Promise<T>
}
async function publicPost<T>(path: string, body?: unknown): Promise<T> {
  const response = await fetch(`${apiBaseUrl}${path}`, body === undefined ? { method: 'POST', credentials: 'omit' } : publicJson(body))
  if (!response.ok) return raise(response)
  if (response.status === 204) return undefined as T
  return response.json() as Promise<T>
}
/* Public calls never attach the signed-in user's token: the public surface is anonymous by design. */
export const getPublicProfile = (slug: string) => publicGet<{ slug: string; version: number; profile: PublicSnapshot }>(`/api/public/p/${encodeURIComponent(slug)}`)
export const askPublicAgent = (slug: string, question: string, referralContext?: string) =>
  publicPost<PublicAnswer>(`/api/public/p/${encodeURIComponent(slug)}/ask`, { question, referral_context: referralContext || null })
export const markReferralStarted = (slug: string) => publicPost<void>(`/api/public/p/${encodeURIComponent(slug)}/referral-started`)
export const submitPublicReferral = (slug: string, referral: PublicReferralInput) =>
  publicPost<{ received: boolean; token: string | null; status_url: string | null; practice_name?: string }>(`/api/public/p/${encodeURIComponent(slug)}/referrals`, referral)
export const getSenderStatus = (token: string) => publicGet<SenderView>(`/api/public/r/${encodeURIComponent(token)}`)
export const respondAsSender = (token: string, message: string, items: Array<{ key: string; value: string; observed_date?: string | null }>) =>
  publicPost<SenderView>(`/api/public/r/${encodeURIComponent(token)}/response`, { message: message || null, items })
export async function uploadAsSender(token: string, file: File): Promise<SenderView> {
  const response = await fetch(`${apiBaseUrl}/api/public/r/${encodeURIComponent(token)}/documents`, {
    method: 'POST', credentials: 'omit',
    headers: { 'Content-Type': file.type || 'application/octet-stream', 'X-Filename': encodeURIComponent(file.name) },
    body: file,
  })
  if (!response.ok) return raise(response)
  return response.json() as Promise<SenderView>
}
