import type { ConsultationRecord, CoordinationEvent, LearningOpportunity, Referral, ReferralStatus } from './api.ts'
import { agentActivity, activityPath } from './agentActivity.ts'
import { CHEN_ID, CHEN_NAME, cleanName } from './demoIdentity.ts'
import type { DemoPatientSummary } from './demoPatients.ts'
import { daysRemaining, type NextStepItem, type SpecialistCareState } from './specialistWorklist.ts'

/**
 * Physician-agent home pass: the ONE derivation of "what does my agent need
 * from me" for a physician's Dashboard and For you page. It is an adapter over
 * state Lamina already persists -- consultation records, referrals and their
 * coordination events, the returned handoff, and the agent's open questions
 * about the physician's practice -- never a parallel task store. The Dashboard
 * shows the top few `needs` items; For you shows all of them, plus `later`
 * and `done`.
 *
 * Conditional readiness: anything the agent can carry on its own (an in-flight
 * referral, scheduling, a booked visit) is reported as `waiting`, not as
 * physician work. Only decisions that need the physician -- or physician-
 * specific knowledge the agent does not have -- become `needs`.
 */

export type QueueKind =
  | 'returned_consult' | 'physician_action' | 'referral_ready' | 'worsening'
  | 'review_options' | 'clarification' | 'not_consulted'
  | 'incoming_referral' | 'handoff_review' | 'established_patient'

/** How the briefing names an item: "<name><rest>". `sentence` is the
 * standalone form used when it is the only thing that needs the physician. */
export type BriefingLead = { name: string | null; rest: string; sentence?: { name: string | null; rest: string } }

export type QueueItem = {
  id: string
  kind: QueueKind
  patientId: string | null
  /** Row headline: the patient's name, or the clarification ask. */
  title: string
  /** Row sub-line. */
  detail: string
  action: string
  path: string
  lead: BriefingLead
  rank: number
  deferred: boolean
  /** Set for an incoming referral, so the page can open the existing review. */
  referralId?: number
}

export type DoneItem = { id: string; title: string; detail: string; path: string }
export type WaitingItem = { id: string; patientId: string; title: string; detail: string; path: string }
/** `time` is ISO; empty for standing synthetic demo context with no event time. */
export type AgentLogEntry = { id: string; time: string; text: string; path: string | null }

export type PhysicianQueue = {
  needs: QueueItem[]
  later: QueueItem[]
  done: DoneItem[]
  waiting: WaitingItem[]
  log: AgentLogEntry[]
}

/** An open question about how the physician practises (practice representation gap). */
export type PracticeQuestion = { id: string; prompt: string; priority: number }

export type QueueInput = {
  patients: DemoPatientSummary[]
  records: ConsultationRecord[]
  referrals: Map<string, Referral | null>
  /** Patient ids whose returned consultation summary the physician has opened, with when. */
  handoffViewedAt: Map<string, string>
  clarifications: LearningOpportunity[]
  clarificationPath: (id: string) => string
  /** Seeded, still-unanswered questions in the physician's practice representation. */
  practiceQuestions?: PracticeQuestion[]
  practiceQuestionsPath?: string
  /** Item ids the physician moved to Later in this browser session. */
  deferred: Set<string>
  now: Date
}

const patientPath = (id: string) => `/patients/${id}`

const receivingName = (referral: Referral) =>
  referral.receiving_physician_id === CHEN_ID ? CHEN_NAME : `the ${referral.specialty} specialist`

const IN_PROGRESS: ReferralStatus[] = ['draft', 'assembling', 'preflight', 'resolving']

const lastEvent = (referral: Referral): CoordinationEvent | undefined =>
  [...referral.coordination_events].sort((a, b) => b.sequence - a.sequence)[0]

export const sameDay = (iso: string | null | undefined, now: Date) => {
  if (!iso) return false
  const date = new Date(iso)
  return date.getFullYear() === now.getFullYear() && date.getMonth() === now.getMonth() && date.getDate() === now.getDate()
}

const missingRequired = (referral: Referral) =>
  referral.requirement_results.filter((item) => item.required && item.status === 'missing_from_packet')

