/* Runs once before the specs: opens each saved role session, lets Supabase refresh it if needed,
 * and saves the refreshed session back. Specs then reuse a token valid for the whole run, so no
 * two contexts refresh the same token concurrently. Never prints tokens. */
import { existsSync } from 'node:fs'
import { expect, test } from '@playwright/test'
import { ROLE_LABELS, ROLES, seedState, storageStatePath } from './support/env.ts'

for (const role of ROLES) {
  test(`session for the ${ROLE_LABELS[role]} is signed in and fresh`, async ({ browser }, testInfo) => {
    const file = storageStatePath(role)
    if (!existsSync(file)) {
      throw new Error(`No saved session for the ${ROLE_LABELS[role]}. Sign in once: npm run e2e:capture (see docs/PILOT_E2E.md).`)
    }
    seedState() // fails early with a clear message if the database couldn't be seeded
    const context = await browser.newContext({ baseURL: testInfo.project.use.baseURL, storageState: file })
    const page = await context.newPage()
    await page.goto('/me/home')
    // Signed in: the workspace shell appears. Expired: the app sends the user to sign-in.
    const outcome = await Promise.race([
      page.getByRole('navigation').getByRole('button', { name: 'Home' }).waitFor({ timeout: 30_000 }).then(() => 'signed-in'),
      page.waitForURL(/\/claim\/sign-in/, { timeout: 30_000 }).then(() => 'expired'),
    ])
    if (outcome !== 'signed-in') throw new Error(`The ${ROLE_LABELS[role]} session has expired. Sign in again: npm run e2e:capture -- ${role}`)
    const secondsLeft = await page.evaluate(() => {
      const key = Object.keys(localStorage).find((name) => /^sb-.*-auth-token$/.test(name))
      const session = key ? JSON.parse(localStorage.getItem(key) ?? '{}') : {}
      return (session.expires_at ?? 0) - Math.floor(Date.now() / 1000)
    })
    expect(secondsLeft, 'a fresh access token for the whole run').toBeGreaterThan(20 * 60)
    await context.storageState({ path: file })
    await context.close()
  })
}
