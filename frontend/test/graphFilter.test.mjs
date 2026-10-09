import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'

const network = readFileSync(new URL('../src/PhysicianNetwork.tsx', import.meta.url), 'utf8')

/* Dashboard+Network polish pass: the network graph/visualization is removed from
 * Network → Colleagues entirely (not collapsed). graphFilter.ts, the visualization's
 * only consumer, was removed with it. */
test('the network graph/visualization is gone from Colleagues, not merely collapsed', () => {
  assert.doesNotMatch(network, /function NetworkGraph/)
  assert.doesNotMatch(network, /function AgentDetail/)
  assert.doesNotMatch(network, /network-visual-section/)
  assert.doesNotMatch(network, /agent-network-stage/)
  assert.doesNotMatch(network, /GraphFilter|graphVisibility/)
})

test('Colleagues still renders the physician list directly -- ranked by connection, not grouped by specialty (Network+Feed refinement pass)', () => {
  assert.match(network, /rankedNetworkList\(network\)/)
  assert.match(network, /Most connected in your network/)
  assert.doesNotMatch(network, /networkRoster\(network\)|network-specialty-group/)
})
