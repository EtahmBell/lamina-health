import type { AgentNetwork, AgentRelationship } from './api.ts'

/** Which physician agents the visualization shows. Edge meaning is unaffected. */
export type GraphFilter = 'recommended' | 'consulted' | 'all'

export const GRAPH_FILTERS: { id: GraphFilter; label: string }[] = [
  { id: 'recommended', label: 'Recommended' },
  { id: 'consulted', label: 'Consulted' },
  { id: 'all', label: 'All' },
]

export const DEFAULT_GRAPH_FILTER: GraphFilter = 'all'

/**
 * One derivation shared by the graph and the detail panel.
 *
 * The backend creates an edge only where a consultation actually happened, so an
 * edge is proof of participation:
 *
 *   all          every node in the supplied projection, including roster nodes
 *                that have no interaction at all
 *   consulted    any node with an edge — recommended, consulted or redirected
 *                participants alike, not only the literal `consulted` type
 *   recommended  only nodes that were an actual recommendation destination
 */
export function graphVisibility(network: AgentNetwork, filter: GraphFilter) {
  const edges = new Map<string, AgentRelationship>(network.edges.map((edge) => [edge.target_agent, edge]))
  const visible = (agentId: string) => {
    if (filter === 'all') return true
    const edge = edges.get(agentId)
    if (!edge) return false
    return filter === 'consulted' ? true : edge.recommended_count > 0
  }
  return { edges, visible }
}
