/** "Why Dr. X?" (routing consolidation pass, Part D/E): turns the backend's
 * structured physician-case fit + route evidence into a few short,
 * provenance-tagged lines. Pure presentation -- no reasoning happens here,
 * no numeric value is shown, and only privacy-preserving case PATTERNS
 * (never prior patients) can appear. */
import type { CandidateRoute, MatchEvidence, MatchEvidenceCategory, PhysicianCaseFit } from './api.ts'

export const EVIDENCE_CATEGORY_LABELS: Record<MatchEvidenceCategory, string> = {
  specialty_scope: 'Specialty / scope',
  similar_case_experience: 'Similar-case experience',
  case_interest: 'Confirmed case interest',
  referral_preference: 'Receiving fit',
  modality_policy: 'Modality',
  access_capacity: 'Access / capacity',
  continuity: 'Continuity',
  network_relationship: 'Network relationship',
}

export type WhyLine = { key: string; label: string; detail: string }

const shortName = (name: string) => `Dr. ${name.replace('(synthetic)', '').trim().split(/\s+/).at(-1)}`
const lowerFirst = (text: string) => text.charAt(0).toLowerCase() + text.slice(1)

/** The compact WHY THIS MATCH block: clinical fit, similar-patient
 * experience, receiving fit, and the route. Every line comes from a real
 * evidence item; a missing signal says so rather than being invented. */
export function whyThisMatch(fit: PhysicianCaseFit, route: CandidateRoute | undefined, patientFirstName: string): WhyLine[] {
  const name = shortName(fit.physician_name)
  const scope = fit.evidence.find((item) => item.category === 'specialty_scope')
  const receiving = fit.evidence.find((item) => item.category === 'referral_preference')
  const lines: WhyLine[] = [{
    key: 'clinical',
    label: fit.clinical_fit === 'strong' ? 'Strong clinical fit' : fit.clinical_fit === 'moderate' ? 'Moderate clinical fit' : 'Limited clinical fit',
    detail: scope?.summary ?? '',
  }]
  lines.push(fit.similar_case_patterns.length > 0
    ? { key: 'similar', label: 'Experience with similar patients', detail: `${name}'s practice history includes comparable patients: ${lowerFirst(fit.similar_case_patterns[0])}.` }
    : { key: 'similar', label: 'Similar-patient experience', detail: 'No similar-case history on record yet.' })
  lines.push(receiving
    ? { key: 'receiving', label: 'Receiving fit', detail: receiving.summary.replace(/^This presentation/, `${patientFirstName}'s presentation`) }
    : { key: 'receiving', label: 'Receiving fit', detail: `Not yet established: ${name} has no confirmed receiving preferences for cases like this.` })
  if (route) {
    const access = route.modality === 'in_person'
      ? `Expected visit access ${route.access.in_person_wait_label.replace('Approximately ', '~')}`
      : `Typical e-consult response ${(route.access.econsult_response_label ?? 'unverified').replace('Approximately ', '~')}`
    const modality = route.modality === 'in_person' ? 'In-person appropriate for this presentation' : 'E-consult route'
    lines.push({ key: 'route', label: 'Route', detail: `${modality} · ${access}` })
  }
  return lines
}

/** Every reason behind a match, physician fit first, then route evidence,
 * each with its provenance -- what the detailed "Why Dr. X" surface shows. */
export function matchEvidence(fit: PhysicianCaseFit | undefined, route: CandidateRoute | undefined): MatchEvidence[] {
  const fitEvidence = fit?.evidence ?? []
  const routeEvidence = (route?.route_evidence ?? []).filter((item) => !fitEvidence.some((existing) => existing.summary === item.summary))
  return [...fitEvidence, ...routeEvidence]
}
