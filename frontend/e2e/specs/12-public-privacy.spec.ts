/* Nothing private reaches the public practice page or the sender page: no representation
 * internals, pending learnings, judgment notes, staff names, or other patients' referrals. */
import { expect, test } from '../support/fixtures.ts'
import { API_URL } from '../support/env.ts'

test('public and sender pages show nothing private', async ({ as, seed, request }) => {
  const office = await as('office')
  const forbidden = seed.private_markers
  await office.goto(`/p/${seed.public_slug}`)
  await expect(office.locator('main, body').first()).toContainText(seed.practice_a.name)
  const publicText = await office.locator('body').innerText()
  for (const marker of forbidden) expect(publicText, `public page must not show "${marker}"`).not.toContain(marker)
  const publicJson = JSON.stringify(await (await request.get(`${API_URL}/api/public/p/${seed.public_slug}`)).json())
  for (const marker of forbidden) expect(publicJson, `public API must not return "${marker}"`).not.toContain(marker)

  // The sender page legitimately lists what was requested; everything else stays private.
  const senderForbidden = [...forbidden.filter((marker) => marker !== 'Thyroid ultrasound'), 'Stone StillOpen-E2E', 'Sato Signoff-E2E']
  await office.goto(`/r/${seed.sender_token}`)
  await expect(office.getByText('Information requested')).toBeVisible()
  const senderText = await office.locator('body').innerText()
  for (const marker of senderForbidden) expect(senderText, `sender page must not show "${marker}"`).not.toContain(marker)
  const senderJson = JSON.stringify(await (await request.get(`${API_URL}/api/public/r/${seed.sender_token}`)).json())
  for (const marker of senderForbidden) expect(senderJson, `sender API must not return "${marker}"`).not.toContain(marker)
})
