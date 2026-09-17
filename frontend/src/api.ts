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
export type PatientActivity = { patient_id: string; last_opened: string | null; last_started: string | null; last_consultation: string | null; consultation_count: number }
export type ConsultationRecord = { id: number; patient_id: string; completed_at: string; result: Consultation }
export type AgentLearning = { key: string; statement: string; provenance: string; status: 'suggested' | 'confirmed' | 'rejected'; updated_at: string | null }
export type MyAgent = {
  id: string; physician: string; specialty: string; status: string; synthetic: boolean; location: string
  known: { label: string; value: string; source: string }[]
  access: { label: string; detail: string }[]
  learnings: AgentLearning[]
  calibrations: Record<string, { question: string; answer: string; based_on: string[] }>
}
export type AgentStatus = 'reserved' | 'verification_pending' | 'verified' | 'active' | 'disabled'
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
}
export type NetworkAgent = {
  id: string; physician_id: string; npi: string; name: string; specialty: string; subspecialty: string
  location: string; status: AgentStatus; source: 'SYNTHETIC'; focus_areas: string[]
  required_workup: string[]; explicit_rules: string[]; confirmed_preferences: AgentPreferences | null
  provenance: string; relationship: AgentRelationship | null
}
export type AgentNetwork = {
  center: { id: string; name: string; specialty: string; location: string; status: 'active'; source: string }
  nodes: NetworkAgent[]; record_count: number; relationship_source: string; status_note: string
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${API_BASE_URL}${path}`, init)
  if (!response.ok) {
    const body = await response.json().catch(() => null) as { detail?: string } | null
    throw new Error(body?.detail || `Request failed (${response.status})`)
  }
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
export const getAgentNetwork = () => request<AgentNetwork>('/api/workspace/network')
export const updateAgentLearning = (key: string, action: 'confirm' | 'edit' | 'reject', statement?: string) => request<AgentLearning>(`/api/workspace/agent/learnings/${encodeURIComponent(key)}`, {
  method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action, statement }),
})
export const searchProviders = (filters: { q?: string; specialty?: string; location?: string }) => {
  const params = new URLSearchParams()
  Object.entries(filters).forEach(([key, value]) => { if (value?.trim()) params.set(key, value.trim()) })
  return request<ProviderSearchResponse>(`/api/providers/search?${params}`)
}
export const getProvider = (npi: string) => request<PhysicianNetworkProfile>(`/api/providers/${encodeURIComponent(npi)}`)
export const claimProvider = (npi: string) => request<PhysicianNetworkProfile>(`/api/providers/${encodeURIComponent(npi)}/claim`, { method: 'POST' })
export const verifyDemoProvider = (npi: string) => request<PhysicianNetworkProfile>(`/api/providers/${encodeURIComponent(npi)}/verify-demo`, { method: 'POST' })
export const saveProviderPreferences = (npi: string, body: AgentPreferences & { practice_confirmed: boolean }) => request<PhysicianNetworkProfile>(`/api/providers/${encodeURIComponent(npi)}/preferences`, {
  method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
})
export const activateProvider = (npi: string) => request<PhysicianNetworkProfile>(`/api/providers/${encodeURIComponent(npi)}/activate`, { method: 'POST' })
