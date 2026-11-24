/* Accounts and access: a new staff member, from the admin's invitation to their first and second
 * sign-in with two-step sign-in. The newcomer is a brand-new account on the dev-only test sign-in
 * (generated per run, never printed); the admin is the captured physician session. */
import { createAccountFromInvitation, invite, setUpTwoStep } from '../support/access.ts'
import { accountEvents, expect, test, totpCode } from '../support/fixtures.ts'

const PRACTICE = 'Northfield Endocrinology (E2E)'

test('staff: invited by email, accepts, sets up two-step sign-in, then signs in with a code', async ({ as, invitee }) => {
  const admin = await as('physician')
  const newcomer = await invitee('staff')
  const path = await invite(admin, newcomer.email, 'Staff', 'Intake desk (E2E)')
  await expect(admin.locator('.pilot-invitation', { hasText: newcomer.email })).toContainText('Invited as staff · Intake desk (E2E) · pending')

  // Invite → own account (never shared) → accept.
  await createAccountFromInvitation(newcomer, path)
  const page = newcomer.page
  await expect(page.getByRole('heading', { name: `Join ${PRACTICE}` })).toBeVisible()
  await expect(page.getByText('You’ll join as staff')).toBeVisible()
  await page.getByRole('button', { name: 'Accept invitation' }).click()

  // MFA before anything about the practice; then the first sign-in lands in the workspace.
  const key = await setUpTwoStep(page)
  await expect(page.getByRole('navigation').getByRole('button', { name: 'Home' })).toBeVisible()
  await expect(page.getByText('Pilot · Staff')).toBeVisible()

  // Every later sign-in: password, then a code.
  await page.getByRole('button', { name: 'Account menu' }).click()
  await page.getByRole('menuitem', { name: 'Sign out' }).click()
  await page.goto('/claim/sign-in?return=%2Fme%2Fhome')
  await page.getByLabel('Email').fill(newcomer.email)
  await page.getByLabel('Password').fill(newcomer.password)
  await page.getByRole('main').getByRole('button', { name: /^Sign in/ }).click()
  await expect(page.getByRole('heading', { name: 'Enter your code' })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Lost your authenticator?' })).toBeVisible()
  await page.getByLabel('6-digit code').fill(totpCode(key))
  await page.getByRole('button', { name: 'Verify' }).click()
  await expect(page.getByRole('navigation').getByRole('button', { name: 'Home' })).toBeVisible()

  // The audit trail has the invitation, the acceptance and the MFA enrollment.
  const events = accountEvents()
  for (const type of ['staff_invited', 'staff_joined']) expect(events.map((event) => event.type)).toContain(type)
  expect(events.some((event) => event.type === 'mfa_enrolled' && event.by_invitee)).toBe(true)

  // Deactivation: the admin ends access; the member's next request shows it.
  await admin.goto('/me/practice')
  const row = admin.locator('.pilot-member', { hasText: 'Intake desk (E2E)' })
  await row.getByRole('button', { name: 'Deactivate…' }).click()
  const confirm = admin.getByRole('group', { name: 'Deactivate Intake desk (E2E)' })
  await expect(confirm).toContainText('Their past work stays in the history under their name.')
  await confirm.getByRole('button', { name: 'Deactivate' }).click()
  await expect(admin.locator('.pilot-member', { hasText: 'Intake desk (E2E)' })).toHaveCount(0)
  await page.reload()
  await expect(page.getByRole('heading', { name: 'You’ve been signed out' }).or(page.getByRole('heading', { name: `Your access to ${PRACTICE} has ended` }))).toBeVisible()
  expect(accountEvents().map((event) => event.type)).toContain('member_deactivated')
})

test('an invitation is bound to its email, and a revoked invitation stops working', async ({ as, invitee }) => {
  const admin = await as('physician')
  const intended = await invitee('intended')
  const someoneElse = await invitee('other')
  const path = await invite(admin, intended.email, 'Staff', 'Revoked desk (E2E)')
  // Someone else with the link can't use it.
  await createAccountFromInvitation(someoneElse, path)
  await expect(someoneElse.page.getByText('This invitation was sent to a different email address.')).toBeVisible()
  await expect(someoneElse.page.getByRole('button', { name: 'Accept invitation' })).toHaveCount(0)
  // Revoked: the intended person can't use it either.
  await admin.goto('/me/practice')
  await admin.locator('.pilot-invitation', { hasText: intended.email }).getByRole('button', { name: 'Revoke' }).click()
  await expect(admin.locator('.pilot-invitation', { hasText: intended.email })).toHaveCount(0)
  await createAccountFromInvitation(intended, path)
  await expect(intended.page.getByRole('heading', { name: 'This invitation can’t be used' })).toBeVisible()
  expect(accountEvents().map((event) => event.type)).toContain('staff_invitation_revoked')
})