/** Labels of requirements the agents found in the record and attached. */
export const attachedRequirementLabels = (referral: Referral): string[] => {
  const labels = new Map([...referral.receiving_requirements, ...referral.requirement_results].map((item) => [item.key, item.label]))
  return referral.coordination_events
    .filter((event) => event.event_type === 'information_attached')
    .map((event) => labels.get(String(event.metadata.requirement ?? '')))
    .filter((label): label is string => Boolean(label))
}

/** Number words for the briefing ("Two things need you today."). */
const WORDS = ['No', 'One', 'Two', 'Three', 'Four', 'Five', 'Six', 'Seven', 'Eight', 'Nine', 'Ten', 'Eleven', 'Twelve']
export const countWord = (n: number) => WORDS[n] ?? String(n)

const finish = (items: Omit<QueueItem, 'deferred'>[], deferred: Set<string>, laterKinds: QueueKind[]) => {
  const ranked = items
    .map((item) => ({ ...item, deferred: deferred.has(item.id) }))
    .sort((a, b) => a.rank - b.rank || a.title.localeCompare(b.title))
  return {
    needs: ranked.filter((item) => !item.deferred && !laterKinds.includes(item.kind)),
    later: ranked.filter((item) => item.deferred || laterKinds.includes(item.kind)),
  }
}

/** The agent's open questions about how the physician practises -- one row.
 * Network-raised clarifications win; otherwise the representation's own
 * seeded unanswered questions, highest priority first. */
function practiceQuestionItem(input: Pick<QueueInput, 'clarifications' | 'clarificationPath' | 'practiceQuestions' | 'practiceQuestionsPath'>): Omit<QueueItem, 'deferred'> | null {
  const lead = { name: null, rest: "a question about how you practise that I can't answer without you." }
  if (input.clarifications.length) {
    const first = input.clarifications[0]
    const n = input.clarifications.length
    return { id: `clarification-${first.id}`, kind: 'clarification', patientId: null, rank: 3, action: 'Answer',
      title: n === 1 ? 'A question about how you practise' : `${countWord(n)} questions about how you practise`,
      detail: `${first.title}. I can't answer this for you without your input.`, path: input.clarificationPath(first.id), lead }
  }
  const questions = [...(input.practiceQuestions ?? [])].sort((a, b) => b.priority - a.priority || a.id.localeCompare(b.id))
  if (!questions.length || !input.practiceQuestionsPath) return null
  const n = questions.length
  return { id: 'practice-questions', kind: 'clarification', patientId: null, rank: 3, action: 'Answer',
    title: n === 1 ? 'A question about how you practise' : `${countWord(n)} questions about how you practise`,
    detail: `${questions[0].prompt} I can't answer this for you without your input.`, path: input.practiceQuestionsPath, lead }
}

/* ------------------------------------------------------ referring physician */

