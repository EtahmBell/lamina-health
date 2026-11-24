/* Step 18: readiness review and physician-approved activation, across roles.
 * Physician A has enough shadow history (seeded); the second physician does not. Runs last: it
 * turns drafting on, and ends by pausing everything. */
import { seedState } from '../support/env.ts'
import { expect, nextStep, openReferral, seedStep, test } from '../support/fixtures.ts'

const READINESS = '/me/agent?tab=readiness'

test('a physician without enough shadow history sees why, and no way to turn it on', async ({ as }) => {
  const second = await as('second_physician')
  await second.goto(READINESS)
  const drafting = second.locator('.pilot-capability', { hasText: 'Draft missing-information requests' })
  await expect(drafting).toContainText('Not eligible yet')
  await expect(drafting).toContainText(/Needs \d+ more decided referrals?/)
  await expect(drafting.getByRole('button', { name: 'Turn on' })).toHaveCount(0)
  // The summary at the top says the same, with one recommended action.
  const summary = second.locator('.pilot-readiness-summary')
  await expect(summary).toContainText('Nothing yet')
  await expect(summary).toContainText(/Recommended: Keep deciding referrals as usual — .*needs \d+ more decided referrals?/)
  await expect(second.locator('.pilot-always-yours')).toContainText('Accepting, redirecting or declining a referral')
})

