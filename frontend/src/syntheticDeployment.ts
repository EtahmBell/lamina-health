/** True only when the API says it is the hosted synthetic deployment (LAMINA_PROFILE=demo). */
export const isSyntheticDeployment = (health: unknown): boolean =>
  typeof health === 'object' && health !== null && (health as { deployment?: unknown }).deployment === 'synthetic'

export const SYNTHETIC_BANNER_TEXT = 'Synthetic demo · no PHI — never enter real patient information'
