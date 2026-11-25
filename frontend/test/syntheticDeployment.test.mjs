import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { SYNTHETIC_BANNER_TEXT, aiLimitedText, isSyntheticDeployment } from '../src/syntheticDeployment.ts'

const source = (name) => readFileSync(new URL(`../src/${name}`, import.meta.url), 'utf8')

test('the synthetic-deployment strip shows only when the API says so', () => {
  assert.equal(isSyntheticDeployment({ status: 'ok', data_mode: 'synthetic', deployment: 'synthetic' }), true)
  assert.equal(isSyntheticDeployment({ status: 'ok', data_mode: 'synthetic' }), false, 'local dev / e2e: no strip')
  assert.equal(isSyntheticDeployment({ deployment: 'production' }), false)
  assert.equal(isSyntheticDeployment(null), false)
  assert.match(SYNTHETIC_BANNER_TEXT, /^Synthetic demo · no PHI/)
})

test('the strip is mounted above every route, demo and pilot, and is never hidden on small screens', () => {
  assert.match(source('main.tsx'), /<SyntheticDeploymentBanner \/><App \/>/)
  const css = source('styles.css')
  assert.match(css, /\.synthetic-deployment-banner \{ position: sticky; top: 0;/)
  assert.doesNotMatch(css, /\.synthetic-deployment-banner \{ display: none/)
  assert.doesNotMatch(css, /\.synthetic-deployment-banner[^{]*\{[^}]*display:\s*none/)
})

test('when the demo hits an AI limit, the page says so and that it fell back to non-AI answers', () => {
  assert.match(aiLimitedText('daily_cap'), /paused for today .*daily limit reached.*non-AI responses/)
  assert.match(aiLimitedText('session'), /paused for a few minutes .*non-AI responses/)
  const api = source('api.ts')
  assert.match(api, /response\.headers\.get\(AI_LIMITED_HEADER\)/)
  assert.match(api, /export const AI_LIMITED_HEADER = 'X-Lamina-AI-Limited'/)
  assert.match(source('SyntheticDeploymentBanner.tsx'), /globalThis\.addEventListener\(AI_LIMITED_EVENT, onLimited\)/)
})
