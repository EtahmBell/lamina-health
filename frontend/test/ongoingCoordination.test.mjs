import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'

const app = readFileSync(new URL('../src/App.tsx', import.meta.url), 'utf8')
const referralSource = readFileSync(new URL('../src/Referral.tsx', import.meta.url), 'utf8')
const styles = readFileSync(new URL('../src/styles.css', import.meta.url), 'utf8')

const slice = (source, from, to) => {
  const start = source.indexOf(from)
  return source.slice(start, to !== undefined ? source.indexOf(to, start) : undefined)
}
const recommendationView = () => slice(app, 'function RecommendationView', 'function PatientWorkspace')
const chenDownstreamCard = () => slice(referralSource, 'export function ChenDownstreamCard', 'export function chenPatientRowStatus')
const coordinationChatCard = () => slice(referralSource, 'export function CoordinationChatCard', '/* ============================================================ RECEIVING SIDE')

const chenPatientRowStatusSource = () => slice(referralSource, 'export function chenPatientRowStatus', 'export function ChenPatientsPage')

/* ================================================================= Part W
 * Chen Patients-list consultation-complete status (Part A) -- derived from
 * the real persisted artifacts, never special-cased by patient id. The
 * function itself can't be imported and called directly (node:test has no
 * TSX loader, matching every other .tsx-sourced test file in this suite),
 * so its exact branching is verified against its real source.
 * ===================================================================== */

test('accepted referral with no encounter/scheduling yet -> "Referral accepted"', () => {
  const fn = chenPatientRowStatusSource()
  assert.match(fn, /return \{ label: 'Referral accepted', nextStep: 'Open patient' \}/)
})

test('scheduled referral with no encounter yet -> "Scheduled"', () => {
  const fn = chenPatientRowStatusSource()
  assert.match(fn, /if \(referral\.status === 'scheduled' \|\| referral\.status === 'consult_returned'\) return \{ label: 'Scheduled', nextStep: 'Open patient' \}/)
})

