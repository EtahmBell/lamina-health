/* A physician's earlier correction that a newer rule disagrees with: banner for everyone,
 * choices for the physician only, each choice recorded. */
import { expect, inspect, nextStep, openReferral, test } from '../support/fixtures.ts'

type Resolution = { field: string; choice: string; rule_version: number; actor_role: string }

test('staff see the conflict read-only; the physician keeps the correction', async ({ as, seed }) => {
  const doctor = seed.practice_a.physician_name
  const staff = await as('staff')
  await openReferral(staff, seed.referrals.conflict_keep)
  const staffBanner = staff.locator('.pilot-conflict')
  await expect(staffBanner).toContainText(`Visit type: ${doctor}’s earlier correction (in-person) differs from ${doctor}’s updated rule (either, Osteoporosis v2). The correction still applies.`)
  await expect(staffBanner.getByRole('button')).toHaveCount(0)

  const physician = await as('physician')
  await openReferral(physician, seed.referrals.conflict_keep)
  const banner = physician.locator('.pilot-conflict')
  await expect(banner).toContainText('Visit type: your earlier correction (in-person) differs from your updated rule (either, Osteoporosis v2)')
  await banner.getByRole('button', { name: 'Keep my correction' }).click()
  await expect(physician.locator('.pilot-conflict')).toHaveCount(0)
  await expect(nextStep(physician)).toContainText('In-person visit')
  await physician.reload()
  await expect(nextStep(physician)).toBeVisible()
  await expect(physician.locator('.pilot-conflict')).toHaveCount(0)
  expect(inspect<Resolution[]>('resolutions', seed.referrals.conflict_keep)).toEqual([
    { field: 'suggested_modality', choice: 'keep_correction', rule_version: 2, actor_role: 'physician' }])
})

test('the physician applies the updated rule instead', async ({ as, seed }) => {
  const doctor = seed.practice_a.physician_name
  const physician = await as('physician')
  await openReferral(physician, seed.referrals.conflict_apply)
  await physician.locator('.pilot-conflict').getByRole('button', { name: 'Apply the rule' }).click()
  await expect(physician.locator('.pilot-conflict')).toHaveCount(0)
  await expect(nextStep(physician)).toContainText(`Visit type: in-person → either (by ${doctor})`)
  await expect(nextStep(physician)).toContainText('Either')
  expect(inspect<Resolution[]>('resolutions', seed.referrals.conflict_apply)).toEqual([
    { field: 'suggested_modality', choice: 'apply_rule', rule_version: 2, actor_role: 'physician' }])
})
