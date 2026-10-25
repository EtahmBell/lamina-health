/* Agent coordination oversight pass: one shared, structured Agent
 * coordination timeline for both physicians, correction controls only on the
 * viewer's own agent's representations, consistent entry points, and a Match
 * Details dropdown that no longer repeats "Why Dr. Chen". */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { canCorrectEvent, coordinationActorLabel, groupByStage, SCOPE_LABELS } from '../src/coordinationEpisode.ts'

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

test('matching and coordination stay separate: no clarification or workup entries in Match Details', () => {
  const view = slice(app, 'function RecommendationView', 'function PatientWorkspace')
  const details = slice(view, '<div className="match-details">{consultation.care_routing ? <>', '</> : <>')
  assert.doesNotMatch(details, /Clarification|coordination|Requirement identified/i)
})
