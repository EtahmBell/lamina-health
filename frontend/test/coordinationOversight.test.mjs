/* Agent coordination oversight pass: one shared, structured Agent
 * coordination timeline for both physicians, correction controls only on the
 * viewer's own agent's representations, consistent entry points, and a Match
 * Details dropdown that no longer repeats "Why Dr. Chen". */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { canCorrectEvent, coordinationActorLabel, groupByStage, groupNetworkConsultation, SCOPE_LABELS } from '../src/coordinationEpisode.ts'

const read = (path) => readFileSync(new URL(path, import.meta.url), 'utf8').replaceAll(String.fromCharCode(13), '')
const referralSource = read('../src/Referral.tsx')
const app = read('../src/App.tsx')
const shared = read('../src/coordinationEpisode.ts')
const slice = (source, from, to) => source.slice(source.indexOf(from), to === undefined ? undefined : source.indexOf(to, source.indexOf(from)))

const LUCY = 'agent-lucy-saruhashi'
const CHEN = 'physician-chen'
const item = (overrides) => ({
  id: 'event-1', stage: 'workup', title: 'Entry', actor_kind: 'agent', actor_physician_id: LUCY,
  content_kind: 'agent_representation', statement: 'Statement.', patient_facts: [], occurred_at: null,
  correctable: false, corrections: [], ...overrides,
})
const names = { referringPhysicianId: LUCY, referringName: 'Dr. Lucy Saruhashi', receivingPhysicianId: CHEN, receivingName: 'Dr. Noah Chen' }

/* ------------------------------------------------------ permissions (X) */

test('a physician can correct only their own agent\'s representations', () => {
  const lucyClarification = item({ title: 'Clarification resolved' })
  const chenRequirement = item({ title: 'Requirement identified', actor_physician_id: CHEN, content_kind: 'practice_representation' })
  assert.equal(canCorrectEvent(LUCY, lucyClarification), true)
  assert.equal(canCorrectEvent(CHEN, lucyClarification), false, 'Lucy\'s agent is read-only for Chen')
  assert.equal(canCorrectEvent(CHEN, chenRequirement), true)
  assert.equal(canCorrectEvent(LUCY, chenRequirement), false, 'Chen\'s agent is read-only for Lucy')
})

test('recorded system facts and chart facts are never correctable, even when an agent produced them', () => {
  assert.equal(canCorrectEvent(LUCY, item({ content_kind: 'system_fact' })), false)
  assert.equal(canCorrectEvent(LUCY, item({ content_kind: 'patient_fact', title: 'Record found' })), false)
  assert.equal(canCorrectEvent(CHEN, item({ actor_kind: 'physician', actor_physician_id: CHEN, content_kind: 'practice_representation' })), false, 'a physician\'s own action is not an agent representation')
  assert.equal(canCorrectEvent(LUCY, item({ actor_kind: 'network', actor_physician_id: null, content_kind: 'system_fact' })), false)
})

/* ------------------------------------------------ structured timeline (C) */

test('entries are grouped by stage in workflow order and numbered continuously', () => {
  const groups = groupByStage([
    item({ id: 'a', stage: 'workup' }), item({ id: 'b', stage: 'routing' }), item({ id: 'c', stage: 'clarification' }),
    item({ id: 'd', stage: 'routing' }), item({ id: 'e', stage: 'scheduling' }),
  ])
  assert.deepEqual(groups.map((group) => group.label), ['Routing', 'Clarification', 'Workup', 'Scheduling'])
  assert.deepEqual(groups.flatMap((group) => group.items.map(({ item: entry, number }) => `${number}:${entry.id}`)), ['01:b', '02:d', '03:c', '04:a', '05:e'])
})

test('actors read as each physician\'s agent, the physician, the network, or Lamina -- never a chat speaker', () => {
  assert.equal(coordinationActorLabel(item({}), names), 'Dr. Lucy Saruhashi Agent')
  assert.equal(coordinationActorLabel(item({ actor_physician_id: CHEN }), names), 'Dr. Noah Chen Agent')
  assert.equal(coordinationActorLabel(item({ actor_kind: 'physician', actor_physician_id: CHEN }), names), 'Dr. Noah Chen')
  assert.equal(coordinationActorLabel(item({ actor_kind: 'network', actor_physician_id: null }), names), 'Lamina Network')
  assert.equal(coordinationActorLabel(item({ actor_kind: 'system', actor_physician_id: null }), names), 'Lamina')
})

