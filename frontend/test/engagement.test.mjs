import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'

const app = readFileSync(new URL('../src/App.tsx', import.meta.url), 'utf8')
const engagement = readFileSync(new URL('../src/Engagement.tsx', import.meta.url), 'utf8')
const specialist = readFileSync(new URL('../src/Specialist.tsx', import.meta.url), 'utf8')
const network = readFileSync(new URL('../src/PhysicianNetwork.tsx', import.meta.url), 'utf8')
const styles = readFileSync(new URL('../src/styles.css', import.meta.url), 'utf8')
const slice = (source, from, to) => source.slice(source.indexOf(from), source.indexOf(to))

const routing = () => slice(app, 'export default function App', app.length)
const trainingPageFn = () => slice(engagement, 'export function TrainingPage', '/* ------------------------------------------------------------- Profile: shared */')
const profilePageFn = () => slice(engagement, 'export function ProfessionalProfilePage', 'export function NetworkPhysicianProfilePage')
const homePageFn = () => slice(app, 'function HomePage', 'function PatientSelector')
const myAgentPageFn = () => slice(app, 'function MyAgentPage', 'function DemoResetControl')

/* ------------------------------------------------------------------- nav */

test('unified navigation: Lucy nav now reads Cases instead of Consultations', () => {
  assert.match(app, /id: 'consultations', title: 'Cases', icon: '◫', path: '\/consultations'/)
})

test('specialist nav now matches the unified physician app, including Profile as a 6th item (Pass 5B)', () => {
  const navBlock = slice(app, 'const SPECIALIST_NAV_ITEMS', 'function ProfileControl')
  assert.deepEqual(navBlock.match(/title: '[^']+'/g), ["title: 'Home'", "title: 'Patients'", "title: 'Cases'", "title: 'My Agent'", "title: 'Network'", "title: 'Profile'"])
})

/* --------------------------------------------------------------- routing */

test('training routes exist for both personas, wrapped in the shared shell with nav intact', () => {
  const dispatch = routing()
  assert.match(dispatch, /path === '\/agent\/train'/)
  assert.match(dispatch, /personaId="lucy" agentName=\{PCP_AGENT_NAME\}/)
  assert.match(dispatch, /path === '\/specialist\/agent\/train'/)
  assert.match(dispatch, /personaId="iain" agentName=\{SPECIALIST_AGENT_NAME\}/)
})

test('professional profile routes exist for both personas', () => {
  const dispatch = routing()
  assert.match(dispatch, /path === '\/profile\/professional'/)
  assert.match(dispatch, /path === '\/specialist\/profile'/)
})

test('specialist patients page is an honest empty state, not a fabricated panel', () => {
  const dispatch = routing()
  assert.match(dispatch, /path === '\/specialist\/patients'/)
  assert.match(specialist, /No patient panel connected in this specialist demo/)
  assert.match(specialist, /Cases where your agent participates appear under Cases\./)
})

test('specialist network page is derived from the feed, never Lucy\'s private roster endpoint', () => {
  const dispatch = routing()
  assert.match(dispatch, /path === '\/specialist\/network'/)
  const networkPage = slice(specialist, 'function dedupePhysicians', specialist.length)
  assert.match(networkPage, /getNetworkFeed\('iain'\)/)
  assert.doesNotMatch(networkPage, /getAgentNetwork/)
})

/* ---------------------------------------------------------------- training */

test('training route consumes canonical state before it resumes or starts a session', () => {
  const page = trainingPageFn()
  assert.match(page, /const training = await getTrainingHistory\(personaId\)/)
  assert.match(page, /training\.state === 'caught_up'/)
  assert.match(page, /training\.active_session_id/)
  assert.match(page, /training\.state === 'review_pending'/)
  assert.match(page, /mode: training\.state === 'initialization_needed' \? 'initialization' : modeParam/)
  assert.match(page, /const remaining = \(started\.questions \?\? \[\]\)\.filter\(\(item\) => !answeredIds\.has\(item\.id\)\)/)
})

test('each answer is persisted via the canonical response endpoint before advancing', () => {
  const page = trainingPageFn()
  assert.match(page, /await answerTrainingQuestion\(personaId, session\.id, current\.id, skipped \? \{ skipped: true \} : \{ answer: answer \?\? undefined \}\)/)
})

test('skip is always available and distinct from answering', () => {
  const page = trainingPageFn()
  assert.match(page, /onClick=\{\(\) => submit\(null, true\)\}>Skip</)
})

test('desktop keyboard support: left arrow = No, right arrow = Yes, down arrow = Depends only when it exists', () => {
  const page = trainingPageFn()
  assert.match(page, /event\.key === 'ArrowLeft'\) void submit\('No', false\)/)
  assert.match(page, /event\.key === 'ArrowRight'\) void submit\('Yes', false\)/)
  assert.match(page, /event\.key === 'ArrowDown' && current\.question_type === 'yes_no_depends'\) void submit\('Depends', false\)/)
})

