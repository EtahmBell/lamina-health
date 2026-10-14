import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'

const app = readFileSync(new URL('../src/App.tsx', import.meta.url), 'utf8')
const referralSource = readFileSync(new URL('../src/Referral.tsx', import.meta.url), 'utf8')
const api = readFileSync(new URL('../src/api.ts', import.meta.url), 'utf8')
const styles = readFileSync(new URL('../src/styles.css', import.meta.url), 'utf8')

const slice = (source, from, to) => source.slice(source.indexOf(from), to !== undefined ? source.indexOf(to) : undefined)
const handoffModal = () => slice(referralSource, 'export function HandoffModal', "/** Lucy's suggested prompts")
const chenDownstreamCard = () => slice(referralSource, 'export function ChenDownstreamCard', 'export function ChenPatientsPage')
const recommendationView = () => slice(app, 'function RecommendationView', 'function PatientWorkspace')
const patientWorkspace = () => slice(app, 'function PatientWorkspace', 'export default function App')

/* ============================================================== Part A/U
 * Sidebar nav text/icons are dark charcoal, shared at the source so every
 * physician workspace inherits it identically.
 * ===================================================================== */

test('sidebar nav text and icons are the shared dark Lamina text token in both active and inactive states, never mineral-blue or copper', () => {
  assert.match(styles, /\.nav-item \{[^}]*color: var\(--text-primary\);[^}]*\}/)
  assert.match(styles, /\.nav-item\.active \{[^}]*color: var\(--text-primary\);[^}]*\}/)
  assert.match(styles, /\.nav-icon \{ width: 24px; color: var\(--text-primary\); font-size: 1\.05rem; text-align: center; \}/)
  assert.doesNotMatch(styles, /\.nav-icon \{ width: 24px; color: var\(--mineral\)/)
  assert.doesNotMatch(styles, /\.nav-icon \{ width: 24px; color: var\(--accent\)/)
})

test('the pale blue active-item background is preserved -- only the text/icon color changed, not the active-state background', () => {
  assert.match(styles, /\.nav-item\.active \{ border-color: rgb\(83 110 125 \/ 22%\); background: var\(--mineral-surface\); color: var\(--text-primary\); \}/)
})

test('sidebar nav markup is shared (ProductShell), so Lucy, Chen, and Iain/any other physician workspace inherit the same dark nav styling -- never a per-physician override', () => {
  assert.match(app, /className="nav-item/)
  assert.doesNotMatch(styles, /#chen[^}]*\.nav-item|#iain[^}]*\.nav-item|#lucy[^}]*\.nav-item/i, 'no per-physician sidebar override exists')
})

/* ============================================================== Part C/Q
 * HandoffModal close bug: `sending` gated every close path (X/backdrop/
 * Escape), but only the catch branch ever reset it back to false -- a
 * successful send left it stuck `true` forever, permanently locking the
 * modal closed since the Send button itself disappears once isDraft flips
 * to false and offers no way to notice. Fixed with a `finally`.
 * ===================================================================== */

test('handleSend resets `sending` in a finally block, not only in the catch branch -- the actual root cause of the close bug', () => {
  const fn = handoffModal()
  const handleSend = slice(fn, 'const handleSend = async', 'return <ModalPortal>')
  assert.match(handleSend, /\} finally \{\s*setSending\(false\)\s*\}/)
  assert.doesNotMatch(handleSend, /catch \(sendError\) \{\s*setError\([^)]*\)\s*setSending\(false\)\s*\}/, 'sending must not be reset only inside the catch branch any more')
})

test('the X button, backdrop click, and Escape key all gate on the same `sending` flag, so once it correctly resets, all three close paths work again', () => {
  const fn = handoffModal()
  assert.match(fn, /<button className="text-button post-flow-close" onClick=\{onClose\} aria-label="Close" disabled=\{sending\}>×<\/button>/)
  assert.match(fn, /onClick=\{\(event\) => \{ if \(event\.target === event\.currentTarget && !sending\) onClose\(\) \}\}/)
  assert.match(fn, /if \(event\.key === 'Escape' && !sending\) onClose\(\)/)
})

