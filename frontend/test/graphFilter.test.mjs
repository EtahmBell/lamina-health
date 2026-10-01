import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { DEFAULT_GRAPH_FILTER, GRAPH_FILTERS, graphVisibility } from '../src/graphFilter.ts'

const network = readFileSync(new URL('../src/PhysicianNetwork.tsx', import.meta.url), 'utf8')
const styles = readFileSync(new URL('../src/styles.css', import.meta.url), 'utf8')
const slice = (source, from, to) => source.slice(source.indexOf(from), source.indexOf(to))
const graph = () => slice(network, 'function NetworkGraph', 'function AgentDetail')

const edge = (agentId, { recommended = 0, redirected = 0, consultations = 1 } = {}) => ({
  source_agent: 'agent-pcp-lianne-cha', target_agent: agentId,
  relationship_type: recommended ? 'recommended' : redirected === consultations ? 'redirected' : 'consulted',
  consultation_count: consultations, recommended_count: recommended, redirect_count: redirected,
  most_recent_interaction: '2026-10-01T11:18:00+00:00', last_patient_id: 'p', last_patient_name: 'Jordan Lee',
  last_record_id: 9, associated_consultation_ids: [9],
  most_recent_recommendation: recommended ? '2026-10-01T11:18:00+00:00' : null,
  last_recommendation_patient_id: null, last_recommendation_patient_name: null,
  last_recommendation_record_id: recommended ? 9 : null,
})

/* Jung was recommended, Onadeko was queried then redirected, Bell was consulted
   without being chosen, and Brooks has no interaction at all. */
const JUNG = 'agent-9900000001'
const ONADEKO = 'agent-9900000002'
const BELL = 'agent-9900000003'
const BROOKS = 'agent-9900000007'

const projection = {
  center: { id: 'agent-pcp-lianne-cha', name: "Dr. Lucy Saru's Agent", specialty: 'Primary Care', location: 'Oakland, CA', status: 'active', source: 'demo' },
  nodes: [JUNG, ONADEKO, BELL, BROOKS].map((id) => ({ id, physician_id: id, npi: id.slice(6), name: id, specialty: 'x', subspecialty: '', location: '', status: 'reserved', source: 'SYNTHETIC', focus_areas: [], required_workup: [], explicit_rules: [], confirmed_preferences: null, provenance: '', relationship: null, in_network: false, added_at: null })),
  edges: [
    edge(JUNG, { recommended: 8, consultations: 8 }),
    edge(ONADEKO, { redirected: 8, consultations: 8 }),
    edge(BELL, { consultations: 8 }),
  ],
  members: [], record_count: 8, relationship_source: 'records', status_note: '',
}
const shown = (filter) => projection.nodes
  .filter((node) => graphVisibility(projection, filter).visible(node.id))
  .map((node) => node.id)

test('All is the default filter', () => {
  assert.equal(DEFAULT_GRAPH_FILTER, 'all')
  assert.deepEqual(GRAPH_FILTERS.map((option) => option.id), ['recommended', 'consulted', 'all'])
  assert.deepEqual(GRAPH_FILTERS.map((option) => option.label), ['Recommended', 'Consulted', 'All'])
  assert.match(network, /useState<GraphFilter>\(DEFAULT_GRAPH_FILTER\)/)
})

test('Recommended keeps only real recommendation destinations', () => {
  assert.deepEqual(shown('recommended'), [JUNG])
  assert.equal(shown('recommended').includes(ONADEKO), false, 'a redirected-only physician is not a destination')
  assert.equal(shown('recommended').includes(BELL), false, 'a queried-only physician is not a destination')
})

test('Consulted includes every actual participant, not just the consulted edge type', () => {
  assert.deepEqual(shown('consulted'), [JUNG, ONADEKO, BELL])
  const types = projection.edges.map((item) => item.relationship_type).sort()
  assert.deepEqual(types, ['consulted', 'recommended', 'redirected'], 'all three outcomes are represented')
  assert.equal(shown('consulted').includes(BROOKS), false, 'a physician with no interaction did not participate')
})

