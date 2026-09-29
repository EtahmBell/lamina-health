/** Deterministic, browser-local greeting for the portal. No backend dependency. */
export function greetingPrefix(hour: number): string {
  if (hour >= 5 && hour < 12) return 'Good morning'
  if (hour >= 12 && hour < 17) return 'Good afternoon'
  return 'Good evening'
}

export function timeAwareGreeting(name: string, now: Date = new Date()): string {
  return `${greetingPrefix(now.getHours())}, ${name}.`
}