test('keyboard hints are subtle, not prominent, and every choice has a real button equivalent', () => {
  const page = trainingPageFn()
  assert.match(page, /className="training-keyboard-hint"/)
  assert.match(page, /<button className="training-choice no"/)
  assert.match(page, /<button className="training-choice yes"/)
  assert.match(page, /<button className="training-choice depends"/)
})

test('card transition respects reduced motion', () => {
  const page = trainingPageFn()
  assert.match(page, /const calm = prefersReducedMotion\(\)/)
  assert.ok(styles.includes('@media (prefers-reduced-motion: reduce) { .training-card { transition: none; }'))
})

test('no gamified mechanics in the training surface', () => {
  assert.doesNotMatch(engagement, /streak|confetti|leaderboard|points earned|level up/i)
})

test('finishing a session never silently converts answers into truth: it calls finish and shows proposed learnings for explicit review', () => {
  const page = trainingPageFn()
  assert.match(page, /const result = await finishTrainingSession\(personaId, activeSession\.id\)/)
  assert.match(page, /setLearnings\(result\.proposed_learnings \?\? \[\]\)/)
  assert.match(page, /Training complete/)
  assert.match(page, /Review what your agent learned\./)
})

test('the completion screen is grounded in actual answered-question counts, never a ranking or score claim', () => {
  const page = trainingPageFn()
  assert.match(page, /You answered \{answered\} question/)
  assert.doesNotMatch(engagement, /ranking increased|more discoverable|score improved|referral score/i)
})

test('question source labeling matches the four documented categories', () => {
  assert.match(engagement, /tag: 'From your network'/)
  assert.match(engagement, /tag: 'From a recent case'/)
  assert.match(engagement, /tag: 'Practice profile'/)
  assert.match(engagement, /tag: 'Referral guidance'/)
})

/* ------------------------------------------------------------ home agent card */

test('Your Agent card never shows a referral score, ranking, or quality metric, and maps its CTA from canonical state/action only', () => {
  const card = slice(engagement, 'export function HomeAgentCard', '/* --------------------------------------------------------------------- Train */')
  assert.doesNotMatch(card, /score|ranking|quality/i)
  assert.match(card, /question\{overview\.stats\.questions_answered_total === 1 \? '' : 's'\} answered/)
  assert.match(card, /training\.state === 'active_in_progress'/)
  assert.doesNotMatch(card, /unfinished training/i)
  const mapping = slice(engagement, 'function homeTrainingCta', 'export function HomeAgentCard')
  assert.match(mapping, /training\.action === 'continue_setup'/)
  assert.match(mapping, /training\.action === 'resume_training' && activeId/)
  assert.match(mapping, /training\.action === 'start_training' && activeId/)
  assert.match(mapping, /training\.action === 'review_training' && reviewId/)
})

