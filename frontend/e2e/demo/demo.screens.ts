/* Demo comparator: the original synthetic demo's matching screens, for visual parity in the UI
 * review. Synthetic demo data only (Dr. Lucy's PCP workspace + Dr. Chen's receiving-specialist
 * workspace). Full-page shots, plus the phone's first screen as a user actually sees it. */
import { mkdirSync } from 'node:fs'
import path from 'node:path'
import { expect, test, type Page } from '@playwright/test'
import { ROOT_DIR } from '../support/env.ts'

type Shot = { name: string; to: string; ready?: (page: Page) => Promise<unknown>; act?: (page: Page) => Promise<unknown> }

const main = (page: Page) => expect(page.locator('main').first()).toBeVisible()

const SHOTS: Shot[] = [
  { name: 'demo-home', to: '/home' },
  { name: 'demo-for-you', to: '/for-you' },
  { name: 'demo-patients', to: '/patients' },
  { name: 'demo-patient-detail', to: '/patients/patient-ida-002' },
  {
    name: 'demo-referral-result', to: '/patients/patient-ckd-htn-001',
    act: async (page) => {
      const consult = page.getByRole('button', { name: /Consult network for referral/ })
      if (await consult.isVisible().catch(() => false)) {
        await consult.click()
        await expect(page.getByRole('button', { name: /Consulting…/ })).toHaveCount(0, { timeout: 60_000 })
      }
    },
  },
  { name: 'demo-my-agent', to: '/agent' },
  { name: 'demo-network', to: '/network' },
  { name: 'demo-profile', to: '/profile' },
  // The receiving specialist (closest to the pilot's specialist practice)
  { name: 'demo-specialist-home', to: '/chen/home' },
  { name: 'demo-specialist-patients', to: '/chen/patients' },
]

test('capture the demo comparator screens', async ({ page }, testInfo) => {
  const size = testInfo.project.use.viewport!
  const dir = path.join(ROOT_DIR, 'ui-review', 'demo', `${size.width}x${size.height}`)
  mkdirSync(dir, { recursive: true })
  for (const [index, shot] of SHOTS.entries()) {
    await page.goto(shot.to)
    await (shot.ready ?? main)(page)
    await page.waitForLoadState('networkidle').catch(() => undefined)
    await shot.act?.(page)
    await page.waitForLoadState('networkidle').catch(() => undefined)
    await page.evaluate(() => document.fonts?.ready)
    const base = path.join(dir, `${String(index + 1).padStart(2, '0')}-${shot.name}`)
    await page.screenshot({ path: `${base}.png`, fullPage: true, animations: 'disabled' })
    if (size.width < 600) await page.screenshot({ path: `${base}.fold.png`, animations: 'disabled' })
  }
})
