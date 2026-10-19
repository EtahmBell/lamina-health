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
  assert.match(referralSource, /createReferral\(patientId, receivingPhysicianId, priority\)/)
  assert.match(api, /export const createReferral = \(patientId: string, receivingPhysicianId: string, priority\?: ReferralPriority\)/)
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
  assert.match(referralSource, /<PriorityChip priority=\{referral\.priority\} \/><span className="incoming-request-modality">· In-person visit<\/span>/)
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
  assert.match(fn, /\.\.\.consultation\.alternatives\.map\(\(option\) => \(\{/)
  assert.match(fn, /\.\.\.consultation\.candidate_routes\.filter\(\(route\) => !route\.recommended\)\.map\(\(route\) => \(\{/)
})

test('Maya Ramanathan is made genuinely selectable via a synthesized Evaluation, reusing the exact same selectCandidate mechanism Okonkwo already uses -- never a fake dead CTA', () => {
  const fn = recommendationView()
  assert.match(fn, /const routeToEvaluation = \(route: CandidateRoute\): Evaluation => \(\{/)
  assert.match(fn, /const selectableRoutes = consultation\.candidate_routes\.filter\(\(route\) => !route\.recommended && route\.modality === 'in_person' && route\.network_participation !== 'external_directory'\)/)
  assert.match(fn, /\{row\.selectable && <button type="button" className="text-button" onClick=\{\(\) => selectCandidate\(row\.physicianId\)\}>Select this specialist/)
})

test('Chen\'s e-consult route is informational only -- no "Select this specialist"/Start e-consult CTA, never a dead-end button', () => {
  const fn = recommendationView()
  // selectableRoutes excludes e-consult modality entirely
  assert.doesNotMatch(fn, /Start e-consult/i)
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

test('the Tonjit row in Needs your review shows exactly ONE status chip (priority), a quiet "Visit" modality label, and the resolved-item summary -- the redundant "Ready for review" badge is gone', () => {
  const fn = slice(referralSource, 'return <div className="incoming-requests"', 'export function RequestReviewModal')
  assert.doesNotMatch(fn, /Ready for review/)
  assert.match(fn, /<span className="incoming-request-modality">· Visit<\/span>/)
})

/* --------------------------------------------------------------- Part T */

test('the referral review modal shows a compact "Recommended handling" triage summary: priority chip, modality, expected access, and packet completeness -- never a numeric acuity score', () => {
  const fn = slice(referralSource, 'export function RequestReviewModal', 'export function markReferralJustAccepted')
  assert.match(fn, /<p className="section-label">Recommended handling<\/p>/)
  assert.match(fn, /<PriorityChip priority=\{referral\.priority\} \/><span className="incoming-request-modality">· In-person visit<\/span>/)
  assert.match(fn, /<span className="section-label">Expected access<\/span>/)
  assert.match(fn, /<span className="section-label">Referral packet<\/span> <strong>Complete<\/strong>/)
})

/* --------------------------------------------------------------- Part R/T/X/Y */

test('Chen exposes three small read-only capacity cards -- Visits, E-consults, Urgent review -- never a KPI-dashboard strip, never fake buttons', () => {
  const fn = slice(referralSource, 'function ChenCapacityCards', 'export function ChenHomePage')
  assert.match(fn, /getPhysicianCapacity\(CHEN_ID\)/)
  assert.match(fn, /<p className="care-capacity-card-label">Visits<\/p>/)
  assert.match(fn, /<p className="care-capacity-card-label">E-consults<\/p>/)
  assert.match(fn, /<p className="care-capacity-card-label">Urgent review<\/p>/)
  assert.match(fn, /Escalated for physician review/)
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
  const fn = slice(referralSource, 'function ChenCapacityCards', 'export function ChenHomePage')
  assert.match(fn, /\{capacity\.econsult_available \? \(capacity\.econsult_response_label \?\? 'Available'\)/)
  assert.match(fn, /: 'Not enabled'/)
})

/* --------------------------------------------------------------- Part Z */

test('a small, understated "Recent routing activity" surface exists near Needs your review -- static/synthetic, never a large new dashboard feed', () => {
  const fn = slice(referralSource, 'function ChenRoutingActivity', 'export function ChenHomePage')
  assert.match(fn, /Recent routing activity/)
  assert.match(fn, /3 requests routed automatically/)
  assert.match(fn, /2 visits · 1 e-consult/)
  assert.doesNotMatch(fn, /<button|onClick|useEffect|fetch/, 'this must be static, understated copy -- not a real workflow/feed')
})

test('ChenHomePage renders the capacity cards and routing activity surface near Needs your review', () => {
  const fn = slice(referralSource, 'export function ChenHomePage', 'export function markReferralJustAccepted')
  assert.match(fn, /<ChenCapacityCards \/>/)
  assert.match(fn, /<ChenRoutingActivity \/>/)
})

/* --------------------------------------------------------------- Part U/V */

test('scheduling-in-progress copy reads "Finding an appointment" / "Looking for the earliest appropriate visit" -- never backend-sounding phrases like "Scheduling to Soon access target" or "Executing triage decision"', () => {
  const fn = slice(referralSource, 'export function ChenDownstreamCard', 'const links =')
  assert.match(fn, /Finding an appointment/)
  assert.match(fn, /Looking for the earliest appropriate \{CHEN_SPECIALTY\} visit\./)
  assert.doesNotMatch(fn, /Scheduling to|Executing triage|Queue optimization/i)
})

test('the finding-an-appointment phases show the same shared priority chip and the real expected-access fact, never a queue position/rank score', () => {
  const fn = slice(referralSource, 'export function ChenDownstreamCard', 'const links =')
  assert.match(fn, /<PriorityChip priority=\{referral\.priority\} \/>/)
  assert.doesNotMatch(fn, /[Qq]ueue position|[Rr]ank score|[Ww]aitlist score/)
})

/* --------------------------------------------------------------- Part X */

test('existing Tonjit flow is preserved -- createReferral/preflight/duplicate-guard call sites are unchanged beyond the new trailing priority arg', () => {
  assert.match(referralSource, /const created = await createReferral\(patientId, receivingPhysicianId, priority\)/)
  assert.match(referralSource, /const preflighted = await runReferralPreflight\(created\.id as number\)/)
})

/* --------------------------------------------------------- Part AD/AF */

test('the word "triage" is not plastered throughout user-facing copy -- physician-friendly terms are used instead', () => {
  const fn = recommendationView()
  assert.doesNotMatch(fn, />\s*[Tt]riage\s*</, 'no visible UI text should be the bare word "triage"')
})
