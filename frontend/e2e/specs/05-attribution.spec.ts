/* Attribution names the actor everywhere, and a recommendation change credits its cause (the
 * physician's rule update), not whoever re-ran the check. */
import { expect, expectNamedAttribution, nextStep, openReferral, test } from '../support/fixtures.ts'

test('"Changed since you last looked" names the cause and the trigger', async ({ as, seed }) => {
  const doctor = seed.practice_a.physician_name
  const staffLabel = seed.practice_a.staff_label
  const staff = await as('staff')
  await openReferral(staff, seed.referrals.change)
  // Staff intake fixes sit in a collapsed "Fix intake details" disclosure.
  await nextStep(staff).getByText('Fix intake details', { exact: true }).click()
  await nextStep(staff).getByRole('button', { name: 'Re-run triage' }).click()
  const cause = `because ${doctor} updated the Adrenal nodule rule (v2) · re-checked by ${staffLabel}`
  await expect(staff.locator('.timeline-event', { hasText: 'Lamina’s recommendation changed' }).first()).toContainText(`By Lamina, ${cause}`)

  const physician = await as('physician')
  await openReferral(physician, seed.referrals.change)
  await expect(physician.locator('.pilot-change-note')).toHaveText(`Changed since you last looked: Visit type: eConsult → in-person, ${cause}`)
  // The note stays for this visit even after the page reloads its data.
  await physician.waitForTimeout(1500)
  await expect(physician.locator('.pilot-change-note')).toBeVisible()
  await expectNamedAttribution(physician)
})

test('history and requests name the physician, staff and referring office', async ({ as, seed }) => {
  const staffLabel = seed.practice_a.staff_label
  for (const actor of ['physician', 'staff'] as const) {
    const page = await as(actor)
    await openReferral(page, seed.referrals.still_open)
    await page.locator('details.source-record summary').click()
    const log = page.locator('.record-rows')
    await expect(log).toContainText(`Referring office replied · by Placeholder Family Medicine (E2E)`)
    await expect(log).toContainText(`Referral item verified · by ${staffLabel}`)
    await expect(log).toContainText(`Marked ready for the physician · by ${staffLabel}`)
    await expect(page.locator('.pilot-request')).toContainText(`drafted by ${staffLabel}`)
    await expectNamedAttribution(page)
  }
})
