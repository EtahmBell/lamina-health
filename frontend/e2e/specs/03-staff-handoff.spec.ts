/* Staff do the paperwork: "Ready for Dr. X" and "Flag for Dr. X", with no clinical controls. */
import { expect, nextStep, openReferral, test } from '../support/fixtures.ts'

test('staff mark ready and flag for the physician, without fit/priority/visit-type controls', async ({ as, seed }) => {
  const doctor = seed.practice_a.physician_name
  const staffLabel = seed.practice_a.staff_label
  const staff = await as('staff')
  await openReferral(staff, seed.referrals.ready)
  const card = nextStep(staff)
  await expect(card.getByRole('button', { name: /Correct fit, priority or visit type/ })).toHaveCount(0)
  await expect(card.locator('select')).toHaveCount(0)
  await expect(card.getByRole('button', { name: /Accept referral|Redirect|Decline/ })).toHaveCount(0)
  await expect(card).toContainText(`${doctor} makes the final accept, redirect, or decline decision, and decides fit, priority and visit type.`)

  await card.getByRole('button', { name: `Ready for ${doctor}` }).click()
  await staff.getByPlaceholder(`Optional note for ${doctor}`).fill('Paperwork complete (E2E).')
  await staff.getByRole('button', { name: 'Mark ready' }).click()
  await expect(card).toContainText(`Marked ready for ${doctor} by ${staffLabel}`)
  await expect(card).toContainText('Paperwork complete (E2E).')

  await openReferral(staff, seed.referrals.flag)
  await nextStep(staff).getByRole('button', { name: `Flag for ${doctor}` }).click()
  await staff.getByPlaceholder(`What should ${doctor} look at?`).fill('Unusual history (E2E).')
  await staff.getByRole('button', { name: 'Flag', exact: true }).click()
  await expect(nextStep(staff)).toContainText(`Flagged for ${doctor} by ${staffLabel}`)

  // The physician sees who handed it over.
  const physician = await as('physician')
  await openReferral(physician, seed.referrals.ready)
  await expect(nextStep(physician).getByRole('heading', { level: 3 }).first()).toHaveText('Ready for your decision')
  await expect(nextStep(physician)).toContainText(`Marked ready for ${doctor} by ${staffLabel}`)
  await expect(physician.locator('.timeline-event', { hasText: 'Marked ready for the physician' })).toContainText(`By ${staffLabel}`)
})