test('the review compares recommendations with the physician’s decisions, with raw counts', async ({ as, seed }) => {
  const physician = await as('physician')
  await physician.goto('/me/home')
  await physician.goto('/me/for-you')
  await expect(physician.getByText('Your agent’s readiness review is available')).toBeVisible()
  await physician.goto(READINESS)
  const summary = physician.locator('.pilot-readiness-summary')
  await expect(summary).toContainText('Draft missing-information requests — you can turn it on; nothing changes until you do')
  await summary.getByRole('button', { name: 'Review where you disagreed' }).click()
  await expect(physician.getByRole('heading', { name: 'Where you disagreed' })).toBeFocused()
  await expect(physician.locator('.pilot-readiness-status')).toContainText(/Shadow mode since .* referrals you’ve decided/)
  const observed = physician.locator('section', { has: physician.getByRole('heading', { name: 'What your agent observed' }) })
  await expect(observed).toContainText('Diabetes management')
  await expect(observed).toContainText('Not enough cases yet')  // Adrenal nodule: one decided referral
  const compared = physician.locator('section', { has: physician.getByRole('heading', { name: 'How its recommendations compared with your decisions' }) })
  await expect(compared).toContainText(/agreed on \d+ of \d+/)
  await expect(compared).toContainText('There is no overall score.')
  await compared.getByRole('button', { name: 'All time' }).click()
  await expect(compared.getByRole('button', { name: 'All time' })).toHaveAttribute('aria-pressed', 'true')
  const disagreements = physician.locator('.pilot-disagreements li')
  await expect(disagreements.first()).toBeVisible()
  await expect(physician.locator('.pilot-disagreements').first()).toContainText('Priority: it recommended routine; you kept soon')  // values in plain words
  // "Possible fit" → declined is its own list, not mixed with the disagreements.
  const possible = physician.locator('.pilot-possible-list')
  await expect(possible).toContainText('Hart History3-E2E · Thyroid nodule')
  await expect(possible).toContainText('It said possible fit; you declined')
  await expect(physician.locator('.pilot-disagreements').first()).not.toContainText('Hart History3-E2E')
  // Each entry links to its referral.
  await possible.locator('li', { hasText: 'Hart History3-E2E' }).getByRole('button').click()
  await expect(physician).toHaveURL(/\/me\/referrals\//)
  expect(seed.history.length).toBeGreaterThanOrEqual(10)
})

test('turning drafting on: confirmation, agent draft in the staff queue, staff read-only, serious flag, pause', async ({ as }) => {
  const physician = await as('physician')
  const staff = await as('staff')
  const doctor = seedState().practice_a.physician_name
  await physician.goto(READINESS)
  const drafting = physician.locator('.pilot-capability', { hasText: 'Draft missing-information requests' })
  await expect(drafting).toContainText('Eligible to turn on.')
  await expect(drafting.locator('.pilot-capability-state')).toHaveText('Shadow')
  await expect(drafting).toContainText('In shadow, it would have drafted')
  await drafting.getByRole('button', { name: 'Turn on' }).click()
  const confirm = drafting.getByRole('group', { name: 'Turn on Draft missing-information requests' })
  await expect(confirm).toContainText('Nothing is sent without staff.')
  await confirm.getByRole('button', { name: 'Turn on' }).click()
  await expect(drafting.locator('.pilot-capability-state')).toHaveText('On')
  await expect(physician.locator('.pilot-readiness-status')).toContainText('Partly active · drafting requests on')

  // A new referral with a missing item: the agent drafts the request in the staff queue.
  seedStep('new-missing-referral')
  const rid = seedState().referrals.auto_draft!
  await openReferral(staff, rid)
  const request = staff.locator('.pilot-request')
  await expect(request).toContainText(`drafted by ${doctor}’s agent`)
  await expect(request).toContainText('Draft — needs your approval')
  // The draft doesn't change the status until staff send it, and the history says who drafted it.
  await expect(nextStep(staff).locator('.status-label')).toHaveText('Triaged · draft request ready for staff')
  await expect(staff.locator('.timeline-event h4', { hasText: `Information request drafted by ${doctor}’s agent (not sent)` })).toHaveCount(1)
  // "Ready" while a required item is missing: only after confirming it by name.
  await nextStep(staff).getByRole('button', { name: `Ready for ${doctor}` }).click()
  const missing = staff.getByRole('group', { name: 'Required items not yet verified' })
  await expect(missing).toContainText('Still missing: Thyroid ultrasound.')
  await expect(staff.getByRole('button', { name: 'Mark ready' })).toBeDisabled()
  await missing.getByRole('checkbox').check()
  await expect(staff.getByRole('button', { name: 'Mark ready' })).toBeEnabled()
  await nextStep(staff).getByRole('button', { name: 'Cancel' }).click()
  // Staff see what is on, read-only.
  await staff.goto(READINESS)
  await expect(staff.getByText(`Only ${doctor} can change this.`).first()).toBeVisible()
  await expect(staff.locator('.pilot-capability', { hasText: 'Draft missing-information requests' })).toContainText(`Last changed by ${doctor}`)
  await expect(staff.locator('.pilot-capability', { hasText: 'Draft missing-information requests' }).locator('.pilot-capability-state')).toHaveText('On')
  await expect(staff.locator('.pilot-readiness').getByRole('button')).toHaveCount(0)

  // A serious "this was wrong" returns drafting to shadow and says so on Home.
  await openReferral(physician, rid)
  await physician.locator('.pilot-request').getByRole('button', { name: /Flag this draft as wrong/ }).click()
  await physician.getByLabel('What was wrong? (optional)').fill('Asked for the wrong study (E2E)')
  await physician.getByLabel(/Serious — return drafting to shadow now/).check()
  await physician.getByRole('button', { name: 'Flag it' }).click()
  await expect(physician.getByText('Flagged as serious — drafting went back to shadow.')).toBeVisible()
  await physician.goto('/me/home')
  await expect(physician.getByRole('button', { name: /Draft missing-information requests went back to shadow/ })).toBeVisible()
  await physician.goto(READINESS)
  await expect(drafting.locator('.pilot-capability-state')).toHaveText('Shadow')
  await expect(drafting).toContainText('A serious “this was wrong” flag is unresolved')

  // Resolve, turn it back on, then pause everything in one action.
  // Resolving takes a note (what the physician found).
  await drafting.getByRole('button', { name: 'Resolve…' }).click()
  await expect(drafting.getByRole('button', { name: 'Resolve flag' })).toBeDisabled()
  await drafting.getByLabel('What did you find?').fill('Rule asked for the wrong study; fixed (E2E)')
  await drafting.getByRole('button', { name: 'Resolve flag' }).click()
  await expect(drafting).toContainText('Resolved: “Rule asked for the wrong study; fixed (E2E)”')
  await drafting.getByRole('button', { name: 'Turn on' }).click()
  await drafting.getByRole('group', { name: 'Turn on Draft missing-information requests' }).getByRole('button', { name: 'Turn on' }).click()
  await expect(drafting.locator('.pilot-capability-state')).toHaveText('On')
  await physician.getByRole('button', { name: 'Pause everything' }).click()
  await expect(drafting.locator('.pilot-capability-state')).toHaveText('Shadow')
  await expect(physician.locator('.pilot-readiness-status')).not.toContainText('Partly active')
})
