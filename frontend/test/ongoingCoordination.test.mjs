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

test('"Review handoff" remains present as the primary action once a handoff exists, and opening it marks it viewed in the background (demo-consolidation pass, Part 15/9)', () => {
  assert.match(referralSource, /\{status === 'done' && referral && !justCompleted && handoff && <div className="referral-mode-links">\s*\n\s*<button type="button" className="button-primary" onClick=\{openHandoff\}>Review handoff →<\/button>/)
  assert.match(referralSource, /const openHandoff = \(\) => \{/)
  assert.match(referralSource, /markHandoffViewed\(referral\.id, referral\.referring_physician_id\)/)
})

test('View referral packet / See agent coordination / Scheduling details are removed from the primary "Review handoff" action block -- they live in their own direct-links section instead, never behind a modal (demo-consolidation pass, Part 1-2)', () => {
  const linksBlock = slice(referralSource, "{status === 'done' && referral && !justCompleted && handoff && <div className=\"referral-mode-links\">", '</div>}')
  assert.doesNotMatch(linksBlock, /View referral packet/)
  assert.doesNotMatch(linksBlock, /See agent coordination/)
  assert.doesNotMatch(linksBlock, /View scheduling details/)
  const artifactLinks = slice(referralSource, "{status === 'done' && referral && !justCompleted && <div className=\"referral-artifact-links\">", '</div>}')
  assert.match(artifactLinks, /View referral packet/)
  assert.match(artifactLinks, /See agent coordination/)
  assert.match(artifactLinks, /View scheduling details/)
})

test('the old generic "Back to referral details" modal is gone entirely -- direct, always-visible artifact links replace it (demo-consolidation pass, Part 1-2)', () => {
  assert.doesNotMatch(referralSource, /function ReferralDetailsModal/)
  assert.doesNotMatch(referralSource, /Back to referral details/)
  assert.match(referralSource, /className="referral-artifact-links"/)
})

test('no historical data is deleted -- ReferralPacketModal/AgentCoordinationModal/SchedulingDetailsModal all still exist unchanged', () => {
  assert.match(referralSource, /export function ReferralPacketModal/)
  assert.match(referralSource, /export function AgentCoordinationModal/)
  assert.match(referralSource, /export function SchedulingDetailsModal/)
})

/* ================================================================= Part Z
 * (demo-consolidation pass, Part 6/9) Once Lucy has reviewed the returned
 * handoff, the episode collapses and the primary card becomes a generic
 * "Current care state" card with a "Consult network" action -- this re-runs
 * the real consult-network pipeline for the SAME patient (never a fake
 * frontend-only second referral), rather than just flipping back to a stale
 * Discovery view.
 * ===================================================================== */

test('once the episode is reviewed, the primary card becomes a generic "Current care state" card offering "Consult network", not a Chen-specific card', () => {
  const fn = recommendationView()
  assert.match(fn, /if \(episodeReviewed\) \{/)
  assert.match(fn, /No specialty action pending/)
  assert.match(fn, />Consult network </)
  assert.match(fn, /onClick=\{onReconsult\}/)
})

test('"Consult network" re-runs the real consult pipeline via onReconsult (runConsult), never a fabricated second-referral UI or a bare view-mode flip', () => {
  assert.doesNotMatch(app, /fakeReferral|localReferral|secondReferral/i)
  assert.match(app, /onReconsult=\{runConsult\}/)
  assert.match(app, /const \[justConsulted, setJustConsulted\] = useState\(false\)/)
})

test('episode-reviewed state is reported up from ReferralCoordinationSurface via onReviewedChange, mirroring the existing onReferralChange\/onWashChange pattern', () => {
  assert.match(referralSource, /onReviewedChange\?: \(reviewed: boolean\) => void/)
  assert.match(app, /onReviewedChange=\{setEpisodeReviewed\}/)
})

/* ================================================================= Part Y
 * (demo-consolidation pass, Part 16-22) Cross-physician agent-to-physician-
 * agent coordination chat -- EPHEMERAL and perspective-isolated. These are
 * private interactions with the other physician's representation, not a
 * shared physician-to-physician message thread: nothing is persisted
 * server-side, and each physician's chat history lives only in their own
 * current frontend session state.
 * ===================================================================== */

/* (bug-fix pass, Part C) Active-episode chat moved from inside
 * ReferralCoordinationSurface's own returned fragment to App.tsx, rendered
 * as a true sibling of the "Referral to Dr. X" <article> -- not nested
 * inside its border. ReferralCoordinationSurface still owns the chat for
 * the COLLAPSED/reviewed episode (nested inside the expanded disclosure is
 * correct there, per Part I/J), so the component still has one definition,
 * just two different call sites now. */
test('active-episode chat is rendered by the parent (App.tsx), gated on real backend acceptance (ACCEPTED_OR_LATER_STATUSES) read directly from activeReferral -- not duplicated local workflow state', () => {
  assert.match(app, /activeReferral && activeReferral\.id && ACCEPTED_OR_LATER_STATUSES\.includes\(activeReferral\.status\) && <CoordinationChatCard/)
})

test('Lucy gets "Ask Dr. Chen\'s Agent" after acceptance, with Chen as the represented physician, as a sibling of the referral <article> -- never nested inside it', () => {
  const activeChat = slice(app, 'const activeEpisodeChat =', 'return <section className="recommendations referral-mode"')
  assert.match(activeChat, /requestingPhysicianId=\{activeReferral\.referring_physician_id\}/)
  assert.match(activeChat, /representedPhysicianId=\{activeReferral\.receiving_physician_id\}/)
  const activeBranch = slice(app, 'const activeEpisodeChat =', "return <section className=\"recommendations\" aria-label=\"Specialist recommendations\"")
  assert.match(activeBranch, /<\/article>\s*\n\s*\{activeEpisodeChat\}/, 'the chat renders after </article> closes, as a sibling, not inside it')
})

test('Chen gets "Ask Dr. Saruhashi\'s Agent" after acceptance, with Lucy as the represented physician -- the SAME shared CoordinationChatCard component, just swapped requesting/represented props (Part S)', () => {
  const fn = chenDownstreamCard()
  assert.match(fn, /requestingPhysicianId=\{referral\.receiving_physician_id\}/)
  assert.match(fn, /representedPhysicianId=\{referral\.referring_physician_id\}/)
  assert.match(fn, /representedPhysicianName=\{PCP_NAME\}/)
})

test('both directions, and both the active and collapsed episode states, reuse the exact same CoordinationChatCard component -- not several separate implementations', () => {
  const definitions = [...referralSource.matchAll(/export function CoordinationChatCard/g)]
  assert.equal(definitions.length, 1)
  assert.match(app, /<CoordinationChatCard/, 'App.tsx renders the active-episode instance directly, as a sibling card (Part C)')
  assert.match(referralSource, /<CoordinationChatCard/, 'Referral.tsx still renders the collapsed-episode instance, nested inside the expanded disclosure (Part I/J)')
})

test('the chat card is ephemeral -- no fetch of a persisted thread on mount, and no GET-chat API helper exists anymore', () => {
  const fn = coordinationChatCard()
  assert.doesNotMatch(fn, /getCoordinationChat/)
  assert.match(fn, /useState<LocalChatMessage\[\]>\(\[\]\)/)
  const api = readFileSync(new URL('../src/api.ts', import.meta.url), 'utf8')
  assert.doesNotMatch(api, /getCoordinationChat/)
})

test('sending a question calls askPhysicianAgent and renders the fresh CoordinationChatAnswer locally -- never a client-only fabricated template', () => {
  const fn = coordinationChatCard()
  assert.match(fn, /askPhysicianAgent\(referral\.id, requestingPhysicianId, trimmed\)/)
})

test('agent answers render requires_physician_input as an escalation note and based_on as quiet grounding, never hidden chain-of-thought', () => {
  const fn = coordinationChatCard()
  assert.match(fn, /requiresPhysicianInput && <p className="chat-uncertainty">/)
  assert.match(fn, /basedOn\.length > 0 && <p className="chat-grounding">Based on: \{.*basedOn\.join\(', '\)\}<\/p>/)
})

test('suggested prompts remain available after being used -- the dropdown is not a checklist, and sending a suggested prompt never removes it from the list', () => {
  const fn = coordinationChatCard()
  assert.match(fn, /suggestedPrompts\.map\(\(prompt\) => <button key=\{prompt\}/)
  assert.doesNotMatch(fn, /setSuggestedPrompts|filter\(\(p\) => p !== prompt\)/, 'the prompt list itself must never be mutated when a prompt is sent')
})

test('chat remains available after scheduling and after consult_returned -- never hidden once the loop closes', () => {
  assert.match(referralSource, /export const ACCEPTED_OR_LATER_STATUSES: ReferralStatus\[\] = \['accepted', 'scheduled', 'consult_returned'\]/)
})

test('the chat thread is a bounded, scrollable viewport that auto-scrolls to the newest message on send, never an ever-growing rail (Part 19)', () => {
  const fn = coordinationChatCard()
  assert.match(fn, /threadRef = useRef<HTMLDivElement>\(null\)/)
  assert.match(fn, /threadRef\.current\.scrollTop = threadRef\.current\.scrollHeight/)
  assert.match(styles, /\.coordination-chat-card \.chat-thread \{[^}]*max-height: 320px;[^}]*overflow-y: auto;/)
})

test('reloading/navigating back to the page starts with an empty chat -- messages are local component state only, never backed by localStorage/sessionStorage', () => {
  const fn = coordinationChatCard()
  assert.doesNotMatch(fn, /localStorage|sessionStorage/)
  assert.doesNotMatch(fn, /useEffect\(\(\) => \{[^}]*setMessages\(/, 'messages must never be populated from an effect on mount -- only via send()')
})

test('persistence is gone entirely -- no shared coordination_chat_messages table backs this feature anymore (Part 16-18)', () => {
  assert.doesNotMatch(referralSource, /CoordinationChatMessage/)
  assert.doesNotMatch(referralSource, /localStorage\.setItem\(.*chat/i)
})
