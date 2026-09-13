const API_BASE_URL = (import.meta.env.VITE_API_BASE_URL || 'http://127.0.0.1:8000').replace(/\/$/, '')

export type LabObservation = { date: string; test: 'creatinine' | 'eGFR'; value: number; unit: string }
export type Patient = {
  id: string; display_name: string; synthetic: true; age: number; diagnoses: string[]
  medications: string[]; labs: LabObservation[]; insurance: string; location: string
}
export type Evidence = { kind: string; detail: string }
export type Evaluation = {
  physician_id: string; physician_name: string; specialty: string
  clinical_fit: 'strong' | 'moderate' | 'poor'; accepts_case: boolean; reason: string
  evidence: Evidence[]; required_workup: string[]; urgency: string
  availability: string; insurance_status: string; confidence: string
}
export type Consultation = {
  consultation_id: string; patient_facts_used: string[]; recommended_physician: Evaluation
  why: string; before_referral: string[]; availability: string; insurance: string
  alternatives: Evaluation[]; consultation: Evaluation[]; disclaimer: string
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
