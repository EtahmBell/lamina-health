import { getAccessToken } from './authClient.ts'

const API_BASE_URL = (import.meta.env.VITE_API_BASE_URL || 'http://127.0.0.1:8000').replace(/\/$/, '')
const workspaceBootstrapToken = Array.from(
  globalThis.crypto.getRandomValues(new Uint8Array(32)),
  (value) => value.toString(16).padStart(2, '0'),
).join('')
let workspaceProvisioned = false

const isWorkspaceScopedPath = (path: string) => path.startsWith('/api/workspace') || path.startsWith('/api/patients')

export type LabObservation = {
  date: string
  test: 'creatinine' | 'eGFR' | 'hemoglobin' | 'ferritin' | 'serum_iron' | 'TIBC' | 'transferrin_saturation' | 'MCV' | 'WBC' | 'platelets'
  value: number
  unit: string
}
export type Patient = {
  id: string; display_name: string; synthetic: true; age: number; diagnoses: string[]
  medications: string[]; labs: LabObservation[]; clinical_notes: string[]; insurance: string; location: string
  clinical_data_source: 'synthetic_fixture' | 'medplum_fhir'
}
export type Evidence = { kind: string; detail: string }
export type ConsultationMessage = {
  id: string; consultation_id: string; sequence: number; sender_agent_id: string
  sender_name: string; sender_role: string; recipient_agent_id: string
  message_type: 'consult_request' | 'fit_response' | 'follow_up_question' | 'follow_up_answer' | 'referral_requirement' | 'redirect' | 'access_update' | 'synthesis'
  summary: string; evidence: Evidence[]; related_patient_facts: string[]
  metadata: Record<string, string | number | boolean>
}
export type Evaluation = {
  physician_id: string; physician_name: string; specialty: string
  clinical_fit: 'strong' | 'moderate' | 'poor'; accepts_case: boolean; reason: string
  evidence: Evidence[]; required_workup: string[]; urgency: string
  availability: string; insurance_status: string; confidence: string
}
export type Consultation = {
  consultation_id: string; patient_id: string; patient_facts_used: string[]; recommended_physician: Evaluation
  why: string; before_referral: string[]; availability: string; insurance: string
  alternatives: Evaluation[]; consultation: Evaluation[]; messages: ConsultationMessage[]; disclaimer: string
}
export type PatientActivity = {
  patient_id: string; last_opened: string | null; last_started: string | null
  last_consultation: string | null; consultation_count: number; has_consultation: boolean
  latest_consultation_id: number | null; latest_consulted_at: string | null
  latest_recommended_physician: string | null; latest_recommended_specialty: string | null
}
export type ConsultationRecord = { id: number; patient_id: string; completed_at: string; result: Consultation }
export type AgentLearning = { key: string; statement: string; provenance: string; status: 'suggested' | 'confirmed' | 'rejected'; updated_at: string | null }
export type MyAgent = {
  id: string; physician: string; specialty: string; status: string; synthetic: boolean; location: string
  known: { label: string; value: string; source: string }[]
  access: { label: string; detail: string }[]
  learnings: AgentLearning[]
  calibrations: Record<string, { question: string; answer: string; based_on: string[] }>
}
export type AgentStatus = 'reserved' | 'claimed' | 'verification_pending' | 'verified' | 'active' | 'disabled'
export type ClaimStatus = 'claimed' | 'verification_pending' | 'verified' | 'rejected' | 'revoked'
export type AgentPreferences = {
  areas_of_focus: string[]; cases_accepted: string[]; cases_redirected: string[]
  preferred_pre_referral_workup: string[]; notes: string
}
export type PhysicianNetworkProfile = {
  npi: string; display_name: string; specialty: string; taxonomy_code: string | null
  organization: string | null; city: string; state: string; phone: string | null
  source: 'NPPES' | 'SYNTHETIC'; consult_eligible: boolean; consult_physician_id: string | null
  directory_disclaimer: string
  agent: { id: string; status: AgentStatus; practice_confirmed: boolean; preferences: AgentPreferences | null }
  synthetic: boolean; lifecycle_status: AgentStatus; claimable: boolean; agent_active: boolean
  claimed_by_me: boolean; my_claim_id: number | null; my_claim_status: ClaimStatus | null
}
export type ProviderClaim = {
  id: number; npi: string; status: ClaimStatus; claimed_at: string
  verification_submitted_at: string | null; verified_at: string | null
  updated_at: string; verification_method: string | null
}
export type ProviderClaimState = {
  npi: string; synthetic: boolean; lifecycle_status: AgentStatus; claimable: boolean
  agent_active: boolean; claimed_by_me: boolean; my_claim_id: number | null
  my_claim_status: ClaimStatus | null
}
export type ProviderSearchResponse = {
  results: PhysicianNetworkProfile[]; count: number; directory_available: boolean
  directory_records: number; data_mode: 'read_only_nppes_with_synthetic_demo'
  directory_status: 'available' | 'unavailable' | 'invalid_query' | 'no_results'
  directory_backend: 'local_snapshot' | 'live_api' | 'unavailable'; directory_message: string | null
}
export type PhysicianSandboxCapabilities = {
  can_edit_profile: boolean; can_enrich_profile: boolean; can_train_agent: boolean
  can_test_agent: boolean; can_draft_posts: boolean; can_publish_profile: boolean
  can_publish_posts: boolean; can_join_network: boolean; can_access_patients: boolean
  can_access_clinical_cases: boolean
}
export type PhysicianSandboxStatus = {
  has_claim: boolean; claim_status: ClaimStatus | null
  verification_status: 'unverified' | 'verified'
  publication_status: 'private' | 'published' | 'unpublished'
  clinical_access_status: 'unavailable' | 'enabled'
  provider_identity: (Pick<PhysicianNetworkProfile, 'npi' | 'display_name' | 'specialty' | 'taxonomy_code' | 'organization' | 'city' | 'state' | 'phone' | 'source' | 'directory_disclaimer'>) | null
  profile_ready: boolean; initialization_required: boolean; initialized: boolean
  agent_ready: boolean; capabilities: PhysicianSandboxCapabilities
}
export type OwnedPhysicianIdentity = NonNullable<PhysicianSandboxStatus['provider_identity']> & {
  id: string; synthetic: false
}
export type OwnedProfessionalProfile = Omit<ProfessionalProfile, 'physician' | 'synthetic'> & {
  physician: OwnedPhysicianIdentity; base_identity: NonNullable<PhysicianSandboxStatus['provider_identity']>
  synthetic: false
}
export type AgentRelationship = {
  source_agent: string; target_agent: string; relationship_type: 'recommended' | 'redirected' | 'consulted'
  consultation_count: number; recommended_count: number; redirect_count: number
  most_recent_interaction: string; last_patient_id: string; last_patient_name: string
  last_record_id: number; associated_consultation_ids: number[]
  most_recent_recommendation: string | null; last_recommendation_patient_id: string | null
  last_recommendation_patient_name: string | null; last_recommendation_record_id: number | null
}
export type NetworkAgent = {
  id: string; physician_id: string; npi: string; name: string; specialty: string; subspecialty: string
  location: string; status: AgentStatus; source: 'SYNTHETIC'; focus_areas: string[]
  required_workup: string[]; explicit_rules: string[]; confirmed_preferences: AgentPreferences | null
  provenance: string; relationship: AgentRelationship | null
  /** A referral relationship the clinician recorded. Never implies agent activation. */
  in_network: boolean; added_at: string | null
}
/** A recorded relationship with a physician outside the synthetic consult roster. */
export type NetworkMemberProfile = {
  npi: string; added_at: string; resolved: boolean; name: string; specialty: string; location: string
  agent_id: string | null; status: AgentStatus | null; source: 'NPPES' | 'SYNTHETIC' | null
}
export type NetworkMember = { npi: string; added_at: string }
export type AgentNetwork = {
  center: { id: string; name: string; specialty: string; location: string; status: 'active'; source: string }
  nodes: NetworkAgent[]; edges: AgentRelationship[]; members: NetworkMemberProfile[]
  record_count: number; relationship_source: string; status_note: string
}
export type SpecialistOutcome = 'recommended' | 'alternative' | 'redirected' | 'consulted_not_selected'
export type SpecialistReviewState = { reviewed: boolean; reviewed_at: string | null }
export type SpecialistCaseSummary = SpecialistReviewState & {
  consultation_id: string; consultation_record_id: number; patient_id: string
  patient_name: string; patient_age: number | null; patient_location: string | null
  referring_physician: string; referring_agent: string; consulted_at: string
  referral_question: string; specialist_outcome: SpecialistOutcome
  specialist_response_summary: string; recommendation_physician: string
  recommendation_specialty: string; was_recommended: boolean; clarification_count: number
  event_ids: string[]; availability: string
}
export type SpecialistAgentInteraction = {
  event_id: string; sequence: number; direction: 'from_specialist_agent' | 'to_specialist_agent'
  message_type: ConsultationMessage['message_type']; summary: string
  supporting_evidence: Evidence[]; related_patient_facts: string[]
  metadata: Record<string, string | number | boolean>
}
export type SpecialistCalibration = {
  key: string; consultation_record_id: number; question: string; statement: string
  based_on: string[]; status: 'suggested' | 'confirmed' | 'rejected'
  provenance: string; updated_at: string | null
}
export type SpecialistCaseDetail = SpecialistCaseSummary & {
  case_context: {
    patient: { id: string; name: string; age: number | null; location: string | null; synthetic: true }
    referring_physician: { name: string; specialty: string; agent_id: string; agent_name: string }
    consultation_purpose: string; referral_question: string | null
  }
  agent_received: { summary: string; facts: string[]; signals: string[]; source: string }
  agent_response: {
    interactions: SpecialistAgentInteraction[]; fit: 'strong' | 'moderate' | 'poor'
    accepts_case: boolean; required_workup: string[]; access: string; explicit_rules_used: string[]
  }
  network_outcome: {
    specialist_outcome: SpecialistOutcome; recommended_physician: string
    recommended_specialty: string; was_recommended: boolean; final_synthesis: string
    recommendation_rationale: string; synthesis_event_id: string | null
  }
  network_context: {
    participants: Array<{
      agent_id: string; physician_id: string; physician_name: string; specialty: string
      interaction_outcome: SpecialistOutcome; agent_response_summary: string; event_ids: string[]
    }>
    source: string
  }
  calibration: SpecialistCalibration; disclaimer: string
}
export type SpecialistWorkspace = {
  physician: {
    npi: string; physician_id: string; physician: string; specialty: string; location: string
    agent_id: string; agent_name: string; synthetic: true; status: 'reserved'
    perspective: 'controlled_demo'; disclaimer: string
  }
  recent_cases: SpecialistCaseSummary[]; latest_case_activity: string | null
  recommended_case_count: number; unreviewed_case_count: number; case_count: number
}
export type DemoPhysicianPerspective = 'lucy' | 'iain'
export type ProfileProvenance = 'synthetic_demo' | 'nppes' | 'physician_entered' | 'imported' | 'confirmed_by_physician' | 'confirmed_public_candidate'
export type ProfileCategory = 'about' | 'training' | 'experience' | 'affiliations' | 'clinical_interests' | 'skills_or_procedures' | 'research' | 'publications' | 'teaching' | 'languages' | 'locations' | 'professional_links'
export type ControlledPhysicianIdentity = {
  id: string; physician_id: string | null; npi: string | null; name: string
  specialty: string; location: string; agent_id: string; agent_name: string; synthetic: boolean
}
export type ProfileItem = {
  id: string; category: ProfileCategory; title: string; detail: string | null
  provenance: ProfileProvenance; shareable: boolean; created_at: string; updated_at: string
}
export type PhysicianInterestType = 'clinical_interest' | 'case_interest' | 'research_interest' | 'teaching_interest'
export type PhysicianInterest = {
  id: string; interest_type: PhysicianInterestType; title: string; detail: string | null
  provenance: string; confirmed: boolean; shareable: boolean; created_at: string; updated_at: string
}
export type ProfessionalProfile = {
  physician: ControlledPhysicianIdentity; items: ProfileItem[]; interests: PhysicianInterest[]
  sections: Record<ProfileCategory, ProfileItem[]>
  completeness: {
    completed_section_count: number; total_section_count: number; incomplete_sections: ProfileCategory[]
    meaning: string
  }
  synthetic: boolean
}
export type PracticeLearning = {
  id: number | string; statement: string; provenance: string
  status: 'suggested' | 'confirmed' | 'rejected'; source_type: string
  source_reference: string; updated_at: string | null
}
export type PracticeRepresentation = {
  physician: ControlledPhysicianIdentity
  sections: {
    specialty: string; clinical_focus: string[]; good_fit: string[]; not_a_fit: string[]
    referral_requirements: string[]; preferred_workup: string[]; access_facts: string[]
    explicit_rules: string[]; confirmed_learnings: PracticeLearning[]
    interests: PhysicianInterest[]; interest_safety: string
  }
  gaps: {
    unanswered_questions: TrainingQuestion[]; unconfirmed_rules: PracticeLearning[]
    practice_areas_needing_input: string[]
  }
  completeness: {
    confirmed_practice_item_count: number; questions_waiting: number
    profile_sections_incomplete: number; meaning: string
  }
  ranking_effect: 'none'
}
export type TrainingQuestionType = 'yes_no' | 'yes_no_depends' | 'single_choice' | 'multi_select' | 'short_text'
export type TrainingQuestion = {
  id: string; physician_persona: string
  source_type: 'profile_confirmation' | 'existing_practice_rule' | 'canonical_case' | 'network_question' | 'explicit_synthetic_demo' | 'initialization' | 'unresolved_branch' | 'practice_gap' | 'bounded_practice_context' | 'deterministic_branch' | 'agent_chat_correction'
  source_reference: string | null; prompt: string; question_type: TrainingQuestionType
  answer_options: string[]; why_this_matters: string; status: 'unanswered' | 'answered' | 'skipped'
  asked_count: number | null; synthetic: true; created_at: string
  root_question_id: string; parent_question_id: string | null; branch_depth: number
  branch_path: string[]; branch_condition: string | null; terminal: boolean
  generated_from: string; priority: number
  dimension_being_narrowed?: string; terminal_candidate?: boolean
  source_references?: string[]; proposed_boundary_rationale?: string
  generation_provider?: 'responses_api' | 'deterministic_fallback'
}
export type TrainingResponse = {
  session_id: number; question_id: string; answer: string | string[] | null
  skipped: boolean; answered_at: string; next_question?: TrainingQuestion | null
  answered_count?: number; answer_target?: number; questions_complete?: boolean
  deferred_branch?: TrainingQuestion | null; completion_summary?: TrainingCompletionSummary | null
}
export type ProposedLearning = {
  id: number; persona_id: string; source_type: string; source_reference: string
  statement: string; provenance: string; status: 'suggested' | 'confirmed' | 'rejected'
  review_action?: 'confirm' | 'edit' | 'reject' | null; created_at: string; updated_at: string
}
export type TrainingSession = {
  id: number; persona_id: string; status: 'active' | 'completed'
  created_at: string; completed_at: string | null; questions?: TrainingQuestion[]
  responses?: TrainingResponse[]; proposed_learnings?: ProposedLearning[]
  mode?: 'initialization' | 'daily' | 'extended' | 'focused'; question_limit?: number
  answer_target?: number; lifecycle_state?: 'active' | 'questions_complete' | 'review_complete' | 'abandoned'
  questions_complete_at?: string | null; review_completed_at?: string | null
  review_deferred?: boolean; focused_seed_id?: string | null
  completion_summary?: TrainingCompletionSummary
}
export type TrainingCompletionSummary = {
  answered_count: number; target_count: number; proposed_learning_count: number
  unresolved_question_count: number; pending_review_count: number; more_training_available: boolean
}
export type TrainingHistoryEntry = {
  session_id: number; mode: 'initialization' | 'daily' | 'extended' | 'focused'
  lifecycle_state: 'active' | 'questions_complete' | 'review_complete' | 'abandoned'
  started_at: string; completed_at: string | null; answered_count: number; target_count: number
  proposed_count: number; confirmed_count: number; edited_count: number; rejected_count: number
  deferred_branch_count: number
}
export type TrainingState = 'initialization_needed' | 'ready' | 'active_unstarted' | 'active_in_progress' | 'review_pending' | 'caught_up'
export type TrainingAction = 'continue_setup' | 'start_training' | 'resume_training' | 'review_training' | 'none'
export type TrainProjection = {
  state: TrainingState; action: TrainingAction
  active_session_id: number | null; review_session_id: number | null
  answered_count: number; answer_target: number | null; review_pending: boolean
  initialization_required: boolean; initialized: boolean
  training_status: 'active' | 'ready'; current_session: TrainingSession | null
  questions_answered_total: number; sessions_completed: number; last_trained_at: string | null
  more_training_available: boolean; available_total: number
  recent_training_history: TrainingHistoryEntry[]; deferred_branch_count: number
  pending_training_review_count: number
}
export type TrainingQueueSummary = {
  recommended_today: number; unanswered_total: number; available_total: number
  answered_today: number; daily_limit: number; extended_limit: number
  availability_model: 'lazy_grounded_sources'
}
export type TrainingWorkspace = {
  physician: ControlledPhysicianIdentity; questions: TrainingQuestion[]
  sessions: TrainingSession[]; responses: TrainingResponse[]; proposed_learnings: ProposedLearning[]
  queue_summary: TrainingQueueSummary
}
export type PostType = 'profile_update' | 'practice_update' | 'referral_guidance' | 'share_paper' | 'research_update' | 'teaching_update' | 'interesting_case' | 'availability' | 'professional_update' | 'other'
export type PracticeUpdateType = 'practice_focus' | 'referral_guidance' | 'availability' | 'publication' | 'research' | 'teaching' | 'location' | 'professional_update'
export type PracticeUpdate = {
  id: number | string; persona_id?: string; physician_persona?: string
  type: PracticeUpdateType; title: string; body: string; provenance: string
  status: 'draft' | 'published' | 'archived'; agent_drafted?: boolean
  created_at: string; updated_at?: string; published_at: string | null; synthetic?: true
  authored_by?: 'physician'; drafted_by?: 'physician' | 'lamina_agent'
  physician_approved?: boolean; visibility?: 'network' | 'private'; source_input?: Record<string, unknown> | null
  synthetic_case?: boolean; case_safety_label?: string | null
}
export type ProfessionalPost = Omit<PracticeUpdate, 'type'> & { type: PostType }
export type AgentInitializationStatus = {
  status: 'setup_needed' | 'in_progress' | 'initialized'; initialized: boolean
  initialized_at: string | null
  required_steps: { id: string; label: string }[]
  completed_steps: { id: string; label: string }[]
  initialized_sections: string[]; incomplete_sections: string[]
  high_value_questions_remaining: number; blocking: false; meaning: string
}
export type AgentInitialization = AgentInitializationStatus
export type AgentOverviewStats = {
  questions_answered_total: number; training_sessions_completed: number
  confirmed_practice_learnings: number; case_interests_count: number
  network_cases_count: number; last_trained_at: string | null
  published_updates_count: number; network_physicians_count: number
}
export type AgentOverview = {
  physician: ControlledPhysicianIdentity; specialty: string; location: string
  portrait: string; portrait_confirmed_facts: string[]; stats: AgentOverviewStats
  initialization: AgentInitializationStatus; training: TrainProjection; last_trained_at: string | null
  more_training_available: boolean
  next_action: TrainingAction
  ranking_effect: 'none'
}
export type OwnedTrainingQuestion = Omit<TrainingQuestion, 'physician_persona'> & { physician_persona: string }
export type OwnedTrainingSession = Omit<TrainingSession, 'persona_id' | 'questions'> & {
  persona_id: string; questions?: OwnedTrainingQuestion[]
}
export type OwnedTrainProjection = Omit<TrainProjection, 'current_session'> & {
  current_session: OwnedTrainingSession | null
}
export type OwnedPracticeRepresentation = Omit<PracticeRepresentation, 'physician' | 'gaps'> & {
  physician: OwnedPhysicianIdentity
  gaps: Omit<PracticeRepresentation['gaps'], 'unanswered_questions'> & { unanswered_questions: OwnedTrainingQuestion[] }
}
export type OwnedAgentOverview = Omit<AgentOverview, 'physician' | 'training'> & {
  physician: OwnedPhysicianIdentity; training: OwnedTrainProjection
}
export type OwnedProfessionalPost = Omit<ProfessionalPost, 'persona_id'> & { persona_id?: string }
export type AgentTestCase = {
  id: string; title: string; summary: string; facts: string[]
  intended_domain: string; source: string
}
export type AgentChatRequest = {
  mode: 'practice_question' | 'synthetic_case'; message: string
  controlled_test_case_id?: string; origin?: 'practice' | 'synthetic_demo' | 'real_patient'
}
export type AgentChatResponse = {
  response_id: string; mode: AgentChatRequest['mode']; answer: string
  evidence_summary: string[]; based_on: string[]
  coverage: 'represented' | 'confirmed_representation' | 'confirmed_training' | 'uncertain'
  uncertainty: string | null; can_train_from_this: boolean
  controlled_test_case_id: string | null; provider: 'responses_api' | 'deterministic_fallback'
  synthetic_only: true
}
export type FocusedTrainingSeed = {
  seed_id: string; chat_response_id: string; status: 'pending' | 'started'
  question: TrainingQuestion; created_at: string
}
export type AgentChatFeedback = {
  response_id: string; feedback: 'reflects' | 'not_quite'
  focused_training_seed: FocusedTrainingSeed | null
}
export type ProfileCandidateFact = {
  candidate_id: string; category: ProfileCategory; proposed_title: string
  proposed_detail: string | null; source_type: string; source_title: string
  source_url: string | null; retrieved_at: string; model_generated_summary: boolean
  confidence: string | null; review_status: 'suggested' | 'confirmed' | 'edited' | 'rejected'
  reviewed_at: string | null
}
export type ProfileEnrichmentJob = {
  id?: number; status: 'idle' | 'running' | 'complete' | 'failed'; provider: string | null
  found_count: number; message?: string | null; candidates: ProfileCandidateFact[]; cached?: boolean
}
export type PostDraftRequest = {
  type: PostType; source_material: Record<string, unknown>
  case_origin?: 'synthetic_demo' | 'real_patient'
}
export type NetworkFeedItem = PracticeUpdate & {
  physician: ControlledPhysicianIdentity; relationship_basis: Array<'explicit_network_member' | 'canonical_agent_interaction'>
}
export type NetworkFeed = {
  items: NetworkFeedItem[]; relationship_sources: string[]
  ranking: 'chronological_only'; disclaimer: string
}
export type NetworkPhysicianProfile = {
  physician: ControlledPhysicianIdentity; professional_profile: ProfessionalProfile
  practice_representation: PracticeRepresentation['sections']; published_updates: PracticeUpdate[]
  disclaimer: string
}

