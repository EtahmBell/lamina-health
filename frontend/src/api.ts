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

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${API_BASE_URL}${path}`, init)
  if (!response.ok) {
    const body = await response.json().catch(() => null) as { detail?: string } | null
    throw new Error(body?.detail || `Request failed (${response.status})`)
  }
  return response.json() as Promise<T>
}

export const getPatient = (id: string) => request<Patient>(`/api/patients/${encodeURIComponent(id)}`)
export const consultNetwork = (id: string) => request<Consultation>(`/api/patients/${encodeURIComponent(id)}/consultations`, {
  method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ pcp_guidance: null }),
})

