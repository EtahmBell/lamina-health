/** "Patients with next steps" for a specialist (routing consolidation pass,
 * Part I-M): ONE worklist of patients for whom something meaningful needs
 * to happen next involving the physician or their care team -- a new
 * referral to review is simply that patient's current next step, never a
 * separate "incoming" section.
 *
 * Attention order is deterministic and uses only known structured fields,
 * never an opaque number:
 *   1. physician judgment required -- agent/staff-resolvable steps never
 *      take a top slot;
 *   2. urgent first (the exceptional escalation path);
 *   3. action-ready before still-being-resolved;
 *   4. least time remaining to the step's service target (so a Routine
 *      case ages toward its target and cannot starve behind newer Soon
 *      cases);
 *   5. clinician-defined priority, then continuity, then name.
 * Priority itself is always clinician-defined; nothing here raises it.
 * Service targets are modality-specific (an e-consult response is not a
 * visit-referral review) and are demo-safe configuration, not clinical
 * SLAs. */
import type { CareModality, Referral, ReferralPriority } from './api.ts'

export type NextStepKind =
  | 'review_referral' | 'respond_econsult' | 'review_results' | 'review_handoff'
  | 'scheduling' | 'awaiting_visit' | 'follow_up_booked'

export type ServiceTargetKind = 'referral_review' | 'econsult_response' | 'result_review' | 'handoff_review'

export type NextStepItem = {
  id: string
  patientId: string
  kind: NextStepKind
  priority: ReferralPriority
  modality: CareModality
  action: string
  detail: string
  /** Does the physician actually need to act? If the agent or staff can
   * safely finish it, it stays off the physician's top attention. */
  physicianJudgment: boolean
  /** Complete enough for the physician to decide now. */
  ready: boolean
  /** Days since this next step arose. */
  ageDays: number
  existingPatient: boolean
  referralId?: number
}

/** Demo-safe, configurable service targets in days, keyed by the kind of
 * work (modality-specific) and clinician-defined priority. The e-consult
 * value mirrors the ~2 business day e-consult response already shown in
 * capacity; the rest are illustrative demo configuration. */
export const SERVICE_TARGET_DAYS: Record<ServiceTargetKind, Record<ReferralPriority, number>> = {
  referral_review: { urgent: 1, soon: 2, routine: 7 },
  econsult_response: { urgent: 1, soon: 2, routine: 2 },
  result_review: { urgent: 1, soon: 3, routine: 7 },
  handoff_review: { urgent: 1, soon: 2, routine: 3 },
}

const TARGET_KIND: Partial<Record<NextStepKind, ServiceTargetKind>> = {
  review_referral: 'referral_review',
  respond_econsult: 'econsult_response',
  review_results: 'result_review',
  review_handoff: 'handoff_review',
}

const PRIORITY_RANK: Record<ReferralPriority, number> = { urgent: 0, soon: 1, routine: 2 }

export function serviceTargetDays(item: NextStepItem): number | null {
  const kind = TARGET_KIND[item.kind]
  return kind ? SERVICE_TARGET_DAYS[kind][item.priority] : null
}

/** Negative once a step is past its target. */
export function daysRemaining(item: NextStepItem): number {
  const target = serviceTargetDays(item)
  return target === null ? Number.POSITIVE_INFINITY : target - item.ageDays
}

export function needsPhysician(items: NextStepItem[]): NextStepItem[] {
  return items.filter((item) => item.physicianJudgment)
}

export function handledByAgentOrStaff(items: NextStepItem[]): NextStepItem[] {
  return items.filter((item) => !item.physicianJudgment)
}

export function attentionOrder(items: NextStepItem[]): NextStepItem[] {
  return [...needsPhysician(items)].sort((a, b) =>
    Number(b.priority === 'urgent') - Number(a.priority === 'urgent')
    || Number(b.ready) - Number(a.ready)
    || daysRemaining(a) - daysRemaining(b)
    || PRIORITY_RANK[a.priority] - PRIORITY_RANK[b.priority]
    || Number(b.existingPatient) - Number(a.existingPatient)
    || a.patientId.localeCompare(b.patientId))
}

/** The Dashboard's three patient next steps most deserving physician
 * attention now -- not newest-first, not static priority alone. */
export function topAttention(items: NextStepItem[], count = 3): NextStepItem[] {
  return attentionOrder(items).slice(0, count)
}

const DAY_MS = 86_400_000
const ageInDays = (iso: string, now: Date) => Math.max(0, Math.floor((now.getTime() - new Date(iso).getTime()) / DAY_MS))

const resolvedCount = (referral: Referral) =>
  referral.coordination_events.filter((event) => event.event_type === 'information_attached').length

