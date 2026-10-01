import assert from 'node:assert/strict'
import { test } from 'node:test'
import { membershipLabel, networkRoster, physicianInitials, rosterSize } from '../src/networkRoster.ts'

const node = (npi, name, specialty, extra = {}) => ({
  id: `agent-${npi}`, physician_id: `physician-${name.split(' ').at(-1).toLowerCase()}`, npi, name, specialty,
  subspecialty: '', location: 'Oakland, CA', status: 'reserved', source: 'SYNTHETIC', focus_areas: [],
  required_workup: [], explicit_rules: [], confirmed_preferences: null, provenance: 'synthetic',
  relationship: null, in_network: false, added_at: null, ...extra,
})
const relationship = (count, recommended, when) => ({
  source_agent: 'agent-pcp-lianne-cha', target_agent: 'x', relationship_type: recommended ? 'recommended' : 'consulted',
  consultation_count: count, recommended_count: recommended, redirect_count: 0,
  most_recent_interaction: when, last_patient_id: 'p', last_patient_name: 'Jordan Lee',
  last_record_id: 13, associated_consultation_ids: [13],
})

const network = {
  center: { id: 'agent-pcp-lianne-cha', name: "Dr. Lucy Saru's Agent", specialty: 'Primary Care', location: 'Oakland, CA', status: 'active', source: 'demo' },
  nodes: [
    node('9900000001', 'Dr. Iain Jung', 'Nephrology', { relationship: relationship(8, 8, '2026-09-30T08:03:51+00:00') }),
    node('9900000002', 'Dr. Matthew Onadeko', 'Cardiology', { relationship: relationship(8, 0, '2026-09-30T08:03:51+00:00') }),
    node('9900000006', 'Dr. Sofia Alvarez', 'Gastroenterology', { relationship: relationship(5, 5, '2026-09-21T18:06:00+00:00') }),
    node('9900000008', 'Dr. Claire Wu', 'Gastroenterology', { in_network: true, added_at: '2026-09-29T10:00:00+00:00' }),
    node('9900000009', 'Dr. Daniel Kim', 'Internal Medicine'),
  ],
  members: [],
  record_count: 13, relationship_source: 'records', status_note: '',
}

test('the roster holds consulted physicians, added physicians, and both', () => {
  const groups = networkRoster(network)
  const everyone = groups.flatMap((group) => group.members)
  assert.deepEqual(everyone.map((member) => member.name).sort(), [
    'Dr. Claire Wu', 'Dr. Iain Jung', 'Dr. Matthew Onadeko', 'Dr. Sofia Alvarez',
  ], 'an untouched roster physician is not in the clinician network')
  assert.equal(everyone.find((member) => member.name === 'Dr. Iain Jung').source, 'consulted')
  assert.equal(everyone.find((member) => member.name === 'Dr. Claire Wu').source, 'added')
  assert.equal(rosterSize(groups), 4)
})

test('a physician who was both consulted and added reports both', () => {
  const both = networkRoster({
    ...network,
    nodes: [node('9900000001', 'Dr. Iain Jung', 'Nephrology', {
      relationship: relationship(8, 8, '2026-09-30T08:03:51+00:00'), in_network: true, added_at: '2026-09-29T10:00:00+00:00',
    })],
  })
  assert.equal(both[0].members[0].source, 'both')
  assert.equal(membershipLabel('both'), 'In your network · consulted through Lamina')
  assert.equal(membershipLabel('added'), 'In your network')
  assert.equal(membershipLabel('consulted'), 'Consulted through Lamina')
})

test('membership never implies agent activation', () => {
  const wu = networkRoster(network).flatMap((group) => group.members).find((member) => member.name === 'Dr. Claire Wu')
  assert.equal(wu.status, 'reserved', 'an added physician keeps their own agent state')
  assert.equal(wu.consultationCount, 0)
  assert.equal(wu.lastInteraction, null, 'adding a relationship creates no consultation history')
})

test('physicians are grouped by their actual specialty, routing destinations first', () => {
  const groups = networkRoster(network)
  assert.deepEqual(groups.map((group) => group.specialty), ['Nephrology', 'Gastroenterology', 'Cardiology'])
  assert.deepEqual(groups[1].members.map((member) => member.name), ['Dr. Sofia Alvarez', 'Dr. Claire Wu'])
})

test('a physician outside the consult roster is listed but is not a graph node', () => {
  const groups = networkRoster({
    ...network,
    members: [{
      npi: '1234567893', added_at: '2026-09-30T09:00:00+00:00', resolved: true, name: 'Jane Smith, MD',
      specialty: 'Dermatology', location: 'Berkeley, CA', agent_id: 'agent-1234567893',
      status: 'reserved', source: 'NPPES',
    }],
  })
  const derm = groups.find((group) => group.specialty === 'Dermatology')
  assert.equal(derm.members[0].source, 'added')
  assert.equal(derm.members[0].inGraph, false)
  assert.equal(derm.members[0].initials, 'JS')
  assert.equal(derm.members[0].consultationCount, 0)
})

test('an unresolvable relationship is reported honestly, with no assumed agent state', () => {
  const groups = networkRoster({
    ...network,
    members: [{
      npi: '1234567893', added_at: '2026-09-30T09:00:00+00:00', resolved: false, name: 'NPI 1234567893',
      specialty: 'Specialty unavailable', location: '', agent_id: null, status: null, source: null,
    }],
  })
  const unknown = groups.find((group) => group.specialty === 'Specialty unavailable').members[0]
  assert.equal(unknown.resolved, false)
  assert.equal(unknown.status, null)
  assert.equal(unknown.initials, '··')
})

test('initials come from the physician name', () => {
  assert.equal(physicianInitials('Dr. Iain Jung'), 'IJ')
  assert.equal(physicianInitials('Jane Smith, MD'), 'JS')
})

test('an empty network produces no groups', () => {
  assert.deepEqual(networkRoster({ ...network, nodes: [], members: [] }), [])
})
