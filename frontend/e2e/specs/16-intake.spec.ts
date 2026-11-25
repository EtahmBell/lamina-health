/* Run 3: the intake pipeline end to end, on synthetic fixtures (scripts/intake_fixtures.py).
 * 1. upload -> extract -> create referral (staff confirm the proposals) -> triage -> Verify;
 * 2. a faxed reply -> suggested match to the open information request -> attach -> Verify;
 * 3. a duplicate patient: suggested, never merged automatically; merged by a person, then undone. */
import { createHmac } from 'node:crypto'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { expect, seedStep, test } from '../support/fixtures.ts'
import { API_URL, E2E_FAX_WEBHOOK_SECRET, seedState } from '../support/env.ts'

function intakeState() {
  seedStep('intake-scenarios')
  const intake = seedState().intake
  if (!intake) throw new Error('intake-scenarios seed step did not run')
  return intake
}

async function sendFax(fixtures: string, name: string, to: string, from: string): Promise<void> {
  const body = JSON.stringify({
    event_id: `e2e-${name}-${Date.now()}`, to, from,
    document: { filename: name, content_type: 'application/pdf', data_base64: readFileSync(path.join(fixtures, name)).toString('base64') },
  })
  const timestamp = Math.floor(Date.now() / 1000)
  const signature = createHmac('sha256', E2E_FAX_WEBHOOK_SECRET).update(`${timestamp}.${body}`).digest('hex')
  const response = await fetch(`${API_URL}/api/public/inbound/fax/mock`, {
    method: 'POST', body, headers: { 'Content-Type': 'application/json', 'X-Lamina-Mock-Signature': `t=${timestamp},v1=${signature}` },
  })
  expect(response.status).toBe(200)
}

test('upload → extract → create referral → triage → Verify; physicians see Intake read-only', async ({ as }) => {
  const { fixtures } = intakeState()
  const staff = await as('staff')
  await staff.goto('/me/intake')
  await expect(staff.getByRole('heading', { level: 1 })).toHaveText('Received documents')
  await staff.getByLabel('Upload referral documents').setInputFiles(path.join(fixtures, 'old-result-referral.pdf'))
  await expect(staff).toHaveURL(/\/me\/intake\?item=/)
  const item = staff.getByRole('article', { name: /Intake item: Avery Quartz-Synthetic/ })
  await expect(item.getByLabel('What was read from it')).toContainText('1959-05-30')
  await expect(item.getByLabel('Received document')).toContainText('Last HbA1c 7.6% drawn 2025-12-01.')
  await expect(item).toContainText('proposals — check before using')

  // The physician sees the same item read-only until choosing to act.
  const physician = await as('physician')
  await physician.goto(staff.url().replace(/^https?:\/\/[^/]+/, ''))
  await expect(physician.getByRole('note').filter({ hasText: 'read-only' }).first()).toBeVisible()
  await expect(physician.getByRole('button', { name: 'Create referral…' })).toHaveCount(0)
  await expect(physician.getByRole('button', { name: 'Act on this item' })).toBeVisible()

  // Staff confirm the prefilled proposals and create the referral.
  await item.getByRole('button', { name: 'Create referral…' }).click()
  const form = staff.getByRole('form', { name: 'Create a referral from this document' })
  await expect(form.getByLabel('Patient name')).toHaveValue('Avery Quartz-Synthetic')
  await expect(form.getByLabel('Referral type')).toHaveValue('Diabetes management')
  await expect(form.getByLabel('A new patient record')).toBeChecked()
  await form.getByRole('button', { name: 'Create referral and triage' }).click()
  await expect(staff).toHaveURL(/\/me\/referrals\/ref_/)

  // Triage proposes the dated results; an old one is flagged against the rule's window; nothing is verified yet.
  const a1c = staff.locator('.pilot-requirement', { hasText: 'Recent HbA1c' })
  await expect(a1c).toContainText('Outside the window.')
  await expect(a1c).toContainText('outside the rule’s 180-day window')
  const renal = staff.locator('.pilot-requirement', { hasText: 'Renal function' })
  await renal.getByRole('button', { name: 'Confirm from document: Renal function' }).click()
  await expect(renal.getByLabel('Date of result')).toHaveValue('2026-09-30')
  await renal.getByRole('button', { name: 'Save' }).click()
  await expect(staff.locator('.pilot-requirement', { hasText: 'Renal function' })).toContainText('Satisfied')
})