export function buildPhysicianQueue(input: QueueInput): PhysicianQueue {
  const items: Omit<QueueItem, 'deferred'>[] = []
  const done: DoneItem[] = []
  const waiting: WaitingItem[] = []
  const latestRecord = (patientId: string) => input.records
    .filter((record) => record.patient_id === patientId)
    .sort((a, b) => b.completed_at.localeCompare(a.completed_at))[0]

  for (const patient of input.patients) {
    const referral = input.referrals.get(patient.id) ?? null
    const record = latestRecord(patient.id)
    const path = patientPath(patient.id)
    const name = patient.name
    const base = { patientId: patient.id, title: name, path }

    if (referral) {
      const to = receivingName(referral)
      switch (referral.status) {
        case 'consult_returned': {
          const viewedAt = input.handoffViewedAt.get(patient.id)
          if (viewedAt) {
            if (sameDay(viewedAt, input.now)) done.push({ id: `done-handoff-${patient.id}`, title: `Reviewed ${to}'s consultation summary`, detail: name, path })
          } else {
            items.push({ ...base, id: `handoff-${patient.id}`, kind: 'returned_consult', rank: 0, action: 'Review',
              detail: `${to} returned the ${referral.specialty.toLowerCase()} consultation summary.`,
              lead: { name, rest: `: ${to} has returned the consultation summary for your review.` } })
          }
          continue
        }
        case 'submitted':
        case 'accepted':
        case 'scheduled': {
          const detail = referral.status === 'submitted' ? `Waiting for ${to} to review the referral.`
            : referral.status === 'accepted' ? `${to} accepted. Waiting on scheduling.`
              : `Consultation with ${to} is scheduled. Waiting on the visit.`
          waiting.push({ id: `waiting-${patient.id}`, patientId: patient.id, title: name, detail, path })
          if (sameDay(referral.updated_at, input.now)) {
            done.push({ id: `done-referral-${patient.id}`, title: referral.status === 'submitted' ? `Sent ${name}'s referral to ${to}` : `${name}'s referral moved forward`, detail, path })
          }
          continue
        }
        case 'ready_for_review':
          items.push({ ...base, id: `referral-ready-${patient.id}`, kind: 'referral_ready', rank: 1, action: 'Review',
            detail: `Referral to ${to} is assembled and checked. It needs your sign-off to send.`,
            lead: { name, rest: `: the referral to ${to} is ready for your sign-off.` } })
          continue
        default: {
          if (IN_PROGRESS.includes(referral.status)) {
            const blocked = lastEvent(referral)?.event_type === 'physician_action_required'
            const missing = missingRequired(referral)
            if (blocked) {
              items.push({ ...base, id: `referral-action-${patient.id}`, kind: 'physician_action', rank: 1, action: 'Review',
                detail: missing.length ? `Referral is missing ${missing.map((item) => item.label.toLowerCase()).join(', ')}. I couldn't find it in the record.` : 'The referral needs a decision only you can make.',
                lead: { name, rest: `: the referral to ${to} needs something only you can provide.` } })
            } else {
              waiting.push({ id: `waiting-${patient.id}`, patientId: patient.id, title: name, detail: `Preparing the referral to ${to}.`, path })
            }
          }
          continue
        }
      }
    }

    if (record) {
      const physician = cleanName(record.result.recommended_physician.physician_name)
      const specialty = record.result.recommended_physician.specialty
      items.push({ ...base, id: `options-${patient.id}`, kind: 'review_options', rank: 2, action: 'Review',
        detail: `Network consult complete. ${specialty} with ${physician} looks like the best fit.`,
        lead: { name, rest: `: the network consult is back and ${specialty.toLowerCase()} looks like the right next step.` } })
      continue
    }

    if (patient.attention) {
      items.push({ ...base, id: `attention-${patient.id}`, kind: 'worsening', rank: 1, action: 'Review',
        detail: patient.reason, lead: { name, rest: patient.attention.lead } })
      continue
    }

    items.push({ ...base, id: `not-consulted-${patient.id}`, kind: 'not_consulted', rank: 4, action: 'Open',
      detail: `${patient.reason}. Not yet sent to the network.`,
      lead: { name, rest: ' has not been sent to the network yet.' } })
  }

  const question = practiceQuestionItem(input)
  if (question) items.push(question)

  // Not-yet-consulted cases are real, but nothing about them is new today --
  // the agent holds them in Later rather than claiming they need the physician now.
  const { needs, later } = finish(items, input.deferred, ['not_consulted'])
  return { needs, later, done, waiting, log: buildAgentLog(input) }
}

/** "While you were away" -- only work Lamina actually recorded: the agent's
 * structured network consultations, and the referral coordination events the
 * referring agent performed automatically. Never actions outside Lamina's own
 * consult and referral workflow, because the product performs none. */