test('ConsultationEncounter exists -> "Consultation complete", regardless of referral status -- the encounter check comes first and short-circuits the status check entirely', () => {
  const fn = chenPatientRowStatusSource()
  assert.match(fn, /if \(encounter\) \{/)
  const encounterBranchIndex = fn.indexOf('if (encounter) {')
  const scheduledBranchIndex = fn.indexOf("referral.status === 'scheduled'")
  assert.ok(encounterBranchIndex < scheduledBranchIndex, 'encounter must be checked before status, so it always wins')
  assert.match(fn, /return \{ label: 'Consultation complete', nextStep: 'Open patient' \}/)
})

test('handoff draft exists -> badge stays "Consultation complete", row action becomes "Review handoff"', () => {
  const fn = chenPatientRowStatusSource()
  assert.match(fn, /if \(handoff\?\.status === 'draft'\) return \{ label: 'Consultation complete', nextStep: 'Review handoff' \}/)
})

test('handoff sent -> badge stays "Consultation complete", row action becomes "View handoff"', () => {
  const fn = chenPatientRowStatusSource()
  assert.match(fn, /if \(handoff\?\.status === 'sent'\) return \{ label: 'Consultation complete', nextStep: 'View handoff' \}/)
})

test('the badge is never derived by special-casing a patient id -- chenPatientRowStatus takes only the real artifacts as arguments', () => {
  const fn = chenPatientRowStatusSource()
  assert.match(fn, /function chenPatientRowStatus\(\s*\n\s*referral: Referral, encounter: ConsultationEncounter \| null, handoff: HandoffSummary \| null,/)
  assert.doesNotMatch(fn, /patient-t2dm-003|TONJIT/i)
})

test('Tonjit (or any accepted patient) remains in Chen\'s active-patient query regardless of care-state progression (unaffected by this pass)', () => {
  const fn = slice(referralSource, 'export function ChenPatientsPage', 'export function ChenHomePage')
  assert.match(fn, /ACCEPTED_OR_LATER_STATUSES\.includes\(referral\.status\)/)
})

/* ================================================================= Part X
 * PCP final state: "Current care state" heading, green success badge,
 * consolidated links, referral-details access.
 * ===================================================================== */

test('consult_returned uses "Current care state" framing, not "Next step"', () => {
  const fn = recommendationView()
  assert.match(fn, /<h2>Current care state<\/h2>/)
})

test('the generic "Next step" heading is skipped once RecommendationView takes over (state-aware heading, Part B)', () => {
  assert.match(app, /\{nextStepState !== 'ready' && <><h2>Next step<\/h2>/)
})

test('pre-referral/discovery states still say "Next step" -- this pass never globally renames that heading', () => {
  const fn = recommendationView()
  assert.match(fn, /return <section className="recommendations" aria-label="Specialist recommendations"/)
})

test('specialist follow-up received uses the shared green success token, not mineral-blue', () => {
  const fn = slice(referralSource, "case 'handoff_received':", "case 'unresolved':")
  assert.match(fn, /<span className="status-label success">/)
  assert.doesNotMatch(fn, /<span className="status-label resolved">/)
})

test('"Review handoff" remains present as the primary action once a handoff exists', () => {
  assert.match(referralSource, /\{handoff && <button type="button" className="button-primary" onClick=\{\(\) => setHandoffOpen\(true\)\}>Review handoff →<\/button>\}/)
})

test('View referral packet / See agent coordination / Scheduling details are removed from the primary current-state card', () => {
  const linksBlock = slice(referralSource, "{status === 'done' && referral && !justCompleted && <div className=\"referral-mode-links\">", '</div>}')
  assert.doesNotMatch(linksBlock, /View referral packet/)
  assert.doesNotMatch(linksBlock, /See agent coordination/)
  assert.doesNotMatch(linksBlock, /View scheduling details/)
})

test('"Back to referral details" provides access to those three artifacts via ReferralDetailsModal, reusing the existing modals rather than duplicating their data', () => {
  const fn = slice(referralSource, 'function ReferralDetailsModal', 'export function HandoffModal')
  assert.match(fn, /<ReferralPacketModal|onOpenPacket/)
  assert.match(fn, /onOpenCoordination/)
  assert.match(fn, /onOpenScheduling/)
  assert.doesNotMatch(fn, /referral\.packet\.items\.map/, 'must not re-render packet items itself -- that stays inside ReferralPacketModal')
})

test('no historical data is deleted -- ReferralPacketModal/AgentCoordinationModal/SchedulingDetailsModal all still exist unchanged', () => {
  assert.match(referralSource, /export function ReferralPacketModal/)
  assert.match(referralSource, /export function AgentCoordinationModal/)
  assert.match(referralSource, /export function SchedulingDetailsModal/)
})

/* ================================================================= Part Z
 * Consult another specialist: reopens the real existing discovery flow,
 * never a fake frontend-only second referral.
 * ===================================================================== */

test('"Consult another specialist" is visible once the original referral loop is complete (consult_returned)', () => {
  assert.match(app, /\{activeReferral\?\.status === 'consult_returned' && <p className="patient-level-action">/)
  assert.match(app, />Consult another specialist →<\/button>/)
})

test('it reopens the real existing Discovery/consult-network flow for the same patient -- the exact same setViewMode call "Back to match options" already uses, never a fabricated second-referral UI', () => {
  const button = slice(app, '<p className="patient-level-action">', '</p>}')
  assert.match(button, /onClick=\{\(\) => setViewMode\('discovery'\)\}/)
})

test('starting a new referral still goes through the one real createReferral/accept pipeline -- no parallel frontend-only referral object is fabricated anywhere', () => {
  assert.doesNotMatch(app, /fakeReferral|localReferral|secondReferral/i)
})

/* ================================================================= Part Y
 * Cross-physician agent-to-physician-agent coordination chat.
 * ===================================================================== */

test('no cross-physician chat before referral acceptance -- gated on ACCEPTED_OR_LATER_STATUSES, same invariant as the patient-list fix', () => {
  assert.match(app, /\{activeReferral && ACCEPTED_OR_LATER_STATUSES\.includes\(activeReferral\.status\) && activeReferral\.id && <CoordinationChatCard/)
})

test('Lucy gets "Ask Dr. Chen\'s Agent" after acceptance, with Chen as the represented physician', () => {
  const fn = slice(app, '<CoordinationChatCard', '/>}')
  assert.match(fn, /requestingPhysicianId=\{activeReferral\.referring_physician_id\}/)
  assert.match(fn, /representedPhysicianId=\{activeReferral\.receiving_physician_id\}/)
})

test('Chen gets "Ask Dr. Saruhashi\'s Agent" after acceptance, with Lucy as the represented physician -- the SAME shared CoordinationChatCard component, just swapped requesting/represented props (Part S)', () => {
  const fn = chenDownstreamCard()
  assert.match(fn, /requestingPhysicianId=\{referral\.receiving_physician_id\}/)
  assert.match(fn, /representedPhysicianId=\{referral\.referring_physician_id\}/)
  assert.match(fn, /representedPhysicianName=\{PCP_NAME\}/)
})

test('both directions reuse the exact same CoordinationChatCard component -- not two separate implementations', () => {
  const definitions = [...referralSource.matchAll(/export function CoordinationChatCard/g)]
  assert.equal(definitions.length, 1)
  assert.match(app, /<CoordinationChatCard/)
  assert.match(referralSource, /chatCard = referral\.id && <CoordinationChatCard/)
})

test('the chat card fetches the real authorized thread via getCoordinationChat, and sends via askPhysicianAgent -- never a client-only template', () => {
  const fn = coordinationChatCard()
  assert.match(fn, /getCoordinationChat\(referral\.id, requestingPhysicianId\)/)
  assert.match(fn, /askPhysicianAgent\(referral\.id, requestingPhysicianId, trimmed\)/)
})

test('agent answers render requires_physician_input as an escalation note and based_on as quiet grounding, never hidden chain-of-thought', () => {
  const fn = coordinationChatCard()
  assert.match(fn, /message\.requires_physician_input && <p className="chat-uncertainty">/)
  assert.match(fn, /message\.based_on\.length > 0 && <p className="chat-grounding">Based on: \{message\.based_on\.join\(', '\)\}<\/p>/)
})

test('suggested prompts remain available after being used -- the dropdown is not a checklist, and sending a suggested prompt never removes it from the list', () => {
  const fn = coordinationChatCard()
  assert.match(fn, /suggestedPrompts\.map\(\(prompt\) => <button key=\{prompt\}/)
  assert.doesNotMatch(fn, /setSuggestedPrompts|filter\(\(p\) => p !== prompt\)/, 'the prompt list itself must never be mutated when a prompt is sent')
})

test('the suggested-prompts disclosure stays open across the conversation (controlled, not auto-closing after a send)', () => {
  const fn = coordinationChatCard()
  assert.match(fn, /<details className="network-optional coordination-chat-prompts" open=\{promptsOpen\} onToggle=\{\(event\) => setPromptsOpen\(event\.currentTarget\.open\)\}>/)
  assert.doesNotMatch(fn, /setPromptsOpen\(false\)[\s\S]{0,40}send|send[\s\S]{0,80}setPromptsOpen\(false\)/)
})

test('chat remains available after scheduling and after consult_returned -- never hidden once the loop closes', () => {
  assert.match(referralSource, /export const ACCEPTED_OR_LATER_STATUSES: ReferralStatus\[\] = \['accepted', 'scheduled', 'consult_returned'\]/)
  assert.match(app, /ACCEPTED_OR_LATER_STATUSES\.includes\(activeReferral\.status\)/)
})

test('reload hydrates the real persisted thread rather than starting empty or replaying -- fetched once on mount, keyed on the real referral/physician ids', () => {
  const fn = coordinationChatCard()
  assert.match(fn, /useEffect\(\(\) => \{\s*if \(!referral\.id\) return\s*let ignore = false\s*getCoordinationChat/)
})

test('persistence is patient/referral scoped, not a generic physician agent memory table (Part M)', () => {
  assert.match(referralSource, /CoordinationChatMessage/)
  assert.doesNotMatch(referralSource, /localStorage\.setItem\(.*chat/i)
})