test('a faxed reply is matched to its information request, attached, then verified', async ({ as }) => {
  const { fixtures, fax_number: faxNumber, reply_referral: referralId } = intakeState()
  await sendFax(fixtures, 'info-reply-fax.pdf', faxNumber, '(555) 010-0199')
  const staff = await as('staff')
  await staff.goto('/me/intake')
  const row = staff.locator('.pilot-intake-row', { hasText: 'Robin Lumen-Synthetic' }).first()
  await expect(row).toContainText('May answer a request')
  await row.click()
  const suggestion = staff.getByRole('group', { name: 'Possible reply to an information request' })
  await expect(suggestion).toContainText('from the fax/phone the request went to')
  await suggestion.getByRole('button', { name: 'Yes — attach as the reply' }).click()
  await expect(staff).toHaveURL(new RegExp(`/me/referrals/${referralId}`))
  // Verify: the faxed TSH is a proposal until a person confirms it.
  const tsh = staff.locator('.pilot-requirement', { hasText: 'Recent TSH' })
  await expect(tsh).toContainText('Possibly in a document')
  await tsh.getByRole('button', { name: 'Confirm from document: Recent TSH' }).click()
  await tsh.getByRole('button', { name: 'Save' }).click()
  await expect(staff.locator('.pilot-requirement', { hasText: 'Recent TSH' })).toContainText('Satisfied')
  // The routed item records what happened.
  await staff.goto('/me/intake')
  await staff.getByRole('tab', { name: 'Routed' }).click()
  await staff.locator('.pilot-intake-row', { hasText: 'Robin Lumen-Synthetic' }).first().click()
  await expect(staff.getByRole('status').filter({ hasText: 'Answered an information request' })).toBeVisible()
})

test('a duplicate patient is suggested, merged only on confirmation, and the merge can be undone', async ({ as }) => {
  const { fixtures, existing_patient: existingPatient } = intakeState()
  const staff = await as('staff')
  await staff.goto('/me/intake')
  await staff.getByLabel('Upload referral documents').setInputFiles(path.join(fixtures, 'duplicate-patient-b-scan.png'))
  const item = staff.getByRole('article', { name: /Intake item: MORGAN RIVERA-SYNTHETIC/ })
  await expect(item).toContainText('Likely an existing patient')
  await expect(item.getByRole('img', { name: /Received document/ })).toBeVisible()
  await item.getByRole('button', { name: 'Create referral…' }).click()
  const form = staff.getByRole('form', { name: 'Create a referral from this document' })
  await expect(form.getByLabel('A new patient record')).toBeChecked()  // never matched automatically
  await form.getByRole('button', { name: 'Create referral and triage' }).click()
  await expect(staff).toHaveURL(/\/me\/referrals\/ref_/)
  await staff.getByRole('button', { name: 'Patient record' }).click()
  const duplicates = staff.getByRole('region', { name: 'Possible duplicates' })
  await expect(duplicates).toContainText('Rivera-Synthetic, Morgan')
  await duplicates.getByRole('button', { name: 'Same patient — merge…' }).click()
  await duplicates.getByRole('button', { name: /Confirm: merge this record into/ }).click()
  await expect(staff).toHaveURL(new RegExp(`/me/patients/${existingPatient}`))
  const history = staff.getByRole('region', { name: 'Merge history' })
  await expect(history).toContainText('1 referral moved')
  await history.getByRole('button', { name: 'Undo merge' }).click()
  await expect(staff.getByRole('region', { name: 'Merge history' })).toContainText('undone')
})
