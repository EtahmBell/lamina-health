/* Practice-level clinical statements: an ADMIN physician can confirm; a non-admin physician
 * and staff cannot. The second physician joins practice A as a non-admin for this spec only
 * (joining as a second physician isn't a product flow yet). */
import { expect, seedStep, test } from '../support/fixtures.ts'

test('admin physician confirms; non-admin physician and staff cannot', async ({ as, seed }) => {
  seedStep('join-second-physician')
  try {
    const proposal = `#proposal-${seed.practice_proposal_id}`
    const second = await as('second_physician')
    await second.goto('/me/agent?tab=teach')
    await expect(second.locator(proposal)).toContainText('calcium level')
    // Run 2: a non-admin physician sees it read-only -- no Confirm button that would only fail.
    await expect(second.locator(proposal)).toContainText('an admin physician confirms practice-wide statements')
    await expect(second.locator(proposal).getByRole('button', { name: 'Confirm', exact: true })).toHaveCount(0)

    const staff = await as('staff')
    await staff.goto('/me/agent?tab=teach')
    await expect(staff.locator(proposal)).toContainText('calcium level')
    await expect(staff.locator(proposal).getByRole('button', { name: 'Confirm', exact: true })).toHaveCount(0)

    const admin = await as('physician')
    await admin.goto('/me/agent?tab=teach')
    await admin.locator(proposal).getByRole('button', { name: 'Confirm', exact: true }).click()
    await expect(admin.locator(proposal)).toHaveCount(0)
    await admin.goto('/me/rules')
    await expect(admin.locator('section, article, div').filter({ hasText: /^Hyperparathyroidism/ }).first()).toContainText('Calcium level')
  } finally {
    seedStep('return-second-physician')
  }
})
