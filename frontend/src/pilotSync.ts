import { useEffect, useRef, useSyncExternalStore } from 'react'

/**
 * One invalidation signal for the authenticated pilot.
 *
 * The backend is the only source of truth. Every successful write through the pilot API
 * client (pilotApi.ts) bumps a single data version; any view that shows server state
 * (Home, For you, Patients, a referral, Your Agent, the agent's conversation) re-reads
 * from the backend when the version changes. Nothing is cached, merged, or duplicated
 * client-side, and nothing touches browser storage.
 */

let version = 0
const listeners = new Set<() => void>()

export function notifyPilotDataChanged(): void {
  version += 1
  for (const listener of [...listeners]) listener()
}

export function subscribePilotData(listener: () => void): () => void {
  listeners.add(listener)
  return () => { listeners.delete(listener) }
}

export const pilotDataVersion = () => version

/** The current data version; include it in a loader's effect dependencies to refetch. */
export function usePilotDataVersion(): number {
  return useSyncExternalStore(subscribePilotData, pilotDataVersion, pilotDataVersion)
}

/** Calls `refresh` after any later pilot write (not on mount). */
export function useOnPilotDataChange(refresh: () => void): void {
  const latest = useRef(refresh)
  latest.current = refresh
  useEffect(() => subscribePilotData(() => latest.current()), [])
}
