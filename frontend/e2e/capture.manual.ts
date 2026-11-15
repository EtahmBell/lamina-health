/* ONE-TIME MANUAL SESSION CAPTURE (headed). A person signs in; this file never types a password.
 *
 *   npm run e2e:capture                  # all three roles, one window each, in turn
 *   npm run e2e:capture -- staff         # just one role (physician | second_physician | staff)
 *
 * For each role a Chrome window opens on the Lamina sign-in page. Sign in with that role's DEV
 * test account. Once Supabase stores a session, the window closes and the session is saved to
 * frontend/e2e/.auth/<role>.json, with the account's user id written to accounts.json (both
 * gitignored). Tokens are never printed. Tracing and video are off for this project. */
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs'
import path from 'node:path'
import { test } from '@playwright/test'
import { AUTH_DIR, ROLE_LABELS, ROLES, storageStatePath, type Role } from './support/env.ts'

const wanted = (process.env.E2E_ROLES ?? '').split(',').map((value) => value.trim()).filter(Boolean)
const roles = (wanted.length ? wanted : ROLES) as Role[]

test.skip(process.env.E2E_CAPTURE !== '1', 'Manual capture runs only through `npm run e2e:capture`.')

for (const role of roles) {
  test(`sign in as the ${ROLE_LABELS[role]}`, async ({ browser }, testInfo) => {
    if (!ROLES.includes(role)) throw new Error(`Unknown role "${role}". Use one of: ${ROLES.join(', ')}`)
    const context = await browser.newContext({ baseURL: testInfo.project.use.baseURL })
    const page = await context.newPage()
    await page.goto(`/claim/sign-in?return=${encodeURIComponent('/me/home')}`)
    console.log(`\n>>> In the Chrome window, sign in as the ${ROLE_LABELS[role]} DEV test account. Waiting…`)
    await page.waitForFunction(() => Object.keys(localStorage).some((name) => {
      if (!/^sb-.*-auth-token$/.test(name)) return false
      try { return Boolean(JSON.parse(localStorage.getItem(name) ?? '{}').access_token) } catch { return false }
    }), undefined, { timeout: 15 * 60_000, polling: 1000 })
    const account = await page.evaluate(() => {
      const key = Object.keys(localStorage).find((name) => /^sb-.*-auth-token$/.test(name))!
      const session = JSON.parse(localStorage.getItem(key)!)
      return { user_id: String(session.user?.id ?? ''), email: String(session.user?.email ?? '') }
    })
    if (!account.user_id) throw new Error('Signed in, but no user id was found in the session.')
    mkdirSync(AUTH_DIR, { recursive: true })
    await context.storageState({ path: storageStatePath(role) })
    const accountsFile = path.join(AUTH_DIR, 'accounts.json')
    const accounts = existsSync(accountsFile) ? JSON.parse(readFileSync(accountsFile, 'utf8')) : {}
    const others = Object.entries(accounts).filter(([other, value]) => other !== role && (value as { user_id: string }).user_id === account.user_id)
    if (others.length) throw new Error(`That account is already saved as "${others[0][0]}". Each role needs its own account.`)
    accounts[role] = account
    writeFileSync(accountsFile, JSON.stringify(accounts, null, 1))
    console.log(`>>> Saved the ${ROLE_LABELS[role]} session.`)
    await context.close()
  })
}