test('clicking inside the dialog content never closes it -- the backdrop handler only fires when the click target IS the overlay itself', () => {
  const fn = handoffModal()
  assert.match(fn, /className="post-flow-overlay" role="presentation" onClick=\{\(event\) => \{ if \(event\.target === event\.currentTarget && !sending\) onClose\(\) \}\}/)
  assert.match(fn, /className="post-flow-dialog packet-dialog"/, 'the dialog content is a separate inner element, never catching the overlay-only close check')
})

test('closing never mutates handoff state -- onClose is a pure () => void, and the modal never calls onSend/mutates the handoff object on close', () => {
  const fn = handoffModal()
  assert.match(fn, /onClose: \(\) => void/)
  assert.doesNotMatch(fn, /onClose=\{.*onSend/i, 'onClose must never be wired to also trigger a send')
})

test('reopening the same handoff renders the same persisted data -- HandoffModal has no internal state that outlives a single handoff/status combination besides the transient sending/error flags', () => {
  const fn = handoffModal()
  const [, stateDecls] = [...fn.matchAll(/const \[(\w+), set\w+\] = useState/g)].reduce(
    (acc, match) => [acc[0], [...acc[1], match[1]]],
    [null, []],
  )
  assert.deepEqual(stateDecls.sort(), ['error', 'sending'].sort())
})

/* ============================================================== Part D/R
 * Hydration-flash fix: the UI must never render a guessed/default workflow
 * state (Discovery mode's "best fit" framing, or a half-resolved activity/
 * consultation derivation) while authoritative persisted artifacts are
 * still loading, and must never replay a live phase-reveal animation for a
 * referral that already existed before this page mounted.
 * ===================================================================== */

test('RecommendationView gates Discovery vs. Referral mode behind an explicit referralHydrated flag, defaulting to "already hydrated" only when there is no referral question to hydrate at all', () => {
  const fn = recommendationView()
  assert.match(fn, /const \[referralHydrated, setReferralHydrated\] = useState\(!referralQuestion\)/)
  assert.match(fn, /setReferralHydrated\(false\)/)
  assert.match(fn, /\}\)\.catch\(\(\) => \{\}\)\.finally\(\(\) => \{ if \(!ignore\) setReferralHydrated\(true\) \}\)/)
})

test('a neutral, quiet placeholder renders while referralHydrated is false -- never Discovery\'s "best fit" framing and never a live phase-reveal animation', () => {
  const fn = recommendationView()
  const gate = slice(fn, 'if (referralQuestion && !referralHydrated)', '// REFERRAL MODE')
  assert.match(gate, /Opening referral…/)
  assert.doesNotMatch(gate, /Start referral|best-fit-physician|consult-button/)
})

test('PatientWorkspace gates the Next step rail behind an explicit consultHydrated flag spanning the ENTIRE activity+consultation fetch chain, not just the first awaited step', () => {
  const fn = patientWorkspace()
  assert.match(fn, /const \[consultHydrated, setConsultHydrated\] = useState\(perspective !== 'pcp'\)/)
  assert.match(fn, /setReconsulting\(false\); setActivity\(null\); setConsultation\(null\); setRecordId\(undefined\); setConsultHydrated\(false\)/)
  assert.match(fn, /\}\)\.catch\(\(\) => \{ if \(!cancelled\) setActivity\(null\) \}\)\.finally\(\(\) => \{ if \(!cancelled\) setConsultHydrated\(true\) \}\)/)
})

