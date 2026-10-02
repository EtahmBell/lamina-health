/** Accept only local absolute paths; never allow auth flows to redirect off-site. */
export function safeReturnPath(value: string | null, fallback: string): string {
  if (!value || !value.startsWith('/') || value.startsWith('//') || value.includes('\\')) {
    return fallback
  }
  try {
    const parsed = new URL(value, 'https://lamina.invalid')
    return parsed.origin === 'https://lamina.invalid'
      ? `${parsed.pathname}${parsed.search}${parsed.hash}`
      : fallback
  } catch {
    return fallback
  }
}