test('the timeline renders structured entries only -- no transcript, evidence, or metadata', () => {
  const modal = slice(referralSource, 'export function AgentCoordinationModal', '/**\n * Generic, reusable PacketItem')
  assert.match(modal, /groupByStage\(episode\.items\)\.map\(\(group\) => <section className="coordination-stage"/)
  assert.match(modal, /<strong className="coordination-title">\{item\.title\}<\/strong>/)
  assert.doesNotMatch(modal, /\.evidence|\.metadata|message\.content|said:|replied:/)
  assert.match(modal, /<ul className="coordination-facts" aria-label="Patient facts">/, 'chart facts are shown separately with their provenance')
  assert.match(modal, /<small>\{fact\.source\}<\/small>/)
})

test('scope choices use plain physician language', () => {
  assert.deepEqual(SCOPE_LABELS, { episode: 'This coordination only', future: 'Similar cases going forward', both: 'This coordination and similar cases' })
  assert.doesNotMatch(shared, /Lucy|Chen|Saruhashi|Tonjit/, 'the shared rules never name a physician or patient')
})

/* --------------------------------------------- one component, every entry (K-R, W) */

test('there is exactly one coordination timeline implementation, used by both physicians', () => {
  assert.equal([...referralSource.matchAll(/export function AgentCoordinationModal/g)].length, 1)
  assert.doesNotMatch(referralSource + app, /LucyAgentCoordination|ChenAgentCoordination/)
  assert.doesNotMatch(app, /coordination-timeline/, 'no second timeline elsewhere')
})

test('Lucy opens Agent coordination from the active referral and from the completed specialty-care episode', () => {
  const surface = slice(referralSource, 'export function ReferralCoordinationSurface', 'export function AgentCoordinationModal')
  const episode = slice(surface, '<details className="specialty-episode"', '</details>')
  assert.match(episode, /onClick=\{\(\) => setCoordinationOpen\(true\)\}>Agent coordination →<\/button>/)
  const artifactLinks = slice(surface, '<div className="referral-artifact-links">\n        <p className="section-label">Referral details</p>', '</div>}')
  assert.match(artifactLinks, />Agent coordination →</)
})

test('Chen opens Agent coordination from the incoming referral review and from every accepted-patient state', () => {
  const review = slice(referralSource, 'export function RequestReviewModal', '/** Dr. Chen\'s own pre-existing synthetic patients')
  assert.match(review, /onClick=\{\(\) => setCoordinationOpen\(true\)\}>Agent coordination <span>→<\/span><\/button>/)
  const downstream = slice(referralSource, 'export function ChenDownstreamCard', 'const CHEN_PATIENT_STAGE_META')
  // The shared `links` definition plus each settled state: handoff sent,
  // handoff draft, consultation documented, e-consult sent, scheduled, and
  // the accepted fallback.
  const entryPoints = [...downstream.matchAll(/>Agent coordination →<\/button>|\{links\}/g)].length
  assert.equal(entryPoints, 7)
  assert.match(slice(downstream, '<h3>Referred by {PCP_NAME}.</h3>', '</div>'), /\{links\}/, 'the accepted fallback state offers it too')
  assert.doesNotMatch(referralSource, /View referral history|See agent coordination|AI conversation|Agent transcript|Agent chat/)
})

/* ---------------------------------------------------------- Match Details (S-V) */

test('Match Details no longer repeats "Why Dr. X" but keeps the alternatives and their reasons', () => {
  const view = slice(app, 'function RecommendationView', 'function PatientWorkspace')
  const details = slice(view, '<div className="match-details">', '</div>}\n    </section>')
  assert.doesNotMatch(details, /Why \{cleanName|match-evidence|Similar-case experience|Receiving fit/)
  assert.match(details, /otherOptionRows\.map\(\(row\) => <li key=\{row\.key\}>/)
  assert.match(details, /\{row\.rationale && <p className="other-option-rationale">\{row\.rationale\}<\/p>\}/, 'why each alternative ranked where it did')
  assert.match(details, /<span>\{row\.accessText\}<\/span>/, 'access/capacity per alternative')
  // Agent responses from every consulted physician (e.g. a moderate fit or a
  // redirect) stay inspectable in the consultation record.
  assert.match(view, /<ConsultationLog messages=\{consultation\.messages\}/)
  assert.match(view, /agent\.accepts_case \? agent\.clinical_fit === 'strong' \? 'Strong fit' : 'Accepts' : 'Redirect'/)
})

/* ------------------------------------- Network consultation oversight (O-S) */

const OKONKWO = 'physician-okonkwo'
const TORRES = 'physician-torres'
const networkItems = [
  item({ id: 'consult-1-1', stage: 'routing', title: 'Case shared with the network', details: [{ label: 'Referral question', text: 'Treatment intensification.' }] }),
  item({ id: 'consult-1-2', stage: 'routing', title: 'Practice fit returned', actor_physician_id: CHEN, actor_name: 'Dr. Noah Chen', content_kind: 'practice_representation' }),
  item({ id: 'consult-1-3', stage: 'routing', title: 'Practice fit returned', actor_physician_id: OKONKWO, actor_name: 'Dr. Adaeze Okonkwo', content_kind: 'practice_representation' }),
  item({ id: 'consult-1-4', stage: 'routing', title: 'Practice fit returned', actor_physician_id: TORRES, actor_name: 'Dr. Marcus Torres', content_kind: 'practice_representation' }),
  item({ id: 'consult-1-priority', stage: 'routing', title: 'Priority', actor_kind: 'system', actor_physician_id: null, content_kind: 'system_fact' }),
  item({ id: 'consult-1-route-1', stage: 'routing', title: 'Recommended route', actor_kind: 'network', actor_physician_id: null, content_kind: 'system_fact' }),
  item({ id: 'consult-1-5', stage: 'clarification', title: 'Clarification requested', actor_physician_id: CHEN, actor_name: 'Dr. Noah Chen' }),
  item({ id: 'consult-1-6', stage: 'clarification', title: 'Clarification resolved' }),
]

test('the Network consultation groups ONE outgoing representation, then each candidate response, then the result', () => {
  const groups = groupNetworkConsultation(networkItems, LUCY)
  assert.deepEqual(groups.map((group) => group.label), ['Case shared with the network', 'Candidate responses', 'Clarification', 'Routing result'])
  const shared = groups[0].items
  assert.equal(shared.length, 1, 'one correction target for the shared representation, not one per candidate')
  assert.deepEqual(groups[1].items.map(({ item: entry }) => entry.actor_physician_id), [CHEN, OKONKWO, TORRES])
  assert.deepEqual(groups.flatMap((group) => group.items.map(({ number }) => number)), ['01', '02', '03', '04', '05', '06', '07', '08'])
})

test('during the Network consultation Lucy may correct only her own agent -- never a candidate, ranking, or access entry', () => {
  const correctable = networkItems.filter((entry) => canCorrectEvent(LUCY, entry)).map((entry) => entry.title)
  assert.deepEqual(correctable, ['Case shared with the network', 'Clarification resolved'])
  for (const owner of [CHEN, OKONKWO, TORRES]) {
    const response = networkItems.find((entry) => entry.actor_physician_id === owner)
    assert.equal(canCorrectEvent(LUCY, response), false)
    // Ownership, not selection: a non-selected candidate owns their own response.
    assert.equal(canCorrectEvent(owner, response), true)
    assert.equal(canCorrectEvent(owner, networkItems[0]), false, 'nobody else edits Lucy\'s agent')
  }
  assert.equal(canCorrectEvent.length, 2, 'the rule takes the viewer and the entry -- no selected-physician input')
  assert.doesNotMatch(slice(shared, 'export function canCorrectEvent', 'export type NumberedItem'), /selected|receiving|recommended/)
})

test('candidate agents are labelled by their own physician\'s name', () => {
  assert.equal(coordinationActorLabel(networkItems[2], names), 'Dr. Adaeze Okonkwo Agent')
  assert.equal(coordinationActorLabel(networkItems[4], names), 'Lamina')
  assert.equal(coordinationActorLabel(networkItems[5], names), 'Lamina Network')
})

test('Consultation details offers the same Review / Correct flow on the Network consultation, before any referral', () => {
  const view = slice(app, 'function RecommendationView', 'function PatientWorkspace')
  const dialog = slice(view, 'aria-label="Consultation details"', '</ModalPortal>}')
  assert.match(dialog, /\{recordId != null && <NetworkConsultationOversight recordId=\{recordId\} viewerPhysicianId=\{PCP_PHYSICIAN_ID\} viewerName=\{PCP_NAME\} \/>\}/)
  assert.doesNotMatch(dialog, /referralStarted &&\s*<NetworkConsultationOversight|activeReferral[^\n]*NetworkConsultationOversight/, 'not gated on a referral or selection')
  const oversight = slice(referralSource, 'export function NetworkConsultationOversight', 'function CoordinationEntry')
  assert.match(oversight, /groupNetworkConsultation\(episode\.items, episode\.referring_physician_id\)/)
  assert.match(oversight, /canCorrect=\{canCorrectEvent\(viewerPhysicianId, item\)\}/)
  assert.match(oversight, /<CoordinationCorrectionDrawer\s+target=\{\{ kind: 'consultation', id: recordId \}\}/, 'the one existing correction drawer, not a second system')
  assert.match(oversight, /<CoordinationEntry/)
  assert.doesNotMatch(oversight, /\.evidence|\.metadata|message\.content|selectedId|receiving_physician_id/)
  assert.equal([...referralSource.matchAll(/function CoordinationCorrectionDrawer/g)].length, 1)
  // After a fresh consult the saved record id is picked up, so the controls are there immediately.
  assert.match(slice(app, 'const runConsult', 'finally'), /void refreshActivity\(\)\.then\(\(found\) => \{ if \(found\?\.latest_consultation_id != null\) setRecordId\(found\.latest_consultation_id\) \}\)/)
})

test('the shared representation shows its referral question with the statement, and corrections keep the original visible', () => {
  const entry = slice(referralSource, 'function CoordinationEntry', '/**\n * Correct your agent')
  assert.match(entry, /<span className="coordination-original-label">Original<\/span><p>“\{item\.statement\}”<\/p>\{details\.map/)
  assert.match(entry, /<p className="coordination-detail" key=\{detail\.label\}><b>\{detail\.label\}:<\/b> \{detail\.text\}<\/p>/)
  assert.match(entry, /Corrected by Dr\. \{lastName\(viewerName\)\}/)
})

test('matching and coordination stay separate: no clarification or workup entries in Match Details', () => {
  const view = slice(app, 'function RecommendationView', 'function PatientWorkspace')
  const details = slice(view, '<div className="match-details">{consultation.care_routing ? <>', '</> : <>')
  assert.doesNotMatch(details, /Clarification|coordination|Requirement identified/i)
})