export function buildAgentLog(input: Pick<QueueInput, 'records' | 'referrals' | 'patients'>): AgentLogEntry[] {
  const names = new Map(input.patients.map((patient) => [patient.id, patient.name]))
  const consultationEntries: AgentLogEntry[] = agentActivity(input.records)
    .filter((event) => event.order !== 2)
    .map((event) => ({
      id: `log-${event.id}`,
      time: event.time,
      path: activityPath(event),
      text: event.order === 1
        ? `Asked the physician network for specialty guidance on ${event.patientLabel}`
        : `Prepared ${event.patientLabel}'s case context and recommendation: ${event.detail.toLowerCase()}`,
    }))
  const referralEntries: AgentLogEntry[] = [...input.referrals.values()]
    .filter((referral): referral is Referral => Boolean(referral))
    .flatMap((referral) => referral.coordination_events
      .filter((event) => event.actor === 'referring_agent' && event.autonomy === 'automatic')
      .map((event) => ({
        id: `log-referral-${referral.id}-${event.sequence}`,
        time: event.created_at,
        path: patientPath(referral.patient_id),
        text: `${names.get(referral.patient_id) ?? 'Referral'}: ${event.summary.replace(/\.$/, '')}`,
      })))
  return [...consultationEntries, ...referralEntries].sort((a, b) => b.time.localeCompare(a.time))
}

/* ------------------------------------------------------ receiving specialist */

export type SpecialistQueueInput = {
  /** specialistNextSteps(...) -- real referral steps plus the seeded panel. */
  steps: NextStepItem[]
  /** Every referral addressed to this specialist (any status). */
  referrals: Referral[]
  careState: SpecialistCareState
  patientName: (id: string) => string
  patientPath: (id: string) => string
  referringName: string
  clarifications: LearningOpportunity[]
  clarificationPath: (id: string) => string
  /** Standing synthetic context the agent handled before this session (e.g.
   * routine requests it routed); shown at the end of the log, never timed. */
  standingLog?: AgentLogEntry[]
  deferred: Set<string>
  now: Date
}

/** A physician-judgment step needs the specialist now when it is new work
 * arriving through the network (a referral to review, a handoff to approve),
 * urgent, or within a day of its service target. Everything else that still
 * needs his judgment is held in Later until it gets close. */
const DUE_SOON_DAYS = 1

export function buildSpecialistQueue(input: SpecialistQueueInput): PhysicianQueue {
  const items: Omit<QueueItem, 'deferred'>[] = []
  const waiting: WaitingItem[] = []
  const referralsById = new Map(input.referrals.filter((item) => item.id != null).map((item) => [item.id as number, item]))

  for (const step of input.steps) {
    const name = input.patientName(step.patientId)
    const path = input.patientPath(step.patientId)
    const base = { patientId: step.patientId, title: name, path }
    if (!step.physicianJudgment) {
      waiting.push({ id: `waiting-${step.id}`, patientId: step.patientId, title: name, detail: `${step.action}. ${step.detail}.`.replace('..', '.'), path })
      continue
    }
    if (step.kind === 'review_referral') {
      const referral = step.referralId != null ? referralsById.get(step.referralId) : undefined
      const specialty = referral?.specialty ?? 'Specialty'
      const attached = referral ? attachedRequirementLabels(referral) : []
      const attachedClause = attached.length
        ? `; the required ${attached.map((label) => label.toLowerCase()).join(' and ')} ${attached.length === 1 ? 'was' : 'were'} found and attached`
        : ''
      items.push({ ...base, id: step.id, kind: 'incoming_referral', rank: 0, action: 'Review', referralId: step.referralId,
        detail: `${specialty} referral · ${step.ready ? 'Ready for review' : 'Waiting on missing information'}`,
        lead: step.ready
          ? { name, rest: `'s referral, which is ready for review${attachedClause}.`, sentence: { name, rest: `'s referral is ready for review${attachedClause}.` } }
          : { name, rest: "'s referral, which is still missing required information.", sentence: { name, rest: "'s referral is still missing required information." } } })
      continue
    }
    if (step.kind === 'review_handoff') {
      items.push({ ...base, id: step.id, kind: 'handoff_review', rank: 1, action: 'Review',
        detail: `${step.detail}. It needs your approval before it goes to ${input.referringName}.`,
        lead: { name, rest: `: I drafted the handoff to ${input.referringName} and it needs your approval.`,
          sentence: { name: null, rest: `I drafted ${name}'s handoff to ${input.referringName} and it needs your approval.` } } })
      continue
    }
    const remaining = daysRemaining(step)
    const due = step.priority === 'urgent' || remaining <= DUE_SOON_DAYS
    const dueText = remaining < 0 ? 'Past its service target' : remaining === 0 ? 'Due today' : `Due in ${remaining} day${remaining === 1 ? '' : 's'}`
    items.push({ ...base, id: step.id, kind: due ? 'physician_action' : 'established_patient', rank: due ? 2 : 4, action: due ? 'Review' : 'Open',
      detail: `${step.detail} · ${dueText}`, lead: { name, rest: `: ${step.action.toLowerCase()}.` } })
  }

  const question = practiceQuestionItem({ clarifications: input.clarifications, clarificationPath: input.clarificationPath })
  if (question) items.push(question)

  const done: DoneItem[] = []
  for (const referral of input.referrals) {
    const name = input.patientName(referral.patient_id)
    const path = input.patientPath(referral.patient_id)
    const accepted = referral.coordination_events.find((event) => event.event_type === 'referral_accepted')
    if (accepted && sameDay(accepted.created_at, input.now)) done.push({ id: `done-accepted-${referral.id}`, title: `Accepted ${name}'s referral`, detail: `${referral.specialty} referral from ${input.referringName}`, path })
    const handoff = referral.id != null ? input.careState.get(referral.id)?.handoff : null
    if (handoff?.status === 'sent' && sameDay(handoff.sent_at, input.now)) done.push({ id: `done-handoff-${referral.id}`, title: `Sent ${name}'s consultation summary to ${input.referringName}`, detail: `${referral.specialty} consultation`, path })
  }

  const { needs, later } = finish(items, input.deferred, ['established_patient'])
  return { needs, later, done, waiting, log: buildSpecialistLog(input) }
}

