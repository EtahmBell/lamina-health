/* Multi-role fixtures: each role gets its own browser context (separate storage, separate
 * session) inside the same test. "office" is an unauthenticated referring office. */
import { execFileSync } from 'node:child_process'
import { createHmac, randomBytes } from 'node:crypto'
import { expect, test as base, type BrowserContext, type Page } from '@playwright/test'
import { apiEnvironment, pythonExecutable, ROOT_DIR, seedState, storageStatePath, type Role, type SeedState } from './env.ts'

export type Actor = Role | 'office'

/** A brand-new invitee: a fresh browser context using the dev-only test sign-in (no real identity
 * provider, nothing stored outside the run). Credentials are generated per run and never printed. */
export type Invitee = { page: Page; email: string; password: string }

export const test = base.extend<{ as: (actor: Actor) => Promise<Page>; seed: SeedState; invitee: (name: string) => Promise<Invitee> }>({
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
  invitee: async ({ browser }, use, testInfo) => {
    const contexts: BrowserContext[] = []
    const { baseURL, viewport, isMobile, hasTouch, deviceScaleFactor } = testInfo.project.use
    await use(async (name) => {
      const context = await browser.newContext({ baseURL, viewport, isMobile, hasTouch, deviceScaleFactor })
      await context.addInitScript(() => window.localStorage.setItem('lamina.devTestAuth', '1'))
      contexts.push(context)
      const run = randomBytes(4).toString('hex')
      return { page: await context.newPage(), email: `${name}.${run}@e2e.example.test`, password: `e2e-${randomBytes(12).toString('hex')}` }
    })
    for (const context of contexts) await context.close()
  },
})
export { expect }

/** RFC 6238 TOTP from an authenticator setup key, as an authenticator app would compute it. */
export function totpCode(setupKey: string, at = Date.now()): string {
  const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'
  const clean = setupKey.replace(/[\s=]/g, '').toUpperCase()
  let bits = ''
  for (const char of clean) bits += alphabet.indexOf(char).toString(2).padStart(5, '0')
  const key = Buffer.from((bits.match(/.{8}/g) ?? []).map((byte) => parseInt(byte, 2)))
  const counter = Buffer.alloc(8)
  counter.writeBigUInt64BE(BigInt(Math.floor(at / 1000 / 30)))
  const digest = createHmac('sha1', key).update(counter).digest()
  const offset = digest[digest.length - 1] & 0x0f
  return String((digest.readUInt32BE(offset) & 0x7fffffff) % 1_000_000).padStart(6, '0')
}

/** Read-only audit trail (event types only) for practice A and the run's invitees. */
export function accountEvents(): Array<{ type: string; by_invitee: boolean; role: string | null }> {
  const out = execFileSync(pythonExecutable(), ['-m', 'scripts.e2e_seed', 'inspect', 'account-events', '-'],
    { cwd: ROOT_DIR, env: apiEnvironment(), stdio: ['ignore', 'pipe', 'pipe'] })
  return JSON.parse(out.toString('utf8'))
}

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
