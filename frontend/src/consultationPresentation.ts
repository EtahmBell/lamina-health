import type { ConsultationMessage } from './api'

export type ConsultationStage = {
  id: string
  kind: 'case' | 'responses' | 'clarification' | 'requirements' | 'access' | 'synthesis'
  title: string
  messages: ConsultationMessage[]
}

const stageFor = (type: ConsultationMessage['message_type']): ConsultationStage['kind'] => {
  switch (type) {
    case 'consult_request': return 'case'
    case 'fit_response':
    case 'redirect': return 'responses'
    case 'follow_up_question':
    case 'follow_up_answer': return 'clarification'
    case 'referral_requirement': return 'requirements'
    case 'access_update': return 'access'
    case 'synthesis': return 'synthesis'
  }
}

const titles: Record<ConsultationStage['kind'], string> = {
  case: 'Case sent',
  responses: 'Physician responses',
  clarification: 'Clarification',
  requirements: 'Workup & acceptance',
  access: 'Access',
  synthesis: 'Synthesis',
}

/** Consecutive runs keep the backend sequence intact, including case-specific phase order. */
export function groupConsultationMessages(messages: ConsultationMessage[]): ConsultationStage[] {
  const stages: ConsultationStage[] = []
  for (const message of [...messages].sort((a, b) => a.sequence - b.sequence)) {
    const kind = stageFor(message.message_type)
    const previous = stages.at(-1)
    if (previous?.kind === kind) previous.messages.push(message)
    else stages.push({ id: `${kind}-${message.sequence}`, kind, title: titles[kind], messages: [message] })
  }
  return stages
}