test('All uses the full supplied node set, including no-interaction nodes', () => {
  assert.deepEqual(shown('all'), [JUNG, ONADEKO, BELL, BROOKS])
  assert.equal(shown('all').length, projection.nodes.length, 'no node is dropped and none is invented')
})

test('filtering never invents an edge', () => {
  for (const filter of ['recommended', 'consulted', 'all']) {
    const { edges } = graphVisibility(projection, filter)
    assert.equal(edges.size, projection.edges.length)
    assert.equal(edges.get(BROOKS), undefined)
  }
})

test('an empty projection is handled without inventing participation', () => {
  const empty = { ...projection, edges: [] }
  assert.deepEqual(projection.nodes.filter((n) => graphVisibility(empty, 'recommended').visible(n.id)), [])
  assert.deepEqual(projection.nodes.filter((n) => graphVisibility(empty, 'consulted').visible(n.id)), [])
  assert.equal(projection.nodes.filter((n) => graphVisibility(empty, 'all').visible(n.id)).length, 4)
})

/* ------------------------------------------------------------------- UI */

test('the central agent is outside the filter and always rendered', () => {
  const centre = graph().slice(graph().indexOf('agent-network-center'), graph().indexOf('placed.map(({ agent, slot }) => <button'))
  assert.match(centre, /network\.center\.name/)
  assert.doesNotMatch(centre, /visible\(|filter/, 'the centre is never filtered out')
  assert.match(graph(), /\.filter\(\(entry\) => visible\(entry\.agent\.id\)\)/, 'only physician nodes are filtered')
})

test('filtering changes visibility, never node position', () => {
  assert.match(graph(), /graphRoster\s*\n?\s*\.map\(\(id, index\) => \(\{ agent: [^}]*slot: graphSlots\[index\] \}\)\)/)
  assert.match(graph(), /`\$\{slot\.x\}%`/)
  assert.doesNotMatch(graph(), /graphSlots\[index\]\.x/, 'slots are bound to the physician, not the filtered index')
})

test('a hidden physician cannot keep an open detail panel', () => {
  assert.match(network, /if \(!graphVisibility\(network, graphFilter\)\.visible\(selectedId\)\) setSelectedId\(null\)/)
  assert.match(network, /\}, \[network, selectedId, graphFilter\]\)/)
  assert.match(network, /\{selected && <AgentDetail/, 'the panel renders only from a live selection')
})

test('the control is a restrained, accessible segmented group', () => {
  assert.match(graph(), /role="group" aria-label="Show physician agents"/)
  assert.match(graph(), /aria-pressed=\{filter === option\.id\}/)
  assert.match(graph(), /className=\{filter === option\.id \? 'active' : ''\}/)
  assert.match(graph(), /type="button"/)
  assert.doesNotMatch(graph(), /<select|dropdown/, 'no dropdown complexity')
  assert.match(styles, /\.graph-filter button\.active \{[^}]*background: #f3e7db/)
  assert.match(styles, /\.graph-filter button:focus-visible/)
  assert.ok(/\.graph-filter button \{[^}]*font-size: \.58rem/.test(styles), 'the control stays small')
})

test('the legend still explains the three edge meanings', () => {
  const legend = graph().slice(graph().indexOf('agent-network-legend'), graph().indexOf('graph-filter'))
  assert.match(legend, /legend-recommended/)
  assert.match(legend, /legend-consulted/)
  assert.match(legend, /legend-redirected/)
  assert.doesNotMatch(legend, /aria-pressed/, 'the legend is not a control')
})

test('node transitions stay subtle and respect reduced motion', () => {
  assert.match(styles, /@keyframes graph-node-in \{ from \{ opacity: 0; \} to \{ opacity: 1; \} \}/)
  assert.match(styles, /@media \(prefers-reduced-motion: reduce\) \{\s*\.graph-filter button \{ transition: none; \}\s*\.agent-network-node \{ animation: none; \}/)
})
