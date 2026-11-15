/* Staff teaching becomes a pending suggestion the physician sees; staff can't confirm it. */
import { expect, test } from '../support/fixtures.ts'

test('a staff suggestion is pending for the physician', async ({ as, seed }) => {
  const doctor = seed.practice_a.physician_name
  const staffLabel = seed.practice_a.staff_label
  const staff = await as('staff')
  await staff.goto('/me/agent?tab=teach')
  await expect(staff.getByText(`Suggest how ${doctor}’s agent should handle referrals.`)).toBeVisible()
  await staff.getByLabel(`Suggest something to ${doctor}`).fill('For Hyperparathyroidism referrals I need a vitamin D level.')
  await staff.getByRole('button', { name: `Send to ${doctor}` }).click()
  const card = staff.locator('[id^="proposal-"]', { hasText: 'vitamin D' })
  await expect(card).toContainText('Staff suggestion')
  await expect(card).toContainText(`Suggested by ${staffLabel}. It changes nothing unless a physician confirms it.`)
  await expect(card.getByRole('button', { name: 'Confirm', exact: true })).toHaveCount(0)

  const physician = await as('physician')
  await physician.goto('/me/home')
  await expect(physician.getByRole('button', { name: new RegExp(`${staffLabel.replace(/[()]/g, '\\$&')} suggested something for your agent`) })).toBeVisible()
  await physician.goto('/me/agent?tab=teach')
  const physicianCard = physician.locator('[id^="proposal-"]', { hasText: 'vitamin D' })
  await expect(physicianCard).toContainText('Staff suggestion')
  await expect(physicianCard.getByRole('button', { name: 'Confirm', exact: true })).toBeVisible()
})
