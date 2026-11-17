/* The physician's correction + accept / redirect / decline is the sign-off; the stored sign-off
 * is the physician's alone, separate from anything staff did. */
import { expect, inspect, nextStep, openReferral, test } from '../support/fixtures.ts'

type Signoff = { decision: string; actor_role: string; actor_is_physician: boolean; redirect_to: string | null
  corrections: Array<{ field: string; from_value: string; to_value: string; agent_value: string; actor_role: string }>; staff_rows: number }

test('correction then accept is the sign-off', async ({ as, seed }) => {
  const doctor = seed.practice_a.physician_name
  const physician = await as('physician')
  await openReferral(physician, seed.referrals.signoff)
  await expect(physician.getByText('Approve triage')).toHaveCount(0)
  // Adjusting triage sits in a collapsed "Adjust triage" disclosure below the decision.
  await nextStep(physician).getByText('Adjust triage', { exact: true }).click()
  await nextStep(physician).getByRole('button', { name: 'Correct fit, priority or visit type' }).click()
  const panel = physician.locator('.pilot-panel', { hasText: 'Correct the triage' })
  await panel.getByLabel('Priority').selectOption('soon')
  await panel.getByLabel(/Why/).fill('Rising HbA1c (E2E).')
  await panel.getByRole('button', { name: 'Save correction' }).click()
  await expect(nextStep(physician)).toContainText(`Corrected: Priority: routine → soon (by ${doctor})`)
  await nextStep(physician).getByRole('button', { name: 'Accept referral' }).click()
  await physician.getByLabel('Note (optional)').fill('Accepted (E2E).')
  await physician.getByRole('button', { name: 'Confirm accept' }).click()
  await expect(nextStep(physician)).toContainText(`Accepted by ${doctor}`)

  const signoff = inspect<Signoff>('signoff', seed.referrals.signoff)
  expect(signoff).toMatchObject({ decision: 'accept', actor_role: 'physician', actor_is_physician: true, staff_rows: 0 })
  expect(signoff.corrections).toEqual([{ field: 'suggested_priority', from_value: 'routine', to_value: 'soon', agent_value: 'routine', actor_role: 'physician' }])

  // Staff see the outcome and who decided; they never get decision controls.
  const staff = await as('staff')
  await openReferral(staff, seed.referrals.signoff)
  await expect(nextStep(staff)).toContainText(`Accepted by ${doctor}`)
  await expect(staff.getByRole('button', { name: /Accept referral|Confirm accept/ })).toHaveCount(0)
})

test('redirect and decline are sign-offs too', async ({ as, seed }) => {
  const doctor = seed.practice_a.physician_name
  const physician = await as('physician')
  await openReferral(physician, seed.referrals.redirect)
  await nextStep(physician).getByRole('button', { name: 'Redirect', exact: true }).click()
  await physician.getByLabel('Redirect to').fill('Nephrology — Dr. Lee (E2E)')
  await physician.getByLabel('Reason').fill('Kidney question first (E2E).')
  await physician.getByRole('button', { name: 'Confirm redirect' }).click()
  await expect(nextStep(physician)).toContainText(`Redirected to Nephrology — Dr. Lee (E2E) by ${doctor}`)
  expect(inspect<Signoff>('signoff', seed.referrals.redirect)).toMatchObject({ decision: 'redirect', actor_role: 'physician', redirect_to: 'Nephrology — Dr. Lee (E2E)', corrections: [] })

  await openReferral(physician, seed.referrals.decline)
  await nextStep(physician).getByRole('button', { name: 'Decline', exact: true }).click()
  await physician.getByLabel('Reason').fill('Outside our scope (E2E).')
  await physician.getByRole('button', { name: 'Confirm decline' }).click()
  await expect(nextStep(physician)).toContainText(`Declined by ${doctor}`)
  expect(inspect<Signoff>('signoff', seed.referrals.decline)).toMatchObject({ decision: 'decline', actor_role: 'physician', staff_rows: 0 })
})
