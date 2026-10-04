import type { Patient } from './api.ts'

export type ContextSuggestion = { id: string; text: string; sourced: boolean }

/**
 * Optional-context suggestion chips. Only derived from real structured
 * patient fields (location, insurance) — never a guess at preferences
 * Lamina has no data for (telehealth, transport, scheduling, goals).
 */
export function contextSuggestions(patient: Patient): ContextSuggestion[] {
  const suggestions: ContextSuggestion[] = []
  const city = patient.location?.split(',')[0]?.trim()
  if (city) suggestions.push({ id: 'location', text: `Prefer ${city}-area options`, sourced: true })
  if (patient.insurance) suggestions.push({ id: 'insurance', text: 'Keep in-network options', sourced: true })
  suggestions.push({ id: 'access', text: 'Prioritize earlier appropriate access', sourced: false })
  return suggestions
}
