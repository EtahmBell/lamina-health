/* Shared steps for the accounts-and-access specs (14, 15) and screenshots. Credentials are generated
 * per run by the invitee fixture and never printed; the invitation link is read from the page the
 * admin sees and never logged. */
import type { Page } from '@playwright/test'
import { expect, totpCode, type Invitee } from './fixtures.ts'

export async function invite(admin: Page, email: string, role: 'Staff' | 'Physician', label: string): Promise<string> {
  await admin.goto('/me/practice')
  const section = admin.getByRole('region', { name: 'Invite someone' })
  await section.getByLabel(role, { exact: true }).check()
  await section.getByLabel('Their email address').fill(email)
  await section.getByLabel(/Name or role/).fill(label)
  await section.getByRole('button', { name: 'Create invitation' }).click()
  const created = section.locator('.pilot-invite-created')
  await expect(created).toContainText(`Send this link to ${email}.`)
  await expect(created).toContainText('It won’t be shown again')
  const link = new URL(await created.getByRole('textbox', { name: 'Invitation link' }).inputValue())
  // Off the screen at once (as an admin would after copying it), so no later failure screenshot shows it.
  await created.getByRole('button', { name: 'Done — hide the link' }).click()
  await expect(section.locator('.pilot-invite-created')).toHaveCount(0)
  expect(link.pathname).toBe('/me/join')
  return `${link.pathname}${link.search}`
}

export async function createAccountFromInvitation(newcomer: Invitee, path: string) {
  const page = newcomer.page
  await page.goto(path)
  await expect(page.getByRole('heading', { name: 'You’ve been invited to Lamina' })).toBeVisible()
  await page.getByRole('button', { name: 'Create account' }).click()
  await expect(page.getByRole('heading', { name: 'Create your account' })).toBeVisible()
  await page.getByLabel('Email').fill(newcomer.email)
  await page.getByLabel('Password', { exact: true }).fill(newcomer.password)
  await page.getByLabel('Confirm password').fill(newcomer.password)
  await page.getByRole('button', { name: 'Create account' }).click()
}

/** First sign-in: set up the authenticator (reads the setup key the page shows) and verify. */
export async function setUpTwoStep(page: Page): Promise<string> {
  await expect(page.getByRole('heading', { name: 'Set up two-step sign-in' })).toBeVisible()
  await page.getByRole('button', { name: 'Set up my authenticator' }).click()
  const key = (await page.getByLabel('Setup key').innerText()).trim()
  await page.getByLabel('6-digit code').fill(totpCode(key))
  await page.getByRole('button', { name: 'Verify' }).click()
  return key
}