/** A submitted referral awaiting this physician's decision. Readiness comes
 * from the real requirement checks, never assumed. */
export function referralReviewStep(referral: Referral, now: Date, referringName: string): NextStepItem {
  const resolved = resolvedCount(referral)
  const ready = referral.requirement_results.every((check) => check.status !== 'missing_from_packet')
  return {
    id: `referral-${referral.id}`,
    patientId: referral.patient_id,
    kind: 'review_referral',
    priority: referral.priority,
    modality: referral.modality,
    action: 'Review referral',
    detail: `${referral.specialty} referral from ${referringName}${resolved > 0 ? ` · ${resolved} missing item${resolved === 1 ? '' : 's'} resolved automatically` : ''}`,
    physicianJudgment: true,
    ready,
    ageDays: ageInDays(referral.created_at, now),
    existingPatient: false,
    referralId: referral.id ?? undefined,
  }
}

/** An accepted referral's current next step. Scheduling and the visit
 * itself are agent/staff work; reviewing the drafted handoff is a real
 * physician decision. A sent handoff leaves no next step. */
export function acceptedReferralStep(
  referral: Referral, state: { encounterDocumented: boolean; handoffStatus: 'draft' | 'sent' | null; handoffDraftedAt: string | null }, now: Date,
): NextStepItem | null {
  const base = { patientId: referral.patient_id, priority: referral.priority, modality: referral.modality, existingPatient: true, referralId: referral.id ?? undefined, ready: true }
  if (state.handoffStatus === 'sent') return null
  if (state.encounterDocumented && state.handoffStatus === 'draft') {
    return { ...base, id: `handoff-${referral.id}`, kind: 'review_handoff', action: 'Review handoff', detail: 'Consultation documented · handoff drafted by your agent', physicianJudgment: true, ageDays: state.handoffDraftedAt ? ageInDays(state.handoffDraftedAt, now) : 0 }
  }
  if (referral.status === 'scheduled' || referral.status === 'consult_returned') {
    return { ...base, id: `visit-${referral.id}`, kind: 'awaiting_visit', action: 'Visit scheduled', detail: 'Appointment confirmed by the scheduling workflow', physicianJudgment: false, ageDays: ageInDays(referral.updated_at, now) }
  }
  return { ...base, id: `scheduling-${referral.id}`, kind: 'scheduling', action: 'Scheduling in progress', detail: 'Your agent is routing appointment options', physicianJudgment: false, ageDays: ageInDays(referral.updated_at, now) }
}

/** Dr. Chen's established synthetic patients' current next steps. Static
 * demo data: "ageDays" is how long each step has been open. Patients with
 * only agent/staff work (booked follow-ups, routine scheduling) are listed
 * but never consume physician attention. */
export const CHEN_SEEDED_NEXT_STEPS: NextStepItem[] = [
  { id: 'econsult-robert', patientId: 'patient-chen-robert-004', kind: 'respond_econsult', priority: 'routine', modality: 'econsult', action: 'Respond to focused question', detail: 'E-consult · add-on therapy with weight-loss benefit?', physicianJudgment: true, ready: true, ageDays: 0, existingPatient: true },
  { id: 'results-elena', patientId: 'patient-chen-elena-001', kind: 'review_results', priority: 'routine', modality: 'in_person', action: 'Review latest results', detail: 'Overnight glucose data after basal insulin change', physicianJudgment: true, ready: true, ageDays: 2, existingPatient: true },
  { id: 'results-maya', patientId: 'patient-chen-maya-003', kind: 'review_results', priority: 'routine', modality: 'in_person', action: 'Decide next step on nodule', detail: 'Indeterminate cytology · repeat biopsy vs. lobectomy', physicianJudgment: true, ready: true, ageDays: 1, existingPatient: true },
  { id: 'scheduling-aisha', patientId: 'patient-chen-aisha-005', kind: 'scheduling', priority: 'routine', modality: 'in_person', action: 'Follow-up labs being scheduled', detail: 'Handled by your agent and staff', physicianJudgment: false, ready: true, ageDays: 1, existingPatient: true },
  { id: 'followup-daniel', patientId: 'patient-chen-daniel-002', kind: 'follow_up_booked', priority: 'routine', modality: 'in_person', action: 'Follow-up visit booked', detail: 'No action needed before the visit', physicianJudgment: false, ready: true, ageDays: 3, existingPatient: true },
  { id: 'followup-peter', patientId: 'patient-chen-peter-006', kind: 'follow_up_booked', priority: 'routine', modality: 'in_person', action: 'Follow-up DEXA booked', detail: 'No action needed before the scan', physicianJudgment: false, ready: true, ageDays: 5, existingPatient: true },
]