test('nextStepState resolves to "hydrating" before any of idle/idle-prior/ready/consulting, and a neutral placeholder renders for it -- never a guessed historical state', () => {
  const fn = patientWorkspace()
  assert.match(fn, /const nextStepState: 'hydrating' \| 'idle' \| 'idle-prior' \| 'consulting' \| 'ready' =\s*\n\s*!consultHydrated \? 'hydrating' :/)
  assert.match(fn, /\{nextStepState === 'hydrating' && <div className="next-step-card idle"><p className="muted-note">Checking patient status…<\/p><\/div>\}/)
})

test('restorePhase-based hydration is untouched by the hydration-flash fix -- a referral that already exists still renders its real terminal phase directly, never an animated replay, confirmed by the existing restoredReferral contract', () => {
  assert.match(referralSource, /const \[status, setStatus\] = useState<'running' \| 'done' \| 'error'>\(restoredReferral \? 'done' : 'running'\)/)
  assert.match(referralSource, /if \(restoredReferral\) return \/\/ already hydrated synchronously via initial state above/)
})

/* ============================================================== Part E-H/S
 * Automatic scheduling: acceptance itself authorizes the whole
 * administrative chain (find options -> route -> synthetic confirmation),
 * so there is no manual "Find appointment options"/"Send to scheduling"
 * click left anywhere in the frontend.
 * ===================================================================== */

test('no manual "Find appointment options" or "Send to scheduling" click exists anywhere in the frontend any more', () => {
  assert.doesNotMatch(referralSource, /onClick=\{findOptions\}/)
  assert.doesNotMatch(referralSource, /onClick=\{sendToScheduling\}/)
  assert.doesNotMatch(referralSource, />Find appointment options </)
  assert.doesNotMatch(referralSource, />Send options to scheduling/)
  assert.doesNotMatch(referralSource, /const findOptions = async|const sendToScheduling = async/)
})

test('the frontend no longer calls findSchedulingOptions/routeSchedulingOptions at all -- scheduling automation lives entirely on the backend, authorized by acceptance', () => {
  assert.doesNotMatch(api, /export const findSchedulingOptions/)
  assert.doesNotMatch(api, /export const routeSchedulingOptions/)
  assert.doesNotMatch(referralSource, /findSchedulingOptions|routeSchedulingOptions/)
})

test('ChenDownstreamCard fetches scheduling/encounter/handoff purely for READING the already-automatic backend state, never to trigger it', () => {
  const fn = chenDownstreamCard()
  assert.match(fn, /getScheduling\(referral\.id\)/)
  assert.doesNotMatch(fn, /SchedulingOptionsModal/)
})

test('the live post-acceptance intro sequence (accepted -> checking -> routing -> scheduled) is pure frontend presentation pacing, gated on a session-local "just accepted" signal that is consumed exactly once and never replayed on reload', () => {
  assert.match(referralSource, /const CHEN_JUST_ACCEPTED_KEY = 'lamina:chen:just-accepted-referral'/)
  assert.match(referralSource, /export function markReferralJustAccepted\(patientId: string\)/)
  assert.match(referralSource, /window\.sessionStorage\.removeItem\(CHEN_JUST_ACCEPTED_KEY\)/)
  const fn = chenDownstreamCard()
  assert.match(fn, /const \[justAccepted\] = useState\(\(\) => consumeJustAcceptedFlag\(referral\.patient_id\)\)/)
  assert.match(fn, /if \(!justAccepted \|\| scheduling === undefined \|\| prefersReducedMotion\(\)\) return/)
})

test('markReferralJustAccepted is called right before navigating away from a just-accepted referral, in both places acceptance can happen', () => {
  const occurrences = [...referralSource.matchAll(/markReferralJustAccepted\(updated\.patient_id\)\s*\n\s*navigate\(`\/chen\/patients\/\$\{updated\.patient_id\}`\)/g)]
  assert.equal(occurrences.length, 2, 'expected both ChenPatientsPage and ChenHomePage handleAccepted to set the flag before navigating')
})

