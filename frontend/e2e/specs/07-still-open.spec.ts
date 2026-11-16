/* A referral marked ready while a request is still out: one consistent statement of where it
 * stands, with what's still open said once. */
import { expect, nextStep, openReferral, test } from '../support/fixtures.ts'

test('"Still open" on a ready referral with an outstanding request', async ({ as, seed }) => {
  const doctor = seed.practice_a.physician_name
  const stillOpen = 'Still open: Thyroid ultrasound — requested from the referring office, not received yet'
  const physician = await as('physician')
  await openReferral(physician, seed.referrals.still_open)
  await expect(nextStep(physician).locator('.status-label')).toHaveText(/Ready for physician review/i)
  await expect(nextStep(physician).getByRole('heading', { level: 3 }).first()).toHaveText('Ready for your decision')
  await expect(nextStep(physician).locator('.pilot-still-open')).toHaveText(stillOpen)
  await expect(nextStep(physician)).not.toContainText('Waiting on the referring office')

  const staff = await as('staff')
  await openReferral(staff, seed.referrals.still_open)
  await expect(nextStep(staff).getByRole('heading', { level: 3 }).first()).toHaveText(`Ready for ${doctor}’s decision`)
  await expect(nextStep(staff).locator('.pilot-still-open')).toHaveText(stillOpen)
})
