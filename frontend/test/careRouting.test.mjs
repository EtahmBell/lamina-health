/**
 * Care routing / match explainability + routing/triage UX consolidation
 * passes. Lamina decides the appropriate CARE NEED before merely ranking
 * doctors; access is visible and modality-specific; network participation
 * is an evidence-confidence label, never a quality tier; priority is
 * physician-editable (always, via one shared chip -- never a separate edit
 * mode) and strictly separate from referral readiness; no numeric match
 * score is ever rendered; Chen only sees decisions that require his
 * decision. See the original care-routing Parts A-W and the consolidation
 * pass's Parts A-AN.
 */

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'

const app = readFileSync(new URL('../src/App.tsx', import.meta.url), 'utf8')
const referralSource = readFileSync(new URL('../src/Referral.tsx', import.meta.url), 'utf8')
const styles = readFileSync(new URL('../src/styles.css', import.meta.url), 'utf8')
const api = readFileSync(new URL('../src/api.ts', import.meta.url), 'utf8')

const slice = (source, from, to) => {
  const start = source.indexOf(from)
  return source.slice(start, to !== undefined ? source.indexOf(to, start) : undefined)
}
const recommendationView = () => slice(app, 'function RecommendationView', 'function PatientWorkspace')

/* ----------------------------------------------------- Part A: renaming */

test('the heading is "Recommended care path" -- never "Care routing", "Patient footprint", "Patient details", or "Next step"', () => {
  const fn = recommendationView()
  assert.match(fn, /<p className="section-label">Recommended care path<\/p>/)
  assert.doesNotMatch(fn, />Care routing</)
  assert.doesNotMatch(fn, /Patient footprint/)
})

/* --------------------------------------------------- Part B: hierarchy */

test('specialty and modality render as two separate lines -- never combined into one opaque phrase', () => {
  const fn = recommendationView()
  assert.match(fn, /<h3>\{consultation\.care_routing\.specialty\}<\/h3>/)
  assert.match(fn, /<p className="care-routing-modality">\{consultation\.care_routing\.recommended_modality === 'in_person' \? 'In-person evaluation recommended' : 'E-consult recommended'\}<\/p>/)
})

/* ------------------------------------------------- Part C: no edit mode */

test('priority is ALWAYS shown as the directly-editable Routine/Soon/Urgent chip row -- there is no separate edit-mode state or Edit button anywhere in Recommended care path', () => {
  const fn = recommendationView()
  assert.match(fn, /<PriorityChipRow priority=\{priority\} onChange=\{setPriority\} \/>/)
  const careRoutingBlock = slice(fn, 'care-routing-block', '</section>}')
  assert.doesNotMatch(careRoutingBlock, />Edit</)
  assert.doesNotMatch(fn, /priorityEditing/)
})

/* -------------------------------------------------- Part D: suggestion */

test('priority defaults to the agent\'s own suggestion when routing data exists, otherwise "routine" -- matching the backend\'s existing default for every other patient', () => {
  const fn = recommendationView()
  assert.match(fn, /useState<ReferralPriority>\(consultation\.care_routing\?\.suggested_priority \?\? 'routine'\)/)
})

test('a quiet "Suggested by your agent" note appears only while the current selection still matches the agent\'s suggestion -- never a large separate object', () => {
  const fn = recommendationView()
  assert.match(fn, /\{priority === consultation\.care_routing\.suggested_priority && <small className="care-routing-priority-note">Suggested by your agent<\/small>\}/)
})

test('the selected priority is threaded into referral creation, never silently upgraded by the frontend', () => {
  assert.match(app, /priority=\{priority\}/)
  assert.match(referralSource, /createReferral\(patientId, receivingPhysicianId, priority, modality\)/)
  assert.match(api, /export const createReferral = \(patientId: string, receivingPhysicianId: string, priority\?: ReferralPriority, modality\?: CareModality\)/)
})

/* -------------------------------------------- Part E: one shared chip */

