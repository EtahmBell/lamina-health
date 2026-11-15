/* Practice isolation: practice A users can't see or open practice B referrals, and back. */
import { expect, referralPath, test } from '../support/fixtures.ts'

test('two practices never see each other’s referrals', async ({ as, seed }) => {
  for (const actor of ['physician', 'staff'] as const) {
    const page = await as(actor)
    await page.goto('/me/patients')
    await expect(page.locator('main')).toContainText('Vega Verify-E2E')
    await expect(page.locator('main')).not.toContainText('Ito Isolated-E2E')
    await expect(page.locator('main')).not.toContainText(seed.practice_b.name)
    await page.goto(referralPath(seed.practice_b_referrals.accepted))
    await expect(page.getByRole('alert')).toContainText('Referral not found')
    await expect(page.locator('main')).not.toContainText('Ito Isolated-E2E')
  }
  const other = await as('second_physician')
  await other.goto('/me/patients')
  await expect(other.locator('main')).toContainText('Ito Isolated-E2E')
  await expect(other.locator('main')).not.toContainText('Vega Verify-E2E')
  await other.goto(referralPath(seed.referrals.verify))
  await expect(other.getByRole('alert')).toContainText('Referral not found')
  await expect(other.locator('main')).not.toContainText('Vega Verify-E2E')
})
