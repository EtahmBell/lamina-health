import type { NppesPracticeLocation, OnboardingIdentity, OnboardingStatus } from './api.ts'
import { ownerHomePath, ownerOnboardingPath } from './ownerPaths.ts'

/**
 * Pure presentation helpers for physician pilot onboarding. Every decision here is a
 * projection of the backend's own `OnboardingStatus` — the client never infers
 * ownership, confirmation, or approval on its own, and nothing here is persisted.
 */

export type OnboardingScreen = 'lookup' | 'confirm' | 'pending' | 'active' | 'rejected' | 'disabled'

export function onboardingScreen(status: OnboardingStatus): OnboardingScreen {
  switch (status.status) {
    case 'account_created': return 'lookup'
    case 'identity_selected': return status.selection ? 'confirm' : 'lookup'
    case 'pilot_approval_pending': return 'pending'
    case 'active': return 'active'
    case 'rejected': return 'rejected'
    case 'disabled': return 'disabled'
  }
}

/** Where the private workspace shell must send this account, or null if it may render. */
export function workspaceGateRedirect(status: OnboardingStatus): string | null {
  return status.status === 'active' && status.workspace_available ? null : ownerOnboardingPath
}

/** Where onboarding should send an account the backend already marked active. */
export const onboardingCompletePath = ownerHomePath

/** UX-only format hint. The backend independently validates the NPI and its check digit. */
export function npiFormatHint(raw: string): string | null {
  const value = raw.replace(/\s+/g, '')
  if (!value) return null
  if (!/^\d+$/.test(value)) return 'An NPI contains digits only.'
  if (value.length !== 10) return 'An NPI is exactly 10 digits.'
  return null
}

export const normalizeNpiInput = (raw: string) => raw.replace(/\s+/g, '')

const LOOKUP_ERROR_COPY: Record<string, string> = {
  invalid_npi: 'That is not a valid NPI. Check the 10 digits and try again.',
  synthetic_identity: 'That NPI belongs to a synthetic Lamina demo physician and cannot be used for a pilot account.',
  npi_not_found: 'No NPPES record was found for that NPI. Check the number and try again.',
  npi_not_eligible: 'That NPI is not an active individual physician record in NPPES. Use your individual (Type 1) NPI.',
  nppes_unavailable: 'The NPPES registry is not responding right now. Nothing was saved — please try again shortly.',
  nppes_rate_limited: 'The NPPES registry is busy. Please wait a minute and try again.',
  lookup_rate_limited: 'Too many lookups from this account. Please wait a few minutes and try again.',
  npi_already_claimed: 'This NPI is already linked to another Lamina account. The existing link will not be changed automatically. If this is your NPI, contact the Lamina team.',
  account_already_bound: 'This account is already linked to a different physician identity. Contact the Lamina team to change it.',
  account_rejected: 'This account cannot continue onboarding. Contact the Lamina team.',
  selection_mismatch: 'The identity on screen is out of date. Look up your NPI again.',
  selection_expired: 'This lookup has expired. Look up your NPI again.',
  selection_required: 'Look up your NPI before confirming.',
  invalid_onboarding_transition: 'This step is no longer available. Refreshing your status…',
}

export function onboardingErrorCopy(code: string | null | undefined, fallback: string): string {
  return (code && LOOKUP_ERROR_COPY[code]) || fallback
}

/** Errors after which the client must re-read authoritative status rather than trust local state. */
export const errorRequiresStatusRefresh = (code: string | null | undefined) =>
  code === 'invalid_onboarding_transition' || code === 'selection_mismatch' || code === 'selection_expired'

export function formatLocation(location: NppesPracticeLocation): string {
  const cityState = [location.city, location.state].filter(Boolean).join(', ')
  return [location.address_line, [cityState, location.postal_code].filter(Boolean).join(' ')].filter(Boolean).join(' · ')
}

export type IdentityFacts = {
  npi: string
  name: string
  specialty: string
  otherTaxonomies: string[]
  locations: string[]
}

/** Everything a physician needs to recognize (or reject) a match, NPI first-class. */
export function identityFacts(identity: OnboardingIdentity): IdentityFacts {
  const taxonomies = identity.taxonomies ?? []
  const primary = identity.primary_specialty ?? taxonomies[0]?.description ?? ('specialty' in identity ? identity.specialty : undefined)
  const locations = (identity.practice_locations ?? []).map(formatLocation).filter(Boolean)
  const legacyLocation = 'city' in identity && identity.city ? [[identity.city, identity.state].filter(Boolean).join(', ')] : []
  return {
    npi: identity.npi,
    name: identity.display_name,
    specialty: primary || 'Specialty not listed in NPPES',
    otherTaxonomies: taxonomies.filter((item) => item.description !== primary).map((item) => item.description),
    locations: locations.length ? locations : legacyLocation,
  }
}
