/* Setup stages A–E for a physician whose agent is still initializing (the second physician, in
 * their own practice B), confirming the representation and entering shadow mode. */
import { expect, test } from '../support/fixtures.ts'

test('setup A–E, confirm the representation, enter shadow mode', async ({ as }) => {
  const doctor = await as('second_physician')
  await doctor.goto('/me/agent')
  await expect(doctor.getByText(/not representing you yet|Setting up/i).first()).toBeVisible()

  await doctor.goto('/me/setup?stage=identity')
  await expect(doctor.getByRole('heading', { name: 'How your agent will represent you' })).toBeVisible()
  await doctor.getByRole('button', { name: /Looks right — continue/ }).click()

  // B: case scope. Add one type we see and one that's out of scope.
  await expect(doctor.getByText('Which kinds of referral do you receive')).toBeVisible()
  await doctor.getByLabel('Add a referral type').fill('Kidney stones')
  await doctor.getByRole('button', { name: 'Add type' }).click()
  await doctor.getByLabel('Add a referral type').fill('Adrenal mass')
  await doctor.getByRole('button', { name: 'Add type' }).click()
  await doctor.getByRole('radiogroup', { name: 'What to do with Adrenal mass' }).getByText('Out of scope').click()
  await doctor.getByRole('button', { name: /Save and continue/ }).click()

  // C: requirements for the type we see; "what I understood" is shown before anything is used.
  const card = doctor.locator('.pilot-requirements-card', { hasText: 'Kidney stones' })
  await card.getByLabel(/Required before review/).fill('Recent creatinine | 90')
  await card.getByLabel('Preferred visit type').selectOption('econsult')
  await card.getByRole('button', { name: 'Save for Kidney stones' }).click()
  await expect(card.getByText('What I understood', { exact: true })).toBeVisible()
  await expect(card.getByText(/Recent creatinine — within 90 days/)).toBeVisible()
  await doctor.getByRole('button', { name: /Done — continue/ }).click()

  // D: delegation preferences (stored for later; nothing enabled).
  await expect(doctor.getByText(/today every capability stays in shadow/)).toBeVisible()
  await doctor.getByRole('button', { name: /Save and continue/ }).click()

  // E: confirm each waiting item, then the representation.
  await expect(doctor.getByText('This is how your agent will represent you')).toBeVisible()
  const waiting = doctor.locator('.pilot-review-section', { hasText: 'Waiting for your confirmation' })
  const confirmButtons = waiting.getByRole('button', { name: 'Confirm', exact: true })
  await expect(confirmButtons.first()).toBeVisible()
  for (let remaining = await confirmButtons.count(), guard = 0; remaining > 0 && guard < 10; guard += 1) {
    await confirmButtons.first().click()
    // Wait for this confirmation to land before the next click (the list re-renders; the
    // section disappears with the last one).
    await expect(confirmButtons).toHaveCount(remaining - 1)
    remaining -= 1
  }
  await expect(doctor.locator('.pilot-representation-type', { hasText: 'Kidney stones' })).toContainText('Recent creatinine')
  await doctor.getByRole('button', { name: /Confirm representation/ }).click()
  await expect(doctor.getByText(/Representation confirmed \(version \d+\)/)).toBeVisible()
  await expect(doctor.locator('.pilot-setup-done')).toContainText('Shadow mode')

  await doctor.goto('/me/agent')
  await expect(doctor.locator('.pilot-lifecycle-line')).toContainText(/Shadow/i)
})
