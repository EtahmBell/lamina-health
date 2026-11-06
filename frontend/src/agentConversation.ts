import type { AgentOverview } from './api.ts'
import type { DemoPatientSummary } from './demoPatients.ts'
import { buildBriefing, briefingText, countWord, type PhysicianQueue } from './physicianQueue.ts'

/**
 * Physician-agent home pass: the docked "Ask your agent" panel answers
 * questions about the physician's own workspace (what happened, what needs
 * them, a patient's status, what it is waiting on, what it has learned)
 * straight from the same PhysicianQueue the Dashboard renders -- so the
 * conversation can never contradict the page beside it. Anything else is
 * passed to the existing practice-question agent chat endpoint.
 */

export const DOCK_SUGGESTED_PROMPTS = [
  'What did you handle while I was away?',
  'What needs my attention today?',
  'How is Tonjit doing?',
  'What are you waiting on?',
  'What have you learned about my practice?',
]

export type AgentReply = {
  paragraphs: string[]
  bullets?: string[]
  /** One action card under the reply, e.g. "Open Tonjit Askarov". */
  link?: { label: string; detail: string; path: string; action: string }
}

export type WorkspaceSnapshot = {
  queue: PhysicianQueue
  overview: AgentOverview | null
  patients: DemoPatientSummary[]
}

const firstName = (name: string) => name.split(' ')[0]

/** A deterministic answer for workspace questions, or null to hand the
 * question to the practice-question agent. */
export function answerWorkspaceQuestion(question: string, snapshot: WorkspaceSnapshot): AgentReply | null {
  const text = question.toLowerCase()
  const { queue } = snapshot

  const patient = snapshot.patients.find((item) =>
    item.name.toLowerCase().split(' ').some((part) => new RegExp(`\\b${part}\\b`).test(text)))
  if (patient) {
    const need = [...queue.needs, ...queue.later].find((item) => item.patientId === patient.id)
    const wait = queue.waiting.find((item) => item.patientId === patient.id)
    const status = need && need.detail === patient.reason
      ? `${patient.name}${need.lead.rest}`
      : need?.detail ?? wait?.detail ?? 'Nothing is open for this patient right now.'
    const paragraphs = [`${patient.name}, ${patient.age}. ${patient.reason}.`, status]
    if (need && !need.deferred && queue.needs.includes(need)) paragraphs.push(`This one needs you. I've kept the case context ready on ${firstName(patient.name)}'s page.`)
    else if (wait) paragraphs.push("I'm handling this and will tell you when it moves.")
    return { paragraphs, link: { label: patient.name, detail: patient.reason, path: need?.path ?? wait?.path ?? `/patients/${patient.id}`, action: 'Open' } }
  }

  if (/while i was away|did you (do|handle)|handled|overnight/.test(text)) {
    if (!queue.log.length) return { paragraphs: ["I haven't had to act on anything on my own yet. When I consult the network or prepare a referral, it will show up here."] }
    return {
      paragraphs: [`I handled ${countWord(queue.log.length).toLowerCase()} thing${queue.log.length === 1 ? '' : 's'} on my own. The most recent:`],
      bullets: queue.log.slice(0, 4).map((entry) => entry.text),
    }
  }

  if (/attention|need(s)? me|need you|today|priorit/.test(text)) {
    if (!queue.needs.length) return { paragraphs: ["Nothing needs you right now. I'm keeping an eye on things."] }
    return {
      paragraphs: [briefingText(buildBriefing(queue.needs))],
      bullets: queue.needs.map((item) => `${item.title}: ${item.detail}`),
      link: { label: queue.needs[0].title, detail: queue.needs[0].detail, path: queue.needs[0].path, action: queue.needs[0].action },
    }
  }

  if (/waiting|pending|blocked/.test(text)) {
    if (!queue.waiting.length) return { paragraphs: ["I'm not waiting on anyone right now. Once a referral is out, I'll track the specialist's reply, scheduling and the returned summary."] }
    return { paragraphs: ["Here's what I'm waiting on. I'll bring each one back when it moves:"], bullets: queue.waiting.map((item) => `${item.title}: ${item.detail}`) }
  }

  if (/learn|know about (me|my)|my practi[cs]e|about you/.test(text)) {
    const overview = snapshot.overview
    const facts = overview?.portrait_confirmed_facts ?? []
    const recent = (overview?.recent_learnings ?? []).map((item) => item.summary)
    const open = overview?.learning_opportunities.length ?? 0
    if (!overview || (!facts.length && !recent.length)) return { paragraphs: ["I haven't confirmed anything about your practice yet. Answering a few questions in Your Agent is the fastest way to teach me."], link: { label: 'Your Agent', detail: 'How I represent your practice', path: '/agent?tab=overview', action: 'Open' } }
    return {
      paragraphs: ['This is what you have confirmed with me so far:'],
      bullets: [...recent, ...facts].slice(0, 5),
      link: { label: 'Your Agent', detail: open ? `${countWord(open)} open question${open === 1 ? '' : 's'} where I need your input` : 'How I represent your practice', path: '/agent?tab=overview', action: 'Open' },
    }
  }

  return null
}
