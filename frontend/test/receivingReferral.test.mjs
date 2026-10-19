import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { derivePhases, restorePhase } from '../src/referralPhases.ts'

const app = readFileSync(new URL('../src/App.tsx', import.meta.url), 'utf8')
const referralSource = readFileSync(new URL('../src/Referral.tsx', import.meta.url), 'utf8')
const api = readFileSync(new URL('../src/api.ts', import.meta.url), 'utf8')
const styles = readFileSync(new URL('../src/styles.css', import.meta.url), 'utf8')

const slice = (source, from, to) => source.slice(source.indexOf(from), to !== undefined ? source.indexOf(to) : undefined)
const receivingSideSource = () => slice(referralSource, 'RECEIVING SIDE')

const event = (sequence, event_type, overrides = {}) => ({
  sequence, event_type, actor: null, autonomy: null, summary: '', metadata: {}, created_at: '2026-10-13T00:00:00+00:00', ...overrides,
})
const requirement = (key, label, required = true) => ({ key, label, required, freshness_days: 180 })

const baseReferral = {
  id: 7, patient_id: 'patient-t2dm-003', referring_physician_id: 'agent-lucy-saruhashi',
  receiving_physician_id: 'physician-chen', specialty: 'Endocrinology',
  referral_question: 'Please evaluate for treatment intensification.', urgency: 'Routine outpatient referral',
  created_at: '2026-10-13T00:00:00+00:00', updated_at: '2026-10-13T00:00:00+00:00',
  receiving_requirements: [
    requirement('recent_hba1c', 'Recent HbA1c'),
    requirement('current_medications', 'Current diabetes medication list'),
    requirement('recent_renal_function', 'Recent renal function'),
    requirement('glucose_log', 'Glucose log or CGM data', false),
  ],
  requirement_results: [
    { key: 'recent_hba1c', label: 'Recent HbA1c', required: true, status: 'satisfied' },
    { key: 'current_medications', label: 'Current diabetes medication list', required: true, status: 'satisfied' },
    { key: 'recent_renal_function', label: 'Recent renal function', required: true, status: 'satisfied' },
    { key: 'glucose_log', label: 'Glucose log or CGM data', required: false, status: 'optional_not_present' },
  ],
  packet: { items: [
    { key: 'recent_hba1c', label: 'Recent HbA1c', value: '9.6% on 2026-09-05', provenance: { source: 'patient_chart', attached_by: 'agent-lucy-saruhashi', attached_during: 'initial_assembly', observed_date: '2026-09-05' } },
    { key: 'recent_renal_function', label: 'Recent renal function', value: 'Creatinine: 0.9 mg/dL, eGFR: 97 mL/min/1.73m2 (2026-07-20)', provenance: { source: 'patient_chart', attached_by: 'agent-lucy-saruhashi', attached_during: 'preflight', observed_date: '2026-07-20' } },
  ] },
  coordination_events: [
    event(1, 'referral_created', { actor: 'referring_agent', autonomy: 'automatic' }),
    event(2, 'packet_assembled', { actor: 'referring_agent', autonomy: 'automatic' }),
    event(3, 'preflight_started', { actor: 'receiving_agent', autonomy: 'automatic' }),
    event(4, 'information_requested', { actor: 'receiving_agent', metadata: { requirement: 'recent_renal_function' } }),
    event(5, 'information_attached', { actor: 'referring_agent', autonomy: 'automatic', metadata: { requirement: 'recent_renal_function' } }),
    event(6, 'referral_ready', { actor: 'system' }),
    event(7, 'referral_submitted', { actor: 'system', autonomy: 'automatic', metadata: { receiving_physician_id: 'physician-chen', specialty: 'Endocrinology' } }),
  ],
}

const SUBMITTED_REFERRAL = { ...baseReferral, status: 'submitted' }
const ACCEPTED_REFERRAL = {
  ...baseReferral,
  status: 'accepted',
  coordination_events: [
    ...baseReferral.coordination_events,
    event(8, 'referral_accepted', { actor: 'receiving_physician', autonomy: 'physician_required', summary: 'Dr. Noah Chen accepted the referral and added the patient to their care.', metadata: { receiving_physician_id: 'physician-chen' } }),
  ],
}

