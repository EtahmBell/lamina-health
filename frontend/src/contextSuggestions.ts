import type { Patient } from './api.ts'
import { JORDAN_ID, MARIA_ID } from './demoIdentity.ts'

export type ContextSuggestion = { id: string; text: string; sourced: boolean }

/**
 * Demo-only clinician-guidance metadata: an explicit, hand-authored map of
 * specialty-comparison phrasing for the two implemented synthetic cases.
 * Not derived from the recommendation engine, a model, or patient facts —
 * purely a quick way for the referring clinician to state a routing
 * question for their own agent. Intentionally has no entry for patients
 * without a supported case, so no specialty suggestion is fabricated.
 */
const SPECIALTY_SUGGESTIONS: Record<string, string> = {
  [JORDAN_ID]: 'Compare nephrology vs cardiology',
  [MARIA_ID]: 'Compare gastroenterology vs haematology',
}

export function specialtySuggestion(patientId: string): ContextSuggestion | null {
  const text = SPECIALTY_SUGGESTIONS[patientId]
  return text ? { id: 'specialty', text, sourced: false } : null
}

/**
 * Access/logistics suggestion chips. Only derived from real structured
 * patient fields (location, insurance) — never a guess at preferences
 * Lamina has no data for (telehealth, transport, scheduling, goals) — plus
 * one generic, clearly non-data-sourced suggestion.
 */
export function accessSuggestions(patient: Patient): ContextSuggestion[] {
  const suggestions: ContextSuggestion[] = []
  const city = patient.location?.split(',')[0]?.trim()
  if (city) suggestions.push({ id: 'location', text: `Prefer ${city}-area options`, sourced: true })
  if (patient.insurance) suggestions.push({ id: 'insurance', text: 'Keep in-network options', sourced: true })
  suggestions.push({ id: 'access', text: 'Prioritize earlier appropriate access', sourced: false })
  return suggestions
}