/** Carries the HTTP status alongside the backend's `detail` message, so claim
 * screens can tell 401 (sign in again) apart from 409 (conflict) apart from a
 * generic failure — without the frontend re-deriving any state the backend
 * already decided. */
export class ApiError extends Error {
  status: number
  constructor(message: string, status: number) {
    super(message)
    this.name = 'ApiError'
    this.status = status
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const headers = new Headers(init?.headers)
  const accessToken = await getAccessToken()
  if (accessToken) headers.set('Authorization', `Bearer ${accessToken}`)
  const workspaceScoped = isWorkspaceScopedPath(path)
  if (workspaceScoped && !workspaceProvisioned) {
    headers.set('X-Lamina-Workspace-Bootstrap', workspaceBootstrapToken)
  }
  const response = await fetch(`${API_BASE_URL}${path}`, {
    ...init,
    headers,
    credentials: 'include',
  })
  if (!response.ok) {
    const body = await response.json().catch(() => null) as { detail?: string } | null
    throw new ApiError(body?.detail || `Request failed (${response.status})`, response.status)
  }
  if (workspaceScoped) workspaceProvisioned = true
  if (response.status === 204) return undefined as T
  return response.json() as Promise<T>
}

const physicianPerspectivePath = (path: string, perspective: DemoPhysicianPerspective) => {
  const separator = path.includes('?') ? '&' : '?'
  return `${path}${separator}perspective=${encodeURIComponent(perspective)}`
}

/** The shared Engagement UI's identity parameter: either a synthetic demo persona (Lucy/Iain)
 * or the signed-in physician's own authenticated private sandbox. Every function below that
 * accepts a `PhysicianIdentity` branches to the matching `/api/me/physician/*` owner endpoint
 * when given `'owner'` — the owner backend's response is normalized to the exact same shape
 * the demo endpoints already return, so shared components never need to know which they got. */
export type PhysicianIdentity = DemoPhysicianPerspective | 'owner'
const isOwner = (perspective: PhysicianIdentity): perspective is 'owner' => perspective === 'owner'

function controlledIdentityFromOwned(identity: OwnedPhysicianIdentity): ControlledPhysicianIdentity {
  return {
    id: identity.id, physician_id: null, npi: identity.npi, name: identity.display_name,
    specialty: identity.specialty || 'Physician',
    location: [identity.city, identity.state].filter(Boolean).join(', ') || 'Location not listed',
    agent_id: identity.id, agent_name: `${identity.display_name}'s Agent`, synthetic: false,
  }
}
function normalizeOwnedProfile(owned: OwnedProfessionalProfile): ProfessionalProfile {
  return { ...owned, physician: controlledIdentityFromOwned(owned.physician), synthetic: false }
}
function normalizeOwnedRepresentation(owned: OwnedPracticeRepresentation): PracticeRepresentation {
  return { ...owned, physician: controlledIdentityFromOwned(owned.physician) }
}
function normalizeOwnedOverview(owned: OwnedAgentOverview): AgentOverview {
  return { ...owned, physician: controlledIdentityFromOwned(owned.physician) }
}

export const getPatient = (id: string) => request<Patient>(`/api/patients/${encodeURIComponent(id)}`)
export const consultNetwork = (id: string, pcpGuidance?: string) => request<Consultation>(`/api/patients/${encodeURIComponent(id)}/consultations`, {
  method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ pcp_guidance: pcpGuidance?.trim() || null }),
})
export const getPatientActivity = () => request<PatientActivity[]>('/api/workspace/activity')
export const getConsultationHistory = () => request<ConsultationRecord[]>('/api/workspace/consultations')
export const getConsultationRecord = (id: number) => request<ConsultationRecord>(`/api/workspace/consultations/${id}`)
export const getMyAgent = () => request<MyAgent>('/api/workspace/agent')
export type DemoResetResult = {
  patient_id: string; removed_consultations: number; remaining_consultations: number; reset_complete: boolean
}
/** Clears one demo case's Lamina workflow history. Synthetic clinical data is untouched. */
export const resetJordanDemo = () => request<DemoResetResult>('/api/workspace/demo/reset/jordan', { method: 'POST' })
export const getAgentNetwork = () => request<AgentNetwork>('/api/workspace/network')
export const getSpecialistWorkspace = () => request<SpecialistWorkspace>('/api/workspace/specialist')
export const getSpecialistCases = () => request<SpecialistCaseSummary[]>('/api/workspace/specialist/cases')
export const getSpecialistCase = (consultationRecordId: number) => request<SpecialistCaseDetail>(`/api/workspace/specialist/cases/${consultationRecordId}`)
export const markSpecialistCaseReviewed = (consultationRecordId: number) => request<SpecialistReviewState>(`/api/workspace/specialist/cases/${consultationRecordId}/review`, { method: 'PUT' })
export const updateSpecialistCalibration = (
  consultationRecordId: number,
  learningKey: string,
  action: 'confirm' | 'edit' | 'reject',
  statement?: string,
) => request<SpecialistCalibration>(`/api/workspace/specialist/cases/${consultationRecordId}/calibrations/${encodeURIComponent(learningKey)}`, {
  method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action, statement }),
})
export const getProfessionalProfile = (perspective: PhysicianIdentity) => isOwner(perspective) ? getOwnedPhysicianProfile().then(normalizeOwnedProfile) : request<ProfessionalProfile>(physicianPerspectivePath('/api/workspace/physician/profile', perspective))
export const getPhysicianInterests = (perspective: DemoPhysicianPerspective) => request<PhysicianInterest[]>(physicianPerspectivePath('/api/workspace/physician/interests', perspective))
export const savePhysicianInterest = (perspective: PhysicianIdentity, interest: Omit<PhysicianInterest, 'id' | 'provenance' | 'created_at' | 'updated_at'>, interestId?: string) => isOwner(perspective) ? saveOwnedPhysicianInterest(interest, interestId) : request<PhysicianInterest>(physicianPerspectivePath(interestId ? `/api/workspace/physician/interests/${encodeURIComponent(interestId)}` : '/api/workspace/physician/interests', perspective), {
  method: interestId ? 'PUT' : 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(interest),
})
export const getAgentInitialization = (perspective: PhysicianIdentity) => isOwner(perspective) ? getOwnedAgentInitialization() : request<AgentInitialization>(physicianPerspectivePath('/api/workspace/physician/initialization', perspective))
export const updateProfessionalProfileItem = (
  perspective: PhysicianIdentity,
  itemId: string,
  item: { category: ProfileCategory; title: string; detail?: string; shareable?: boolean },
) => isOwner(perspective) ? updateOwnedProfileItem(itemId, item) : request<{ profile_item: ProfileItem; draft_update?: PracticeUpdate }>(physicianPerspectivePath(`/api/workspace/physician/profile/items/${encodeURIComponent(itemId)}`, perspective), {
  method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(item),
})
export const getPracticeRepresentation = (perspective: PhysicianIdentity) => isOwner(perspective) ? getOwnedPracticeRepresentation().then(normalizeOwnedRepresentation) : request<PracticeRepresentation>(physicianPerspectivePath('/api/workspace/physician/agent-representation', perspective))
export const getPhysicianTraining = (perspective: DemoPhysicianPerspective) => request<TrainingWorkspace>(physicianPerspectivePath('/api/workspace/physician/training', perspective))
export const getAgentOverview = (perspective: PhysicianIdentity) => isOwner(perspective) ? getOwnedAgentOverview().then(normalizeOwnedOverview) : request<AgentOverview>(physicianPerspectivePath('/api/workspace/physician/agent-overview', perspective))
export const getTrainingHistory = (perspective: PhysicianIdentity) => isOwner(perspective) ? getOwnedTrainProjection() as Promise<TrainProjection> : request<TrainProjection>(physicianPerspectivePath('/api/workspace/physician/training/history', perspective))
export const getAgentTestCases = (perspective: PhysicianIdentity) => isOwner(perspective) ? getOwnedAgentTestCases() : request<AgentTestCase[]>(physicianPerspectivePath('/api/workspace/physician/agent-test-cases', perspective))
export const chatWithAgent = (perspective: PhysicianIdentity, input: AgentChatRequest) => isOwner(perspective) ? chatWithOwnedAgent(input) : request<AgentChatResponse>(physicianPerspectivePath('/api/workspace/physician/agent-chat', perspective), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(input) })
export const submitAgentChatFeedback = (perspective: PhysicianIdentity, responseId: string, feedback: 'reflects' | 'not_quite') => isOwner(perspective) ? submitOwnedChatFeedback(responseId, feedback) : request<AgentChatFeedback>(physicianPerspectivePath(`/api/workspace/physician/agent-chat/${encodeURIComponent(responseId)}/feedback`, perspective), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ feedback }) })
export const startFocusedTraining = (perspective: PhysicianIdentity, seedId: string, answerTarget = 10) => isOwner(perspective) ? startOwnedFocusedTraining(seedId, answerTarget) as Promise<TrainingSession> : request<TrainingSession>(physicianPerspectivePath('/api/workspace/physician/training/focused', perspective), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ seed_id: seedId, answer_target: answerTarget }) })
export const startTrainingSession = (perspective: PhysicianIdentity, options?: { mode?: 'initialization' | 'daily' | 'extended'; limit?: number }) => isOwner(perspective) ? startOwnedTraining(options?.mode ?? 'daily') as Promise<TrainingSession> : request<TrainingSession>(physicianPerspectivePath('/api/workspace/physician/training/sessions', perspective), { method: 'POST', headers: options ? { 'Content-Type': 'application/json' } : undefined, body: options ? JSON.stringify(options) : undefined })
export const resumeTrainingSession = (perspective: PhysicianIdentity, sessionId: number) => isOwner(perspective) ? resumeOwnedTraining(sessionId) as Promise<TrainingSession> : request<TrainingSession>(physicianPerspectivePath(`/api/workspace/physician/training/sessions/${sessionId}`, perspective))
export const answerTrainingQuestion = (
  perspective: PhysicianIdentity,
  sessionId: number,
  questionId: string,
  response: { answer?: string | string[]; skipped?: boolean },
) => isOwner(perspective) ? answerOwnedTraining(sessionId, questionId, response) : request<TrainingResponse>(physicianPerspectivePath(`/api/workspace/physician/training/sessions/${sessionId}/responses/${encodeURIComponent(questionId)}`, perspective), {
  method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(response),
})
export const finishTrainingSession = (perspective: PhysicianIdentity, sessionId: number) => isOwner(perspective) ? finishOwnedTraining(sessionId) as Promise<TrainingSession> : request<TrainingSession>(physicianPerspectivePath(`/api/workspace/physician/training/sessions/${sessionId}/finish`, perspective), { method: 'POST' })
export const completeTrainingReview = (perspective: PhysicianIdentity, sessionId: number, deferPending = false) => isOwner(perspective) ? completeOwnedTrainingReview(sessionId, deferPending) as Promise<TrainingSession & { pending_review_count: number }> : request<TrainingSession & { pending_review_count: number }>(physicianPerspectivePath(`/api/workspace/physician/training/sessions/${sessionId}/review/complete`, perspective), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ defer_pending: deferPending }) })
export const resetTraining = (perspective: DemoPhysicianPerspective) => request<{ persona_id: DemoPhysicianPerspective; deleted: Record<string, number>; queue_summary: TrainingQueueSummary; questions: TrainingQuestion[]; proposed_learnings: ProposedLearning[] }>(physicianPerspectivePath('/api/workspace/physician/training/reset', perspective), { method: 'POST' })
export const updateProposedLearning = (
  perspective: PhysicianIdentity,
  learningId: number,
  action: 'confirm' | 'edit' | 'reject',
  statement?: string,
) => isOwner(perspective) ? reviewOwnedLearning(learningId, action, statement) as Promise<{ learning: ProposedLearning; draft_update?: PracticeUpdate | null }> : request<{ learning: ProposedLearning; draft_update?: PracticeUpdate | null }>(physicianPerspectivePath(`/api/workspace/physician/training/learnings/${learningId}`, perspective), {
  method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action, statement }),
})
export const getPhysicianUpdates = (perspective: DemoPhysicianPerspective) => request<PracticeUpdate[]>(physicianPerspectivePath('/api/workspace/physician/updates', perspective))
export const createPracticeUpdate = (perspective: DemoPhysicianPerspective, update: { type: PracticeUpdateType; title: string; body: string }) => request<PracticeUpdate>(physicianPerspectivePath('/api/workspace/physician/updates', perspective), {
  method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(update),
})
export const editPracticeUpdate = (perspective: DemoPhysicianPerspective, updateId: number, update: { type: PracticeUpdateType; title: string; body: string }) => request<PracticeUpdate>(physicianPerspectivePath(`/api/workspace/physician/updates/${updateId}`, perspective), {
  method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(update),
})
export const publishPracticeUpdate = (perspective: DemoPhysicianPerspective, updateId: number) => request<PracticeUpdate>(physicianPerspectivePath(`/api/workspace/physician/updates/${updateId}/publish`, perspective), { method: 'PUT' })
export const dismissPracticeUpdate = (perspective: DemoPhysicianPerspective, updateId: number) => request<PracticeUpdate>(physicianPerspectivePath(`/api/workspace/physician/updates/${updateId}/dismiss`, perspective), { method: 'PUT' })
export const enrichPhysicianProfile = (perspective: PhysicianIdentity) => isOwner(perspective) ? runOwnedProfileEnrichment() : request<ProfileEnrichmentJob>(physicianPerspectivePath('/api/workspace/physician/profile/enrich', perspective), { method: 'POST' })
export const getProfileEnrichment = (perspective: PhysicianIdentity) => isOwner(perspective) ? getOwnedProfileEnrichment() : request<ProfileEnrichmentJob>(physicianPerspectivePath('/api/workspace/physician/profile/enrichment', perspective))
export const reviewProfileCandidate = (perspective: PhysicianIdentity, candidateId: string, input: { action: 'confirm' | 'edit_confirm' | 'reject'; title?: string; detail?: string; shareable?: boolean }) => isOwner(perspective) ? reviewOwnedProfileCandidate(candidateId, input) : request<{ candidate: ProfileCandidateFact; profile_item: ProfileItem | null }>(physicianPerspectivePath(`/api/workspace/physician/profile/enrichment/${encodeURIComponent(candidateId)}`, perspective), { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(input) })
export const getProfessionalPosts = (perspective: DemoPhysicianPerspective) => request<ProfessionalPost[]>(physicianPerspectivePath('/api/workspace/physician/posts', perspective))
export const createProfessionalPost = (perspective: DemoPhysicianPerspective, post: { type: PostType; title: string; body: string; case_origin?: 'synthetic_demo' | 'real_patient' }) => request<ProfessionalPost>(physicianPerspectivePath('/api/workspace/physician/posts', perspective), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(post) })
export const draftProfessionalPost = (perspective: DemoPhysicianPerspective, input: PostDraftRequest) => request<{ post: ProfessionalPost; draft_provider: string }>(physicianPerspectivePath('/api/workspace/physician/posts/draft', perspective), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(input) })
export const editProfessionalPost = (perspective: DemoPhysicianPerspective, postId: number, post: { type: PostType; title: string; body: string; case_origin?: 'synthetic_demo' | 'real_patient' }) => request<ProfessionalPost>(physicianPerspectivePath(`/api/workspace/physician/posts/${postId}`, perspective), { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(post) })
export const publishProfessionalPost = (perspective: DemoPhysicianPerspective, postId: number) => request<ProfessionalPost>(physicianPerspectivePath(`/api/workspace/physician/posts/${postId}/publish`, perspective), { method: 'PUT' })
export const dismissProfessionalPost = (perspective: DemoPhysicianPerspective, postId: number) => request<ProfessionalPost>(physicianPerspectivePath(`/api/workspace/physician/posts/${postId}/dismiss`, perspective), { method: 'PUT' })
export const getNetworkFeed = (perspective: DemoPhysicianPerspective) => request<NetworkFeed>(physicianPerspectivePath('/api/workspace/network/feed', perspective))
export const getNetworkPhysicianProfile = (controlledId: string) => request<NetworkPhysicianProfile>(`/api/workspace/network/physicians/${encodeURIComponent(controlledId)}/profile`)
export const addNetworkMember = (npi: string) => request<NetworkMember>('/api/workspace/network/members', {
  method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ npi }),
})
export const removeNetworkMember = async (npi: string) => {
  await request<void>(`/api/workspace/network/members/${encodeURIComponent(npi)}`, { method: 'DELETE' })
}
export const updateAgentLearning = (key: string, action: 'confirm' | 'edit' | 'reject', statement?: string) => request<AgentLearning>(`/api/workspace/agent/learnings/${encodeURIComponent(key)}`, {
  method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action, statement }),
})
export const searchProviders = (filters: { q?: string; specialty?: string; location?: string }) => {
  const params = new URLSearchParams()
  Object.entries(filters).forEach(([key, value]) => { if (value?.trim()) params.set(key, value.trim()) })
  return request<ProviderSearchResponse>(`/api/providers/search?${params}`)
}
export const getProvider = (npi: string) => request<PhysicianNetworkProfile>(`/api/providers/${encodeURIComponent(npi)}`)
export const getProviderClaimState = (npi: string) => request<ProviderClaimState>(`/api/providers/${encodeURIComponent(npi)}/claim-state`)
export const getMyProviderClaims = () => request<ProviderClaim[]>('/api/me/provider-claims')
export const getPhysicianSandboxStatus = () => request<PhysicianSandboxStatus>('/api/me/physician/status')
export const selectPhysicianSandbox = (claimId: number) => request<PhysicianSandboxStatus>(`/api/me/physician/selection/${claimId}`, { method: 'PUT' })
export const getOwnedPhysicianProfile = () => request<OwnedProfessionalProfile>('/api/me/physician/profile')
export const updateOwnedProfileItem = (itemId: string, item: { category: ProfileCategory; title: string; detail?: string; shareable?: boolean }) => request<{ profile_item: ProfileItem }>(`/api/me/physician/profile/items/${encodeURIComponent(itemId)}`, {
  method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(item),
})
export const getOwnedPhysicianInterests = () => request<PhysicianInterest[]>('/api/me/physician/interests')
export const saveOwnedPhysicianInterest = (interest: Omit<PhysicianInterest, 'id' | 'provenance' | 'created_at' | 'updated_at'>, interestId?: string) => request<PhysicianInterest>(interestId ? `/api/me/physician/interests/${encodeURIComponent(interestId)}` : '/api/me/physician/interests', {
  method: interestId ? 'PUT' : 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(interest),
})
export const getOwnedAgentInitialization = () => request<AgentInitialization>('/api/me/physician/initialization')
export const getOwnedAgentOverview = () => request<OwnedAgentOverview>('/api/me/physician/agent-overview')
export const getOwnedPracticeRepresentation = () => request<OwnedPracticeRepresentation>('/api/me/physician/practice-representation')
export const getOwnedTrainProjection = () => request<OwnedTrainProjection>('/api/me/physician/training')
export const startOwnedTraining = (mode: 'initialization' | 'daily' | 'extended' = 'daily') => request<OwnedTrainingSession>('/api/me/physician/training/sessions', {
  method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ mode }),
})
export const resumeOwnedTraining = (sessionId: number) => request<OwnedTrainingSession>(`/api/me/physician/training/sessions/${sessionId}`)
export const answerOwnedTraining = (sessionId: number, questionId: string, response: { answer?: string | string[]; skipped?: boolean }) => request<TrainingResponse>(`/api/me/physician/training/sessions/${sessionId}/responses/${encodeURIComponent(questionId)}`, {
  method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(response),
})
export const finishOwnedTraining = (sessionId: number) => request<OwnedTrainingSession>(`/api/me/physician/training/sessions/${sessionId}/finish`, { method: 'POST' })
export const completeOwnedTrainingReview = (sessionId: number, deferPending = false) => request<OwnedTrainingSession & { pending_review_count: number }>(`/api/me/physician/training/sessions/${sessionId}/review/complete`, {
  method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ defer_pending: deferPending }),
})
export const reviewOwnedLearning = (learningId: number, action: 'confirm' | 'edit' | 'reject', statement?: string) => request<{ learning: ProposedLearning }>(`/api/me/physician/training/learnings/${learningId}`, {
  method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action, statement }),
})
export const runOwnedProfileEnrichment = () => request<ProfileEnrichmentJob>('/api/me/physician/profile/enrich', { method: 'POST' })
export const getOwnedProfileEnrichment = () => request<ProfileEnrichmentJob>('/api/me/physician/profile/enrichment')
export const reviewOwnedProfileCandidate = (candidateId: string, input: { action: 'confirm' | 'edit_confirm' | 'reject'; title?: string; detail?: string; shareable?: boolean }) => request<{ candidate: ProfileCandidateFact; profile_item: ProfileItem | null }>(`/api/me/physician/profile/enrichment/candidates/${encodeURIComponent(candidateId)}`, {
  method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(input),
})
export const getOwnedAgentTestCases = () => request<AgentTestCase[]>('/api/me/physician/agent-test-cases')
export const chatWithOwnedAgent = (input: AgentChatRequest) => request<AgentChatResponse>('/api/me/physician/agent-chat', {
  method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(input),
})
export const submitOwnedChatFeedback = (responseId: string, feedback: 'reflects' | 'not_quite') => request<AgentChatFeedback>(`/api/me/physician/agent-chat/${encodeURIComponent(responseId)}/feedback`, {
  method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ feedback }),
})
export const startOwnedFocusedTraining = (seedId: string, answerTarget = 10) => request<OwnedTrainingSession>('/api/me/physician/training/focused', {
  method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ seed_id: seedId, answer_target: answerTarget }),
})
export const getOwnedProfessionalPosts = () => request<OwnedProfessionalPost[]>('/api/me/physician/posts')
export const createOwnedProfessionalPost = (post: { type: PostType; title: string; body: string; case_origin?: 'synthetic_demo' }) => request<OwnedProfessionalPost>('/api/me/physician/posts', {
  method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(post),
})
export const draftOwnedProfessionalPost = (input: PostDraftRequest) => request<OwnedProfessionalPost>('/api/me/physician/posts/draft', {
  method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(input),
})
export const editOwnedProfessionalPost = (postId: number, post: { type: PostType; title: string; body: string; case_origin?: 'synthetic_demo' }) => request<OwnedProfessionalPost>(`/api/me/physician/posts/${postId}`, {
  method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(post),
})
export const dismissOwnedProfessionalPost = (postId: number) => request<OwnedProfessionalPost>(`/api/me/physician/posts/${postId}/dismiss`, { method: 'POST' })
export const createProviderClaim = (npi: string) => request<ProviderClaim>(`/api/providers/${encodeURIComponent(npi)}/claim`, { method: 'POST' })
export const submitProviderVerification = (claimId: number) => request<ProviderClaim>(`/api/provider-claims/${claimId}/submit-verification`, { method: 'POST' })
export const verifySyntheticDemoClaim = (claimId: number) => request<ProviderClaim>(`/api/provider-claims/${claimId}/verify-demo`, { method: 'POST' })
export const activateProviderClaim = (claimId: number) => request<PhysicianNetworkProfile>(`/api/provider-claims/${claimId}/activate-agent`, { method: 'POST' })
export const disableProviderClaim = (claimId: number) => request<PhysicianNetworkProfile>(`/api/provider-claims/${claimId}/disable-agent`, { method: 'POST' })

async function ownedClaimId(npi: string) {
  const profile = await getProvider(npi)
  if (!profile.claimed_by_me || !profile.my_claim_id) throw new Error('Sign in as the claim owner to continue')
  return profile.my_claim_id
}

/** Compatibility helpers for the existing minimal activation surface. */
export const claimProvider = async (npi: string) => { await createProviderClaim(npi); return getProvider(npi) }
export const submitProviderVerificationForNpi = async (npi: string) => { await submitProviderVerification(await ownedClaimId(npi)); return getProvider(npi) }
export const verifyDemoProvider = async (npi: string) => { await verifySyntheticDemoClaim(await ownedClaimId(npi)); return getProvider(npi) }
export const saveProviderPreferences = (npi: string, body: AgentPreferences & { practice_confirmed: boolean }) => request<PhysicianNetworkProfile>(`/api/providers/${encodeURIComponent(npi)}/preferences`, {
  method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
})
export const activateProvider = async (npi: string) => activateProviderClaim(await ownedClaimId(npi))
export const disableProvider = async (npi: string) => disableProviderClaim(await ownedClaimId(npi))