test('Home (both personas) renders the Your Agent card from AgentOverview, with a quiet link to My Agent', () => {
  assert.match(homePageFn(), /getAgentOverview\('lucy'\)\.then\(setOverview\)/)
  assert.match(homePageFn(), /<HomeAgentCard overview=\{overview\} navigate=\{navigate\} trainPath=\{trainingPath\('lucy'\)\} viewAgentPath="\/agent\?tab=overview" \/>/)
  const specialistHome = slice(specialist, 'export function SpecialistHomePage', '/* --------------------------------------------------------------- Cases */')
  assert.match(specialistHome, /getAgentOverview\('iain'\)\.then\(setOverview\)/)
  assert.match(specialistHome, /<HomeAgentCard overview=\{overview\} navigate=\{navigate\} trainPath=\{trainingPath\('iain'\)\} viewAgentPath="\/specialist\/agent\?tab=overview" \/>/)
})

test('the full Network Pulse feed section is gone from Home; only the compact 2-item highlight preview remains', () => {
  assert.doesNotMatch(homePageFn(), /NetworkFeedSection/)
  assert.match(homePageFn(), /<NetworkHighlights feed=\{feed\} navigate=\{navigate\} perspective="lucy" \/>/)
  const specialistHome = slice(specialist, 'export function SpecialistHomePage', '/* --------------------------------------------------------------- Cases */')
  assert.doesNotMatch(specialistHome, /NetworkFeedSection/)
  assert.match(specialistHome, /<NetworkHighlights feed=\{feed\} navigate=\{navigate\} perspective="iain" \/>/)
  const highlights = slice(engagement, 'export function NetworkHighlights', 'export const NETWORK_TABS')
  assert.match(highlights, /feed\.items\.slice\(0, 2\)/)
  assert.doesNotMatch(highlights, /No network updates yet/, 'Home never shows a giant empty feed state')
})

/* -------------------------------------------------------------- My Agent */

test('My Agent uses the simplified Pass 6C tabs, with legacy Knowledge/Calibration deep links preserved via alias', () => {
  assert.match(app, /const AGENT_TABS = \['overview', 'practice', 'train', 'chat', 'activity'\] as const/)
  assert.match(app, /const LEGACY_AGENT_TAB_ALIASES: Record<string, AgentTab> = \{ knowledge: 'practice', calibration: 'practice' \}/)
  assert.match(myAgentPageFn(), /learningParam = params\.get\('learning'\)/)
  assert.match(myAgentPageFn(), /recordParam = params\.get\('record'\)/)
})

test('Practice tab shows confirmed truth and links pending training review into Train, not a recreated Calibration UI', () => {
  const page = myAgentPageFn()
  assert.match(page, /tab === 'practice' && representation && <PracticeTab/)
  assert.doesNotMatch(engagement, /export function PracticeRepresentationPanel/, 'the old flat representation panel was replaced by the tabbed PracticeTab')
  assert.match(engagement, /reviewHref && <p className="practice-review-link">/)
})

/* ----------------------------------------------------------- profile editing */

test('profile items are saved through the canonical upsert endpoint with a client-generated id for new items', () => {
  const page = profilePageFn()
  assert.match(engagement, /onSave=\{\(fields\) => save\(`item-\$\{crypto\.randomUUID\(\)\}`, fields\)\}/)
  assert.match(engagement, /await updateProfessionalProfileItem\(personaId, itemId, \{ category, title: fields\.title, detail: fields\.detail \|\| undefined, shareable: fields\.shareable \}\)/)
  void page
})

test('profile distinguishes itself from My Agent referral preferences', () => {
  const page = profilePageFn()
  assert.match(page, /View how my agent represents me/)
  assert.match(engagement, /they do not guarantee referral eligibility or override clinical fit/)
})

test('profile never shows a completeness score, percentage, or ranking', () => {
  const page = profilePageFn()
  assert.doesNotMatch(page, /sections completed/)
  assert.doesNotMatch(page, /completeness/i)
  assert.doesNotMatch(page, /score|rank|top \d+%/i)
})

test('provenance is honest: never claims Verified for a synthetic demo item', () => {
  assert.doesNotMatch(engagement, /'Verified'/)
  assert.match(engagement, /'Added by you'/)
  assert.match(engagement, /'Synthetic demo profile'/)
})

