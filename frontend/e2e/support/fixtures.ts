/* Multi-role fixtures: each role gets its own browser context (separate storage, separate
 * session) inside the same test. "office" is an unauthenticated referring office. */
import { execFileSync } from 'node:child_process'
import { expect, test as base, type BrowserContext, type Page } from '@playwright/test'
import { apiEnvironment, pythonExecutable, ROOT_DIR, seedState, storageStatePath, type Role, type SeedState } from './env.ts'

export type Actor = Role | 'office'

export const test = base.extend<{ as: (actor: Actor) => Promise<Page>; seed: SeedState }>({
  // eslint-disable-next-line no-empty-pattern
  seed: async ({}, use) => { await use(seedState()) },
  as: async ({ browser }, use, testInfo) => {
    const contexts: BrowserContext[] = []
    const pages = new Map<Actor, Page>()
    const { baseURL, viewport, isMobile, hasTouch, deviceScaleFactor } = testInfo.project.use
    await use(async (actor) => {
      const existing = pages.get(actor)
      if (existing) return existing
      const context = await browser.newContext({
        baseURL, viewport, isMobile, hasTouch, deviceScaleFactor,
        storageState: actor === 'office' ? undefined : storageStatePath(actor),
      })
      contexts.push(context)
      const page = await context.newPage()
      pages.set(actor, page)
      return page
    })
    for (const context of contexts) await context.close()
  },
})
export { expect }

/** A dev-only scenario switch on the e2e database (see scripts/e2e_seed.py). */
export function seedStep(name: string): void {
  execFileSync(pythonExecutable(), ['-m', 'scripts.e2e_seed', 'step', name], { cwd: ROOT_DIR, env: apiEnvironment(), stdio: 'pipe' })
}

/** Read-only JSON about stored records (no secrets), for assertions the UI can't show. */
export function inspect<T = unknown>(what: 'signoff' | 'resolutions', referralId: string): T {
  const out = execFileSync(pythonExecutable(), ['-m', 'scripts.e2e_seed', 'inspect', what, referralId],
    { cwd: ROOT_DIR, env: apiEnvironment(), stdio: ['ignore', 'pipe', 'pipe'] })
  return JSON.parse(out.toString('utf8')) as T
}

export const referralPath = (id: string) => `/me/referrals/${encodeURIComponent(id)}`

/** The referral's next-step card (status, heading, notes, actions). */
export const nextStep = (page: Page) => page.locator('.next-step-card')

/** Attribution must always name someone. */
export async function expectNamedAttribution(page: Page): Promise<void> {
  const text = await page.locator('main').innerText()
  expect(text).not.toMatch(/by your team/i)
}

/** Opens a referral and waits until its next-step card has rendered. */
export async function openReferral(page: Page, id: string): Promise<void> {
  await page.goto(referralPath(id))
  await expect(nextStep(page)).toBeVisible()
}
