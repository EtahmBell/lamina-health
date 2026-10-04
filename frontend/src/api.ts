import { getAccessToken } from './authClient.ts'

const API_BASE_URL = (import.meta.env.VITE_API_BASE_URL || 'http://127.0.0.1:8000').replace(/\/$/, '')

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
  const response = await fetch(`${API_BASE_URL}${path}`, {
    ...init,
    headers,
    credentials: 'include',
  })
  if (!response.ok) {
    const body = await response.json().catch(() => null) as { detail?: string } | null
    throw new ApiError(body?.detail || `Request failed (${response.status})`, response.status)
  }
  if (response.status === 204) return undefined as T
  return response.json() as Promise<T>
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
