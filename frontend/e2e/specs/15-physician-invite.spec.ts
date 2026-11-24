/* Accounts and access: a second physician joins practice A by invitation. They set up two-step
 * sign-in, confirm their OWN identity (a fictional NPI), wait for the Lamina operator's approval,
 * then sign in to their own agent -- not as an admin. Runs last: it adds a physician to practice A. */
import { createAccountFromInvitation, invite, setUpTwoStep } from '../support/access.ts'
import { accountEvents, expect, seedStep, test } from '../support/fixtures.ts'

const PRACTICE = 'Northfield Endocrinology (E2E)'
const INVITED_NPI = '1234567810' // Dr. Riley Newcomb (fictional directory in scripts/dev_pilot_server.py)

test('second physician: invited, accepts, sets up MFA, confirms their own NPI, then opens their own agent', async ({ as, invitee }) => {
  const admin = await as('physician')
  const newcomer = await invitee('physician')
  const path = await invite(admin, newcomer.email, 'Physician', 'Dr. Newcomb (E2E)')
  await expect(admin.locator('.pilot-invitation', { hasText: newcomer.email })).toContainText('Invited as a physician')

  await createAccountFromInvitation(newcomer, path)
  const page = newcomer.page
  await expect(page.getByRole('heading', { name: `Join ${PRACTICE}` })).toBeVisible()
  await expect(page.getByText('confirm your own professional profile (NPI) — only you can')).toBeVisible()
  await page.getByRole('button', { name: 'Accept invitation' }).click()
  await setUpTwoStep(page)

  // Their own identity: the invitation names the practice; the NPI is theirs to confirm.
  await expect(page.getByRole('note')).toContainText(`You’re joining ${PRACTICE} as a physician`)
  await page.getByLabel('Your individual NPI').fill(INVITED_NPI)
  await page.getByRole('button', { name: 'Find my record' }).click()
  await expect(page.getByRole('heading', { name: 'Is this you?' })).toBeVisible()
  await page.getByRole('button', { name: 'Yes, this is me' }).click()

  // Joined (non-admin), waiting for the Lamina pilot approval of a new physician identity.
  await expect(page.getByRole('heading', { name: `${PRACTICE} is awaiting approval` })).toBeVisible()
  await expect(page.getByText('You’ve joined this practice and confirmed your professional profile.')).toBeVisible()
  seedStep('approve-invited-physician') // the operator approves, through the real internal API
  await page.getByRole('button', { name: 'Check status again' }).click()

  // First sign-in: their own agent (still to be set up), as a physician who is not an admin.
  await expect(page.getByRole('navigation').getByRole('button', { name: 'Your Agent' })).toBeVisible()
  await expect(page.getByText('Pilot · Physician')).toBeVisible()
  // Their own agent and lifecycle: not the admin's agent (which is already in shadow mode).
  await page.goto('/me/agent')
  const own = page.getByRole('region', { name: 'Agent setup' })
  await expect(own.getByRole('heading', { name: 'Finish telling your agent how you practise' })).toBeVisible()
  await page.goto('/me/practice')
  await expect(page.getByRole('region', { name: 'Invite someone' })).toHaveCount(0)
  await expect(page.getByText('A practice admin manages the team and practice details. You still confirm clinical statements and decide referrals.')).toBeVisible()
  await expect(page.locator('.pilot-member', { hasText: '· you' })).toContainText('Physician')
  await expect(page.locator('.pilot-member', { hasText: '· you' })).not.toContainText('admin')

  // The admin sees the new physician on the team; the audit trail has every step.
  await admin.goto('/me/practice')
  await expect(admin.locator('.pilot-member', { hasText: 'Dr. Newcomb (E2E)' })).toContainText('Physician')
  const types = accountEvents().map((event) => event.type)
  for (const type of ['physician_invited', 'physician_invitation_accepted', 'physician_joined']) expect(types).toContain(type)
})