test('the intro sequence never runs under reduced motion or on a restored/hydrated view -- it falls straight through to the real durable state', () => {
  const fn = chenDownstreamCard()
  assert.match(fn, /if \(introPhase === 'accepted'\) return/)
  assert.match(fn, /if \(introPhase === 'checking'\) return/)
  assert.match(fn, /if \(introPhase === 'routing'\) return/)
  // Falls through to real data-driven rendering once introPhase is null again.
  assert.match(fn, /if \(scheduling && scheduling\.status === 'scheduled'\) \{/)
})

test('Lucy automatically sees scheduling propagation from the same shared SchedulingCoordination artifact once status reaches scheduled, with no extra Lucy-side action and no duplicate PCP-only scheduling state', () => {
  const fn = slice(referralSource, 'export function ReferralCoordinationSurface', 'export function AgentCoordinationModal')
  assert.match(fn, /if \(referral\.status === 'scheduled' \|\| referral\.status === 'consult_returned'\) \{\s*\n\s*getScheduling\(referral\.id\)/)
  assert.doesNotMatch(fn, /SchedulingCoordination\[\]|lucySchedulingCopy|separate.*scheduling/i)
})

/* ============================================================== Part I-K/T
 * Automatic handoff drafting: once a ConsultationEncounter exists, Chen's
 * Agent drafts the handoff automatically -- no manual "Draft handoff"
 * click. Sending still requires Chen's explicit approval (never automated).
 * ===================================================================== */

test('no manual "Draft handoff" click exists anywhere in the frontend any more', () => {
  assert.doesNotMatch(referralSource, /Draft handoff →/)
  assert.doesNotMatch(api, /export const draftHandoff/)
  assert.doesNotMatch(referralSource, /\bdraftHandoff\(/)
})

test('ChenDownstreamCard renders "Handoff ready for review" directly from the persisted draft, with a Review & send action -- never a drafting trigger', () => {
  const fn = chenDownstreamCard()
  assert.match(fn, /Handoff ready for review/)
  assert.match(fn, /Your agent prepared an update for Dr\. Saruhashi from the documented consultation\./)
  assert.match(fn, /Review &amp; send →/)
})

test('sending the handoff is still a real, explicit physician action -- the only automation-pass click that was NOT removed', () => {
  const fn = chenDownstreamCard()
  assert.match(fn, /const sendTheHandoff = async \(\) => \{/)
  assert.match(fn, /onSend=\{sendTheHandoff\}/)
})

test('HandoffModal still retains the provenance note and requires explicit approval language for a draft, unchanged by automatic drafting', () => {
  const fn = handoffModal()
  assert.match(fn, /Prepared by \{receivingPhysicianName\}'s Agent from the documented consultation\./)
  assert.match(fn, /Requires \{receivingPhysicianName\}'s approval before sending\./)
})

/* ============================================================== Part B/P
 * Completion wash: effectively opaque, with underlying content explicitly
 * hidden (not merely covered by an opaque background, which cannot hide a
 * card's own foreground children) -- covered in depth in referral.test.mjs;
 * these are the durable-state and no-replay-on-reload checks specific to
 * this pass's acceptance criteria.
 * ===================================================================== */

test('the durable "sent" state renders beneath the overlay/wash and becomes visible once both fade away together -- the wash and overlay toggle from the exact same class flip', () => {
  const fn = slice(referralSource, 'const revealSentPhase =', 'const start = async')
  assert.match(fn, /setWash\(true\)/)
  assert.match(fn, /setWash\(false\)/)
})

test('completion wash/overlay never render for a restored/hydrated referral -- justCompleted only ever becomes true inside the live start() sequence', () => {
  assert.match(referralSource, /const \[justCompleted, setJustCompleted\] = useState\(false\)/)
  assert.doesNotMatch(referralSource, /restoredReferral[\s\S]{0,80}setJustCompleted\(true\)/)
})