/* --------------------------------------------------- Pass 7D: one-page profile */

test('Profile has no visible tab navigation; it is one continuous page', () => {
  const page = profilePageFn()
  assert.doesNotMatch(page, /PROFILE_TABS/)
  assert.doesNotMatch(page, /className="profile-tabs"/)
  assert.doesNotMatch(page, /setTab\(/)
})

test('legacy ?tab= deep links degrade to a scroll target or a redirect, never a visible tab switch', () => {
  const page = profilePageFn()
  assert.match(page, /params\?\.get\('tab'\)/)
  assert.match(page, /if \(tabParam === 'updates'\) \{ navigate\(networkUpdatesPath\(personaId\)\); return \}/)
  assert.match(page, /LEGACY_PROFILE_TAB_SECTION\[tabParam\]/)
  assert.match(page, /scrollIntoView/)
  const map = slice(engagement, 'const LEGACY_PROFILE_TAB_SECTION', 'export function ProfessionalProfilePage')
  assert.match(map, /background: 'profile-section-training'/)
  assert.match(map, /research: 'profile-section-research'/)
  assert.match(map, /interests: 'profile-section-interests'/)
})

test('Updates is retired from Profile IA entirely: no drafts/published-posts list rendering remains on the profile page (Share-this-paper reuse of PostButton is unrelated and still allowed)', () => {
  const page = profilePageFn()
  assert.doesNotMatch(page, /<PostCard/)
  assert.doesNotMatch(page, /suggestedDrafts|yourDrafts|getProfessionalPosts/)
})

test('enrichment suggestions render as a compact dismissible indicator, never a dominant inline block, and are omitted entirely when there are zero pending suggestions', () => {
  const entry = slice(engagement, 'export function ProfileSuggestionsEntry', 'export function NetworkPhysicianProfilePage')
  assert.match(entry, /pending\.length > 0/)
  assert.match(entry, /className="profile-suggestions-indicator"/)
  assert.match(entry, /\{pending\.length\} profile suggestion/)
  assert.match(entry, /Find public information/)
})

test('suggestion review reuses the existing backend review-state semantics, never a parallel frontend approval state', () => {
  assert.match(engagement, /await reviewProfileCandidate\(personaId, candidate\.candidate_id, action === 'edit_confirm' \? \{ action, title: title\.trim\(\) \} : \{ action \}\)/)
  const candidateCard = slice(engagement, 'function EnrichmentCandidateCard', 'function ProfileSuggestionsModal')
  assert.match(candidateCard, />Add to profile</)
  assert.match(candidateCard, />Edit &amp; add</)
  assert.match(candidateCard, />Dismiss</)
  assert.match(candidateCard, /candidate\.source_url && <>.*View source/)
})

test('"Find public information" never auto-runs on page open; it is a user-triggered action with the documented loading/empty/failure copy', () => {
  const entry = slice(engagement, 'export function ProfileSuggestionsEntry', 'export function NetworkPhysicianProfilePage')
  assert.doesNotMatch(entry, /useEffect\(\(\) => \{ runEnrichment/)
  assert.match(entry, /Looking for public professional information…/)
  assert.match(entry, /No new profile information found\./)
  assert.match(entry, /Public profile enrichment is temporarily unavailable\./)
})

test('own-profile editing controls (Edit, +Add, suggestions, Find public information) never render on another physician\'s public profile', () => {
  const publicPage = slice(engagement, 'export function NetworkPhysicianProfilePage', engagement.length)
  assert.doesNotMatch(publicPage, /ProfileSuggestionsEntry/)
  assert.doesNotMatch(publicPage, /Edit profile/)
  assert.doesNotMatch(publicPage, /Find public information/)
  assert.match(publicPage, /readOnly/)
})

test('public and private profile reuse the same section-rendering components (timeline, chips, interests) for presentational consistency', () => {
  const publicPage = slice(engagement, 'export function NetworkPhysicianProfilePage', engagement.length)
  assert.match(publicPage, /<ProfileTimelineGroup category="training"/)
  assert.match(publicPage, /<ProfileChipSection category="skills_or_procedures"/)
  assert.match(publicPage, /<InterestsPanel interests=\{data\.professional_profile\.interests\}/)
})

test('Profile structural parity: Lucy and Iain render the same ProfessionalProfilePage shell', () => {
  const dispatch = routing()
  assert.match(dispatch, /ProfessionalProfilePage personaId="lucy" navigate=\{navigate\} params=\{params\}/)
  assert.match(dispatch, /ProfessionalProfilePage personaId="iain" navigate=\{navigate\} params=\{params\}/)
})

/* --------------------------------------------------------- posts & updates */

test('agent-drafted posts are framed as a suggestion, not an autonomous post, and start as drafts', () => {
  assert.match(engagement, /post\.drafted_by === 'lamina_agent' && <span className="practice-update-agent-drafted">Drafted with your Lamina agent<\/span>/)
  assert.doesNotMatch(engagement, /[Yy]our agent posted/)
})

test('publishing is always an explicit physician action, never automatic', () => {
  assert.match(engagement, /await publishProfessionalPost\(personaId, Number\(post\.id\)\)/)
  assert.doesNotMatch(engagement, /publishProfessionalPost\([^)]*\)[\s\S]{0,40}useEffect/)
})

/* ------------------------------------------------------------- network feed */

test('the network feed renders chronologically and never computes its own popularity ordering', () => {
  const section = slice(engagement, 'export function NetworkFeedSection', '/* --------------------------------------------------------------------- Train */')
  assert.doesNotMatch(section, /\.sort\(/, 'ordering comes from the backend (chronological_only), not a client-side re-sort')
})

test('feed cards offer professional actions only — no likes, comments, or follower counts', () => {
  const card = slice(engagement, 'function FeedCard', 'export function NetworkHighlights')
  assert.match(card, /View profile/)
  assert.doesNotMatch(card, /like|heart|comment|follower|repost/i)
})

/* ------------------------------------------------------- Physician Network */

test('Lucy\'s physician directory links to a professional profile only for known engagement personas', () => {
  assert.match(network, /ENGAGEMENT_PERSONA_BY_NPI\[profile\.npi\] && <section className="professional-profile-link-card"/)
})

/* ------------------------------------------------------------ regression */

test('specialist review/calibration endpoints are untouched by the engagement additions', () => {
  assert.match(specialist, /markSpecialistCaseReviewed\(recordId\)/)
  assert.match(specialist, /updateSpecialistCalibration\(recordId, detail\.calibration\.key, action, statement\)/)
})

test('the PCP referral flow and demo perspectives remain exactly as before this pass', () => {
  assert.match(app, /Consult network for referral/)
  assert.doesNotMatch(app, /id: 'specialist' as const, name: SPECIALIST_NAME.*path: '\/specialist\/cases'/)
})

/* -------------------------------------------------------- Pass 6D: Practice tab */

const practiceTabFn = () => slice(engagement, 'export function PracticeTab', '/* ----------------------------------------------------------------- My Agent: Train */')

test('ordinary Practice navigation never shows the legacy case-raised review block', () => {
  assert.doesNotMatch(practiceTabFn(), /Case-raised preferences/, 'the legacy block moved out of PracticeTab itself')
  assert.match(app, /tabParam === 'calibration' && pending > 0 && <section className="agent-panel learning-panel practice-legacy-review">/, 'legacy block only renders when explicitly deep-linked via the old ?tab=calibration URL')
})

test('legacy ?tab=calibration deep links still resolve to Practice and can show the legacy block', () => {
  assert.match(app, /const LEGACY_AGENT_TAB_ALIASES: Record<string, AgentTab> = \{ knowledge: 'practice', calibration: 'practice' \}/)
})

test('the pending-training-review CTA is still wired to the real Train projection', () => {
  assert.match(app, /findPendingReviewHistoryEntry\(trainProjection\.recent_training_history\)/)
  assert.match(engagement, /reviewHref && <p className="practice-review-link">/)
})

test('Clinical focus and Case interests render as visual chip groups', () => {
  const page = practiceTabFn()
  assert.match(page, /<ChipGroup items=\{clinicalFocus\} prominent \/>/)
  assert.match(page, /INTEREST_CATEGORY_HEADINGS\[group\.category\]/)
  assert.match(engagement, /case_interest: "Areas you're especially interested in seeing"/)
})

test('only clinical_interest is suppressed against an identical Clinical Focus label; rules vs. learnings are still deduplicated', () => {
  const fn = slice(engagement, 'export function categorizeInterests', 'export function PracticeTab')
  assert.match(fn, /if \(category === 'clinical_interest' && focusLabels\.has\(label\)\) return false/, 'only the clinical_interest category is suppressed against Clinical Focus')
  assert.doesNotMatch(fn, /category !== 'clinical_interest'.*focusLabels/, 'no other category should be gated on focusLabels')
  const page = practiceTabFn()
  assert.match(page, /!ruleLabels\.has\(normalizeLabel\(item\.statement\)\)/, 'confirmed learnings that duplicate an explicit rule sentence are still deduplicated')
})

test("Iain's Cardiorenal disease case interest survives alongside the identical Clinical Focus chip, while Lucy's duplicate clinical interest stays suppressed", () => {
  // Mirrors the real categorizeInterests predicate (Engagement.tsx) against the exact
  // backend-shaped fixtures confirmed live for Lucy/Iain, since this suite can't import
  // .tsx modules directly. The source-pattern check above ties this back to the real code.
  const normalizeLabel = (value) => value.trim().toLowerCase().replace(/\s+/g, ' ')
  const categorizeInterests = (interests, clinicalFocus) => {
    const focusLabels = new Set(clinicalFocus.map(normalizeLabel))
    const order = ['case_interest', 'clinical_interest', 'research_interest', 'teaching_interest']
    return order.map((category) => {
      const seen = new Set()
      const items = interests.filter((item) => {
        if (item.interest_type !== category) return false
        const label = normalizeLabel(item.title)
        if (category === 'clinical_interest' && focusLabels.has(label)) return false
        if (seen.has(label)) return false
        seen.add(label)
        return true
      })
      return { category, items }
    }).filter((group) => group.items.length > 0)
  }

  const iainFocus = ['CKD stage 3–4', 'resistant hypertension', 'proteinuria', 'cardiorenal disease']
  const iainInterests = [
    { id: 'iain-case-interest-1', interest_type: 'case_interest', title: 'Resistant hypertension with renal dysfunction' },
    { id: 'iain-case-interest-2', interest_type: 'case_interest', title: 'Proteinuric CKD' },
    { id: 'iain-case-interest-3', interest_type: 'case_interest', title: 'Cardiorenal disease' },
    { id: 'iain-case-interest-4', interest_type: 'case_interest', title: 'Difficult-to-control blood pressure in CKD' },
  ]
  const iainGrouped = categorizeInterests(iainInterests, iainFocus)
  const iainCaseInterests = iainGrouped.find((group) => group.category === 'case_interest')?.items.map((item) => item.title) ?? []
  assert.ok(iainCaseInterests.includes('Cardiorenal disease'), 'a case interest must survive even when it textually matches a Clinical Focus item')
  assert.deepEqual(iainCaseInterests, ['Resistant hypertension with renal dysfunction', 'Proteinuric CKD', 'Cardiorenal disease', 'Difficult-to-control blood pressure in CKD'])

  const lucyFocus = ['Primary care', 'Specialty-care coordination']
  const lucyInterests = [
    { id: 'lucy-care-coordination', interest_type: 'clinical_interest', title: 'Specialty-care coordination' },
  ]
  const lucyGrouped = categorizeInterests(lucyInterests, lucyFocus)
  assert.deepEqual(lucyGrouped, [], "Lucy's duplicate clinical_interest must remain suppressed against Clinical Focus")
})

test('referral fit only renders when the backend provides meaningful good-fit/not-a-fit values, never raw signal codes', () => {
  const page = practiceTabFn()
  assert.match(page, /isRawSignalCode/)
  assert.match(page, /\(goodFit\.length > 0 \|\| notFit\.length > 0\) && <section className="practice-section practice-section-fit">/)
})

test('workup/referral/access sections use canonical data and collapse an identical referral/workup duplicate into one group', () => {
  const page = practiceTabFn()
  assert.match(page, /workupSameAsReferral/)
  assert.match(page, /sections\.access_facts\.join\(' · '\)/)
})

test('Practice Rules render as a quiet, scalable list', () => {
  const page = practiceTabFn()
  assert.match(page, /Practice rules/)
  assert.match(page, /<ExpandableList items=\{sections\.explicit_rules/)
  assert.match(engagement, /Show all \$\{items\.length\} rules/)
})

test('no disconnected completeness disclaimer remains on Practice since no completeness metric is shown', () => {
  assert.doesNotMatch(practiceTabFn(), /completeness\.meaning/)
  assert.doesNotMatch(practiceTabFn(), /Representation completeness only/)
})

test('the practice summary reuses the real Overview portrait sentence rather than composing new copy', () => {
  const page = practiceTabFn()
  assert.match(page, /const summary = practiceSummarySentence\(portrait\)/)
  assert.match(engagement, /const practiceSummarySentence = \(portrait: string \| undefined \| null\)/)
})

/* ----------------------------------------------------------------- Pass 7B: Home */

test('Current Work has a calm, compact empty state on both Home pages instead of a blank gap', () => {
  assert.match(homePageFn(), /No current cases need your attention\./)
  const specialistHome = slice(specialist, 'export function SpecialistHomePage', '/* --------------------------------------------------------------- Cases */')
  assert.match(specialistHome, /Cases involving your agent will appear here\./)
})

test('caught_up renders no CTA button at all — just quiet up-to-date text', () => {
  const card = slice(engagement, 'export function HomeAgentCard', '/* --------------------------------------------------------------------- Train */')
  assert.match(card, /training\.state === 'caught_up' && <p className="home-agent-caught-up">Training is up to date\.<\/p>/)
  assert.match(card, /\{cta && <button/, 'the CTA button only renders when homeTrainingCta returns a mapped action')
})

test('Lucy and Iain Home share the same dashboard architecture: Your Agent card + compact activity + optional network highlights, no separate specialist design', () => {
  const specialistHome = slice(specialist, 'export function SpecialistHomePage', '/* --------------------------------------------------------------- Cases */')
  assert.match(specialistHome, /<HomeAgentCard overview=\{overview\}/)
  assert.match(specialistHome, /<NetworkHighlights feed=\{feed\}/)
  assert.doesNotMatch(specialistHome, /agent learning|Review preferences/i, 'legacy case-raised learnings never drive Iain\'s ordinary Home either')
})

/* ----------------------------------------------------------------- Pass 7C: Network */

test('sidebar says Network, not Physician Network, for both personas', () => {
  assert.match(app, /id: 'network', title: 'Network', icon: '⌁', path: '\/network'/)
  assert.match(app, /id: 'specialist-network', title: 'Network', icon: '⌁', path: '\/specialist\/network'/)
  assert.doesNotMatch(app, /title: 'Physician Network'/)
})

test('Network defaults to My Network and routes ?tab=feed to Feed, for both personas', () => {
  const lucyShell = slice(app, 'function LucyNetworkPage', 'function HomePage')
  assert.match(lucyShell, /const \[tab, setTab\] = useState<NetworkTab>\(tabParam === 'feed' \? 'feed' : 'my-network'\)/)
  assert.match(lucyShell, /tab === 'my-network' \? <MyNetworkTab navigate=\{navigate\} \/> : <NetworkFeedTab personaId="lucy" navigate=\{navigate\} \/>/)
  const specialistShell = slice(specialist, 'export function SpecialistNetworkPage', specialist.length)
  assert.match(specialistShell, /const \[tab, setTab\] = useState<NetworkTab>\(tabParam === 'feed' \? 'feed' : 'my-network'\)/)
  assert.match(specialistShell, /tab === 'my-network' \? <SpecialistMyNetworkTab navigate=\{navigate\} \/> : <NetworkFeedTab personaId="iain" navigate=\{navigate\} \/>/)
})

test('legacy /network/updates and /specialist/network/updates alias to the Feed tab, never a separate feed page', () => {
  const dispatch = routing()
  assert.match(dispatch, /path === '\/network\/updates'[\s\S]{0,160}LucyNetworkPage navigate=\{navigate\} params=\{new URLSearchParams\('tab=feed'\)\}/)
  assert.match(dispatch, /path === '\/specialist\/network\/updates'[\s\S]{0,160}SpecialistNetworkPage navigate=\{navigate\} params=\{new URLSearchParams\('tab=feed'\)\}/)
  assert.doesNotMatch(engagement, /export function FullNetworkFeedPage/, 'the old standalone full-feed page implementation is gone')
})

test('Home "View network" lands on Network -> Feed, not a standalone feed route', () => {
  assert.match(engagement, /export const networkUpdatesPath = \(perspective: DemoPhysicianPerspective\) => \(perspective === 'iain' \? '\/specialist\/network\?tab=feed' : '\/network\?tab=feed'\)/)
})

test('My Network retains the existing graph/search/add behavior unchanged', () => {
  assert.match(network, /export function MyNetworkTab/)
  assert.match(network, /getAgentNetwork\(\)\.then\(setNetwork\)/)
  assert.match(network, /searchProviders\(filters\)/)
  assert.match(network, /addNetworkMember\(profile\.npi\)/)
  assert.match(network, /<NetworkGraph network=\{network\}/)
})

test('Network Feed uses canonical getNetworkFeed and never renders drafts', () => {
  const feedTab = slice(engagement, 'export function NetworkFeedTab', '/* --------------------------------------------------------------------- Train */')
  assert.match(feedTab, /getNetworkFeed\(personaId\)\.then\(setFeed\)/)
  assert.doesNotMatch(feedTab, /status === 'draft'/, 'the public feed never shows draft/suggested posts')
})

test('Post intents map to backend-supported PostType values with friendly labels', () => {
  const intents = slice(engagement, 'const POST_INTENTS', 'type PostFlowStage')
  for (const type of ['practice_update', 'referral_guidance', 'share_paper', 'research_update', 'teaching_update', 'interesting_case', 'availability', 'professional_update', 'other']) {
    assert.match(intents, new RegExp(`type: '${type}'`))
  }
  assert.doesNotMatch(intents, /type: 'profile_update'/, 'profile_update stays system-generated only, never a user-facing intent')
})

test('agent-drafted posts stay unpublished until explicit physician approval, never auto-published', () => {
  const postButton = slice(engagement, 'export function PostButton', '/* ------------------------------------------------------------------ Interests */')
  assert.match(postButton, /setDraftPost\(result\.post\)/)
  assert.match(postButton, /setStage\('preview'\)/)
  assert.doesNotMatch(postButton, /publishProfessionalPost[\s\S]{0,60}draftWithAgent/, 'drafting never implies publishing')
  assert.match(postButton, /await publishProfessionalPost\(personaId, Number\(draftPost\.id\)\)/)
})

test('the synthetic-case post safety boundary is preserved', () => {
  assert.match(engagement, /Demo mode supports synthetic case reflections only\./)
  assert.match(engagement, /case_origin: intent === 'interesting_case' \? 'synthetic_demo' : undefined/)
})

test('no likes, comments, follower, or engagement mechanics were added to the feed', () => {
  const feedArea = slice(engagement, 'function FeedCard', 'export function NetworkFeedTab')
  assert.doesNotMatch(feedArea, /like|comment|follower|repost|trending|engagement score/i)
})
