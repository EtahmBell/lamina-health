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

test('post-8B consolidated navigation: Cases is no longer a top-level destination for either persona', () => {
  assert.doesNotMatch(slice(app, 'const navItems', 'const SPECIALIST_NAV_ITEMS'), /title: 'Cases'/)
  assert.match(app, /if \(path === '\/consultations'\) return <ConsultationsPage navigate=\{navigate\} \/>/, 'the route stays reachable for compatibility')
})

test('specialist nav matches the consolidated Dashboard/Patients/Network set (post-8B), with My Agent as the persistent sidebar object and Profile in the avatar menu', () => {
  const navBlock = slice(app, 'const SPECIALIST_NAV_ITEMS', 'const CHEN_NAV_ITEMS')
  assert.deepEqual(navBlock.match(/title: '[^']+'/g), ["title: 'Dashboard'", "title: 'Patients'", "title: 'Network'"])
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

test('the agent banner (post-8B rename of the Your Agent card) never shows a referral score, ranking, or quality metric, and maps its CTA from canonical state/action only', () => {
  const card = slice(engagement, 'export function HomeAgentCard', 'const FEED_TYPE_LABELS')
  assert.doesNotMatch(card, /score|ranking|quality/i)
  assert.match(card, /Make your agent more like you\./)
  assert.doesNotMatch(card, /unfinished training/i)
  const mapping = slice(engagement, 'function agentBannerPlan', 'export function HomeAgentCard')
  assert.match(mapping, /training\.action === 'continue_setup'/)
  assert.match(mapping, /training\.action === 'resume_training' && activeId/)
  assert.match(mapping, /training\.action === 'start_training' && activeId/)
  assert.match(mapping, /training\.action === 'review_training' && reviewId/)
  assert.doesNotMatch(mapping, /\d+ of \d+/, 'never a finite "x of y" completion count for the open-ended representation')
})

test('the quick-training modal is its own session track, isolated from the full My Agent -> Train flow', () => {
  const modal = slice(engagement, 'function QuickTrainingModal', 'export function TrainingPage')
  assert.match(modal, /getTrainingHistory\(personaId, 'quick'\)/, 'the Dashboard burst must ask for the quick track, never the shared/standard one')
  assert.match(modal, /startTrainingSession\(personaId, \{ mode: 'quick', limit: 3 \}\)/)
})

test('the quick modal reads its progress from the backend-computed answered_count, never a raw response-list length (a Depends clarifier is not a top-level question)', () => {
  const modal = slice(engagement, 'function QuickTrainingModal', 'export function TrainingPage')
  assert.match(modal, /setAnsweredCount\(started\.answered_count \?\?/, 'resume/start progress prefers the backend-computed top-level count')
  assert.match(modal, /setAnsweredCount\(response\.answered_count \?\? answeredCount \+ 1\)/, 'per-answer progress comes from the backend response, not a local index increment')
})

test('HomeAgentCard threads the real viewing persona into the quick-training modal, never a hardcoded identity', () => {
  const card = slice(engagement, 'export function HomeAgentCard', 'const FEED_TYPE_LABELS')
  assert.match(card, /<QuickTrainingModal personaId=\{personaId\}/)
  assert.doesNotMatch(card, /<QuickTrainingModal personaId="lucy"/, 'the specialist Dashboard must not open a quick session for the PCP persona')
})

test('Home (both personas) renders the Your Agent card from AgentOverview, with a quiet link to My Agent', () => {
  assert.match(homePageFn(), /getAgentOverview\('lucy'\)\.then\(setOverview\)/)
  assert.match(homePageFn(), /<HomeAgentCard overview=\{overview\} navigate=\{navigate\} trainPath=\{trainingPath\('lucy'\)\} viewAgentPath="\/agent\?tab=overview" matchesReady=\{currentWork\.length\} records=\{records\} personaId="lucy" onTrainingUpdated=\{\(\) => getAgentOverview\('lucy'\)\.then\(setOverview\)\.catch\(\(\) => \{\}\)\} \/>/)
  const specialistHome = slice(specialist, 'export function SpecialistHomePage', '/* --------------------------------------------------------------- Cases */')
  assert.match(specialistHome, /getAgentOverview\('iain'\)\.then\(setOverview\)/)
  assert.match(specialistHome, /<HomeAgentCard overview=\{overview\} navigate=\{navigate\} trainPath=\{trainingPath\('iain'\)\} viewAgentPath="\/specialist\/agent\?tab=overview" personaId="iain" onTrainingUpdated=\{\(\) => getAgentOverview\('iain'\)\.then\(setOverview\)\.catch\(\(\) => \{\}\)\} \/>/)
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

test('My Agent uses the consolidated post-8B tabs (Overview/Train/Test), with legacy Knowledge/Calibration/Practice/Chat/Activity deep links preserved via alias', () => {
  assert.match(app, /const AGENT_TABS = \['overview', 'train', 'test'\] as const/)
  assert.match(app, /const LEGACY_AGENT_TAB_ALIASES: Record<string, AgentTab> = \{ knowledge: 'overview', calibration: 'overview', practice: 'overview', chat: 'test', activity: 'overview' \}/)
  assert.match(myAgentPageFn(), /learningParam = params\.get\('learning'\)/)
  assert.match(myAgentPageFn(), /recordParam = params\.get\('record'\)/)
})

test('Overview (which absorbed the old separate Practice tab) shows confirmed truth and links pending training review into Train, not a recreated Calibration UI', () => {
  const page = myAgentPageFn()
  assert.match(page, /tab === 'overview' && <AgentOverviewPanel overview=\{overview\} representation=\{representation\}/)
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
  const disclaimer = slice(engagement, 'function ProfileInterestSection', 'function ProfilePracticeLocationsSection')
  assert.match(disclaimer, /They do not guarantee referral eligibility or override clinical fit\./)
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
  assert.match(page, /if \(tabParam === 'updates'\) \{ if \(personaId !== 'owner'\) navigate\(networkUpdatesPath\(personaId\)\); return \}/)
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

test('"Edit profile" is the dominant primary action in the profile header; "View as others see it" and "View how my agent represents me" are quiet supporting text links', () => {
  const page = profilePageFn()
  assert.match(page, /<button className="button-primary" onClick=\{scrollToAbout\}>Edit profile<\/button>/)
  assert.match(page, /<button className="text-button" onClick=\{\(\) => navigate\(networkProfilePreviewPath\(personaId, profile\.physician\.id\)\)\}>View as others see it →<\/button>/)
  assert.match(page, /<button className="text-button" onClick=\{\(\) => navigate\(agentPracticePath\(personaId\)\)\}>View how my agent represents me →<\/button>/)
})

test('the Case interests explanatory sentence ("Case interests describe areas of professional interest...") is removed -- it is unnecessary on the physician\'s own profile', () => {
  assert.doesNotMatch(engagement, /Case interests describe areas of professional interest/)
})

test('Case interests heading has no accidental copper typography -- InterestGroup no longer applies the old .primary/accent-hover modifier to any interest type', () => {
  assert.doesNotMatch(engagement, /interest-group\.primary|interestType === 'case_interest' \? 'primary'/, 'the copper-tinted "primary" case-interest modifier is gone from both the component and its CSS')
  assert.match(engagement, /return <div className="interest-group">/, 'always the same plain class regardless of interest type')
})

test('the stray "Lamina can ask follow-up questions based on these interests" inline hint is gone, replaced by a deliberate TrainingFollowUpBanner after the interest sections', () => {
  assert.doesNotMatch(engagement, /Lamina can ask follow-up questions based on these interests|interest-training-hint/)
  const page = profilePageFn()
  assert.match(page, /\{hasInterests && <TrainingFollowUpBanner trainPath=\{trainingPath\(personaId\)\} navigate=\{navigate\} \/>\}/, 'only shown when there is actually something to train on')
})

test('TrainingFollowUpBanner has its own slate-blue palette and stacked-bar "progression" motif -- distinct from My Agent Overview\'s copper .training-reminder/TrainingReminderGlyph -- and still routes into the real existing training flow, no new training architecture', () => {
  const banner = slice(engagement, 'function TrainingFollowUpBanner', '/* ------------------------------------------------------------- My Agent: Overview */')
  assert.match(banner, /className="training-followup-banner"/)
  assert.match(banner, /<TrainingFollowUpGlyph \/>/)
  assert.doesNotMatch(banner, /className="training-reminder|<TrainingReminderGlyph/, 'never reuses My Agent Overview\'s copper banner classes/glyph directly')
  assert.match(banner, /Help your agent understand these preferences better/)
  assert.match(banner, /Training can refine how your agent represents these interests and referral preferences\./)
  assert.match(banner, /onClick=\{\(\) => navigate\(trainPath\)\}>Continue training <span>→<\/span>/)
  const glyph = slice(engagement, 'function TrainingFollowUpGlyph', 'function TrainingFollowUpBanner')
  assert.match(glyph, /className="tf-bar b1"/)
  assert.match(glyph, /className="tf-bar b2"/)
  assert.match(glyph, /className="tf-bar b3"/)
  assert.match(glyph, /className="tf-chevron"/)
  assert.doesNotMatch(glyph, /training-reminder-ring|✧/, 'a stacked-bar + chevron motif, not the old concentric rings + sparkle')
  assert.match(styles, /\.tf-bar \{ fill: var\(--slate\); \}/)
  assert.match(styles, /\.training-followup-banner \{[^}]*background: linear-gradient\(120deg, var\(--slate-surface\), var\(--surface\) 70%\);/)
})

test('Background renders compact "label ... + Add" rows when empty, never three stacked "Nothing added yet." blocks', () => {
  const group = slice(engagement, 'function ProfileTimelineGroup', 'function AboutSection')
  assert.doesNotMatch(group, /Nothing added yet/, 'the empty-state paragraph is gone from the editable timeline group entirely')
  assert.match(group, /const isEmpty = items\.length === 0 && !adding/)
  assert.match(group, /className=\{`profile-timeline-group \$\{isEmpty \? 'empty' : ''\}`\}/)
  assert.match(styles, /\.profile-timeline-group\.empty \{ margin-top: 10px; \}/)
})

test('the public physician profile never surfaces private/internal data (calibration, agent training, patient data) -- only the same ProfessionalProfile fields the physician controls on their own profile', () => {
  const publicPage = slice(engagement, 'export function NetworkPhysicianProfilePage', engagement.length)
  assert.doesNotMatch(publicPage, /calibration|proposed_learning|training_question|patient_id|patientName/i)
  assert.match(publicPage, /data\.professional_profile\.sections|sections\.about|sections\.locations/)
})

test('"View as others see it" enters preview mode via an explicit ?preview=1 route state, never a second parallel preview implementation', () => {
  const page = profilePageFn()
  assert.match(page, /networkProfilePreviewPath\(personaId, profile\.physician\.id\)/, 'routes to the real public-profile page, just with the preview flag appended')
  assert.match(engagement, /export const networkProfilePreviewPath = \(perspective: DemoPhysicianPerspective, controlledId: string\) => `\$\{networkProfilePath\(perspective, controlledId\)\}\?preview=1`/)
  const publicPage = slice(engagement, 'export function NetworkPhysicianProfilePage', engagement.length)
  assert.match(publicPage, /const isPreview = params\?\.get\('preview'\) === '1'/)
  assert.match(publicPage, /\{isPreview && <div className="profile-preview-bar">/)
  assert.match(publicPage, /Previewing your public profile/)
})

test('preview mode: both "Back to editing" in the preview bar AND the ordinary ← Back link route to the same canonical signed-in Profile route -- never browser history, never Dashboard', () => {
  const publicPage = slice(engagement, 'export function NetworkPhysicianProfilePage', engagement.length)
  assert.match(publicPage, /const backTarget = isPreview \? professionalProfilePath\(perspective\) : backPath/, 'one canonical target computed once, shared by every back control on the page')
  const previewBar = slice(publicPage, 'className="profile-preview-bar"', '</div>}')
  assert.match(previewBar, /onClick=\{\(\) => navigate\(backTarget\)\}>Back to editing →/)
  // Both the main back-link AND the two early-return (error/loading) back
  // links use backTarget, not the raw backPath prop, so the bug can't
  // resurface in any render path.
  const backLinkCount = (publicPage.match(/className="text-button back-link" onClick=\{\(\) => navigate\(backTarget\)\}/g) ?? []).length
  assert.equal(backLinkCount, 3, `expected all 3 back-link render paths (error, loading, main) to use backTarget, found ${backLinkCount}`)
  assert.doesNotMatch(publicPage, /onClick=\{\(\) => navigate\(backPath\)\}/, 'the raw Dashboard backPath is never used directly anymore -- only via backTarget, which already accounts for preview mode')
})

test('outside preview mode, the normal back-link behavior is unchanged -- it still routes to backPath (the public-flow Dashboard destination)', () => {
  const publicPage = slice(engagement, 'export function NetworkPhysicianProfilePage', engagement.length)
  assert.match(publicPage, /const backTarget = isPreview \? professionalProfilePath\(perspective\) : backPath/)
})

test('an ordinary public visitor never sees the preview bar -- it only renders when the ?preview=1 flag is present', () => {
  const publicPage = slice(engagement, 'export function NetworkPhysicianProfilePage', engagement.length)
  assert.match(publicPage, /isPreview &&/, 'the preview bar is conditionally rendered, not always-on')
  assert.doesNotMatch(publicPage, /^\s*<div className="profile-preview-bar">/m, 'never renders unconditionally outside the isPreview guard')
})

test('the Profile Assistant banner replaces the old InitializationCard ("Set up your agent") and ProfileSuggestionsEntry link with one banner, related to the Dashboard-banner composition but with its own soft-neutral-grey palette and faceted-triangle motif, never the Dashboard\'s mineral rings + sparkle', () => {
  assert.doesNotMatch(engagement, /^function InitializationCard|^export function InitializationCard/m, 'the old "Set up your agent" card component is removed entirely, not hidden')
  assert.doesNotMatch(engagement, /function ProfileSuggestionsEntry/)
  const banner = slice(engagement, 'export function ProfileAssistantBanner', 'function TrainingFollowUpBanner')
  assert.doesNotMatch(banner, /Set up your agent|initialization-card|initialization-steps/, 'the banner itself never renders the old setup-card copy/classes')
  assert.match(banner, /className="profile-assistant-banner"/)
  assert.match(banner, /<ProfileAssistantGlyph \/>/)
  assert.doesNotMatch(banner, /className="agent-banner |agent-banner-ring|agent-banner-sparkle/, 'never reuses the Dashboard\'s .agent-banner shell/rings/sparkle directly')
  assert.match(banner, /Let your agent build out your profile\./)
  assert.match(banner, /Your agent can use what it has learned about your practice and public professional information to suggest additions for your review\./)
  const glyph = slice(engagement, 'function ProfileAssistantGlyph', 'export function ProfileAssistantBanner')
  assert.match(glyph, /className="pa-facet f1"/)
  assert.match(glyph, /className="pa-facet f2"/)
  assert.match(glyph, /className="pa-facet f3"/)
  assert.match(glyph, /className="pa-facet f4"/)
  assert.match(glyph, /className="pa-guide"/)
  assert.match(styles, /\.pa-facet \{ fill: #5b615c; \}/)
  assert.match(styles, /\.profile-assistant-banner \{ display: grid; grid-template-columns: 1\.1fr 1fr;[^}]*background: #eef0ee;/, 'a soft-neutral grey surface, not the Dashboard\'s mineral/sage-tinted one')
})

test('the Profile Assistant banner idle/loading/ready states use the same .status-label/.spark-icon pulse language as the Patient Detail next-step rail, and nothing is auto-applied', () => {
  const banner = slice(engagement, 'export function ProfileAssistantBanner', 'function TrainingFollowUpBanner')
  assert.match(banner, /Profile suggestions/, 'idle heading')
  assert.match(banner, /Find missing details and review them before anything is added\./, 'idle support copy')
  assert.match(banner, /<span className="status-label pulse"><span className="spark-icon lead" aria-hidden="true">✧<\/span>Finding profile suggestions<\/span>/, 'loading pill')
  assert.match(banner, /Your agent is reviewing your profile\./)
  assert.match(banner, /Comparing your current profile with available professional information and what it has learned about your practice…/)
  assert.match(banner, /<span className="status-label resolved"><span className="spark-icon lead" aria-hidden="true">✓<\/span>Suggestions ready<\/span>/, 'ready pill')
  assert.match(banner, /Your agent found profile updates for you to review\./)
  const ctaCount = (banner.match(/Review suggestions <span>→<\/span>/g) ?? []).length
  assert.equal(ctaCount, 2, 'the same "Review suggestions" CTA label appears in both the idle and ready states')
  assert.doesNotMatch(banner, /useEffect\(\(\) => \{ runEnrichment/, 'never auto-runs the search on page open')
  assert.match(banner, /onClick=\{runEnrichment\}/, 'the idle CTA is what triggers the real search')
  assert.match(banner, /onClick=\{\(\) => setOpen\(true\)\}/, 'the ready CTA opens the real review modal -- nothing applies without it')
  assert.match(banner, /No new profile information found\./)
  assert.match(banner, /Public profile enrichment is temporarily unavailable\./)
})

test('suggestion review reuses the existing backend review-state semantics, never a parallel frontend approval state', () => {
  assert.match(engagement, /await reviewProfileCandidate\(personaId, candidate\.candidate_id, action === 'edit_confirm' \? \{ action, title: title\.trim\(\) \} : \{ action \}\)/)
  const candidateCard = slice(engagement, 'function EnrichmentCandidateCard', 'function ProfileSuggestionsModal')
  assert.match(candidateCard, />Add to profile</)
  assert.match(candidateCard, />Edit &amp; add</)
  assert.match(candidateCard, />Dismiss</)
  assert.match(candidateCard, /candidate\.source_url && <>.*View source/)
})

test('own-profile editing controls (Edit, +Add, suggestions, Find public information) never render on another physician\'s public profile', () => {
  const publicPage = slice(engagement, 'export function NetworkPhysicianProfilePage', engagement.length)
  assert.doesNotMatch(publicPage, /ProfileSuggestionsEntry/)
  assert.doesNotMatch(publicPage, /Edit profile/)
  assert.doesNotMatch(publicPage, /Find public information/)
  assert.match(publicPage, /readOnly/)
})

test('public and private profile call the exact same shared section components (not two independently-styled copies) -- the architectural core of the synchronization pass', () => {
  const ownPage = profilePageFn()
  const publicPage = slice(engagement, 'export function NetworkPhysicianProfilePage', engagement.length)
  for (const call of [
    /<ProfileBackgroundSection sections=\{/,
    /<ProfileInterestSection .*heading="Case interests" interestType="case_interest"/,
    /<ProfileInterestSection heading="Clinical interests" interestType="clinical_interest"/,
    /<ProfilePracticeLocationsSection sections=\{/,
    /<ProfileResearchTeachingSection sections=\{/,
  ]) {
    assert.match(ownPage, call, `own profile calls ${call}`)
    assert.match(publicPage, call, `public profile calls the same ${call}`)
  }
  // And the shared components themselves are built from the same lower-level
  // presentational pieces (timeline, chips, interest groups), each already
  // readOnly-aware -- one component with two modes, not two components.
  const background = slice(engagement, 'function ProfileBackgroundSection', 'function ProfileInterestSection')
  assert.match(background, /<ProfileTimelineGroup key=\{category\}/)
  const practiceLocations = slice(engagement, 'function ProfilePracticeLocationsSection', 'function ProfileResearchTeachingSection')
  assert.match(practiceLocations, /<ProfileChipSection category="skills_or_procedures"/)
})

test('the claimed member profile shares the NPPES directory profile\'s top-level identity/fact-strip shell, not a separate visual system', () => {
  const publicPage = slice(engagement, 'export function NetworkPhysicianProfilePage', engagement.length)
  assert.match(publicPage, /className="provider-profile-hero"/, 'same hero wrapper as PhysicianProfilePage (NPPES)')
  assert.match(publicPage, /className="profile-identity"/)
  assert.match(publicPage, /className="directory-avatar large"/, 'same avatar scale as the NPPES hero')
  assert.match(publicPage, /className="profile-facts three-up"/, 'same fact-strip geometry as the NPPES profile, 3-column variant')
  assert.match(publicPage, /className="profile-provenance"/, 'same quiet public-record strip language as "Public directory record"')
  assert.match(publicPage, /Public Lamina profile/)
})

test('the claimed-member fact strip prioritizes physician fields (location, specialty, network relationship), never a redundant "Public agent -- Available" column or fabricated organisation, and never consultation counts', () => {
  const publicPage = slice(engagement, 'export function NetworkPhysicianProfilePage', engagement.length)
  const facts = slice(publicPage, 'className="profile-facts three-up"', 'className="profile-provenance"')
  assert.match(facts, /Network relationship/)
  assert.match(facts, /networkRelationshipLabel/)
  assert.doesNotMatch(facts, /Public agent/, 'the chat rail already communicates public-agent availability -- no redundant fact-strip field for it')
  assert.doesNotMatch(facts, /Organisation/, 'no fabricated organisation field -- claimed physicians have no real org/practice-name data today')
  assert.doesNotMatch(facts, /consultation|Consultations/i)
})

test('a physician profile offers a real add/remove-network action, never implies the physician can be consulted directly from their profile', () => {
  const publicPage = slice(engagement, 'export function NetworkPhysicianProfilePage', engagement.length)
  assert.match(publicPage, /<NetworkRelationshipAction npi=\{data\.physician\.npi\} relationship=\{relationship\} \/>/)
  assert.doesNotMatch(publicPage, /Consult Network/)
})

test('"Add to network" is a real filled primary button when disconnected, using the same button family as other Network actions, and transitions to a quiet "In your network" state with a subtle Remove after adding -- state is read from the real API, never fabricated', () => {
  const action = slice(engagement, 'export function NetworkRelationshipAction', '/* ------------------------------------------------------------- Home: engagement */')
  assert.match(action, /if \(!npi \|\| !relationship\.loaded\) return null/, 'never renders a connection state before the real network has loaded')
  assert.match(action, /relationship\.inNetwork\s*\n\s*\? <span className="network-relationship-control"><span className="network-relationship-chip in-network">✓ In your network<\/span><button type="button" className="text-button quiet-remove"/, 'connected: a quiet chip plus a subtle text-button Remove, not another primary button')
  assert.match(action, /: <button type="button" className="button-primary network-relationship-action" disabled=\{relationship\.busy\} onClick=\{\(\) => void relationship\.add\(\)\}>Add to network <span>→<\/span><\/button>/, 'disconnected: a real filled .button-primary, the same family as other major Network CTAs, not a weak text/secondary link')
})

test('the "Public Lamina agent" badge and the network-relationship action have clear vertical separation in the top-right hero column, both still right-aligned', () => {
  assert.match(styles, /\.profile-hero-status \{ display: flex; flex-direction: column; align-items: flex-end; gap: 16px;/)
})

test('the referral card gives its title and internal subsections real breathing room, not a cramped box', () => {
  assert.match(styles, /\.referral-representation-section \{ border: 1px solid var\(--border\); border-radius: 14px; background: var\(--surface\); padding: 30px 32px;/)
  assert.match(styles, /\.referral-representation-section > h2 \{ margin: 0 0 6px;/, 'the title is not flush against the card edge with zero margin below it')
  assert.match(styles, /\.referral-rep-block \{ padding: 26px 0;/)
  assert.match(styles, /\.referral-rep-block:first-of-type \{ padding-top: 24px;/)
})

test('the referral card\'s own top padding AND top border always win over the shared .member-profile-section:first-child reset, which was silently zeroing padding-top and nulling border-top via a specificity collision', () => {
  assert.match(styles, /\.member-profile-section:first-child \{ margin-top: 0; border-top: none; padding-top: 0; \}/, 'confirms the shared reset rule that caused the collision still exists (it is correct for ordinary divider sections)')
  assert.match(styles, /\.referral-representation-section\.member-profile-section \{ padding-top: 30px; border-top: 1px solid var\(--border\); \}/, 'one same-specificity rule restores both the card\'s own top padding and its top border regardless of first-child position -- not a stack of ever-more-specific patches')
})

test('About / Background / Case interests / Clinical interests / Practice & locations / Research & teaching all share the SAME .profile-block-heading class -- one typography rule, not a scoped override needed per section', () => {
  assert.doesNotMatch(engagement, /profile-block-subheading/, 'the old small-uppercase eyebrow sub-heading class is gone entirely -- every major section now uses the one serif heading class')
  assert.match(engagement, /<h2 className="profile-block-heading">About<\/h2>/)
  assert.match(engagement, /<h2 className="profile-block-heading">Background<\/h2>/)
  assert.match(engagement, /<h2 className="profile-block-heading">\{heading\}<\/h2>/, 'ProfileInterestSection (Case interests / Clinical interests) uses the same class')
  assert.match(engagement, /<h2 className="profile-block-heading">Practice &amp; locations<\/h2>/)
  assert.match(engagement, /<h2 className="profile-block-heading">Research &amp; teaching<\/h2>/)
  // Exactly one CSS rule defines the resolved typography -- no page-scoped
  // override needed because every section now calls the class directly at
  // the same nesting depth (no wrapper section nested headings inside
  // another heading's section anymore).
  const ruleCount = (styles.match(/\.profile-block-heading \{/g) ?? []).length
  assert.equal(ruleCount, 1, `expected exactly one .profile-block-heading rule, found ${ruleCount}`)
})

test('the joined-Lamina member profile is a two-column layout with a sticky agent-chat rail, not the old single-column shell', () => {
  const publicPage = slice(engagement, 'export function NetworkPhysicianProfilePage', engagement.length)
  assert.match(publicPage, /className="member-profile-layout"/)
  assert.match(publicPage, /<PhysicianAgentChatRail /)
  assert.match(styles, /\.member-chat-rail\.pinned \{ position: sticky/)
})

test('the chat rail pins sticky only while its own content fits the viewport, reusing the Patient Detail next-step rail\'s ResizeObserver "pin while it fits" pattern -- never a hard sticky that could pin content out of reach', () => {
  const rail = slice(engagement, 'function PhysicianAgentChatRail', engagement.length)
  assert.match(rail, /\[pinned, setPinned\] = useState\(false\)/)
  assert.match(rail, /new ResizeObserver\(evaluate\)/)
  assert.match(rail, /window\.innerWidth <= 900.*setPinned\(false\)/)
  assert.match(rail, /className=\{`member-chat-rail \$\{pinned \? 'pinned' : ''\}`\}/)
  assert.match(styles, /\.member-chat-rail \{ position: static;/, 'unpinned by default, not hard-sticky')
})

test('mobile collapses the member-profile layout to a single column with the rail no longer sticky', () => {
  assert.match(styles, /@media \(max-width: 900px\) \{\s*\.member-profile-layout \{ grid-template-columns: 1fr; \}\s*\.member-chat-rail, \.member-chat-rail\.pinned \{ position: static; \}/)
})

test('"How this practice works with referrals" is ONE coherent bordered card with internal hairline-divided blocks (clinical focus / good-fit / helpful before referral), not three separate equal SaaS tiles', () => {
  const publicPage = slice(engagement, 'export function NetworkPhysicianProfilePage', engagement.length)
  assert.match(publicPage, /How this practice works with referrals/)
  assert.match(publicPage, /className="referral-rep-block"/)
  assert.doesNotMatch(publicPage, /referral-rep-grid|referral-rep-column|practice-rep-cards|practice-representation-panel/, 'the old 3-equal-column grid and flat-panel layouts are both gone')
  assert.match(styles, /\.referral-representation-section \{ border: 1px solid var\(--border\)/, 'one bordered object, not three')
})

test('clinical focus renders as quiet chips, good-fit referrals as generous rows, and helpful-before-referral as a distinct checklist -- three different treatments, not three identical tiles', () => {
  const publicPage = slice(engagement, 'export function NetworkPhysicianProfilePage', engagement.length)
  assert.match(publicPage, /className="referral-focus-chips"/)
  assert.match(publicPage, /className="referral-fit-rows"/)
  assert.match(publicPage, /className="referral-checklist"/)
  assert.match(publicPage, /<span aria-hidden="true">✓<\/span>/, 'the pre-referral checklist uses a real checkmark, visually distinct from the chips/rows above it')
})

test('raw snake_case backend tokens are humanized before reaching the referral card, via one reusable formatter rather than one-off string replacements', () => {
  assert.match(engagement, /function humanizeClinicalTerm\(raw: string\): string/)
  const formatter = slice(engagement, 'function humanizeClinicalTerm', 'const FEED_TYPE_LABELS')
  assert.doesNotMatch(formatter, /resistant_hypertension|ckd_stage|progressive_renal/i, 'a reusable word-by-word formatter, never a hardcoded replacement for one specific string')
  assert.match(formatter, /raw\.split\('_'\)/)
  const publicPage = slice(engagement, 'export function NetworkPhysicianProfilePage', engagement.length)
  const referralSection = slice(publicPage, 'referral-representation-section', 'about-physician-section')
  assert.match(referralSection, /<span className="referral-chip" key=\{item\}>\{humanizeClinicalTerm\(item\)\}<\/span>/, 'clinical focus is humanized')
  assert.match(referralSection, /<li key=\{item\}>\{humanizeClinicalTerm\(item\)\}<\/li>/, 'good-fit referrals are humanized')
  assert.match(referralSection, /<span aria-hidden="true">✓<\/span>\{humanizeClinicalTerm\(item\)\}/, 'pre-referral workup is humanized')
})

test('case interests are their own public section (synchronized with the owner\'s own profile), never folded into the referral card -- so the disclaimer about referring physicians only appears there', () => {
  const publicPage = slice(engagement, 'export function NetworkPhysicianProfilePage', engagement.length)
  assert.doesNotMatch(publicPage, /caseInterests|especially interested in seeing/, 'no case-interest folding logic left in the referral-card section of this page')
  assert.match(publicPage, /<ProfileInterestSection heading="Case interests" interestType="case_interest" interests=\{interests\} physicianName=\{name\} readOnly \/>/)
  const interestSection = slice(engagement, 'function ProfileInterestSection', 'function ProfilePracticeLocationsSection')
  assert.match(interestSection, /readOnly && interestType === 'case_interest' && items\.length > 0 && physicianName && <small className="profile-interest-disclaimer">/, 'the referring-physician disclaimer moved with it, shown only in read-only context')
})

test('good-fit referrals that exactly restate a clinical-focus entry are deduped, never shown twice', () => {
  const publicPage = slice(engagement, 'export function NetworkPhysicianProfilePage', engagement.length)
  assert.match(publicPage, /clinicalFocusSeen\.has\(item\.toLowerCase\(\)\)/)
  assert.match(publicPage, /dedupedGoodFit/)
})

test('research and teaching interests render only inside the shared Research & teaching section, never duplicated inside the referral card', () => {
  const publicPage = slice(engagement, 'export function NetworkPhysicianProfilePage', engagement.length)
  assert.doesNotMatch(publicPage, /Research &amp; teaching interests|otherInterests|researchInterests|teachingInterests/, 'no research/teaching logic lives inline in this page anymore -- it is all inside the shared component')
  assert.match(publicPage, /<ProfileResearchTeachingSection sections=\{sections\} interests=\{interests\} readOnly \/>/)
})

test('the About section has exactly ONE heading, reading simply "About" (not "About this physician") -- no separate inner "About" heading, and no doubled divider above the bio', () => {
  assert.doesNotMatch(engagement, /About this physician/, 'the old redundant "About this physician" + "About" pairing is gone entirely')
  const aboutSection = slice(engagement, 'function AboutSection', 'function PostCard')
  const headingCount = (aboutSection.match(/>About</g) ?? []).length
  assert.equal(headingCount, 1, `expected exactly one literal "About" heading in AboutSection, found ${headingCount}`)
  assert.match(aboutSection, /<h2 className="profile-block-heading">About<\/h2>/)
  assert.match(aboutSection, /className="profile-block profile-about"/, 'always one .profile-block divider -- no longer a conditional showHeading toggle, since both pages now want the same single heading')
  // Both pages call the exact same AboutSection -- one real "About" heading
  // on each page, never nested inside a second wrapper heading.
  const ownPage = profilePageFn()
  const publicPage = slice(engagement, 'export function NetworkPhysicianProfilePage', engagement.length)
  assert.match(ownPage, /<AboutSection items=\{profile\.sections\.about\} personaId=\{personaId\} onSaved=\{onItemSaved\} \/>/)
  assert.match(publicPage, /<AboutSection items=\{sections\.about\} readOnly \/>/)
})

test('About / Background / Case interests / Clinical interests / Practice & locations / Research & teaching are flat, independent top-level sections on both pages -- not nested inside one umbrella "About" wrapper', () => {
  assert.doesNotMatch(engagement, /about-physician-section/, 'the old wrapper section that wrongly nested everything under one About heading is gone')
  assert.match(engagement, /className="about-practice-grid"/, 'the lighter practice-detail fields (skills/languages/links) still use a restrained two-column grid')
  assert.match(styles, /\.about-practice-grid \{ display: grid; grid-template-columns: repeat\(auto-fit/)
})

test('Practice & locations shows the location value directly, with no redundant inner "Locations" subheading -- parallel to the simplified About structure, and the same for both own and public profiles', () => {
  const section = slice(engagement, 'function ProfilePracticeLocationsSection', 'function ProfileResearchTeachingSection')
  assert.match(section, /className="profile-location-value"/)
  assert.match(section, /<ProfileSection category="locations" items=\{sections\.locations\} personaId=\{personaId\} onSaved=\{onSaved\} showHeading=\{false\} \/>/, 'the editable path keeps real add/edit controls but suppresses the redundant "Locations" heading')
  assert.match(section, /sections\.locations\.map\(\(item\) => item\.title\)\.join\(' · '\)/, 'read-only renders the actual location value directly, e.g. "San Francisco, CA"')
})

test('recent network updates reuse FeedCard (the real Network Feed post component) directly, never a second simplified post renderer', () => {
  const publicPage = slice(engagement, 'export function NetworkPhysicianProfilePage', engagement.length)
  assert.doesNotMatch(engagement, /function MemberUpdateCard/, 'the old simplified duplicate post card is gone entirely')
  assert.match(publicPage, /<FeedCard key=\{item\.id\} item=\{item\} navigate=\{navigate\} perspective=\{perspective\} \/>/)
  assert.match(publicPage, /Recent network updates/)
  assert.match(publicPage, /recentPosts\.length > 0/, 'an honest empty state renders when the physician has no published updates')
  assert.match(publicPage, /View network posts →/)
  assert.match(publicPage, /navigate\(networkUpdatesPath\(perspective\)\)/, 'routes to the real Feed tab -- no invented physician-filtered route')
})

test('"Practice representation at a glance" is visually the quietest, lowest-priority section -- an eyebrow label after every other profile section, not another h2 feature', () => {
  const publicPage = slice(engagement, 'export function NetworkPhysicianProfilePage', engagement.length)
  const mainOrder = publicPage.indexOf('referral-representation-section')
  const analyticsOrder = publicPage.indexOf('<MemberProfileAnalytics')
  const updatesOrder = publicPage.indexOf('Recent network updates')
  assert.ok(mainOrder < analyticsOrder && updatesOrder < analyticsOrder, 'analytics render after the referral section and the updates section')
  const analyticsFn = slice(engagement, 'function MemberProfileAnalytics', 'function MemberUpdateCard')
  assert.doesNotMatch(analyticsFn, /<h2>/, 'no h2-weight heading -- an eyebrow label only')
  assert.doesNotMatch(analyticsFn, /consultation_count|interaction|popularity/i, 'never a fabricated interaction/popularity metric')
  assert.match(analyticsFn, /rep\.clinical_focus\.length/)
})

test('the agent-chat rail reads as a real compact messenger, not four giant FAQ buttons: starter prompts live behind a collapsible "Suggested questions" control', () => {
  const publicPage = slice(engagement, 'export function NetworkPhysicianProfilePage', engagement.length)
  const rail = slice(publicPage, 'function PhysicianAgentChatRail', engagement.length)
  assert.match(rail, /\[suggestionsOpen, setSuggestionsOpen\] = useState\(false\)/, 'collapsed by default')
  assert.match(rail, /Suggested questions/)
  assert.match(rail, /aria-expanded=\{suggestionsOpen\}/)
  assert.match(rail, /className="suggested-question-item"/)
  assert.match(publicPage, /What cases are a good fit for this practice\?/)
  assert.match(publicPage, /What workup is usually helpful before referral\?/)
  assert.match(publicPage, /When would this physician want co-management\?/)
  assert.match(publicPage, /What does this practice prioritize most\?/)
})

test('the suggested-questions control is never gated on message count -- it stays available after messages are sent, and selecting a prompt sends it and collapses the panel', () => {
  const rail = slice(engagement, 'function PhysicianAgentChatRail', engagement.length)
  assert.doesNotMatch(rail, /messages\.length === 0[\s\S]{0,40}suggestionsOpen/, 'the suggestions toggle is not conditioned on an empty thread')
  assert.match(rail, /onClick=\{\(\) => ask\(prompt\)\}/)
  assert.match(rail, /setSuggestionsOpen\(false\)/, 'selecting a prompt (via ask()) collapses the panel again')
})

test('the conversation area starts with meaningful empty space, not pre-filled starter bubbles', () => {
  const rail = slice(engagement, 'function PhysicianAgentChatRail', engagement.length)
  assert.match(rail, /messages\.length === 0 && !typing && <p className="member-chat-empty">/)
  assert.match(styles, /\.member-chat-conversation \{[^}]*min-height: 96px/)
})

test('sending a message shows a lightweight typing state (reusing the My Agent Test tab\'s .chat-typing-dots) before the answer appears, and it respects reduced motion', () => {
  const rail = slice(engagement, 'function PhysicianAgentChatRail', engagement.length)
  assert.match(rail, /window\.setTimeout\(\(\) => \{/)
  assert.match(rail, /className="chat-typing-dots"/)
  assert.doesNotMatch(rail, /<div className="spinner"|loading-spinner/i)
  assert.match(styles, /@media \(prefers-reduced-motion: reduce\) \{ \.chat-typing-dots span \{ animation: none/)
})

test('the chat avatar is small (matching the Feed\'s compact agent-avatar scale), never the giant stretched regression, and physician identity initials stay separate from agent identity', () => {
  assert.match(styles, /\.member-chat-avatar \{ display: block; width: 30px; height: 30px;/)
  assert.match(styles, /\.member-chat-message-avatar \{ display: block; width: 18px; height: 18px;/)
})

test('the chat disclaimer is honest but quiet -- a short caption, not a dominant opening paragraph -- and the greeting response uses natural public-agent language, never implementation-facing text', () => {
  const rail = slice(engagement, 'function PhysicianAgentChatRail', engagement.length)
  assert.match(rail, /className="member-chat-disclaimer"/)
  assert.doesNotMatch(rail, /<p>A grounded preview of how/, 'the old dominant top-of-rail disclaimer paragraph is gone')
  const builder = slice(engagement, 'function buildAgentPreviewAnswer', 'function PhysicianAgentChatRail')
  assert.match(builder, /Hi — I can help you understand \$\{name\}'s referral preferences/)
  assert.doesNotMatch(builder, /can speak to clinical focus, good-fit cases, and pre-referral guidance -- try one of the starter prompts/, 'the old implementation-facing fallback copy is gone')
})

test('agent-chat preview answers are built only from this physician\'s own on-page representation fields, never invented facts, and chatWithAgent (the editable-persona-only endpoint) is never called here', () => {
  const publicPage = slice(engagement, 'export function NetworkPhysicianProfilePage', engagement.length)
  assert.doesNotMatch(publicPage, /await chatWithAgent|= chatWithAgent\(/)
  const builder = slice(publicPage, 'function buildAgentPreviewAnswer', 'function toneForAgent')
  assert.match(builder, /rep\.good_fit/)
  assert.match(builder, /rep\.preferred_workup/)
  assert.match(builder, /rep\.clinical_focus/)
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

test('the network feed interleaves the 1-2 agent-authored examples with the real backend feed purely by date, never a popularity/engagement ordering', () => {
  const section = slice(engagement, 'export function NetworkFeedTab', '/* --------------------------------------------------------------------- Train */')
  assert.match(section, /\[\.\.\.feed\.items, \.\.\.AGENT_FEED_POSTS\]\.sort\(\(a, b\) => \(b\.published_at \?\? b\.created_at\)\.localeCompare\(a\.published_at \?\? a\.created_at\)\)/, 'date is the only sort key')
  assert.doesNotMatch(section, /likes|views|engagement_score|popularity|confidence/i)
})

test('feed cards offer professional actions only — no likes, comments, or follower counts', () => {
  const card = slice(engagement, 'function FeedCard', 'export function NetworkHighlights')
  assert.match(card, /networkProfilePath\(perspective, item\.physician\.id\)/, 'the author name links to their profile')
  assert.doesNotMatch(card, /like|heart|comment|follower|repost/i)
})

test('the feed reads as a content-first professional stream, not a grid of action cards', () => {
  const card = slice(engagement, 'function FeedCard', 'export function NetworkHighlights')
  assert.match(card, /feed-post-avatar/)
  assert.match(card, /feed-post-title/)
  assert.match(card, /feed-post-body/)
  assert.match(engagement, /className="feed-stream"/)
  assert.doesNotMatch(engagement, /feed-grid|feed-card\b/)
})

test('long feed posts truncate with a See more/See less expansion instead of always showing full body', () => {
  const card = slice(engagement, 'function FeedCard', 'export function NetworkHighlights')
  assert.match(card, /isLong[\s\S]*See more/)
  assert.match(card, /See less/)
})

test('feed posts render an optional static image from the Vite public directory, with no external fetching or embedded data URIs', () => {
  const section = slice(engagement, 'function FeedPostImage', 'function feedInitials')
  assert.match(section, /if \(!item\.image_url\) return null/, 'a post with no image_url renders text-only')
  assert.match(section, /<img className="feed-post-image" src=\{item\.image_url\} alt=\{item\.image_alt \?\? ''\} loading="lazy" \/>/)
  assert.doesNotMatch(engagement, /https?:\/\/.*\.(png|jpe?g|gif|webp)/i, 'no external image URLs')
  assert.doesNotMatch(engagement, /data:image\//, 'no embedded base64 images')
})

test('image posts pick cover vs. contain media treatment from media_style, with a neutral surface behind contain figures', () => {
  const section = slice(engagement, 'function FeedPostImage', 'function feedInitials')
  assert.match(section, /item\.media_style === 'contain' \? 'contain' : 'cover'/)
  assert.match(styles, /\.fit-contain \{[^}]*background: var\(--mineral-surface\)/, 'research/figure images get a neutral backing, not raw transparency')
  assert.match(styles, /\.fit-cover \.feed-post-image \{ object-fit: cover/)
  assert.match(styles, /\.fit-contain \.feed-post-image \{ object-fit: contain/)
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

test('legacy ?tab=calibration deep links still resolve to Overview and can show the legacy block', () => {
  assert.match(app, /const LEGACY_AGENT_TAB_ALIASES: Record<string, AgentTab> = \{ knowledge: 'overview', calibration: 'overview', practice: 'overview', chat: 'test', activity: 'overview' \}/)
})

test('the pending-training-review CTA is still wired to the real Train projection (now computed inside AgentOverviewPanel itself)', () => {
  assert.match(engagement, /const reviewHref = training\.state === 'review_pending' && training\.review_session_id \? `\$\{trainPath\}\?review=\$\{training\.review_session_id\}` : null/)
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

test('Needs you (post-8B rename of Current Work) has a calm, compact empty state on the Specialist Dashboard instead of a blank gap (mineral-system pass: the PCP Dashboard replaced its standalone Needs You section with the patient watchlist, so this empty-state copy is now Specialist-only)', () => {
  const specialistHome = slice(specialist, 'export function SpecialistHomePage', '/* --------------------------------------------------------------- Cases */')
  assert.match(specialistHome, /Nothing needs you right now\./)
})

test('genuinely caught up (no training plan, case interests present, profile complete) renders no CTA button at all — just quiet up-to-date support text', () => {
  const card = slice(engagement, 'export function HomeAgentCard', 'const FEED_TYPE_LABELS')
  assert.match(card, /\{prompt \? prompt\.body : 'Training is up to date\.'\}/)
  assert.match(card, /\{prompt && prompt\.kind === 'quick-training' && <button/, 'the quick-training CTA only renders for that prompt kind')
  assert.match(card, /\{prompt && prompt\.kind === 'navigate' && <button/, 'the navigate CTA only renders for that prompt kind')
})

test('the improvement prompt is selected by a deterministic, state-driven helper -- training plan, then case interests, then profile completeness, then genuinely caught up', () => {
  assert.match(engagement, /export function selectImprovementPrompt\(/)
  assert.match(engagement, /if \(plan\) \{/)
  assert.match(engagement, /const caseInterestCount = profile\.interests\.filter\(\(item\) => item\.interest_type === 'case_interest'\)\.length/)
  assert.match(engagement, /if \(caseInterestCount === 0\) \{/)
  assert.match(engagement, /if \(profile\.completeness\.completed_section_count < profile\.completeness\.total_section_count\) \{/)
})

test('the improvement-prompt type is an open union, not an enum hardcoded to exactly three prompt kinds -- a future referral-preferences prompt is just another priority branch', () => {
  assert.match(engagement, /export type ImprovementPromptKind = 'quick-training' \| 'navigate'/)
  assert.match(engagement, /export type ImprovementPrompt = \{/)
  assert.doesNotMatch(engagement, /Describe how you receive referrals|Add referral preferences/i, 'the NLP referral-preferences prompt is not shown yet -- the feature does not exist')
})

test('"Add case interests" navigates directly to the existing Profile -> Clinical & Case Interests editing experience, never a new Dashboard editor', () => {
  assert.match(engagement, /href: `\$\{profilePath\}\?tab=interests`/)
  assert.doesNotMatch(engagement, /CaseInterestEditor|DashboardInterestEditor/i)
})

test('HomeAgentCard reuses the existing getProfessionalProfile fetch (threaded through a reusable loadProfile, re-run on training completion too) and reuses professionalProfilePath for the profile-completeness/case-interests destinations', () => {
  const card = slice(engagement, 'export function HomeAgentCard', 'const FEED_TYPE_LABELS')
  assert.match(card, /const loadProfile = \(\) => \{ getProfessionalProfile\(personaId\)\.then\(setProfile\)\.catch\(\(\) => \{\}\) \}/)
  assert.match(card, /useEffect\(loadProfile, \[personaId\]\)/)
  assert.match(card, /const profilePath = personaId === 'owner' \? '\/me\/profile' : professionalProfilePath\(personaId\)/)
})

/* --------------------------------------------------------------- Part F-I */

test('root cause fix: completing quick training now invalidates/refetches both the card\'s own profile AND the parent-owned overview/training state -- onFinished no longer just closes the modal', () => {
  const card = slice(engagement, 'export function HomeAgentCard', 'const FEED_TYPE_LABELS')
  assert.match(card, /onFinished=\{\(\) => \{ setTrainingOpen\(false\); loadProfile\(\); onTrainingUpdated\?\.\(\) \}\}/)
  assert.match(card, /onTrainingUpdated\?: \(\) => void/)
})

test('every HomeAgentCard caller (Lucy, Chen, Iain) passes onTrainingUpdated, refetching its own overview the moment training completes -- the parent actually receives the completion event', () => {
  assert.match(app, /onTrainingUpdated=\{\(\) => getAgentOverview\('lucy'\)\.then\(setOverview\)\.catch\(\(\) => \{\}\)\}/)
  const referralSource = readFileSync(new URL('../src/Referral.tsx', import.meta.url), 'utf8')
  assert.match(referralSource, /onTrainingUpdated=\{\(\) => getAgentOverview\('chen'\)\.then\(setOverview\)\.catch\(\(\) => \{\}\)\}/)
  assert.match(specialist, /onTrainingUpdated=\{\(\) => getAgentOverview\('iain'\)\.then\(setOverview\)\.catch\(\(\) => \{\}\)\}/)
})

test('the improvement prompt is never randomly rotated -- selectImprovementPrompt is a pure deterministic function of real state, with no Math.random/rotation-index anywhere in it', () => {
  const fn = engagement.slice(engagement.indexOf('export function selectImprovementPrompt'), engagement.indexOf('type DigestTile'))
  assert.doesNotMatch(fn, /Math\.random|rotationIndex|% prompts\.length|Date\.now\(\) %/)
})

test('the resume/continue-setup state uses plan.label/plan.support directly (dynamic, already computed by agentBannerPlan) rather than one hardcoded "Answer 3 quick questions" string for every training action', () => {
  const fn = engagement.slice(engagement.indexOf('export function selectImprovementPrompt'), engagement.indexOf('if (!profile) return null'))
  assert.match(fn, /ctaLabel: plan\.label/)
  assert.match(fn, /body: plan\.support/)
})

test('Lucy and Iain Home share the same dashboard architecture: Your Agent card + compact activity + optional network highlights, no separate specialist design', () => {
  const specialistHome = slice(specialist, 'export function SpecialistHomePage', '/* --------------------------------------------------------------- Cases */')
  assert.match(specialistHome, /<HomeAgentCard overview=\{overview\}/)
  assert.match(specialistHome, /<NetworkHighlights feed=\{feed\}/)
  assert.doesNotMatch(specialistHome, /agent learning|Review preferences/i, 'legacy case-raised learnings never drive Iain\'s ordinary Home either')
})

/* ----------------------------------------------------------------- Pass 7C: Network */

test('sidebar says Network, not Physician Network, for both personas', () => {
  assert.match(app, /id: 'network', title: 'Network', icon: <NetworkNavIcon \/>, path: '\/network'/)
  assert.match(app, /id: 'specialist-network', title: 'Network', icon: <NetworkNavIcon \/>, path: '\/specialist\/network'/)
  assert.doesNotMatch(app, /title: 'Physician Network'/)
})

test('the Network sidebar icon is a simple thin-line people/group mark, not the old lightning bolt or a node/graph diagram', () => {
  assert.doesNotMatch(app, /icon: '⌁'/, 'the lightning-bolt glyph is gone, not just unused')
  const icon = slice(app, 'function NetworkNavIcon', 'const navItems')
  assert.match(icon, /<circle cx="8" cy="7\.5" r="3" \/>/, 'a head')
  assert.match(icon, /<circle cx="16\.5" cy="9" r="2\.3" \/>/, 'a second, smaller head -- a group, not a single person')
  assert.match(icon, /stroke="currentColor"/, 'inherits .nav-icon\'s existing copper tint rather than a hardcoded color')
  assert.match(icon, /fill="none"/, 'thin-line treatment, not a filled glyph')
})

test('Network defaults to Feed and routes ?tab=my-network to Colleagues, for both personas (post-8B: Feed is primary, not graph/directory-first)', () => {
  const lucyShell = slice(app, 'function LucyNetworkPage', 'function HomePage')
  assert.match(lucyShell, /const \[tab, setTab\] = useState<NetworkTab>\(tabParam === 'my-network' \? 'my-network' : 'feed'\)/)
  assert.match(lucyShell, /tab === 'my-network' \? <MyNetworkTab navigate=\{navigate\} \/> : <NetworkFeedTab personaId="lucy" navigate=\{navigate\} \/>/)
  const specialistShell = slice(specialist, 'export function SpecialistNetworkPage', specialist.length)
  assert.match(specialistShell, /const \[tab, setTab\] = useState<NetworkTab>\(tabParam === 'my-network' \? 'my-network' : 'feed'\)/)
  assert.match(specialistShell, /tab === 'my-network' \? <SpecialistMyNetworkTab navigate=\{navigate\} \/> : <NetworkFeedTab personaId="iain" navigate=\{navigate\} \/>/)
})

test('legacy /network/updates and /specialist/network/updates alias to the Feed tab, never a separate feed page', () => {
  const dispatch = routing()
  assert.match(dispatch, /path === '\/network\/updates'[\s\S]{0,160}LucyNetworkPage navigate=\{navigate\} params=\{new URLSearchParams\('tab=feed'\)\}/)
  assert.match(dispatch, /path === '\/specialist\/network\/updates'[\s\S]{0,160}SpecialistNetworkPage navigate=\{navigate\} params=\{new URLSearchParams\('tab=feed'\)\}/)
  assert.doesNotMatch(engagement, /export function FullNetworkFeedPage/, 'the old standalone full-feed page implementation is gone')
})

test('Home "View network" lands on Network -> Feed, not a standalone feed route', () => {
  assert.match(engagement, /export const networkUpdatesPath = \(perspective: DemoPhysicianPerspective\) => \(perspective === 'iain' \? '\/specialist\/network\?tab=feed' : perspective === 'chen' \? '\/chen\/network\?tab=feed' : '\/network\?tab=feed'\)/)
})

test('My Network retains the existing search/add/list behavior; the graph is deliberately gone (Dashboard+Network polish pass)', () => {
  assert.match(network, /export function MyNetworkTab/)
  assert.match(network, /getAgentNetwork\(\)\.then\(setNetwork\)/)
  assert.match(network, /searchProviders\(filters\)/)
  assert.match(network, /addNetworkMember\(profile\.npi\)/)
  assert.doesNotMatch(network, /NetworkGraph/)
})

test('Network Feed uses canonical getNetworkFeed and never renders drafts', () => {
  const feedTab = slice(engagement, 'export function NetworkFeedTab', '/* --------------------------------------------------------------------- Train */')
  assert.match(feedTab, /getNetworkFeed\(personaId\)\.then\(setFeed\)/)
  assert.doesNotMatch(feedTab, /status === 'draft'/, 'the public feed never shows draft/suggested posts')
})

test('the composer Tag vocabulary covers every backend-supported PostType, with friendly labels', () => {
  const tags = slice(engagement, 'const PRIMARY_POST_TAGS', 'type PostFlowStage')
  for (const type of ['practice_update', 'referral_guidance', 'share_paper', 'research_update', 'teaching_update', 'interesting_case', 'availability', 'professional_update', 'other']) {
    assert.match(tags, new RegExp(`type: '${type}'`))
  }
  assert.doesNotMatch(tags, /type: 'profile_update'/, 'profile_update stays system-generated only, never a user-facing intent')
})

test('the Post composer opens directly to a blank writable body -- no up-front category-selection splash screen', () => {
  const postButton = slice(engagement, 'export function PostButton', '/* ------------------------------------------------------------------ Interests */')
  assert.doesNotMatch(postButton, /post-intent-grid|post-intent-option|What would you like to share\?/, 'the old category-first screen is gone')
  assert.match(postButton, /setStage\('compose'\)/)
  assert.match(postButton, /<textarea id="post-note" className="post-composer-body"/)
  assert.match(postButton, /useState<PostType>\(prefillIntent \?\? 'practice_update'\)/, 'a quiet default type is set so publishing never requires picking a category first (prefillIntent only applies when the agent-rail draft handoff supplies one)')
})

test('the composer has a lightweight Tag row (Practice/Research/Referral guidance/Teaching/More), plus optional Add image and Add paper/link controls', () => {
  const postButton = slice(engagement, 'export function PostButton', '/* ------------------------------------------------------------------ Interests */')
  assert.match(postButton, /<span className="post-tag-label">Tag<\/span>/)
  assert.match(postButton, /PRIMARY_POST_TAGS\.map/)
  assert.match(postButton, />More</)
  assert.match(postButton, /\+ Add image/)
  assert.match(postButton, /\+ Add paper\/link/)
})

test('Feed header spacing is tightened with a divider, not a large floating gap, before the first post', () => {
  assert.match(styles, /\.network-feed-tab-header \{[^}]*border-bottom: 1px solid var\(--border\)/)
  assert.match(styles, /\.network-feed-tab \.feed-stream \{[^}]*margin-top: 0;/)
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

/* ------------------------------------------------------- design-fidelity pass */

test('the sticky rail uses a callback ref, not useRef+useLayoutEffect, so it still attaches after the loading placeholder resolves', () => {
  const patientPage = slice(app, 'function PatientWorkspace', 'export default function App')
  assert.match(patientPage, /const nextStepRef = useCallback\(\(node: HTMLElement \| null\) => \{/)
  assert.doesNotMatch(patientPage, /useLayoutEffect\(/, 'a one-shot mount effect would observe a still-null ref while the loading branch is showing')
  assert.match(patientPage, /setNextStepPinned\(node\.offsetHeight <= availableHeight\)/)
})

test('AgentAvatar has a dark outline, white upper-left eyes/smile, and a perfect 1:1 aspect ratio', () => {
  const avatar = readFileSync(new URL('../src/AgentAvatar.tsx', import.meta.url), 'utf8')
  assert.match(avatar, /stroke="var\(--text-primary\)"/, 'a dark/near-black outline, per design_references/agent_profile_picture_example.png')
  assert.match(avatar, /viewBox="0 0 32 32" width="100%" height="100%"/, 'scales to any container while staying square')
  assert.match(avatar, /fill="#fff"/)
})

test('My Agent sidebar active state glows the avatar/label only -- no outline or fill around the whole tile', () => {
  assert.doesNotMatch(styles, /\.sidebar-clinician\.active \{[^}]*box-shadow/, 'the full row must not carry its own outline/glow')
  assert.doesNotMatch(styles, /\.sidebar-clinician\.active \{[^}]*border(?!-top-color: transparent)/, 'no border drawn around the whole tile')
  assert.match(styles, /\.sidebar-clinician\.active \.agent-avatar \{ box-shadow:/, 'the glow lives on the avatar')
  assert.match(styles, /\.sidebar-clinician\.active strong \{[^}]*text-shadow:/, 'and on the label text')
})

test('My Agent overview analytics reflect real network behavior (consultation records), not a representation-coverage bar', () => {
  const activity = slice(engagement, 'function AgentNetworkActivity', 'export function AgentOverviewPanel')
  assert.match(activity, /for \(const evaluation of record\.result\.consultation\)/, 'built from real per-consultation physician-agent evaluations')
  assert.match(activity, /agentNames\.add\(evaluation\.physician_name\)/)
  assert.match(activity, /specialtyCounts\.set\(evaluation\.specialty/)
  assert.doesNotMatch(engagement, /Representation coverage/i, 'the completion/coverage framing is gone')
  assert.doesNotMatch(styles, /agent-analytics-segment/, 'the stacked coverage bar CSS is gone, not just unused')
})

/* ----------------------------------------------------- Overview IA reorganization */

test('AgentAvatar\'s eyes sit on the same horizontal line -- no slant/rotation', () => {
  const avatar = readFileSync(new URL('../src/AgentAvatar.tsx', import.meta.url), 'utf8')
  const eyeYs = [...avatar.matchAll(/<circle cx="[\d.]+" cy="([\d.]+)" r="1\.7" fill="#fff"/g)].map((m) => m[1])
  assert.equal(eyeYs.length, 2, 'exactly two white eye dots')
  assert.equal(eyeYs[0], eyeYs[1], 'both eyes must share the same cy -- a slanted face is the exact bug being fixed')
  assert.doesNotMatch(avatar, /transform=/, 'no rotation transform anywhere in the mark')
})

test('the old top KPI-card row (Questions answered / Rules confirmed / Case interests / Network cases) is gone from Overview, not just restyled', () => {
  const panel = slice(engagement, 'export function AgentOverviewPanel', 'export type AgentActivityRow')
  assert.doesNotMatch(panel, /agent-stats-row/)
  assert.doesNotMatch(panel, /Questions answered/)
  assert.doesNotMatch(panel, /Case interests/)
  assert.doesNotMatch(styles, /\.agent-stats-row/, 'the KPI-card CSS is gone, not just unused')
})

test('Overview has exactly one training-reminder surface, with no separate duplicate setup CTA', () => {
  const panel = slice(engagement, 'export function AgentOverviewPanel', 'export type AgentActivityRow')
  assert.equal((panel.match(/<TrainingReminder/g) ?? []).length, 1)
  assert.doesNotMatch(panel, /<InitializationCard/, 'Overview no longer renders the separate setup card alongside the reminder')
})

test('the training reminder adapts its headline to real initialization state -- setup-oriented when incomplete, ongoing-teaching when initialized -- never fabricating counts, with no separate eyebrow label', () => {
  const reminder = slice(engagement, 'function TrainingReminderGlyph', 'function AgentNetworkActivity')
  assert.match(reminder, /const plan = agentBannerPlan\(overview\.training, trainPath\)/, 'reuses the real, state-driven CTA logic rather than inventing new copy')
  assert.match(reminder, /overview\.initialization\.initialized/)
  assert.match(reminder, /Build your agent's starting picture of your practice\./)
  assert.match(reminder, /Your agent keeps learning how you make referral and care decisions\./)
  assert.match(reminder, /\{plan\.support\}/, 'the supporting line is the real plan.support string, not a hardcoded fabricated count')
  assert.doesNotMatch(reminder, /<p className="eyebrow">/, 'no separate eyebrow focal point -- the headline alone carries the framing')
})

test('the training reminder is a single copper mini-hero card with a radiating-rings glyph, adapted from (not copying) the Dashboard banner technique', () => {
  const reminder = slice(engagement, 'function TrainingReminderGlyph', 'function AgentNetworkActivity')
  assert.match(reminder, /<TrainingReminderGlyph \/>/)
  assert.equal((reminder.match(/<section className="training-reminder">/g) ?? []).length, 2, 'one single surface per render path (up-to-date vs plan), never a split side box')
  assert.doesNotMatch(reminder, /className="training-reminder-action"/, 'no second bordered sub-panel like the Dashboard banner\'s .agent-banner-action')
  assert.match(styles, /\.training-reminder \{[^}]*border: 1px solid var\(--agent-copper-soft\)/, 'the semantic My Agent copper token, not a bespoke rgb() literal or the Dashboard banner\'s mineral/sage tones')
  assert.doesNotMatch(styles, /\.training-reminder \{[^}]*var\(--sage/, 'never the Dashboard banner\'s sage/mineral background')
  assert.match(styles, /\.training-reminder-ring \{[^}]*border: 1px solid var\(--agent-copper\)/, 'copper rings via the semantic token, adapted from .agent-banner-ring\'s mineral rings')
})

test('My Agent has its own semantic copper token system, separate from the global mineral/accent tokens', () => {
  assert.match(styles, /--agent-copper: #b66a45; --agent-copper-deep: #765044; --agent-copper-deep-hover: #634238;/)
  assert.match(styles, /--agent-copper-mid: #c58a6d; --agent-copper-soft: #e4c6b5; --agent-copper-surface: #f5ebe4; --agent-copper-ink: #714838;/)
})

test('My Agent primary buttons use the deep umber tone, not straight copper or the global mineral default -- scoped to .agent-page/.training-shell only', () => {
  assert.match(styles, /\.agent-page \.button-primary, \.training-shell \.button-primary \{\s*background: var\(--agent-copper-deep\); border-color: var\(--agent-copper-deep\);\s*\}/)
  assert.match(styles, /\.agent-page \.button-primary:hover, \.training-shell \.button-primary:hover \{\s*background: var\(--agent-copper-deep-hover\)/)
  const base = styles.slice(styles.indexOf('.consult-button, .button-primary {'), styles.indexOf('.consult-button, .button-primary {') + 400)
  assert.match(base, /var\(--mineral-deep\)/, 'the global default stays mineral for every other surface (Patient detail, Network, Dashboard quick-training modal)')
})

test('Overview specialty bars use the My Agent copper palette with tonal variation, not a single mineral fill', () => {
  assert.match(styles, /\.agent-specialty-bar-track \{[^}]*background: var\(--agent-copper-surface\)/)
  assert.match(styles, /\.agent-specialty-bar-fill \{[^}]*background: var\(--agent-copper-mid\)/)
  assert.match(styles, /\.agent-specialty-bar-fill\.top-ranked \{ background: var\(--agent-copper-deep\); \}/, 'the top-ranked specialty gets a deeper tone, not every bar painted identically')
  assert.match(engagement, /className=\{`agent-specialty-bar-fill \$\{index === 0 \? 'top-ranked' : ''\}`\}/)
  assert.doesNotMatch(styles, /\.agent-specialty-label \{[^}]*var\(--agent-copper/, 'specialty name labels stay normal dark text, not copper')
})

test('the active My Agent tab uses copper, not the mineral/mineral-surface treatment used for the shared primary nav', () => {
  assert.match(styles, /\.agent-tabs button\.active \{ border-color: var\(--agent-copper\); color: var\(--agent-copper-ink\); \}/)
})

test('the Train overlay (My Agent -> Train) uses copper accents for progress, selection, and labels, scoped to .training-shell so the Dashboard quick-training modal is untouched', () => {
  assert.match(styles, /\.training-shell \.training-progress-bar > span \{ background: var\(--agent-copper\); \}/)
  assert.match(styles, /\.training-shell \.training-choice-plain\.selected \{ border-color: var\(--agent-copper\); background: var\(--agent-copper-surface\); color: var\(--agent-copper-ink\); \}/)
  assert.doesNotMatch(styles, /\.training-modal \.training-progress-bar/, 'the Dashboard quick-training modal (.training-modal, a different wrapper) is never retargeted')
})

test('the agent avatar stays blue even inside the copper-themed My Agent environment', () => {
  assert.match(styles, /\.agent-avatar-blue \{ color: var\(--mineral\); \}/)
  assert.doesNotMatch(styles, /\.agent-avatar-blue \{ color: var\(--agent-copper/, 'the avatar fill itself must never become copper')
  const avatar = readFileSync(new URL('../src/AgentAvatar.tsx', import.meta.url), 'utf8')
  assert.doesNotMatch(avatar, /agent-copper/, 'the avatar component has no copper references at all')
})

test('the detailed practice-representation band still exists after the network band, with its own heading', () => {
  const panel = slice(engagement, 'export function AgentOverviewPanel', 'export type AgentActivityRow')
  assert.match(panel, /How your agent currently represents your practice/)
  assert.match(panel, /<PracticeTab representation=\{representation\}/)
})

test('practice rules keep an editable action, and "Looks right" never renders without a real backing confirm action', () => {
  const ruleRow = slice(engagement, 'function RuleRow', 'export function PracticeTab')
  assert.match(ruleRow, /onClick=\{\(\) => navigate\(trainPath\)\}>Adjust/, 'Adjust is always available')
  assert.match(ruleRow, /\{onAgree &&/, '"Looks right" only renders when a real onAgree handler was supplied')
  const practiceTab = slice(engagement, 'export function PracticeTab', 'function trainHistorySummaryLine')
  assert.match(practiceTab, /onAgree=\{item\.source_type === 'training_response' \? \(\) => agree\(item\.id\) : undefined\}/, 'only training-derived learnings (a real proposed-learning id) get the confirm action')
})

test('Dashboard Recent activity / Recent network uses a 2fr/1fr split, consistent with the richer content in Recent activity', () => {
  assert.match(styles, /\.dashboard-bottom-row \{ display: grid; grid-template-columns: 2fr 1fr;/)
  assert.match(styles, /@media \(max-width: 900px\) \{ \.dashboard-bottom-row \{ grid-template-columns: 1fr; \} \}/, 'still stacks responsively below the breakpoint')
})

test('the sidebar My Agent avatar renders blue, not grey -- the generic text-label span rule must not override the avatar\'s own color', () => {
  assert.doesNotMatch(styles, /\.sidebar-clinician span \{[^}]*color: var\(--text-secondary\)/, 'the old unscoped rule caught the avatar span too (0,1,1 beats .agent-avatar-blue\'s 0,1,0) and painted it grey')
  assert.match(styles, /\.sidebar-clinician span:not\(\.agent-avatar\) \{ color: var\(--text-secondary\)/, 'the text-label color rule explicitly excludes the one unified avatar component')
  assert.match(styles, /\.agent-avatar-blue \{ color: var\(--mineral\); \}/)
})

/* -------------------------------------------------------- Network growth + Feed */

test('main sidebar icons (Dashboard/Patients/Network) are dark charcoal text, not mineral-blue or copper (polish pass, Part A: the muted mineral tone read as washed-out)', () => {
  assert.match(styles, /\.nav-icon \{ width: 24px; color: var\(--text-primary\); font-size: 1\.05rem; text-align: center; \}/)
  assert.doesNotMatch(styles, /\.nav-icon \{ width: 24px; color: var\(--accent\)/)
  assert.doesNotMatch(styles, /\.nav-icon \{ width: 24px; color: var\(--mineral\)/)
})

test('the Network sidebar icon is still the people/group mark, and inherits the restored mineral color via currentColor', () => {
  assert.match(app, /icon: <NetworkNavIcon \/>/)
  const icon = slice(app, 'function NetworkNavIcon', 'const navItems')
  assert.match(icon, /stroke="currentColor"/)
})

test('My Agent\'s own copper theme is untouched by the sidebar icon color revert (scoped overrides, not the shared .nav-icon rule)', () => {
  assert.match(styles, /\.agent-page \.button-primary, \.training-shell \.button-primary \{/)
  assert.match(styles, /\.agent-tabs button\.active \{ border-color: var\(--agent-copper\)/)
})

test('the Network hero is restructured as ONE continuous surface (copy + decorative motif + a white inset action card), a Network-specific sibling of the Dashboard banner shape (not a literal copy) -- see design_references/dash_banner.png', () => {
  const hero = slice(network, 'function NetworkHero', 'function SuggestedConnectionCard')
  assert.match(hero, /<h2>Grow your Lamina network\.<\/h2>/)
  assert.match(hero, /<h3>Search and add your colleagues\.<\/h3>/)
  assert.match(hero, /Find physicians you already work with\./)
  assert.match(hero, /<button className="button-primary" onClick=\{onAdd\}>Add a colleague/, 'the existing add-colleague modal CTA, unchanged behavior')
  assert.doesNotMatch(hero, /<img\b/, 'no stock photography -- CSS/SVG only')
  assert.match(styles, /\.network-hero \{ position: relative; display: flex;/, 'one flex surface, not a 2-column grid with a separately-colored sub-pane')
})

test('the network globe motif is a composed wireframe globe (one sphere silhouette + unrotated latitude/longitude grid sharing its center, only the whole group tilts), with purposeful routing arcs between specific node pairs -- not scattered random lines/circles -- mineral-toned with one copper "you" node, no literal map/airline-route imagery -- reinterpreting design_references/map_guidance_banner.png', () => {
  const hero = slice(network, 'function NetworkHero', 'function SuggestedConnectionCard')
  const nodeCount = (hero.match(/className="globe-node/g) ?? []).length
  const arcCount = (hero.match(/className="globe-arc/g) ?? []).length
  const gridCount = (hero.match(/className="globe-ring"/g) ?? []).length
  assert.ok(nodeCount >= 5 && nodeCount <= 8, `expected 5-8 nodes, found ${nodeCount}`)
  assert.ok(arcCount >= 3 && arcCount <= 5, `expected 3-5 arcs, found ${arcCount}`)
  assert.match(hero, /<circle className="globe-sphere" cx="120" cy="120" r="84" \/>/, 'one sphere silhouette, the recognizable globe structure')
  assert.ok(gridCount >= 4, 'a latitude/longitude grid, not just arcs floating in space')
  assert.doesNotMatch(hero, /transform="rotate/, 'grid lines are never individually rotated -- that is what made the previous version read as scattered ovals rather than one sphere')
  assert.match(hero, /className="globe-arc dashed"/, 'at least one dashed route for texture, not every path identical')
  assert.match(styles, /\.globe-tilt \{ transform: rotate\(-11deg\)/, 'the whole composed sphere tilts as one group')
  assert.match(styles, /\.globe-node\.hub \{ fill: var\(--accent\); opacity: 1; \}/, 'exactly one copper "you" node; the rest are mineral')
  assert.doesNotMatch(hero, /usa|united-states|map|airline/i)
})

test('the globe motif is anchored near the hero\'s horizontal center, not hidden behind the white action card at the far right', () => {
  assert.match(styles, /\.network-hero-globe-art \{ position: absolute; left: 47%;/)
  assert.doesNotMatch(styles, /\.network-hero-globe-art \{ position: absolute; right:/)
})

test('Suggested connections exists below the hero as a 3-up card grid (not rows), shows ~3 by default with a local expand, a filled primary Add action, and never fabricates a reason', () => {
  assert.match(network, /function SuggestedConnections/)
  assert.match(network, /const visible = expanded \? suggestions : suggestions\.slice\(0, 3\)/)
  assert.match(network, /People your agent thinks you should know/)
  const card = slice(network, 'function SuggestedConnectionCard', 'function SuggestedConnections')
  assert.match(card, /\[showReason, setShowReason\] = useState\(false\)/, 'the reason is a compact disclosure, not shown by default')
  assert.match(card, /onClick=\{\(\) => setShowReason/)
  assert.match(card, /\{showReason && <p className="suggestion-reason">\{suggestion\.reason\}<\/p>\}/)
  assert.match(card, /<button className="button-primary suggestion-add" disabled=\{busy\} onClick=\{onAdd\}>Add/, 'a real, filled primary Add action')
  assert.match(styles, /\.suggestion-grid \{ display: grid; grid-template-columns: repeat\(3, 1fr\);/, '3-up on desktop')
})

test('a consultation-driven suggestion reason is represented honestly -- real relationship data only, never a fabricated mutual-colleague count', () => {
  const builder = slice(network, 'function buildSuggestions', 'const statusCopy')
  assert.match(builder, /if \(node\.in_network \|\| seen\.has\(node\.npi\) \|\| !node\.relationship\) continue/, 'only physicians the agent actually has a relationship record for')
  assert.match(builder, /Recently connected through \$\{last_recommendation_patient_name\}'s consultation\./)
  assert.doesNotMatch(builder, /mutual|Math\.random|Math\.floor\(Math\.random/i, 'no fabricated mutual-colleague count or random number')
})

test('no generic Network KPI/analytics block was added -- My Agent already owns network-behavior analytics', () => {
  const tab = slice(network, 'export function MyNetworkTab', 'export function PhysicianProfilePage')
  assert.doesNotMatch(tab, /specialties ·|consultations ·|physicians ·/i)
  assert.doesNotMatch(styles, /\.network-kpi/)
})

test('every suggested connection resolves to a real profile -- the directory page, when there is no public-agent profile -- never a dead link', () => {
  const card = slice(network, 'function SuggestedConnectionCard', 'function SuggestedConnections')
  assert.doesNotMatch(card, /\{persona && <button/, 'the View profile link must not be conditionally omitted')
  assert.match(card, /navigate\(persona \? networkProfilePath\('lucy', persona\) : `\/network\/\$\{suggestion\.npi\}`\)/)
})

test('the "not yet on Lamina" directory page never implies an agent exists before the physician has joined, and the card has no grey eyebrow label at all', () => {
  const page = slice(network, 'export function PhysicianProfilePage', network.length)
  assert.doesNotMatch(page, /Lamina Agent/)
  assert.doesNotMatch(page, /Lamina status/)
  const card = slice(page, 'className="agent-activation-card"', '</section>')
  assert.doesNotMatch(card, /className="eyebrow"/, 'no eyebrow above "Not yet on Lamina" -- the card reads as just the headline, detail, and CTA')
})

test('a physician profile offers a real add/remove-network action, never a "Consult Network" CTA -- consultation stays patient-context-driven', () => {
  const page = slice(network, 'export function PhysicianProfilePage', network.length)
  assert.match(page, /<NetworkRelationshipAction npi=\{profile\.npi\} relationship=\{relationship\} \/>/)
  assert.doesNotMatch(page, /Return to Consult Network|Consult Network<\/button>/)
})

test('the "not yet on Lamina" card and the clinical-boundary card both give their copy room to breathe', () => {
  assert.match(styles, /\.agent-activation-card > \.button-primary, \.agent-activation-card > \.button-secondary \{ margin-top: 22px; \}/)
  assert.match(styles, /\.consult-boundary-card \{[^}]*padding: 22px;/)
  assert.match(styles, /\.consult-boundary-card p:last-child \{[^}]*margin-top: 10px/)
})

test('the existing "Most connected in your network" colleague list, View physician action, and See all colleagues are preserved unchanged', () => {
  const tab = slice(network, 'export function MyNetworkTab', 'export function PhysicianProfilePage')
  assert.match(tab, /Most connected in your network/)
  assert.match(tab, /See all colleagues ↓/)
  assert.match(network, /View physician <b>→<\/b>/)
  assert.doesNotMatch(tab, /specialty group|groupBy.*specialty/i, 'never reverted to specialty grouping')
})

test('Feed evolves into a two-column desktop layout -- main feed (2fr) + a narrow agent-assist rail (~0.85fr) -- and the feed stays visually dominant', () => {
  assert.match(styles, /\.feed-layout \{ display: grid; grid-template-columns: 2fr minmax\(240px, \.85fr\); align-items: start; gap: 32px; \}/)
  assert.match(engagement, /<div className="feed-stream">/)
  assert.match(engagement, /<AgentAssistRail personaId=\{personaId\} onPublished=\{/)
})

test('the Post affordance is sticky in the Feed rail -- a dedicated card, first in the (position: sticky) rail, so posting stays reachable while scrolling, not stranded in the page header', () => {
  assert.match(styles, /\.agent-assist-rail \{ position: sticky; top: 76px;/)
  const rail = slice(engagement, 'function AgentAssistRail', 'export function NetworkFeedTab')
  assert.match(rail, /<section className="agent-assist-card agent-assist-post-card">/)
  assert.match(rail, /<PostButton personaId=\{personaId\} triggerLabel="Post" compact=\{false\} buttonClassName="button-primary agent-assist-post-trigger" onPublished=\{onPublished\} \/>/)
  assert.doesNotMatch(engagement, /<PostButton personaId=\{personaId\} triggerLabel="Post" compact=\{false\} onPublished=\{\(post\) => \{ onPublished/, 'the old header Post button is gone, not duplicated')
  assert.match(engagement, /The rail \(and its sticky Post action\) renders whenever the feed has/, 'the rail (and its Post card) still renders even with zero real feed items')
})

test('the agent-assist rail offers draft ideas (not KPIs), each opening a modal on Preview, plus lightweight local posting-preference chips -- no autonomous-post toggle anywhere', () => {
  const rail = slice(engagement, 'function AgentAssistRail', 'export function NetworkFeedTab')
  assert.match(rail, /Your agent can help you share/)
  assert.match(rail, /onClick=\{\(\) => setPreviewId\(draft\.id\)\}>Preview →/)
  assert.match(rail, /What should your agent watch for\?/)
  assert.match(rail, /POSTING_WATCH_TOPICS\.map/)
  assert.doesNotMatch(engagement, /Automatically post for me/i)
  assert.doesNotMatch(rail, /type="checkbox"|<input/i, 'no toggle control of any kind in the rail')
})

test('posting-preference chips are frontend-local state only, never implying server persistence', () => {
  const rail = slice(engagement, 'function AgentAssistRail', 'export function NetworkFeedTab')
  assert.match(rail, /const \[watching, setWatching\] = useState<string\[\]>/)
  assert.doesNotMatch(rail, /await (fetch|save|update|post)/i)
})

test('Draft preview opens a modal (reusing the existing post-flow-overlay/dialog language), shows the full draft + tag + provenance, and "Post" hands off into the real compose/draft/publish pipeline rather than a fake posting path', () => {
  const modal = slice(engagement, 'function DraftIdeaPreviewModal', 'function AgentAssistRail')
  assert.match(modal, /className="post-flow-overlay"/)
  assert.match(modal, /className="post-flow-dialog draft-preview-dialog"/)
  assert.match(modal, /Drafted by your agent/)
  assert.match(modal, /Based on your confirmed practice representation and recent network activity\./)
  assert.match(modal, /<PostButton personaId=\{personaId\} prefillNote=\{body\} prefillIntent=\{draft\.tagType\} triggerLabel="Post" buttonClassName="button-primary" onOpen=\{onClose\} \/>/, 'Post is literally the real PostButton trigger, prefilled')
})

test('agent-authored feed posts are clearly labeled AGENT and never presented as though the physician wrote them, while physician posts render exactly as before', () => {
  assert.match(engagement, /AGENT_FEED_POSTS: FeedListItem\[\]/)
  assert.match(engagement, /isAgentAuthored: true, representedPhysicianName: 'Dr\. Chris Mithel'/)
  assert.match(engagement, /isAgentAuthored: true, representedPhysicianName: 'Dr\. Iain Jung'/)
  const card = slice(engagement, 'function FeedCard', "/** Home's tiny network preview")
  assert.match(card, /<span className="feed-post-agent-badge">Agent<\/span>/)
  assert.match(card, /representing \$\{item\.representedPhysicianName\}/)
  assert.match(card, /item\.isAgentAuthored\s*\n\s*\? <span className="feed-post-agent-avatar"><AgentAvatar tone=\{item\.agentTone\} \/><\/span>/, 'the agent avatar (sized down via .feed-post-agent-avatar) renders instead of physician initials for agent posts')
})

test('agent-authored posts use varied, restrained Lamina-palette avatar tones (not every agent painted identically), and the icon itself is sized down from the default, never visually dominant', () => {
  const avatar = readFileSync(new URL('../src/AgentAvatar.tsx', import.meta.url), 'utf8')
  assert.match(engagement, /agentTone: 'copper-light'/)
  // Both fixture posts are specialists (Chris/Iain), so both are copper-family --
  // a distinct shade each (copper-light vs copper), never painted identically,
  // and never blue (blue is reserved for the PCP/Lucy family, see agentTone()).
  assert.match(engagement, /agentTone: 'copper'/)
  assert.match(styles, /\.feed-post-agent-avatar \{ display: block; width: 26px; height: 26px; flex: 0 0 26px; \}/, 'smaller than the 36px physician-initials avatar it stands beside')
  assert.match(avatar, /export type AgentAvatarTone = 'blue' \| 'blue-light' \| 'copper' \| 'copper-light'/)
  assert.match(styles, /\.agent-avatar-blue-light \{ color: var\(--mineral-subtle\); \}/)
  assert.match(styles, /\.agent-avatar-copper \{ color: var\(--agent-copper\); \}/)
  assert.match(styles, /\.agent-avatar-copper-light \{ color: var\(--agent-copper-mid\); \}/)
})

test('agent-authored posts carry enough body text to always trigger See more truncation -- real previewable posts, not placeholder blurbs', () => {
  const posts = slice(engagement, 'const AGENT_FEED_POSTS: FeedListItem[] = [', ']\n\ntype DraftIdea')
  const bodies = [...posts.matchAll(/body: "([^"]+)"/g)].map((m) => m[1])
  assert.equal(bodies.length, 2)
  for (const body of bodies) assert.ok(body.length > 220, `agent post body must exceed the 220-char See-more threshold (got ${body.length})`)
})

test('agent-authored posts use a quiet mineral accent, never copper -- Feed stays in the Network/mineral palette even for agent content', () => {
  assert.match(styles, /\.feed-post-agent-badge \{[^}]*color: var\(--mineral-deep\)/)
  assert.doesNotMatch(styles, /\.feed-post-agent-badge \{[^}]*var\(--agent-copper/)
})

test('the agent rail stacks below the feed on tablet/mobile with no horizontal overflow', () => {
  assert.match(styles, /@media \(max-width: 900px\) \{\s*\.feed-layout \{ grid-template-columns: 1fr; \}\s*\.agent-assist-rail \{ position: static; \}\s*\}/)
})

/* =====================================================================
 * Pre-NLP physician-representation cleanup pass, Part J-Q: "Ask their
 * agent" -- a general, non-patient-specific question from an eligible
 * Network physician profile.
 * ===================================================================== */

test('unclaimed/external-directory physicians (Okonkwo, Okafor) never expose "Ask their agent" -- that trigger only exists inside NetworkPhysicianProfilePage, which they are structurally never reachable through (they use PhysicianProfilePage/the directoryProfile branch instead)', () => {
  const network = readFileSync(new URL('../src/PhysicianNetwork.tsx', import.meta.url), 'utf8')
  assert.doesNotMatch(network, /Ask their agent|askNetworkAgent|NetworkAskAgentModal/, 'PhysicianProfilePage (Okonkwo\'s NPI-directory page, Okafor\'s directoryProfile page) never gains this CTA')
})

test('eligible claimed/trained physicians (reachable via NetworkPhysicianProfilePage) get a quiet "Ask their agent" action -- never the primary CTA', () => {
  const page = slice(engagement, 'export function NetworkPhysicianProfilePage', engagement.length)
  assert.match(page, /Ask their agent →/)
  assert.match(page, /className="text-button ask-network-agent-trigger"/)
  // NetworkRelationshipAction ("Add to network") renders first/above --
  // the quiet ask-agent trigger is a secondary action alongside it, never
  // replacing or outranking it.
  assert.match(page, /<NetworkRelationshipAction npi=\{data\.physician\.npi\} relationship=\{relationship\} \/>/)
})

test('the Ask-their-agent action is hidden while previewing your OWN public profile', () => {
  const page = slice(engagement, 'export function NetworkPhysicianProfilePage', engagement.length)
  assert.match(page, /\{!isPreview && <button type="button" className="text-button ask-network-agent-trigger"/)
})

test('no patient context is required or sent -- askNetworkAgent posts only {question} to a controlled-physician-scoped endpoint, no patient/referral identifier anywhere in the call', () => {
  const apiSource = readFileSync(new URL('../src/api.ts', import.meta.url), 'utf8')
  assert.match(apiSource, /export const askNetworkAgent = \(controlledId: string, question: string\) => request<CoordinationChatAnswer>\(`\/api\/workspace\/network\/physicians\/\$\{encodeURIComponent\(controlledId\)\}\/ask`/)
  assert.match(apiSource, /body: JSON\.stringify\(\{ question \}\)/)
})

test('the Network agent chat is ephemeral -- bounded local component state only, no persistence, no fetch-on-mount to restore prior messages (reload clears it)', () => {
  const modalFn = engagement.slice(engagement.indexOf('function NetworkAskAgentModal'), engagement.indexOf('export function NetworkPhysicianProfilePage'))
  assert.match(modalFn, /const \[messages, setMessages\] = useState<NetworkAgentChatMessage\[\]>\(\[\]\)/)
  assert.doesNotMatch(modalFn, /localStorage|sessionStorage|useEffect\(\(\) => \{[^}]*getA/s)
})

test('unsupported/unconfirmed physician preferences surface an honest uncertainty note, never a fabricated answer', () => {
  const modalFn = engagement.slice(engagement.indexOf('function NetworkAskAgentModal'), engagement.indexOf('export function NetworkPhysicianProfilePage'))
  assert.match(modalFn, /\{message\.unconfirmed && <p className="chat-uncertainty">Not yet confirmed by \{physicianName\}\.<\/p>\}/)
})

test('the scope-limiting helper copy is present, and the modal never creates a referral or mutates any clinical record', () => {
  const modalFn = engagement.slice(engagement.indexOf('function NetworkAskAgentModal'), engagement.indexOf('export function NetworkPhysicianProfilePage'))
  assert.match(modalFn, /General practice questions only\. No patient context is shared\./)
  assert.doesNotMatch(modalFn, /createReferral|ingestConsultationEncounter|sendHandoff/)
})

/* =====================================================================
 * Pre-NLP physician-representation cleanup pass, Part R-T: training cards
 * support going back and revising an answer, with branch invalidation.
 * ===================================================================== */

test('Back is unavailable on the first question, in both the full and quick training flows', () => {
  const fullPage = engagement.slice(engagement.indexOf('export function TrainingPage'), engagement.indexOf('/* ------------------------------------------------------------- Profile: shared */'))
  assert.match(fullPage, /\{index > 0 && <button type="button" className="text-button training-back-button" disabled=\{busy\} onClick=\{goBack\}>← Back<\/button>\}/)
  const quickModal = engagement.slice(engagement.indexOf('function QuickTrainingModal'), engagement.indexOf('// Confirmed practice-representation values'))
  assert.match(quickModal, /\{index > 0 && <button type="button" className="text-button training-back-button" disabled=\{busy\} onClick=\{goBack\}>← Back<\/button>\}/)
})

test('goBack returns to the immediately previous TOP-LEVEL question (skipping branch/follow-up questions), truncates the queue, and restores the prior typed/selected answer -- in both flows', () => {
  for (const [start, end] of [
    ['export function TrainingPage', '/* ------------------------------------------------------------- Profile: shared */'],
    ['function QuickTrainingModal', '// Confirmed practice-representation values'],
  ]) {
    const fn = engagement.slice(engagement.indexOf(start), engagement.indexOf(end))
    const goBackFn = fn.slice(fn.indexOf('const goBack = () => {'), fn.indexOf('const trainTenMore') === -1 ? fn.length : fn.indexOf('const trainTenMore'))
    assert.match(goBackFn, /if \(index === 0 \|\| busy\) return/, 'never navigates before the first question')
    assert.match(goBackFn, /while \(newIndex > 0 && queue\[newIndex\]\.branch_depth > 0\) newIndex--/, 'skips back over branch/follow-up questions to the previous TOP-LEVEL question')
    assert.match(goBackFn, /setQueue\(\(prev\) => prev\.slice\(0, newIndex \+ 1\)\)/, 'truncates the queue -- stale downstream branch questions are dropped')
    assert.match(goBackFn, /setMultiSelected\(Array\.isArray\(prior\) \? prior : \[\]\)/, 'restores a prior multi_select answer')
    assert.match(goBackFn, /setTextAnswer\(target\.question_type === 'short_text' && typeof prior === 'string' \? prior : ''\)/, 'restores a prior short_text answer')
  }
})

test('re-answering a changed question updates in place (answersById keyed by question id) and the single_choice UI highlights the previously-given answer, never a duplicate/fresh-blank state', () => {
  const fullPage = engagement.slice(engagement.indexOf('export function TrainingPage'), engagement.indexOf('/* ------------------------------------------------------------- Profile: shared */'))
  assert.match(fullPage, /if \(!skipped && answer !== null\) setAnswersById\(\(prev\) => \(\{ \.\.\.prev, \[current\.id\]: answer \}\)\)/)
  assert.match(fullPage, /className=\{`training-choice-plain \$\{answersById\[current\.id\] === option \? 'selected' : ''\}`\}/)
})
