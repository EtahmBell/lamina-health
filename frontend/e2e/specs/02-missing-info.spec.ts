/* Missing information: staff request → the referring office replies (unauthenticated) →
 * staff open the Home "Verify" item, which lands on Verify as the primary action. */
import { expect, nextStep, openReferral, test } from '../support/fixtures.ts'

test('request → sender reply → staff Verify from Home', async ({ as, seed }) => {
  const staff = await as('staff')
  const office = await as('office')
  await openReferral(staff, seed.referrals.verify)
  await nextStep(staff).getByRole('button', { name: 'Request information' }).click()
  await staff.getByRole('button', { name: 'Prepare request' }).click()
  await staff.getByRole('button', { name: /Approve — I’ll fax\/send it/ }).click()
  const link = (await staff.locator('code.pilot-link').innerText()).trim()
  await expect(staff.locator('.pilot-request')).toContainText(`drafted by ${seed.practice_a.staff_label}`)
  await expect(staff.locator('.pilot-request')).toContainText(`by ${seed.practice_a.staff_label}`)
  await expect(staff.locator('.pilot-request pre')).toContainText('[Secure link included when sent (not stored)]')

  // The referring office answers through the secure link (no account).
  const token = link.split('/r/')[1]
  await office.goto(`/r/${token}`)
  const row = office.locator('.pilot-form-row', { hasText: 'Recent TSH' })
  await row.getByPlaceholder('Value or summary').fill('TSH 2.2 mIU/L (E2E)')
  await row.getByLabel('Date of result').fill(new Date(Date.now() - 20 * 86400_000).toISOString().slice(0, 10))
  await office.getByRole('button', { name: 'Send response' }).click()
  await expect(office.getByRole('status')).toHaveText('Thank you — the practice has your response.')

  // Home → Verify lands on the referral with Verify as THE next step and primary action.
  await staff.goto('/me/home')
  await staff.getByRole('button', { name: /^Verify Verify what the referring office sent for Vega Verify-E2E/ }).click()
  await expect(staff).toHaveURL(new RegExp(`/me/referrals/${seed.referrals.verify}`))
  await expect(nextStep(staff).getByRole('heading', { level: 3 })).toHaveText('Verify what the referring office sent')
  const verify = nextStep(staff).getByRole('button', { name: 'Verify Recent TSH' })
  await expect(verify).toHaveClass(/button-primary/)
  await verify.click()
  const requirement = staff.locator('.pilot-requirement', { hasText: 'Recent TSH' })
  await expect(requirement).toContainText('Satisfied')
  await expect(requirement).toContainText(`sent by Placeholder Family Medicine (E2E), verified by ${seed.practice_a.staff_label}`)
})
