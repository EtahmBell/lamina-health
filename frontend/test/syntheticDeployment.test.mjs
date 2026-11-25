import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { SYNTHETIC_BANNER_TEXT, isSyntheticDeployment } from '../src/syntheticDeployment.ts'

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
