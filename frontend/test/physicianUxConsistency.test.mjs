/* Physician UX consistency + NLP pass: one shared Network page for every
 * claimed physician, Ask the Network breathing room, the inline change
 * highlight, the Recent Specialty Care episode row, and proposal UX. */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'

const read = (path) => readFileSync(new URL(path, import.meta.url), 'utf8').replaceAll(String.fromCharCode(13), '')
const app = read('../src/App.tsx')
const network = read('../src/PhysicianNetwork.tsx')
const networkQuery = read('../src/NetworkQuery.tsx')
const referral = read('../src/Referral.tsx')
const specialist = read('../src/Specialist.tsx')
const preferences = read('../src/ReferralPreferences.tsx')
const engagement = read('../src/Engagement.tsx')
const api = read('../src/api.ts')
const styles = read('../src/styles.css')
const slice = (source, from, to) => source.slice(source.indexOf(from), to === undefined ? undefined : source.indexOf(to, source.indexOf(from)))
const sharedPage = () => slice(network, 'export function PhysicianNetworkPage', '/** UX polish pass, Part A/B')
const colleagues = () => slice(network, 'export function MyNetworkTab', 'export function PhysicianNetworkPage')
const routes = () => slice(app, 'export default function App', app.length)

/* ------------------------------------------------------------- NETWORK 1-7 */

test('Saruhashi, Chen, and Iain all render the ONE shared Network page -- no identity-specific page forks remain', () => {
  for (const [path, perspective] of [['/network', 'lucy'], ['/chen/network', 'chen'], ['/specialist/network', 'iain']]) {
    assert.match(routes(), new RegExp(`path === '${path.replaceAll('/', '\\/')}'\\)[^\\n]*<PhysicianNetworkPage perspective="${perspective}" navigate=\\{navigate\\} params=\\{params\\} />`), path)
  }
  assert.doesNotMatch(app, /function LucyNetworkPage/)
  assert.doesNotMatch(referral, /function ChenNetworkPage|function ChenMyNetworkTab/)
  assert.doesNotMatch(specialist, /function SpecialistNetworkPage|function SpecialistMyNetworkTab/)
})

test('the shared page has Colleagues and Feed tabs and defaults to Colleagues', () => {
  const page = sharedPage()
  assert.match(page, /<NetworkTabs tab=\{tab\} onSelect=\{selectTab\} \/>/)
  assert.match(page, /useState<NetworkTab>\(tabParam === 'feed' \? 'feed' : 'my-network'\)/)
  assert.match(page, /<MyNetworkTab navigate=\{navigate\} perspective=\{perspective\} onViewInFeed=\{viewInFeed\} \/>/)
  assert.match(page, /<NetworkFeedTab personaId=\{perspective\}/)
})

test('every physician gets Grow your Lamina network, Add a colleague, suggestions, and Ask the Network through the same components', () => {
  const tab = colleagues()
  assert.match(tab, /<NetworkHero onAdd=\{\(\) => setAddOpen\(true\)\} \/>/)
  assert.match(tab, /<SuggestedConnections suggestions=\{suggestions\} navigate=\{navigate\} perspective=\{perspective\}/)
  assert.match(tab, /<ActiveNetworkRail navigate=\{navigate\} perspective=\{perspective\}/)
  assert.match(tab, /<AddColleagueModal navigate=\{navigate\} perspective=\{perspective\}/)
  assert.match(network, /<h2>Grow your Lamina network\.<\/h2>/)
  assert.match(slice(network, 'function SuggestedConnections', 'function AddColleagueModal'), /<SuggestedConnectionCard/)
  assert.match(networkQuery, /<AskNetworkCard navigate=\{navigate\} perspective=\{perspective\}/)
})

