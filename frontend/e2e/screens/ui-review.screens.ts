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
import { ROOT_DIR, type SeedState } from '../support/env.ts'
import { expect, referralPath, seedStep, test, type Actor } from '../support/fixtures.ts'

const runName = (process.env.E2E_RUN_NAME || new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-')).replace(/[^\w.-]/g, '-')

const main = (page: Page) => expect(page.locator('main').first()).toBeVisible()
const card = (page: Page) => expect(page.locator('.next-step-card')).toBeVisible()
const text = (value: string | RegExp) => (page: Page) => expect(page.getByText(value).first()).toBeVisible()

type Shot = { name: string; actor: Actor; to: (seed: SeedState) => string; ready?: (page: Page) => Promise<void>; before?: () => void; mock?: 'loading' | 'error' }

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
]

// E2E_ONLY=name,name captures just those screens (e.g. a follow-up round on affected screens);
// numbering stays the same as the full list so rounds compare file-for-file.
const only = new Set((process.env.E2E_ONLY ?? '').split(',').map((name) => name.trim()).filter(Boolean))

test('capture the UI-review screens', async ({ as, seed }, testInfo) => {
  test.setTimeout(10 * 60_000)
  const size = testInfo.project.use.viewport!
  const dir = path.join(ROOT_DIR, 'ui-review', runName, `${size.width}x${size.height}`)
  mkdirSync(dir, { recursive: true })
  for (const [index, shot] of SHOTS.entries()) {
    if (only.size && !only.has(shot.name)) {
      // Steps that set up later shots still run, so a filtered run sees the same states.
      shot.before?.()
      continue
    }
    shot.before?.()
    const page = await as(shot.actor)
    await page.unrouteAll({ behavior: 'ignoreErrors' })
    if (shot.mock) {
      await page.route(/\/api\/me\/practice\/referrals\/[^/]+$/, async (route) => {
        if (shot.mock === 'loading') return // never answered: the page stays in its loading state
        await route.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ detail: { code: 'e2e_error', message: 'Simulated server error (e2e)' } }) })
      })
    }
    await page.goto(shot.to(seed))
    await shot.ready?.(page)
    if (!shot.mock) await page.waitForLoadState('networkidle').catch(() => undefined)
    await page.evaluate(() => document.fonts?.ready)
    const file = path.join(dir, `${String(index + 1).padStart(2, '0')}-${shot.name}.png`)
    await page.screenshot({ path: file, fullPage: true, animations: 'disabled' })
    // On the phone, also the first screen exactly as the viewport shows it (fixed elements in place).
    if (size.width < 600) await page.screenshot({ path: file.replace(/\.png$/, '.fold.png'), animations: 'disabled' })
    if (shot.mock) await page.unrouteAll({ behavior: 'ignoreErrors' })
  }
})
