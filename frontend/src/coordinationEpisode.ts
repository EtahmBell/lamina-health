/** Agent coordination oversight pass: the pure presentation rules behind the
 * one shared Agent coordination timeline -- used unchanged by both referral
 * physicians, from every entry point. No physician is named here; who may
 * correct what is decided only by ownership. */
import type { CoordinationItem, CoordinationStage, CorrectionScope } from './api.ts'

export const STAGE_LABELS: Record<CoordinationStage, string> = {
  routing: 'Routing',
  clarification: 'Clarification',
  workup: 'Workup',
  acceptance: 'Acceptance',
  scheduling: 'Scheduling',
  handoff: 'Handoff',
}
const STAGE_ORDER: CoordinationStage[] = ['routing', 'clarification', 'workup', 'acceptance', 'scheduling', 'handoff']

/** A physician may correct an entry only when it is their OWN agent's
 * representation -- never a recorded system or chart fact, never the other
 * physician's agent. Mirrors backend can_correct_item, which the correction
 * API enforces regardless of what is shown here. */
export function canCorrectEvent(viewerPhysicianId: string, item: CoordinationItem): boolean {
  return (item.content_kind === 'agent_representation' || item.content_kind === 'practice_representation')
    && item.actor_kind === 'agent'
    && item.actor_physician_id != null
    && item.actor_physician_id === viewerPhysicianId
}

export type NumberedItem = { item: CoordinationItem; number: string }
export type StageGroup = { stage: CoordinationStage; label: string; items: NumberedItem[] }

/** Stage groups in workflow order, numbered continuously ("01", "02", ...). */
export function groupByStage(items: CoordinationItem[]): StageGroup[] {
  let index = 0
  return STAGE_ORDER
    .map((stage) => ({ stage, label: STAGE_LABELS[stage], items: items.filter((item) => item.stage === stage) }))
    .filter((group) => group.items.length > 0)
    .map((group) => ({ ...group, items: group.items.map((item) => ({ item, number: String(++index).padStart(2, '0') })) }))
}

export type PartyNames = { referringPhysicianId: string; referringName: string; receivingPhysicianId: string; receivingName: string }

export function coordinationActorLabel(item: CoordinationItem, names: PartyNames): string {
  const name = item.actor_physician_id === names.referringPhysicianId ? names.referringName
    : item.actor_physician_id === names.receivingPhysicianId ? names.receivingName
      : null
  if (item.actor_kind === 'agent' && name) return `${name} Agent`
  if (item.actor_kind === 'physician' && name) return name
  if (item.actor_kind === 'network') return 'Lamina Network'
  if (item.actor_kind === 'scheduling_workflow') return 'Scheduling workflow'
  return 'Lamina'
}

export const SCOPE_LABELS: Record<CorrectionScope, string> = {
  episode: 'This coordination only',
  future: 'Similar cases going forward',
  both: 'This coordination and similar cases',
}