/* ----------------------------------------------------------- state machine */

test('the backend referral status type includes accepted, in sequence after submitted', () => {
  assert.match(api, /export type ReferralStatus = 'draft' \| 'assembling' \| 'preflight' \| 'resolving' \| 'ready_for_review' \| 'submitted' \| 'accepted'/)
})

test('the coordination event/actor types include referral_accepted and receiving_physician', () => {
  assert.match(api, /'referral_submitted' \| 'referral_accepted'/)
  assert.match(api, /export type CoordinationActor = 'referring_agent' \| 'receiving_agent' \| 'system' \| 'receiving_physician'/)
})

/* -------------------------------------------------------- phase derivation */

test('derivePhases produces an accepted phase only when a real referral_accepted event exists', () => {
  const submittedPhases = derivePhases(SUBMITTED_REFERRAL)
  assert.ok(!submittedPhases.some((phase) => phase.kind === 'accepted'))
  const acceptedPhases = derivePhases(ACCEPTED_REFERRAL)
  const accepted = acceptedPhases.at(-1)
  assert.equal(accepted.kind, 'accepted')
  assert.equal(accepted.acceptedAt, '2026-10-13T00:00:00+00:00')
})

test('restorePhase on an accepted referral restores directly to the accepted phase -- no animation involved', () => {
  const phase = restorePhase(ACCEPTED_REFERRAL)
  assert.equal(phase.kind, 'accepted')
})

test('the accepted phase copy says "Accepted by Dr. X" and never repeats "Awaiting review"', () => {
  const caseBlock = slice(referralSource, "case 'accepted':", "case 'unresolved':")
  const renderedJsx = slice(caseBlock, 'return <>')
  assert.match(renderedJsx, /Accepted by Dr\. \{who\}/)
  assert.doesNotMatch(renderedJsx, /Awaiting/i)
})

test('eventActorLabel resolves receiving_physician to the physician\'s own name, distinct from "{name}\'s Agent"', () => {
  const referralPhasesSource = readFileSync(new URL('../src/referralPhases.ts', import.meta.url), 'utf8')
  const fn = slice(referralPhasesSource, 'export function eventActorLabel', referralPhasesSource.length)
  assert.match(fn, /if \(event\.actor === 'receiving_physician'\) return receivingPhysicianName/)
})

test('EVENT_TYPE_TITLES includes a human-readable referral_accepted title, so the shared Agent Coordination modal renders it without a second transcript', () => {
  const referralPhasesSource = readFileSync(new URL('../src/referralPhases.ts', import.meta.url), 'utf8')
  assert.match(referralPhasesSource, /referral_accepted: 'Referral accepted'/)
})

/* ------------------------------------------------------------- Part D/V API */

