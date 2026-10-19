/**
 * Care routing / match explainability demo pass. Lamina decides the
 * appropriate CARE NEED before merely ranking doctors; access is visible
 * and modality-specific; network participation is an evidence-confidence
 * label, never a quality tier; priority is physician-editable and strictly
 * separate from referral readiness; no numeric match score is ever
 * rendered. See Parts A-W.
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

/* --------------------------------------------------------------- Part D */

test('a compact "Care routing" block renders above the physician match, only when the agent returned routing data -- absent entirely for any other patient', () => {
  const fn = recommendationView()
  assert.match(fn, /\{consultation\.care_routing && <section className="care-routing-block">/)
  assert.match(fn, /\{consultation\.care_routing\.recommended_modality === 'in_person' \? 'In-person' : 'E-consult'\} \{consultation\.care_routing\.specialty\}/)
  assert.match(fn, /\{consultation\.care_routing\.rationale\}/)
})

/* --------------------------------------------------------------- Part E */

test('priority defaults to the agent\'s own suggestion when routing data exists, otherwise "routine" -- matching the backend\'s existing default for every other patient', () => {
  const fn = recommendationView()
  assert.match(fn, /useState<ReferralPriority>\(consultation\.care_routing\?\.suggested_priority \?\? 'routine'\)/)
})

test('priority is shown as Routine/Soon/Urgent chips, editable inline -- never a forced modal', () => {
  const fn = recommendationView()
  assert.match(fn, /\(\['routine', 'soon', 'urgent'\] as const\)\.map/)
  assert.match(fn, /className=\{`priority-chip \$\{priority === value \? 'selected' : ''\}`\}/)
})

test('a quiet "Suggested by your agent" note appears only while the current selection still matches the agent\'s suggestion', () => {
  const fn = recommendationView()
  assert.match(fn, /\{priority === consultation\.care_routing\.suggested_priority && <small>Suggested by your agent<\/small>\}/)
})

/* ------------------------------------------------------------- Part E/Y.3/4 */

test('the selected priority is threaded into referral creation, never silently upgraded by the frontend', () => {
  assert.match(app, /priority=\{priority\}/)
  assert.match(referralSource, /createReferral\(patientId, receivingPhysicianId, priority\)/)
  assert.match(api, /export const createReferral = \(patientId: string, receivingPhysicianId: string, priority\?: ReferralPriority\)/)
})

/* --------------------------------------------------------------- Part F */

test('referral-mode surface shows Clinical priority as its own separate labeled value, never merged into the phase/readiness content', () => {
  const fn = slice(referralSource, 'export function ReferralCoordinationSurface', '/**\n * The detailed, scrollable audit trail')
  assert.match(fn, /<p className="referral-priority-line"><span className="section-label">Clinical priority<\/span> <strong>\{priorityLabel\(referral\.priority\)\}<\/strong><\/p>/)
})

/* --------------------------------------------------------------- Part W */

test('no numeric match score is ever rendered -- no %, no X/100, no "score" anywhere near the care-routing or match-details UI', () => {
  const fn = recommendationView()
  const careRoutingBlock = slice(fn, 'care-routing-block', '</section>}')
  assert.doesNotMatch(careRoutingBlock, /%|score|\/100/i)
  const matchDetails = slice(fn, "<div className=\"match-details\">", '</div>}\n\n    {/* One open surface')
  assert.doesNotMatch(matchDetails, /%|\bscore\b|\/100/i)
})

/* --------------------------------------------------------------- Part M */

test('Review match details explains the actual route decision -- modality, priority, fit, network, evidence confidence, and access all shown as separate labeled values', () => {
  const fn = recommendationView()
  assert.match(fn, /Why this route/)
  assert.match(fn, /Why \{cleanName\(recommendedRoute\.physician_name\)\}/)
  assert.match(fn, /<dt>Practice fit<\/dt><dd>\{fitLabelText\(recommendedRoute\.fit_label\)\}<\/dd>/)
  assert.match(fn, /<dt>Network<\/dt><dd>\{networkParticipationLabel\(recommendedRoute\.network_participation\)\}<\/dd>/)
  assert.match(fn, /<dt>Evidence confidence<\/dt><dd>\{confidenceLabelText\(recommendedRoute\.evidence_confidence\)\}<\/dd>/)
  assert.match(fn, /<dt>In-person access<\/dt><dd>\{recommendedRoute\.access\.in_person_wait_label\}<\/dd>/)
  assert.match(fn, /Why this option won/)
  assert.match(fn, /Other routes considered/)
})

test('the existing (non-routing) match-details structure is untouched for every other patient', () => {
  const fn = recommendationView()
  assert.match(fn, /Why this match/)
  assert.match(fn, /Before referral/)
  assert.match(fn, /Access &amp; coverage/)
})

/* --------------------------------------------------------------- Part O */

test('e-consult copy never calls itself a fallback/backup/second-best -- it is an alternative modality', () => {
  const fn = recommendationView()
  assert.doesNotMatch(fn, /[Ff]allback|[Bb]ackup|[Ss]econd-best/)
})

/* --------------------------------------------------------------- Part Q */

test('Chen\'s Incoming Requests shows a quiet Routine/Soon/Urgent priority tag per row, reading the referring physician\'s own selection -- never a numeric acuity score, never something this view changes', () => {
  const fn = slice(referralSource, 'function IncomingRequestsControl', 'export function ChenPatientsPage')
  assert.match(fn, /<span className=\{`priority-tag priority-\$\{referral\.priority\}`\}>\{priorityLabel\(referral\.priority\)\}<\/span>/)
})

/* --------------------------------------------------------------- Part R/T */

test('Chen exposes visit and e-consult capacity as two separate lanes, never three equal queues, never a full e-consult workflow', () => {
  const fn = slice(referralSource, 'function ChenCapacityStrip', 'export function ChenHomePage')
  assert.match(fn, /getPhysicianCapacity\(CHEN_ID\)/)
  assert.match(fn, /<span className="care-capacity-label">Visits<\/span>/)
  assert.match(fn, /<span className="care-capacity-label">E-consults<\/span>/)
  assert.match(fn, /<span className="care-capacity-label">Urgent cases<\/span>/)
  assert.doesNotMatch(fn, /<button|onClick/, 'the capacity strip must be read-only -- no fake e-consult request affordance (Part S)')
})

test('the capacity strip reuses the SAME structured access endpoint the routing UI reads, not a second hardcoded copy', () => {
  assert.match(api, /export const getPhysicianCapacity = \(physicianId: string\) => request<AccessProfile>\(`\/api\/physicians\/\$\{encodeURIComponent\(physicianId\)\}\/capacity`\)/)
})

/* --------------------------------------------------------------- Part P */

test('the shared label helpers never assume unknown e-consult availability is "enabled"', () => {
  const fn = slice(referralSource, 'function ChenCapacityStrip', 'export function ChenHomePage')
  assert.match(fn, /\{capacity\.econsult_available \? `Enabled/)
})

/* ------------------------------------------------------------- Part X */

test('existing Tonjit flow is preserved -- createReferral/preflight/duplicate-guard call sites are unchanged beyond the new trailing priority arg', () => {
  assert.match(referralSource, /const created = await createReferral\(patientId, receivingPhysicianId, priority\)/)
  assert.match(referralSource, /const preflighted = await runReferralPreflight\(created\.id as number\)/)
})
