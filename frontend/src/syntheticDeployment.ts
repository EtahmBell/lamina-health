/** True only when the API says it is the hosted synthetic deployment (LAMINA_PROFILE=demo). */
export const isSyntheticDeployment = (health: unknown): boolean =>
  typeof health === 'object' && health !== null && (health as { deployment?: unknown }).deployment === 'synthetic'

export const SYNTHETIC_BANNER_TEXT = 'Synthetic demo · no PHI — never enter real patient information'

/** Shown when the demo's model-spend limits were reached (X-Lamina-AI-Limited). */
export function aiLimitedText(reasons: string): string {
  const daily = reasons.split(',').includes('daily_cap')
  return daily
    ? 'AI answers are paused for today on this demo (daily limit reached). You’re seeing the standard, non-AI responses.'
    : 'AI answers are paused for a few minutes (demo usage limit). You’re seeing the standard, non-AI responses.'
}