test('a real accept-referral API call and a physician-scoped referrals query exist, never a local fabrication', () => {
  assert.match(api, /export const acceptReferral = \(referralId: number, receivingPhysicianId: string\) => request<Referral>\(`\/api\/referrals\/\$\{referralId\}\/accept`/)
  assert.match(api, /export const getPhysicianReferrals = \(physicianId: string, status\?: ReferralStatus\) => request<Referral\[\]>\(`\/api\/physicians\/\$\{encodeURIComponent\(physicianId\)\}\/referrals/)
})

/* --------------------------------------------------------- Incoming requests */

test('IncomingRequestsControl renders the real referral count, never a hardcoded number', () => {
  const fn = slice(referralSource, 'function IncomingRequestsControl', 'export function RequestReviewModal')
  assert.match(fn, /Needs your review <span>\{referrals\.length\}<\/span>/)
  assert.doesNotMatch(fn, />\s*1\s*<\/span>/, 'the count must come from referrals.length, not a literal 1')
})

test('the incoming popover shows patient name, the real referring physician (Lucy), specialty, priority, and a real resolved-count summary -- no redundant second status badge (routing/triage UX pass, Part S)', () => {
  const fn = slice(referralSource, 'function IncomingRequestsControl', 'export function RequestReviewModal')
  assert.match(fn, /patientName\(referral\.patient_id\)/)
  assert.match(fn, /\{referral\.specialty\} referral from \{PCP_NAME\}/)
  assert.match(fn, /<PriorityChip priority=\{referral\.priority\} \/>/)
  assert.doesNotMatch(fn, /Ready for review/, 'the redundant status badge was removed -- the whole section is already called Needs your review')
  assert.match(fn, /resolvedSummary\(resolvedCountFor\(referral\)\)/)
  assert.match(fn, /onClick=\{\(\) => onReview\(referral\)\}>Review/)
})

test('resolvedCountFor derives the resolved-item count from real information_attached events, never a hardcoded "1"', () => {
  assert.match(referralSource, /const resolvedCountFor = \(referral: Referral\) =>\s*\n\s*referral\.coordination_events\.filter\(\(event\) => event\.event_type === 'information_attached'\)\.length/)
})

test('ChenPatientsPage hides the Incoming requests control entirely when there are zero submitted referrals -- no noisy empty card', () => {
  const fn = slice(referralSource, 'export function ChenPatientsPage', 'export function ChenHomePage')
  assert.match(fn, /\{incoming && incoming\.length > 0 && <IncomingRequestsControl/)
})

test('ChenPatientsPage queries submitted referrals and ALL of Chen\'s own referrals from the real backend, scoped to Dr. Chen, never a frontend fixture', () => {
  const fn = slice(referralSource, 'export function ChenPatientsPage', 'export function ChenHomePage')
  assert.match(fn, /getPhysicianReferrals\(CHEN_ID, 'submitted'\)/)
  assert.match(fn, /getPhysicianReferrals\(CHEN_ID\)/)
})

test('closed-loop referral follow-up pass, item 2: a referral stays in Chen\'s accepted patient list through every downstream status, not just "accepted" -- the original bug was ?status=accepted alone silently dropping it once scheduling/encounter/handoff progress advanced the status', () => {
  const module = slice(referralSource, 'export const ACCEPTED_OR_LATER_STATUSES', 'export function ChenPatientsPage')
  assert.match(module, /export const ACCEPTED_OR_LATER_STATUSES: ReferralStatus\[\] = \['accepted', 'scheduled', 'consult_returned'\]/)
  const fn = slice(referralSource, 'export function ChenPatientsPage', 'export function ChenHomePage')
  assert.match(fn, /all\.filter\(\(referral\) => ACCEPTED_OR_LATER_STATUSES\.includes\(referral\.status\)\)/)
  assert.doesNotMatch(fn, /getPhysicianReferrals\(CHEN_ID, 'accepted'\)/, 'must never go back to filtering by a single fixed status at the query level')
})

test('accepted referrals are merged into the shared WorklistRows rendering at the top (priority -1), with a care-state-accurate label derived from the real artifacts, and an honest empty state exists when there are none', () => {
  const fn = slice(referralSource, 'export function ChenPatientsPage', 'export function ChenHomePage')
  assert.match(fn, /const \{ label, nextStep \} = chenPatientRowStatus\(referral, state\.encounter, state\.handoff\)/)
  assert.match(fn, /return \{ patient, label, tone: 'copper', nextStep, priority: -1, updated: null \}/)
  assert.match(fn, /<WorklistRows rows=\{active\} navigate=\{navigate\} basePath="\/chen\/patients" highlightIds=\{highlighted\} \/>/)
  assert.match(fn, /No patients found/)
})

/* ---------------------------------------------------------- Request Review */

test('RequestReviewModal renders through ModalPortal and shows the real referral question, never a hardcoded one', () => {
  const fn = slice(referralSource, 'export function RequestReviewModal', 'export function ChenPatientsPage')
  assert.match(fn, /<ModalPortal>/)
  assert.match(fn, /\{referral\.referral_question\}/)
})

test('the clinical snapshot and referral readiness checklist render from the real packet and requirement_results, never hardcoded strings', () => {
  const fn = slice(referralSource, 'export function RequestReviewModal', 'export function ChenPatientsPage')
  assert.match(fn, /referral\.packet\.items\.map/)
  assert.match(fn, /referral\.requirement_results\.map/)
  assert.doesNotMatch(fn, /Tonjit|9\.6%|Creatinine: 0\.9/i, 'no per-patient hardcoded clinical values')
})

test('a satisfied requirement shows the real packet item value and, when attached during preflight, its real provenance', () => {
  const fn = slice(referralSource, 'export function RequestReviewModal', 'export function ChenPatientsPage')
  assert.match(fn, /referral\.packet\.items\.find\(\(packetItem\) => packetItem\.key === check\.key\)/)
  assert.match(fn, /packetItemProvenanceLine\(item\)/)
})

test('"Agent preflight complete" summary and "See agent coordination" reuse the same real coordination_events-derived resolved count', () => {
  const fn = slice(referralSource, 'export function RequestReviewModal', 'export function ChenPatientsPage')
  assert.match(fn, /Agent preflight complete/)
  assert.match(fn, /resolvedCountFor\(referral\)/)
  assert.match(fn, /onClick=\{\(\) => setCoordinationOpen\(true\)\}>See agent coordination/)
})

test('"View full referral packet" reuses the existing ReferralPacketModal -- no second receiving-side packet renderer', () => {
  const fn = slice(referralSource, 'export function RequestReviewModal', 'export function ChenPatientsPage')
  assert.match(fn, /onClick=\{\(\) => setPacketOpen\(true\)\}>View full referral packet/)
  assert.match(fn, /<ReferralPacketModal referral=\{referral\}/)
  assert.match(fn, /<AgentCoordinationModal referral=\{referral\}/)
})

test('Accept referral is present and is the only enabled action -- no fake-functional Decline/Redirect/Request-clarification buttons', () => {
  const fn = slice(referralSource, 'export function RequestReviewModal', 'export function ChenPatientsPage')
  assert.match(fn, />Accept referral<\/button>|\{accepting \? 'Accepting…' : 'Accept referral'\}/)
  assert.doesNotMatch(fn, /Decline referral|Redirect referral|Request clarification/i)
})

/* -------------------------------------------------------------- Acceptance */

const acceptFnSource = () => {
  const start = referralSource.indexOf('const accept = async')
  const end = referralSource.indexOf('return <>', start)
  return referralSource.slice(start, end)
}

test('clicking Accept calls the real backend accept endpoint with this referral\'s id and receiving physician, never a local status flip', () => {
  const fn = acceptFnSource()
  assert.match(fn, /acceptReferral\(referral\.id, referral\.receiving_physician_id\)/)
})

test('the success message only appears after accept() resolves -- accepted state is set from the real response, not optimistically before the call', () => {
  const fn = acceptFnSource()
  const awaitIndex = fn.indexOf('await acceptReferral')
  const setAcceptedIndex = fn.indexOf('setAccepted(true)')
  assert.ok(awaitIndex >= 0 && setAcceptedIndex > awaitIndex, 'setAccepted(true) must come after the awaited real API call')
})

test('after acceptance, the parent removes the referral from its local incoming list and navigates to that patient\'s Chen Patient Detail -- Request -> Patient', () => {
  const fn = slice(referralSource, 'const handleAccepted', 'return <main')
  assert.match(fn, /setIncoming\(\(current\) => current\?\.filter\(\(item\) => item\.id !== updated\.id\) \?\? current\)/)
  assert.match(fn, /navigate\(`\/chen\/patients\/\$\{updated\.patient_id\}`\)/)
})

test('no decline/redirect/insurance/prior-authorization workflow exists on the receiving side (real synthetic scheduling coordination is in scope for this pass and is expected to appear)', () => {
  assert.doesNotMatch(receivingSideSource(), /Decline|Redirect|insurance|prior authorization/i)
})

/* ---------------------------------------------------------- Chen's persona */

test('demoIdentity.ts defines Chen\'s canonical demo identity, matching the real backend physician-chen id', () => {
  const demoIdentity = readFileSync(new URL('../src/demoIdentity.ts', import.meta.url), 'utf8')
  assert.match(demoIdentity, /export const CHEN_ID = 'physician-chen'/)
  assert.match(demoIdentity, /export const CHEN_NAME = 'Dr\. Noah Chen'/)
})

test('DEMO_PERSPECTIVES includes Chen as a third perspective, routed to his real Dashboard', () => {
  assert.match(app, /id: 'chen' as const, name: CHEN_NAME, role: 'Receiving specialist', initials: 'NC', path: '\/chen\/home'/)
})

test('the Chen routes are registered in the SPA dispatcher, reusing ProductShell and PatientWorkspace rather than new pages', () => {
  const dispatch = slice(app, 'export default function App', app.length)
  assert.match(dispatch, /path === '\/chen' \|\| path === '\/chen\/home'/)
  assert.match(dispatch, /perspective="chen"/)
  assert.match(dispatch, /<ChenPatientsPage navigate=\{navigate\} params=\{params\} \/>/)
  assert.match(dispatch, /chenPatientId === TONJIT_ID \|\| \(chenPatientId && CHEN_PATIENT_IDS\.includes\(chenPatientId\)\)\) return <PatientWorkspace patientId=\{chenPatientId\} navigate=\{navigate\} perspective="receiving" \/>/)
})

test('Chen now has a "My Agent" sidebar object, same standing as Lucy\'s and Iain\'s (closed-loop referral pass 2: full first-class workspace)', () => {
  const shell = slice(app, 'function ProductShell', 'function LandingPage')
  assert.match(shell, /perspective === 'chen'\s*\n\s*\? <button className=\{`sidebar-clinician \$\{onAgent \? 'active' : ''\}`\}[\s\S]{0,200}CHEN_AGENT_NAME/)
})

/* ------------------------------------------------------- Patient Detail reuse */

test('PatientWorkspace is reused for Chen\'s Patient Detail via a perspective prop -- no new specialist Patient Detail page', () => {
  assert.match(app, /function PatientWorkspace\(\{ patientId, navigate, perspective = 'pcp' \}: \{ patientId: string; navigate: Navigate; perspective\?: 'pcp' \| 'receiving' \}\)/)
})

test('in receiving mode, PatientWorkspace fetches the real active referral and renders an accepted-state card instead of "Find a specialist"', () => {
  const fn = slice(app, 'function PatientWorkspace', 'export default function App')
  assert.match(fn, /if \(perspective !== 'receiving'\) return/)
  assert.match(fn, /getActiveReferral\(patientId\)\.then\(\(referral\) => \{ if \(!cancelled\) setReceivingReferral\(referral\) \}\)/)
  assert.match(fn, /perspective === 'receiving'\s*\n\s*\? <ReceivingReferralCard referral=\{receivingReferral\} patientLabel=\{patientName\(patientId\)\} demoPatient=\{demoPatient\} \/>/)
})

test('ReceivingReferralCard never says "Find a specialist" and delegates to the real downstream coordination card when an accepted referral exists, and an honest lightweight status card for Chen\'s own pre-existing patients otherwise', () => {
  const fn = slice(app, 'function ReceivingReferralCard', 'function PatientWorkspace')
  assert.doesNotMatch(fn, /Find a specialist/)
  assert.match(fn, /if \(referral\) return <ChenDownstreamCard referral=\{referral\} patientLabel=\{patientLabel\} \/>/)
  assert.match(fn, /if \(referral === undefined\)/, 'a loading state is distinct from "no referral exists"')
  assert.match(fn, /In your care/)
  assert.match(fn, /demoPatient\?\.reason/)
})

test('the PCP consult-network effects are skipped entirely in receiving mode -- Chen\'s view never calls consultNetwork', () => {
  const fn = slice(app, 'function PatientWorkspace', 'export default function App')
  assert.match(fn, /if \(perspective !== 'pcp'\) return/)
})

/* --------------------------------------------------------------------- CSS */

test('new receiving-side classes exist in styles.css, reusing the shared post-flow-dialog/packet-section shell', () => {
  assert.match(styles, /\.incoming-requests-toggle/)
  assert.match(styles, /\.incoming-requests-popover/)
  assert.match(styles, /\.request-review-dialog/)
  assert.match(styles, /\.requirement-check /)
})
