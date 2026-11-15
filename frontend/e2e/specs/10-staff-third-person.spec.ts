/* Staff read Your Agent (and the dock) about the physician, in the third person. */
import { expect, test } from '../support/fixtures.ts'

test('staff see Your Agent in the third person', async ({ as, seed }) => {
  const doctor = seed.practice_a.physician_name
  const staff = await as('staff')
  await staff.goto('/me/agent')
  const main = staff.locator('main')
  await expect(main.locator('.agent-hero .eyebrow')).toHaveText(`${doctor}’s agent`)
  await expect(main).toContainText(`It recommends; ${doctor} decides.`)
  await expect(main).toContainText(`How ${doctor}’s agent currently represents the practice`)
  await expect(main).toContainText(`${doctor} sees these referrals`)
  for (const phrase of ['Your physician agent', 'Your judgment', 'Train your agent', 'You decide these', 'Always comes to you', 'your agent recommends']) {
    await expect(main).not.toContainText(phrase)
  }
  await staff.goto('/me/home')
  await expect(staff.getByRole('complementary')).toContainText(`${doctor}’s agent`)
})
