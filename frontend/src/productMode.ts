/** Build-time product mode. `pilot` renders only the real authenticated practice pilot
 * (PilotApp); anything else renders the unchanged synthetic demo. */
export type ProductMode = 'demo' | 'pilot'
export const resolveProductMode = (value: string | undefined): ProductMode =>
  (value ?? '').trim().toLowerCase() === 'pilot' ? 'pilot' : 'demo'
export const productMode: ProductMode = resolveProductMode(import.meta.env?.VITE_LAMINA_PRODUCT_MODE)