test('PriorityChip/PriorityChipRow are the ONE shared component used everywhere priority appears -- never plain bold text in one place and a pill elsewhere', () => {
  assert.match(referralSource, /export function PriorityChip\(\{ priority \}: \{ priority: ReferralPriority \}\) \{/)
  assert.match(referralSource, /export function PriorityChipRow\(\{ priority, onChange \}: \{ priority: ReferralPriority; onChange: \(value: ReferralPriority\) => void \}\) \{/)
  // active referral surface
  assert.match(referralSource, /<PriorityChip priority=\{referral\.priority\} \/>/)
  // Chen's Needs your review row
  assert.match(referralSource, /<PriorityChip priority=\{referral\.priority\} \/><span className="incoming-request-modality">/)
  // referral review modal
  assert.match(referralSource, /<PriorityChip priority=\{referral\.priority\} \/><span className="incoming-request-modality">· \{referral\.modality === 'econsult' \? 'E-consult' : 'In-person visit'\}<\/span>/)
  // match-details "Why this care path"
  assert.match(app, /<dt>Priority<\/dt><dd><PriorityChip priority=\{consultation\.care_routing\.suggested_priority\} \/><\/dd>/)
  assert.doesNotMatch(app, /<strong>\{priorityLabel\(/, 'priority must never render as plain bold text anywhere')
})

/* --------------------------------------------------- Part F: readiness */

test('referral-mode surface shows Clinical priority via the shared chip, visually secondary to the actual workflow status', () => {
  const fn = slice(referralSource, 'export function ReferralCoordinationSurface', '/**\n * The detailed, scrollable audit trail')
  assert.match(fn, /<p className="referral-priority-line"><span className="section-label">Clinical priority<\/span> <PriorityChip priority=\{referral\.priority\} \/><\/p>/)
})

test('no "Referral readiness: Ready" (or similar combined priority+readiness) literal phrase is introduced', () => {
  assert.doesNotMatch(app, /Referral readiness: ?Ready/)
  assert.doesNotMatch(referralSource, /Referral readiness: ?Ready/)
})

/* ----------------------------------------------------------- Part W */

test('no numeric match score is ever rendered -- no %, no X/100, no "score" anywhere near the care-routing or match-details UI', () => {
  const fn = recommendationView()
  const careRoutingBlock = slice(fn, 'care-routing-block', '</section>}')
  assert.doesNotMatch(careRoutingBlock, /%|score|\/100/i)
  const matchDetails = slice(fn, '<div className="match-details">', '</div>}\n    </section>')
  assert.doesNotMatch(matchDetails, /%|\bscore\b|\/100/i)
})

/* ----------------------------------------------- Part F-J: match details */

test('Review match details is reduced to exactly three primary sections: Why this care path, Why Dr. Chen, Other options', () => {
  const fn = recommendationView()
  assert.match(fn, /Why this care path/)
  assert.match(fn, /Why \{cleanName\(recommendedRoute\.physician_name\)\}/)
  assert.match(fn, /Other options/)
  assert.doesNotMatch(fn, /Why this route/, 'the old "Why this route" heading was renamed to "Why this care path"')
  assert.doesNotMatch(fn, /Other routes considered/, 'merged into the one "Other options" section')
})

test('the oversized "Why this option won" section is gone -- replaced by a small supporting line, visually subordinate to the structured facts', () => {
  const fn = recommendationView()
  assert.doesNotMatch(fn, /Why this option won/)
  assert.match(fn, /<p className="route-why-recommended"><span className="route-why-recommended-label">Why recommended:<\/span> \{recommendedRoute\.rationale\}<\/p>/)
})

test('"Why this care path" shows specialty, modality, priority, and e-consult suitability as separate labeled values', () => {
  const fn = recommendationView()
  assert.match(fn, /<dt>Specialty<\/dt><dd>\{consultation\.care_routing\.specialty\}<\/dd>/)
  assert.match(fn, /<dt>Modality<\/dt><dd>\{consultation\.care_routing\.recommended_modality === 'in_person' \? 'In-person evaluation' : 'E-consult'\}<\/dd>/)
  assert.match(fn, /<dt>Priority<\/dt><dd><PriorityChip priority=\{consultation\.care_routing\.suggested_priority\} \/><\/dd>/)
  assert.match(fn, /<dt>E-consult<\/dt><dd>\{econsultSuitabilityLabel\(consultation\.care_routing\.econsult_suitability\)\}<\/dd>/)
})

test('"Why Dr. Chen" shows practice fit, network, evidence confidence, and both access values as separate labeled facts', () => {
  const fn = recommendationView()
  assert.match(fn, /<dt>Practice fit<\/dt><dd>\{fitLabelText\(recommendedRoute\.fit_label\)\}<\/dd>/)
  assert.match(fn, /<dt>Network<\/dt><dd>\{networkParticipationLabel\(recommendedRoute\.network_participation\)\}<\/dd>/)
  assert.match(fn, /<dt>Evidence confidence<\/dt><dd>\{confidenceLabelText\(recommendedRoute\.evidence_confidence\)\}<\/dd>/)
  assert.match(fn, /<dt>In-person access<\/dt><dd>\{recommendedRoute\.access\.in_person_wait_label\}<\/dd>/)
  assert.match(fn, /<dt>E-consult response<\/dt><dd>\{recommendedRoute\.access\.econsult_response_label\}<\/dd>/)
})

test('the existing (non-routing) match-details structure is untouched for every other patient', () => {
  const fn = recommendationView()
  assert.match(fn, /Why this match/)
  assert.match(fn, /Before referral/)
  assert.match(fn, /Access &amp; coverage/)
})

/* ----------------------------------------- Part J/K: unified Other options */

test('the standalone "Other referral options" disclosure is removed entirely when routing data exists -- unified into the one "Other options" group inside Review match details', () => {
  const fn = recommendationView()
  assert.match(fn, /\{!consultation\.care_routing && <section className="options-section"><button className="options-toggle" aria-expanded=\{alternativesOpen\}/, 'the old standalone disclosure must still exist, but ONLY for non-routing patients')
  assert.match(fn, /otherOptionRows\.map\(\(row\) => <li key=\{row\.key\}>/)
})

test('Other options merges the real pre-existing alternatives (Okonkwo) with the new routing model\'s non-recommended routes (Maya, Chen e-consult, external directory)', () => {
  const fn = recommendationView()
  assert.match(fn, /const mayaRoute = consultation\.candidate_routes\.find\(\(route\) => route\.physician_id === 'physician-ramanathan'\)/)
  assert.match(fn, /const chenEconsultRoute = consultation\.candidate_routes\.find\(\(route\) => route\.physician_id === CHEN_ID && route\.modality === 'econsult'\)/)
  assert.match(fn, /const okonkwoAlternative = consultation\.alternatives\.find\(\(option\) => option\.physician_id === 'physician-okonkwo'\)/)
  assert.match(fn, /const externalDirectoryRoute = consultation\.candidate_routes\.find\(\(route\) => route\.network_participation === 'external_directory'\)/)
})

/* --------------------------------------------------------------- Part 1 */

test('all routes are explicitly ordered: Chen in-person (the recommended route) first, then Maya (stronger alternative), then Chen e-consult, then Okonkwo (worse access), then the external directory last', () => {
  const fn = recommendationView()
  const built = slice(fn, 'const allOptionRows = consultation.care_routing ? [', 'const otherOptionRows = allOptionRows.filter')
  const chenInPersonIndex = built.indexOf('chenInPersonRoute ? [{ ...routeRow(chenInPersonRoute), isAgentPick: true }]')
  const mayaIndex = built.indexOf('mayaRoute ? [routeRow(mayaRoute)]')
  const chenEconsultIndex = built.indexOf('chenEconsultRoute ? [routeRow(chenEconsultRoute)]')
  const okonkwoIndex = built.indexOf('okonkwoAlternative ? [alternativeRow(okonkwoAlternative)]')
  const externalIndex = built.indexOf('externalDirectoryRoute ? [routeRow(externalDirectoryRoute)]')
  assert.ok(
    chenInPersonIndex >= 0 && mayaIndex > chenInPersonIndex && chenEconsultIndex > mayaIndex && okonkwoIndex > chenEconsultIndex && externalIndex > okonkwoIndex,
    'the five known options must appear in this exact deliberate order'
  )
})

/* ------------------------------------------------- Follow-up pass, Part A-E */

test('Chen\'s in-person route is a normal row in the SAME unified route list, filtered out of "Other options" only while it IS the current selection -- never a one-way trap once e-consult is picked', () => {
  const fn = recommendationView()
  assert.match(fn, /const chenInPersonRoute = consultation\.candidate_routes\.find\(\(route\) => route\.recommended\)/)
  assert.match(fn, /const otherOptionRows = allOptionRows\.filter\(\(row\) => !\(row\.physicianId === selectedId && row\.modality === selectedModality\)\)/)
})

test('physician selection and modality selection are orthogonal -- selectCandidate takes both, and reselecting the SAME physician with a different modality is never a no-op treated as "nothing changed"', () => {
  const fn = recommendationView()
  assert.match(fn, /const selectCandidate = \(physicianId: string, modality: CareModality = 'in_person'\) => \{/)
  assert.match(fn, /if \(physicianId === selectedId && modality === selectedModality\) return/)
})

test('the recommended route is never rewritten just because Lucy tries a different one -- Recommended care path still reads directly from consultation.care_routing, never from the current selection', () => {
  const fn = recommendationView()
  const careRoutingBlock = slice(fn, 'care-routing-block', '</section>}')
  assert.doesNotMatch(careRoutingBlock, /selectedModality|selectedId/, 'Recommended care path must read only from consultation.care_routing, never the live selection')
  assert.match(fn, /const physicianDiffersFromRecommendation = selected\.physician_id !== primary\.physician_id/)
  assert.match(fn, /const modalityDiffersFromRecommendation = !physicianDiffersFromRecommendation && selectedModality !== 'in_person'/)
})

test('no referral is created merely by switching the selected route -- selectCandidate only ever updates local presentation state, never calls the referral API', () => {
  const fn = recommendationView()
  const selectCandidateFn = fn.slice(fn.indexOf('const selectCandidate = ('), fn.indexOf('/**\n   * Once the physician clicks Start referral'))
  assert.doesNotMatch(selectCandidateFn, /createReferral|fetch\(|request\(/)
})

test('Maya Ramanathan is made genuinely selectable via a synthesized Evaluation, reusing the exact same selectCandidate mechanism Okonkwo already uses -- never a fake dead CTA', () => {
  const fn = recommendationView()
  assert.match(fn, /const routeToEvaluation = \(route: CandidateRoute\): Evaluation => \(\{/)
  assert.match(fn, /const selectableRoutes = consultation\.candidate_routes\.filter\(\(route\) => !route\.recommended && route\.modality === 'in_person' && route\.network_participation !== 'external_directory'\)/)
  assert.match(fn, /\{row\.selectable && <button type="button" className="text-button" onClick=\{\(\) => selectCandidate\(row\.physicianId, row\.modality\)\}>/)
})

/* --------------------------------------------------------------- Part 3A */

test('UX polish pass: Dr. Chen\'s e-consult route is now a real selectable alternative -- never a dead CTA -- and transitions into a coherent e-consult-specific downstream state', () => {
  const fn = recommendationView()
  const routeRowFn = slice(fn, 'const routeRow = (route: CandidateRoute) => ({', '})')
  assert.match(routeRowFn, /selectable: route\.network_participation !== 'external_directory'/, 'only the external-directory candidate stays informational-only now')
  assert.match(fn, /Request e-consult/, 'the e-consult row has its own selection CTA copy, distinct from "Select this specialist"')
  assert.match(fn, /const \[selectedModality, setSelectedModality\] = useState<CareModality>\('in_person'\)/)
  const downstream = slice(referralSource, 'export function ChenDownstreamCard', 'export function chenPatientRowStatus')
  assert.match(downstream, /E-consult request sent/, 'a coherent downstream state exists once an e-consult referral is scheduled')
  assert.doesNotMatch(downstream.replace(/\/\/[^\n]*/g, ''), /Start e-consult/i, 'no literal "Start e-consult" CTA copy -- the real button text is "Request e-consult"')
})

test('the external-directory candidate is never made selectable -- selecting it would 404 (she is not in the backend\'s physician directory)', () => {
  const fn = recommendationView()
  assert.match(fn, /route\.network_participation !== 'external_directory'/)
})

test('e-consult copy never calls itself a fallback/backup/second-best -- it is an alternative modality', () => {
  const fn = recommendationView()
  assert.doesNotMatch(fn, /[Ff]allback|[Bb]ackup|[Ss]econd-best/)
})

test('the external-directory candidate\'s display name carries no fixture/debug metadata like "(external directory, synthetic)"', () => {
  const careRoutingSource = readFileSync(new URL('../../backend/agents/care_routing.py', import.meta.url), 'utf8')
  assert.match(careRoutingSource, /"physician_name": "Dr\. Renata Okafor",/)
})

/* --------------------------------------------------------------- Part 3B */

test('every physician shown in routing/options is inspectable by clicking their avatar or name -- Lamina physicians open a real profile, the external-directory candidate opens a small unclaimed-profile panel instead of a dead/404 link', () => {
  assert.match(app, /function PhysicianProfileLink\(\{ physicianId, navigate, onUnclaimed, children, className \}: \{/)
  assert.match(app, /const ROUTING_PHYSICIAN_PERSONA: Record<string, string> = \{ \[CHEN_ID\]: 'chen', 'physician-ramanathan': 'maya' \}/)
  assert.match(app, /const ROUTING_PHYSICIAN_NPI: Record<string, string> = \{ 'physician-okonkwo': '9900000029' \}/)
  const fn = recommendationView()
  assert.match(fn, /<PhysicianProfileLink physicianId=\{selected\.physician_id\}/, 'the primary match card avatar/name are clickable')
  assert.match(fn, /<PhysicianProfileLink physicianId=\{row\.physicianId\}/, 'each Other options row name is clickable')
  assert.match(fn, /setUnclaimedProfile/, 'the external-directory candidate opens a local panel, never a navigation that would 404')
})

/* --------------------------------------------------------------- Part Q */

test('Chen\'s review surface is renamed "Needs your review" -- never "Incoming requests"', () => {
  const fn = slice(referralSource, 'function IncomingRequestsControl', 'export function ChenPatientsPage')
  assert.match(fn, /Needs your review <span>\{referrals\.length\}<\/span>/)
  assert.doesNotMatch(fn, /Incoming requests/)
})

test('Chen\'s Needs your review shows the shared priority chip per row, reading the referring physician\'s own selection -- never a numeric acuity score, never something this view changes', () => {
  const fn = slice(referralSource, 'function IncomingRequestsControl', 'export function ChenPatientsPage')
  assert.match(fn, /<PriorityChip priority=\{referral\.priority\} \/>/)
})

/* --------------------------------------------------------------- Part S */

test('the Tonjit row in Needs your review shows exactly ONE status chip (priority), a quiet modality label, and the resolved-item summary -- the redundant "Ready for review" badge is gone', () => {
  const fn = slice(referralSource, 'return <div className="incoming-requests"', 'export function RequestReviewModal')
  assert.doesNotMatch(fn, /Ready for review/)
  assert.match(fn, /<span className="incoming-request-modality">· \{referral\.modality === 'econsult' \? 'E-consult' : 'Visit'\}<\/span>/)
})

/* --------------------------------------------------------- Part 6 (polish) */

test('UX polish pass, Part 6: a bit more horizontal breathing room between the priority chip and the bullet-separated modality text in Needs your review', () => {
  const rule = slice(styles, '.incoming-request-priority {', '}')
  assert.match(rule, /gap: 10px/)
})

/* ------------------------------------------------- Part T (polish, 7A-D) */

test('the referral review modal\'s "Ready for your review" badge is gone -- the whole modal already IS the review', () => {
  const fn = slice(referralSource, 'export function RequestReviewModal', 'export function markReferralJustAccepted')
  assert.doesNotMatch(fn, /Ready for your review/)
})

test('the referral review modal shows a compact "Routing summary" (renamed from "Recommended handling") -- priority chip, modality, expected access, and packet completeness -- never a numeric acuity score, never a heavy blue-boxed treatment', () => {
  const fn = slice(referralSource, 'export function RequestReviewModal', 'export function markReferralJustAccepted')
  assert.match(fn, /<p className="section-label">Routing summary<\/p>/)
  assert.doesNotMatch(fn, /Recommended handling/, 'the old section label is gone, renamed to something physician-friendly and not backend-ish')
  assert.match(fn, /<PriorityChip priority=\{referral\.priority\} \/><span className="incoming-request-modality">· \{referral\.modality === 'econsult' \? 'E-consult' : 'In-person visit'\}<\/span>/)
  assert.match(fn, /<span className="section-label">Expected access<\/span>/)
  assert.match(fn, /<span className="section-label">Referral packet<\/span> <strong>Complete<\/strong>/)
  const sectionRule = slice(styles, '.routing-summary {', '}')
  assert.doesNotMatch(sectionRule, /border:|background:/, 'the blue-boxed/filled-card treatment is gone -- calm hairline-rule structure instead')
})

test('the Routing summary\'s facts align cleanly -- the label/value flex row never off-kilters from a stray block-layout bottom margin', () => {
  assert.match(styles, /\.recommended-handling-fact > \.section-label \{ margin: 0; \}/)
})

/* --------------------------------------------------------------- Part R/T/X/Y (polish, 5D) */

test('Chen exposes two small read-only capacity cards -- Visits and E-consults -- Urgent review was removed as a third card (it read as a third equal queue, not an escalation path), never a KPI-dashboard strip, never fake buttons', () => {
  const fn = slice(referralSource, 'function ChenCapacityCards', 'export const CHEN_AUTO_ROUTED_PATIENT_IDS')
  assert.match(fn, /getPhysicianCapacity\(CHEN_ID\)/)
  assert.match(fn, /<p className="care-capacity-card-label">Visits<\/p>/)
  assert.match(fn, /<p className="care-capacity-card-label">E-consults<\/p>/)
  assert.doesNotMatch(fn, /Urgent review/, 'Urgent review is no longer a third capacity card')
  assert.doesNotMatch(fn, /<button|onClick/, 'the capacity cards must be read-only -- no fake e-consult request affordance (Part S)')
})

test('capacity cards use no box-shadow -- calm, restrained, not KPI/metric-SaaS styling', () => {
  const rule = slice(styles, '.care-capacity-card {', '\n')
  assert.doesNotMatch(rule, /box-shadow/)
})

test('the capacity cards reuse the SAME structured access endpoint the routing UI reads, not a second hardcoded copy', () => {
  assert.match(api, /export const getPhysicianCapacity = \(physicianId: string\) => request<AccessProfile>\(`\/api\/physicians\/\$\{encodeURIComponent\(physicianId\)\}\/capacity`\)/)
})

/* --------------------------------------------------------------- Part P */

test('the capacity cards never assume unknown e-consult availability is "enabled"', () => {
  const fn = slice(referralSource, 'function ChenCapacityCards', 'export const CHEN_AUTO_ROUTED_PATIENT_IDS')
  assert.match(fn, /\{capacity\.econsult_available \? \(capacity\.econsult_response_label \?\? 'Available'\)/)
  assert.match(fn, /: 'Not enabled'/)
})

/* ------------------------------------------------- Part Z (polish, 5A-C) */

test('UX polish pass, Part 5A/B: the synthetic auto-routed demand no longer has its own standalone "Recent routing activity" block in the dashboard middle -- it is folded into the ordinary Recent activity feed instead, at ordinary visual weight', () => {
  assert.doesNotMatch(referralSource, /function ChenRoutingActivity/, 'the old standalone component is gone entirely')
  const home = slice(referralSource, 'export function ChenHomePage', 'export function ChenAgentPage')
  assert.doesNotMatch(home, /<ChenRoutingActivity/)
  assert.match(home, /Your agent coordinated with Dr\. Saruhashi's agent/)
  assert.match(home, /3 requests routed automatically/)
  assert.match(home, /2 visits · 1 e-consult/)
})

test('UX polish pass, Part 5C: clicking the auto-routing activity item navigates to Patients and briefly highlights the affected patients -- the Witness-style cross-agent boundary means it cannot open a detail view of the coordination itself', () => {
  const home = slice(referralSource, 'export function ChenHomePage', 'export function ChenAgentPage')
  assert.match(home, /onClick=\{\(\) => navigate\(`\/chen\/patients\?highlight=\$\{CHEN_AUTO_ROUTED_PATIENT_IDS\.join\(','\)\}`\)\}/)
  const patientsPage = slice(referralSource, 'export function ChenPatientsPage', 'export function ChenHomePage')
  assert.match(patientsPage, /const ids = \(params\?\.get\('highlight'\) \?\? ''\)\.split\(','\)\.filter\(Boolean\)/)
  assert.match(patientsPage, /highlightIds=\{highlighted\}/)
})

test('the highlight is purely presentational and briefly-applied -- never changes which patients are shown or how long the highlight persists beyond a short demo-friendly window', () => {
  const patientsPage = slice(referralSource, 'export function ChenPatientsPage', 'export function ChenHomePage')
  assert.match(patientsPage, /window\.setTimeout\(\(\) => setHighlighted\(new Set\(\)\), 2600\)/)
  assert.match(styles, /\.worklist-row-highlight \{ animation: medication-row-wash 2600ms ease-in-out; \}/)
})

test('ChenHomePage renders the two capacity cards near Needs your review', () => {
  const fn = slice(referralSource, 'export function ChenHomePage', 'export function ChenAgentPage')
  assert.match(fn, /<ChenCapacityCards \/>/)
})

/* --------------------------------------------------------------- Part U/V */

test('scheduling-in-progress copy reads "Finding an appointment" / "Looking for the earliest appropriate visit" -- never backend-sounding phrases like "Scheduling to Soon access target" or "Executing triage decision"', () => {
  const fn = slice(referralSource, 'export function ChenDownstreamCard', 'const links =')
  assert.match(fn, /Finding an appointment/)
  assert.match(fn, /Looking for the earliest appropriate \$\{CHEN_SPECIALTY\} visit\./)
  assert.doesNotMatch(fn, /Scheduling to|Executing triage|Queue optimization/i)
})

test('UX polish pass, Part 3A/W: an e-consult referral gets its own coherent "finding" copy -- never the in-person visit phrasing, and the scheduling/triage distinction is preserved (scheduling never recalculates priority, whatever the modality)', () => {
  const fn = slice(referralSource, 'export function ChenDownstreamCard', 'const links =')
  assert.match(fn, /Preparing e-consult response/)
  assert.match(fn, /Preparing an e-consult response\./)
})

test('the finding-an-appointment phases show the same shared priority chip and the real expected-access fact, never a queue position/rank score', () => {
  const fn = slice(referralSource, 'export function ChenDownstreamCard', 'const links =')
  assert.match(fn, /<PriorityChip priority=\{referral\.priority\} \/>/)
  assert.doesNotMatch(fn, /[Qq]ueue position|[Rr]ank score|[Ww]aitlist score/)
})

/* --------------------------------------------------------------- Part X */

test('existing Tonjit flow is preserved -- createReferral/preflight/duplicate-guard call sites are unchanged beyond the new trailing priority/modality args', () => {
  assert.match(referralSource, /const created = await createReferral\(patientId, receivingPhysicianId, priority, modality\)/)
  assert.match(referralSource, /const preflighted = await runReferralPreflight\(created\.id as number\)/)
})

/* --------------------------------------------------------- Part AD/AF */

test('the word "triage" is not plastered throughout user-facing copy -- physician-friendly terms are used instead', () => {
  const fn = recommendationView()
  assert.doesNotMatch(fn, />\s*[Tt]riage\s*</, 'no visible UI text should be the bare word "triage"')
})

/* =====================================================================
 * UX + triage consolidation pass, item 2: "ROUTING + TRIAGE UX
 * CONSOLIDATION" polish pass. Rebalances perceived ranking, polishes the
 * consultation-details disclosure, makes Chen's e-consult route
 * selectable, makes every routing/options physician inspectable, fixes
 * clinical-priority/wash alignment bugs, and reshapes Chen's dashboard.
 * ===================================================================== */

/* --------------------------------------------------------------- Part 1 */

test('Okonkwo\'s own clinical-fit rationale no longer leaks backend/fixture language ("synthetic access interval") into physician-facing copy', () => {
  const agentSource = readFileSync(new URL('../../backend/agents/physician_agent.py', import.meta.url), 'utf8')
  assert.doesNotMatch(agentSource.match(/physician-okonkwo[\s\S]{0,400}/)[0], /synthetic access interval/)
})

test('Chen\'s e-consult rationale reads as a real alternative (fast response) rather than a generic "considered" dismissal', () => {
  const careRoutingSource = readFileSync(new URL('../../backend/agents/care_routing.py', import.meta.url), 'utf8')
  assert.match(careRoutingSource, /Fast response \(about 2 business days\), but direct in-person evaluation is/)
})

/* --------------------------------------------------------------- Part 2 */

test('the "How your agent handled this" caret is a real SVG chevron, flex-aligned, never a Unicode glyph fighting its own font metrics', () => {
  const rule = slice(styles, '.network-transparency-toggle em {', '}')
  assert.match(rule, /display: inline-flex/)
  assert.match(rule, /align-items: center/)
  assert.doesNotMatch(app, /View consultation details <i>/, 'the old glyph-in-<i> markup is gone')
  assert.match(app, /View consultation details <svg className="disclosure-chevron"/)
  const chevronRule = slice(styles, '.disclosure-chevron {', '}')
  assert.match(chevronRule, /display: block/, 'a block-level replaced element never participates in inline-text baseline layout, so it can never sit below the text it sits beside')
})

test('Consultation details content is brought up to date with the newer routing model -- Maya, Chen e-consult, and the fact that access/modality were weighed, not just fit', () => {
  const fn = recommendationView()
  const modal = slice(fn, 'aria-label="Consultation details"', '</div></ModalPortal>}')
  assert.match(modal, /Access &amp; modality considered/)
  assert.match(modal, /was recommended for this presentation; expected access and e-consult suitability were weighed for every route below alongside clinical fit, not fit alone\./)
  assert.match(modal, /allOptionRows\.map\(\(row\) => <li key=\{row\.key\}>/)
  // Dr. Noah Chen and Dr. Adaeze Okonkwo already appear via the pre-existing
  // real "Specialist-agent responses" list above this new block.
  assert.match(modal, /Specialist-agent responses/)
})

/* ------------------------------------------------- Follow-up pass, Part G-K */

test('"physician agents consulted" counts unique PHYSICIANS, never routes -- Chen\'s in-person and e-consult routes never count twice, and the count is derived (never a hardcoded "3") so it stays accurate as the routing set grows', () => {
  const fn = recommendationView()
  assert.match(fn, /const routingOnlyAgents = consultation\.candidate_routes/)
  assert.match(fn, /\.filter\(\(route\) => route\.network_participation !== 'external_directory'\)/)
  assert.match(fn, /\.filter\(\(route\) => !consultation\.consultation\.some\(\(agent\) => agent\.physician_id === route\.physician_id\)\)/)
  assert.match(fn, /const consultedPhysicianCount = new Set\(\[/)
  assert.match(fn, /<p className="agent-consult-count">\{consultedPhysicianCount\} physician agent\{consultedPhysicianCount === 1 \? '' : 's'\} consulted<\/p>/)
  assert.doesNotMatch(fn, /\{consultation\.consultation\.length\} physician agent/, 'the stale hardcoded-to-the-real-pipeline-only count is gone')
})

test('Maya is represented in the specialist-agent responses whenever she is part of the current routing set, using her real structured CandidateRoute rationale -- never fabricated chain-of-thought', () => {
  const fn = recommendationView()
  assert.match(fn, /\{routingOnlyAgents\.map\(\(agent\) => <li key=\{agent\.physician_id\}><b>\{cleanName\(agent\.physician_name\)\}:<\/b> \{agent\.reason\}<\/li>\)\}/)
})

test('the external-directory candidate (Okafor) is never counted or listed as a physician agent consulted -- no Lamina agent ever evaluated her', () => {
  const fn = recommendationView()
  const routingOnlyAgentsFn = fn.slice(fn.indexOf('const routingOnlyAgents = consultation.candidate_routes'), fn.indexOf('const consultedPhysicianCount'))
  assert.match(routingOnlyAgentsFn, /route\.network_participation !== 'external_directory'/)
})

test('"Access & modality considered" distinguishes PHYSICIANS consulted from ROUTES considered, using the unfiltered route list so it stays a stable record regardless of Lucy\'s current selection', () => {
  const fn = recommendationView()
  assert.match(fn, /\{consultedPhysicianCount\} physician agent\{consultedPhysicianCount === 1 \? '' : 's'\} consulted · \{allOptionRows\.length\} route\{allOptionRows\.length === 1 \? '' : 's'\} considered\./)
})

/* --------------------------------------------------------------- Part 4 */

test('Clinical priority and its chip are cleanly aligned -- the shared .section-label\'s own block-layout bottom margin (meant for stacking a label above a value) no longer off-kilters a row where it sits beside a chip instead', () => {
  assert.match(styles, /\.care-routing-priority > \.section-label,\s*\.referral-priority-line > \.section-label,\s*\.recommended-handling-fact > \.section-label \{ margin: 0; \}/)
})

test('the Clinical priority row disappears cleanly behind the blue completion wash, in lockstep with everything else, instead of bleeding through', () => {
  const rule = slice(styles, '.best-fit-card.referral-card.handoff-wash > .back-to-match,', '{')
  assert.match(rule, /\.best-fit-card\.referral-card\.handoff-wash \.referral-priority-line/)
})

/* =====================================================================
 * Follow-up pass: fix the e-consult route trap, the caret, stale
 * consultation-details metadata, and split the conflated Recent activity
 * entry. See Parts A-U.
 * ===================================================================== */

/* ----------------------------------------------- Part R: reversibility */

test('default Tonjit selection is Chen + in_person, and resets to exactly that on every fresh mount (no sessionStorage/module-level persistence that could survive a demo reset)', () => {
  const fn = recommendationView()
  assert.match(fn, /const \[selectedId, setSelectedId\] = useState\(consultation\.recommended_physician\.physician_id\)/)
  assert.match(fn, /const \[selectedModality, setSelectedModality\] = useState<CareModality>\('in_person'\)/)
  assert.doesNotMatch(fn, /sessionStorage.*selectedModality|selectedModality.*sessionStorage/, 'selectedModality must be plain component state, never persisted across a remount')
})

test('selecting Chen\'s e-consult route keeps selectedId on Chen and only changes selectedModality -- physician and modality are genuinely orthogonal state', () => {
  const fn = recommendationView()
  // The e-consult row's onClick passes Chen's own physician_id (via
  // row.physicianId, which for the chenEconsultRoute row is CHEN_ID) and
  // 'econsult' as modality -- never a second/duplicate physician identity.
  assert.match(fn, /onClick=\{\(\) => selectCandidate\(row\.physicianId, row\.modality\)\}/)
  assert.doesNotMatch(fn, /physician-chen-econsult['"]|chen::econsult/i, 'no synthetic duplicate physician id is ever invented for the e-consult route')
})

test('Chen in-person remains reachable (and Maya/Okonkwo switching keeps working) -- the SAME otherOptionRows/selectCandidate mechanism handles every transition, never a special case for any one route', () => {
  const fn = recommendationView()
  assert.match(fn, /\{row\.selectable && <button type="button" className="text-button" onClick=\{\(\) => selectCandidate\(row\.physicianId, row\.modality\)\}>/)
  // every named route (chenInPerson, maya, chenEconsult, okonkwo) goes
  // through the exact same routeRow/alternativeRow + filter pipeline --
  // there is no per-route special-cased selection handler anywhere.
  assert.doesNotMatch(fn, /onClick=\{\(\) => selectCandidate\('physician-chen'/, 'no hardcoded physician id bypassing the generic row.physicianId mechanism')
})

/* ----------------------------------------------------- Part S: consultation details */

test('Chen is counted once even though two of his routes (in-person, e-consult) are evaluated -- the dedup happens by physician_id, in a Set', () => {
  const fn = recommendationView()
  assert.match(fn, /new Set\(\[\s*\.\.\.consultation\.consultation\.map\(\(agent\) => agent\.physician_id\),\s*\.\.\.routingOnlyAgents\.map\(\(agent\) => agent\.physician_id\),\s*\]\)\.size/)
})

test('the structured consultation record (ConsultationLog) remains intact and unmodified by this pass', () => {
  const fn = recommendationView()
  assert.match(fn, /<ConsultationLog messages=\{consultation\.messages\} focusEventId=\{focusEventId\} highlight=\{highlight\} \/>/)
})

/* ----------------------------------------------------------- Part T: caret */

test('the consultation-details trigger is an aligned flex row with the caret in the same inline row as the label text, not a separate/below line', () => {
  const fn = recommendationView()
  assert.match(fn, /<em>View consultation details <svg className="disclosure-chevron"/, 'the label text and the chevron are siblings inside the same <em>, never on separate lines')
  const toggleRule = slice(styles, '.network-transparency-toggle {', '}')
  assert.match(toggleRule, /display: flex/)
  assert.match(toggleRule, /align-items: center/)
})

/* ------------------------------------------------- Part U: Recent activity */

test('Saruhashi coordination and automatic routing are two separate activity rows -- the old conflated single-row copy is gone', () => {
  const home = slice(referralSource, 'export function ChenHomePage', 'export function ChenAgentPage')
  assert.doesNotMatch(home, /Endocrinology referral routed automatically/, 'the old combined single-row phrasing is gone -- these are two separate facts now')
  const matches = [...home.matchAll(/key="(saruhashi-coordination|auto-routing)"/g)]
  assert.equal(matches.length, 2, 'exactly two distinct activity rows exist')
})

test('the Saruhashi coordination activity never exposes the private cross-agent transcript -- it only navigates to Tonjit\'s own already-authorized patient record, never a chat/coordination modal', () => {
  const home = slice(referralSource, 'export function ChenHomePage', 'export function ChenAgentPage')
  const saruhashiRow = home.slice(home.indexOf('key="saruhashi-coordination"'), home.indexOf('key="auto-routing"'))
  assert.match(saruhashiRow, /onClick=\{\(\) => navigate\(`\/chen\/patients\/\$\{TONJIT_ID\}`\)\}/)
  assert.doesNotMatch(saruhashiRow, /View agent conversation|AgentCoordinationModal|coordinationOpen/i, 'never opens the raw cross-agent conversation')
})

test('Recent network (NetworkHighlights) is unchanged by this pass', () => {
  const home = slice(referralSource, 'export function ChenHomePage', 'export function ChenAgentPage')
  assert.match(home, /<NetworkHighlights feed=\{feed\} navigate=\{navigate\} perspective="chen" \/>/)
})