test('physician identity changes data only: the roster, suggestions, routes, and patient context -- never the layout', () => {
  assert.match(colleagues(), /getAgentNetwork\(perspective\)/)
  assert.match(network, /const CURATED_SUGGESTIONS: Record<DemoPhysicianPerspective, SuggestedConnection\[\]> = \{/)
  for (const perspective of ['lucy:', 'chen:', 'iain:']) assert.ok(slice(network, 'const CURATED_SUGGESTIONS', '/** Real, consultation-derived').includes(perspective))
  assert.match(network, /export const networkBasePath = \(perspective: DemoPhysicianPerspective\)/)
  assert.doesNotMatch(colleagues(), /perspective === '(chen|lucy|iain)'/, 'no identity branches inside the shared Colleagues layout')
  assert.match(networkQuery, /const askablePatients = \(perspective: DemoPhysicianPerspective\)/)
  assert.match(api, /JSON\.stringify\(\{ question, patient_id: patientId, perspective \}\)/)
})

test('profile links from the shared Network stay inside the viewer\'s own shell', () => {
  assert.doesNotMatch(network, /networkProfilePath\('lucy'/)
  assert.doesNotMatch(networkQuery, /networkProfilePath\('lucy'/)
  assert.match(routes(), /const chenNetworkNpi = path\.match\(\/\^\\\/chen\\\/network\\\/\(\\d\+\)\$\/\)/)
  assert.match(routes(), /<PhysicianProfilePage npi=\{chenNetworkNpi\} navigate=\{navigate\} perspective="chen" \/>/)
})

test('Ask the Network has intentional layout spacing below the banner, keeping the rail sticky', () => {
  assert.match(styles, /\.network-hero \+ \.network-colleagues-layout \{ margin-top: 30px; \}/)
  assert.match(styles, /\.network-colleagues-main > \.suggested-connections:first-child \{ margin-top: 0; \}/)
  assert.match(styles, /\.network-colleagues-layout \.active-network-rail \{ position: sticky; top: 76px; \}/)
  assert.doesNotMatch(slice(styles, '.active-network-rail {', '}'), /transform|position: absolute/)
})

/* ----------------------------------------------------------- PATIENT 8-15 */

test('changed clinical text uses an inline highlighter treatment, not a boxed row', () => {
  const rule = slice(styles, '.change-highlight {', '}')
  assert.match(rule, /padding: 2px 5px/)
  assert.match(rule, /margin: -2px -5px/)
  assert.match(rule, /box-decoration-break: clone/, 'wrapped lines each get their own padded highlight')
  assert.match(rule, /border-radius: 3px/)
  const keyframes = slice(styles, '@keyframes medication-row-wash {', '\n}')
  assert.match(keyframes, /background-color: var\(--change-highlight\)/)
  assert.doesNotMatch(keyframes, /box-shadow/, 'no inset border box')
  assert.match(styles, /--change-highlight: rgba\(83, 110, 125, \.16\)/)
  assert.match(app, /<div className="medication-row-text">\s*\n\s*\{change && medicationHighlight \? <mark className="change-highlight medication-row-highlight">\{text\}<\/mark> : text\}/)
  // Never a direct <span> child of the list item: `.clinical-list li > span` is the bullet-dot rule.
  assert.doesNotMatch(slice(app, '<h3>Current medications</h3>', 'discontinued'), /<li key=\{item\}>\s*\n\s*<span/)
})

test('the collapsed Recent Specialty Care row is one vertically centered flex row', () => {
  assert.match(styles, /\.specialty-episode-summary \{ display: flex; align-items: center; gap: 12px; min-height: 44px;/)
  assert.match(styles, /\.specialty-episode-identity \{ display: inline-flex; align-items: center;/)
  assert.match(styles, /\.specialty-episode-summary \.status-label \{ display: inline-flex; align-items: center; line-height: 1; \}/)
  assert.match(styles, /\.specialty-episode-chevron \{ display: inline-grid; place-items: center;/)
})

test('Chen\'s avatar and name in the episode open his public network profile without toggling the episode', () => {
  const summary = slice(referral, '<summary className="specialty-episode-summary">', '</summary>')
  assert.match(summary, /className="specialty-episode-avatar directory-avatar"/)
  assert.match(summary, /physicianInitials\(receivingPhysicianName\)/)
  const handlers = summary.match(/onClick=\{\(event\) => \{ event\.preventDefault\(\); event\.stopPropagation\(\); onViewReceivingProfile\(\) \}\}/g) ?? []
  assert.equal(handlers.length, 2, 'avatar and name both cancel the summary toggle')
  assert.match(summary, /aria-label=\{`View \$\{receivingPhysicianName\}'s profile`\}/)
  assert.match(app, /onViewReceivingProfile=\{ROUTING_PHYSICIAN_PERSONA\[selected\.physician_id\]\s*\n\s*\? \(\) => navigate\(`\$\{networkProfilePath\('lucy', ROUTING_PHYSICIAN_PERSONA\[selected\.physician_id\]\)\}\?back=/)
  assert.match(routes(), /backPath=\{safeBackPath\(params, '\/home'\)\} perspective="lucy"/)
  assert.match(app, /return back && back\.startsWith\('\/'\) && !back\.startsWith\('\/\/'\) \? back : fallback/)
})

test('profile and Ask agent stay separate affordances; the episode chat is unchanged', () => {
  const episode = slice(referral, '<div className="specialty-episode-section">', '{modals}')
  assert.match(episode, /<CoordinationChatCard/)
  assert.doesNotMatch(slice(episode, '<summary', '</summary>'), /CoordinationChatCard|setChat/)
})

test('the expanded episode has clear spacing around the nested Ask agent card', () => {
  assert.match(styles, /\.specialty-episode-detail \{ margin-top: 14px; padding: 0 0 20px 42px; \}/)
  assert.match(styles, /\.specialty-episode-detail \.coordination-chat-card \{ margin-top: 24px; \}/)
})

/* --------------------------------------------------------------- NLP 16, 28 */

test('a proposal names its case family and separates what it adds from guidance it keeps', () => {
  const review = slice(preferences, 'export function PreferenceDraftReview', '/** Placeholder and example')
  assert.match(preferences, /type_2_diabetes: 'Diabetes referrals'/)
  assert.match(review, /CASE_FAMILY_LABELS\[draft\.case_family\]/)
  assert.match(review, /splitAgainstConfirmed\(draft\.structured_rules, draft\.supersedes_id \? null : confirmedInFamily\)/)
  assert.match(review, /Already part of how your agent represents you:/)
})

test('an empty (or no-op) interpretation can never be confirmed from the proposal', () => {
  const review = slice(preferences, 'export function PreferenceDraftReview', '/** Placeholder and example')
  assert.match(review, /const nothingToConfirm = isEmptyInterpretation\(draft\.structured_rules\) \|\| \(keptLabels\.length > 0 && isEmptyInterpretation\(added\)\)/)
  assert.match(review, /\{!nothingToConfirm && <button type="button" className="button-primary" disabled=\{busy\} onClick=\{\(\) => void confirm\(\)\}>Looks right<\/button>\}/)
  assert.match(review, />Edit interpretation</)
  assert.match(review, />Start over</)
})

test('confirmed learnings remain editable through the one existing edit flow', () => {
  assert.match(engagement, /\{item\.status === 'confirmed' && <button type="button" className="text-button train-history-edit"/)
  assert.match(engagement, /interpretReferralPreference\(personaId, text\.trim\(\), undefined, preference\.id\)/)
})
