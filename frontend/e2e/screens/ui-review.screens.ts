/* UI-review screenshots: a FIXED list of screens and states, captured at the project's real
 * viewport (1440×900, 1280×800, 390×844) into ui-review/<run-name>/<viewport>/ (gitignored).
 *
 *   npm run e2e:screens                 # run name = today's date-time
 *   npm run e2e:screens -- my-review    # run name = my-review
 *
 * Read-only apart from two dev-only seed steps that switch the second physician between
 * "initializing" and "shadow" so both Your Agent states can be captured. */
import { mkdirSync } from 'node:fs'
import path from 'node:path'
import type { Page } from '@playwright/test'
import { createAccountFromInvitation, invite } from '../support/access.ts'
import { ROOT_DIR, seedState, type SeedState } from '../support/env.ts'
import { expect, referralPath, seedStep, test, totpCode, type Actor, type Invitee } from '../support/fixtures.ts'

const runName = (process.env.E2E_RUN_NAME || new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-')).replace(/[^\w.-]/g, '-')

const main = (page: Page) => expect(page.locator('main').first()).toBeVisible()
const card = (page: Page) => expect(page.locator('.next-step-card')).toBeVisible()
const text = (value: string | RegExp) => (page: Page) => expect(page.getByText(value).first()).toBeVisible()

/* Accounts and access shots drive two brand-new invitee accounts (dev-only test sign-in) and the
 * admin's page. Anything credential-like on screen is masked in every screenshot: the invitation
 * link, the authenticator setup key and its QR code. */
type Tools = { admin: () => Promise<Page>; newcomer: () => Promise<Invitee>; leaver: () => Promise<Invitee> }
type Shot = {
  name: string; actor: Actor | 'newcomer' | 'leaver'; to: (seed: SeedState) => string; ready?: (page: Page) => Promise<void>; before?: () => void; after?: () => void
  mock?: 'loading' | 'error'; act?: (page: Page, tools: Tools) => Promise<void>; prepare?: (page: Page) => Promise<void>; mask?: string[]
}
const MASK = ['.pilot-link-field input', '.pilot-setup-key', '.pilot-mfa-secret img']
let pendingInvite = '' // the join path from the admin's invitation (never printed)

const SHOTS: Shot[] = [
  // Physician (practice admin)
  { name: 'physician-home-busy', actor: 'physician', to: () => '/me/home', ready: text(/need you today|needs you today/) },
  { name: 'physician-for-you', actor: 'physician', to: () => '/me/for-you', ready: main },
  { name: 'physician-patients', actor: 'physician', to: () => '/me/patients', ready: text('Vega Verify-E2E') },
  { name: 'referral-needs-information', actor: 'physician', to: (s) => referralPath(s.referrals.verify), ready: card },
  { name: 'referral-triaged-complete', actor: 'physician', to: (s) => referralPath(s.referrals.ready), ready: card },
  { name: 'referral-ready-still-open', actor: 'physician', to: (s) => referralPath(s.referrals.still_open), ready: card },
  { name: 'referral-conflict-banner', actor: 'physician', to: (s) => referralPath(s.referrals.conflict_keep), ready: (p) => expect(p.locator('.pilot-conflict')).toBeVisible() },
  { name: 'representation-review', actor: 'physician', to: () => '/me/setup?stage=review', ready: text('This is how your agent will represent you') },
  { name: 'your-agent-shadow', actor: 'physician', to: () => '/me/agent', ready: text(/Shadow/) },
  { name: 'pending-learning', actor: 'physician', to: () => '/me/agent?tab=teach', ready: text('calcium level') },
  { name: 'network', actor: 'physician', to: () => '/me/network', ready: main },
  // Second physician: initializing, setup stages A–E, then shadow with nothing to do
  { name: 'your-agent-initializing', actor: 'second_physician', before: () => seedStep('initializing-second-physician'), to: () => '/me/agent', ready: text(/not representing you yet|Setting up/) },
  { name: 'setup-a-identity', actor: 'second_physician', to: () => '/me/setup?stage=identity', ready: text('Looks right') },
  { name: 'setup-b-scope', actor: 'second_physician', to: () => '/me/setup?stage=scope', ready: text('Which kinds of referral') },
  { name: 'setup-c-requirements', actor: 'second_physician', to: () => '/me/setup?stage=requirements', ready: text(/For each type you see/) },
  { name: 'setup-d-delegation', actor: 'second_physician', to: () => '/me/setup?stage=delegation', ready: text(/Who handles each kind of work/) },
  { name: 'setup-e-review', actor: 'second_physician', to: () => '/me/setup?stage=review', ready: text('This is how your agent will represent you') },
  { name: 'home-nothing-needs-you', actor: 'second_physician', before: () => seedStep('shadow-second-physician'), to: () => '/me/home', ready: text('Nothing needs you right now.') },
  { name: 'referral-closed-declined', actor: 'second_physician', to: (s) => referralPath(s.practice_b_referrals.declined), ready: card },
  // Staff
  { name: 'staff-home', actor: 'staff', to: () => '/me/home', ready: main },
  { name: 'staff-referral-ready-flag-controls', actor: 'staff', to: (s) => referralPath(s.referrals.flag), ready: card },
  { name: 'staff-conflict-read-only', actor: 'staff', to: (s) => referralPath(s.referrals.conflict_keep), ready: (p) => expect(p.locator('.pilot-conflict')).toBeVisible() },
  { name: 'staff-your-agent-third-person', actor: 'staff', to: () => '/me/agent', ready: (p) => expect(p.locator('main').getByText(/’s agent/).first()).toBeVisible() },
  { name: 'staff-train-suggest', actor: 'staff', to: () => '/me/agent?tab=teach', ready: text(/Suggest how/) },
  // Public and sender (no account)
  { name: 'public-page', actor: 'office', to: (s) => `/p/${s.public_slug}`, ready: text('Northfield Endocrinology (E2E)') },
  { name: 'sender-page', actor: 'office', to: (s) => `/r/${s.sender_token}`, ready: text('Information requested') },
  // Loading and error states (the API is held / failed for this one page only)
  { name: 'state-loading-referral', actor: 'physician', mock: 'loading', to: (s) => referralPath(s.referrals.ready), ready: text('Opening referral…') },
  { name: 'state-error-referral', actor: 'physician', mock: 'error', to: (s) => referralPath(s.referrals.ready), ready: (p) => expect(p.getByRole('alert')).toBeVisible() },
  // Added in the follow-up round (appended so earlier numbering is unchanged).
  { name: 'staff-referral-declined-notify', actor: 'staff', to: (s) => referralPath(s.referrals.declined_notify), ready: text('Not sent — notify the referring office') },
  // Step 18 (appended): readiness review and activation.
  { name: 'physician-readiness-review', actor: 'physician', before: () => { seedStep('resolve-auto-draft-flags'); seedStep('shadow-auto-draft') }, to: () => '/me/agent?tab=readiness', ready: text('What your agent observed') },
  { name: 'physician-readiness-confirm', actor: 'physician', to: () => '/me/agent?tab=readiness', ready: text('Eligible to turn on.'),
    act: async (p) => { await p.locator('.pilot-capability', { hasText: 'Draft missing-information requests' }).getByRole('button', { name: 'Turn on' }).click(); await expect(p.getByText('Nothing is sent without staff.')).toBeVisible() } },
  { name: 'second-physician-readiness-not-eligible', actor: 'second_physician', to: () => '/me/agent?tab=readiness', ready: text('Not eligible yet:') },
  { name: 'staff-capabilities-readonly', actor: 'staff', before: () => seedStep('activate-auto-draft'), to: () => '/me/agent?tab=readiness', ready: text(/can change this\./) },
  { name: 'staff-auto-drafted-request', actor: 'staff', before: () => seedStep('new-missing-referral'), to: () => referralPath(seedState().referrals.auto_draft!), ready: text(/drafted by .*’s agent/) },
  { name: 'physician-agent-partly-active', actor: 'physician', to: () => '/me/agent', ready: text(/Partly active · drafting requests on/) },
  // Step 18 decisions (appended): "Ready" while a required item is missing needs a named confirmation.
  { name: 'staff-ready-missing-confirm', actor: 'staff', to: () => referralPath(seedState().referrals.auto_draft!), ready: text(/drafted by .*’s agent/),
    act: async (p) => { await p.locator('.next-step-card').getByRole('button', { name: /^Ready for / }).click(); await expect(p.getByText('Still missing:')).toBeVisible() } },
  // Accounts and access, run 1 (appended).
  { name: 'admin-team-and-invite', actor: 'physician', to: () => '/me/practice', ready: text('Invite someone') },
  { name: 'admin-invitation-created', actor: 'physician', to: () => '/me/practice', ready: text('Invite someone'), mask: MASK,
    act: async (p, tools) => {
      const email = (await tools.newcomer()).email
      const section = p.getByRole('region', { name: 'Invite someone' })
      await section.getByLabel('Physician', { exact: true }).check()
      await section.getByLabel('Their email address').fill(email)
      await section.getByLabel(/Name or role/).fill('Dr. Newcomb (E2E)')
      await section.getByRole('button', { name: 'Create invitation' }).click()
      const link = new URL(await section.getByRole('textbox', { name: 'Invitation link' }).inputValue())
      pendingInvite = `${link.pathname}${link.search}`
    } },
  { name: 'admin-deactivate-confirm', actor: 'physician', to: () => '/me/practice', ready: text('Invite someone'),
    act: async (p) => { await p.locator('.pilot-member', { hasText: 'Front desk (E2E)' }).getByRole('button', { name: 'Deactivate…' }).click(); await expect(p.getByText('Their access ends now, on every device.')).toBeVisible() } },
  { name: 'security-sign-out-everywhere', actor: 'physician', to: () => '/me/practice#security', ready: text('Sign-in & security'),
    act: async (p) => { await p.getByRole('button', { name: 'Sign out everywhere' }).click(); await expect(p.getByText('Sign out on every device?')).toBeVisible() } },
  { name: 'landing-invite-only', actor: 'office', to: () => '/me/home', ready: text('Request pilot access') },
  { name: 'sign-in-after-idle', actor: 'office', to: () => '/claim/sign-in?reason=idle&return=%2Fme%2Fhome', ready: text(/signed out after 30 minutes/) },
  { name: 'request-pilot-access', actor: 'office', to: () => '/claim/sign-up?return=%2Fme%2Fhome', ready: (p) => expect(p.getByRole('heading', { name: 'Request pilot access' })).toBeVisible() },
  { name: 'join-signed-out', actor: 'office', to: () => pendingInvite, ready: text('You’ve been invited to Lamina') },
  { name: 'join-physician-preview', actor: 'newcomer', to: () => '/me/home', ready: main,
    act: async (_p, tools) => { const newcomer = await tools.newcomer(); await createAccountFromInvitation(newcomer, pendingInvite); await expect(newcomer.page.getByText('only you can')).toBeVisible() } },
  { name: 'mfa-setup', actor: 'newcomer', to: () => pendingInvite, ready: text('only you can'), mask: MASK,
    act: async (p) => {
      await p.getByRole('button', { name: 'Accept invitation' }).click()
      await p.getByRole('button', { name: 'Set up my authenticator' }).click()
      await expect(p.getByLabel('Setup key')).toBeVisible()
    } },
  { name: 'onboarding-invited-physician', actor: 'newcomer', to: () => '/me/home', ready: text('Set up two-step sign-in'),
    act: async (p) => {
      await p.getByRole('button', { name: 'Set up my authenticator' }).click()
      const key = (await p.getByLabel('Setup key').innerText()).trim()
      await p.getByLabel('6-digit code').fill(totpCode(key)); await p.getByRole('button', { name: 'Verify' }).click()
      await expect(p.getByRole('note')).toContainText('as a physician')
    } },
  { name: 'mfa-enter-code', actor: 'newcomer', to: () => '/me/home', ready: main,
    act: async (p, tools) => {
      const newcomer = await tools.newcomer()
      await p.getByRole('button', { name: 'Sign out' }).first().click()
      await p.goto('/claim/sign-in?return=%2Fme%2Fhome')
      await p.getByLabel('Email').fill(newcomer.email); await p.getByLabel('Password').fill(newcomer.password)
      await p.getByRole('main').getByRole('button', { name: /^Sign in/ }).click()
      await expect(p.getByRole('heading', { name: 'Enter your code' })).toBeVisible()
    } },
  { name: 'mfa-recovery-request', actor: 'newcomer', to: () => '/me/home', ready: text('Enter your code'),
    act: async (p) => { await p.getByRole('button', { name: 'Lost your authenticator?' }).click(); await expect(p.getByText('never a practice admin')).toBeVisible() } },
  { name: 'access-ended', actor: 'leaver', to: () => '/me/home', ready: main,
    act: async (p, tools) => {
      const admin = await tools.admin()
      const leaver = await tools.leaver()
      const path = await invite(admin, leaver.email, 'Staff', 'Temp desk (E2E)')
      await createAccountFromInvitation(leaver, path)
      await p.getByRole('button', { name: 'Accept invitation' }).click()
      await p.getByRole('button', { name: 'Set up my authenticator' }).click()
      await p.getByLabel('6-digit code').fill(totpCode((await p.getByLabel('Setup key').innerText()).trim())); await p.getByRole('button', { name: 'Verify' }).click()
      await expect(p.getByRole('navigation').getByRole('button', { name: 'Home' })).toBeVisible()
      await admin.goto('/me/practice')
      await admin.locator('.pilot-member', { hasText: 'Temp desk (E2E)' }).getByRole('button', { name: 'Deactivate…' }).click()
      await admin.getByRole('group', { name: 'Deactivate Temp desk (E2E)' }).getByRole('button', { name: 'Deactivate' }).click()
      await expect(admin.locator('.pilot-member', { hasText: 'Temp desk (E2E)' })).toHaveCount(0)
      await p.goto('/me/home')
      await expect(p.getByRole('heading', { name: /has ended|signed out/ })).toBeVisible()
    } },
  // Step 18 follow-ups (appended): flags behind an automatic return need notes; the Ready check splits items.
  { name: 'readiness-flags-need-notes', actor: 'physician', before: () => seedStep('flag-auto-draft-three-times'), to: () => '/me/agent?tab=readiness', ready: text('needs resolving'),
    act: async (p) => { await p.getByRole('button', { name: 'Resolve…' }).first().click(); await expect(p.getByLabel('What did you find?')).toBeVisible() } },
  { name: 'staff-ready-received-not-verified', actor: 'staff', before: () => seedStep('new-unverified-referral'), to: () => referralPath(seedState().referrals.unverified!), ready: card,
    act: async (p) => { await p.locator('.next-step-card').getByRole('button', { name: /^Ready for / }).click(); await expect(p.getByText('Received, not verified:')).toBeVisible() } },
  // Run 2 (appended): the practice idle timeout an admin sets, and two physicians in one practice
  // (the second joins practice A as a non-admin; nothing after this depends on where they are).
  { name: 'security-idle-timeout-setting', actor: 'physician', to: () => '/me/practice#security', ready: (p) => expect(p.getByRole('form', { name: 'Idle sign-out for the practice' })).toBeVisible() },
  { name: 'second-physician-practice-learning-read-only', actor: 'second_physician', before: () => seedStep('join-second-physician'), to: () => '/me/agent?tab=teach', ready: text('an admin physician confirms practice-wide statements') },
  { name: 'second-physician-home-same-practice', actor: 'second_physician', to: () => '/me/home', ready: main },
  // `after` puts the second physician back in their own practice: the next viewport replays the list.
  { name: 'second-physician-conflict-other-physician', actor: 'second_physician', to: (s) => referralPath(s.referrals.conflict_keep), ready: card,
    after: () => seedStep('return-second-physician') },
]

// E2E_ONLY=name,name captures just those screens (e.g. a follow-up round on affected screens);
// numbering stays the same as the full list so rounds compare file-for-file.
const only = new Set((process.env.E2E_ONLY ?? '').split(',').map((name) => name.trim()).filter(Boolean))

test('capture the UI-review screens', async ({ as, seed, invitee }, testInfo) => {
  test.setTimeout(20 * 60_000)
  const size = testInfo.project.use.viewport!
  const dir = path.join(ROOT_DIR, 'ui-review', runName, `${size.width}x${size.height}`)
  mkdirSync(dir, { recursive: true })
  let newcomer: Invitee | null = null
  let leaver: Invitee | null = null
  const tools: Tools = {
    admin: () => as('physician'),
    newcomer: async () => (newcomer ??= await invitee('newcomer')),
    leaver: async () => (leaver ??= await invitee('leaver')),
  }
  for (const [index, shot] of SHOTS.entries()) {
    if (only.size && !only.has(shot.name)) {
      // Steps that set up later shots still run, so a filtered run sees the same states.
      shot.before?.()
      shot.after?.()
      continue
    }
    shot.before?.()
    const page = shot.actor === 'newcomer' ? (await tools.newcomer()).page : shot.actor === 'leaver' ? (await tools.leaver()).page : await as(shot.actor)
    await page.unrouteAll({ behavior: 'ignoreErrors' })
    await shot.prepare?.(page)
    if (shot.mock) {
      await page.route(/\/api\/me\/practice\/referrals\/[^/]+$/, async (route) => {
        if (shot.mock === 'loading') return // never answered: the page stays in its loading state
        await route.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ detail: { code: 'e2e_error', message: 'Simulated server error (e2e)' } }) })
      })
    }
    await page.goto(shot.to(seed))
    await shot.ready?.(page)
    await shot.act?.(page, tools)
    if (!shot.mock) await page.waitForLoadState('networkidle').catch(() => undefined)
    await page.evaluate(() => document.fonts?.ready)
    const file = path.join(dir, `${String(index + 1).padStart(2, '0')}-${shot.name}.png`)
    const mask = (shot.mask ?? []).map((selector) => page.locator(selector))
    await page.screenshot({ path: file, fullPage: true, animations: 'disabled', mask })
    // On the phone, also the first screen exactly as the viewport shows it (fixed elements in place).
    if (size.width < 600) await page.screenshot({ path: file.replace(/\.png$/, '.fold.png'), animations: 'disabled', mask })
    if (shot.mock) await page.unrouteAll({ behavior: 'ignoreErrors' })
    shot.after?.()
  }
})