/** The receiving agent's own recorded work on incoming referrals -- checking
 * the packet against this physician's requirements, asking for what was
 * missing, attaching what was found, and scheduling -- then any standing
 * synthetic context. */
export function buildSpecialistLog(input: Pick<SpecialistQueueInput, 'referrals' | 'patientName' | 'patientPath' | 'standingLog'>): AgentLogEntry[] {
  const AGENT_EVENTS = new Set(['requirement_checked', 'information_requested', 'information_attached', 'preflight_completed', 'scheduling_options_found', 'scheduling_options_sent', 'appointment_scheduled', 'handoff_drafted'])
  const entries = input.referrals.flatMap((referral) => referral.coordination_events
    .filter((event) => AGENT_EVENTS.has(event.event_type) && event.actor !== 'receiving_physician')
    .map((event) => ({
      id: `log-referral-${referral.id}-${event.sequence}`,
      time: event.created_at,
      path: input.patientPath(referral.patient_id),
      text: `${input.patientName(referral.patient_id)}: ${event.summary.replace(/\.$/, '')}`,
    })))
    .sort((a, b) => b.time.localeCompare(a.time))
  return [...entries, ...(input.standingLog ?? [])]
}

/* ---------------------------------------------------------------- briefing */

/** The briefing is at most two sentences: how many, then the most important one. */
export type Briefing = { opening: string; lead: { name: string | null; rest: string } | null; closing: string }

export function buildBriefing(needs: QueueItem[]): Briefing {
  if (needs.length === 0) return { opening: 'Nothing needs you right now.', lead: null, closing: "I'm keeping an eye on things and will tell you if that changes." }
  const top = needs[0]
  if (needs.length === 1) {
    return top.lead.sentence
      ? { opening: 'One thing needs you. ', lead: top.lead.sentence, closing: "I'm keeping an eye on the rest." }
      : { opening: "One thing needs you today. It's ", lead: top.lead, closing: "I'm keeping an eye on the rest." }
  }
  return { opening: `${countWord(needs.length)} things need you today. The most important is `, lead: top.lead, closing: "I'm keeping an eye on the rest." }
}

export const briefingText = (briefing: Briefing) =>
  `${briefing.opening}${briefing.lead ? `${briefing.lead.name ?? ''}${briefing.lead.rest}` : ''} ${briefing.closing}`.replace(/\s+/g, ' ').trim()

/** The few rows the Dashboard shows; For you shows everything. */
export const DASHBOARD_NEEDS_LIMIT = 3
export const dashboardNeeds = (queue: PhysicianQueue) => queue.needs.slice(0, DASHBOARD_NEEDS_LIMIT)
