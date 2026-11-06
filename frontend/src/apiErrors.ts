/** FastAPI `detail` is either a string, a `{code, message}` object, or a validation list. */
export function parseErrorDetail(detail: unknown, status: number): { message: string; code: string | null } {
  if (typeof detail === 'string' && detail) return { message: detail, code: null }
  if (detail && typeof detail === 'object' && !Array.isArray(detail)) {
    const record = detail as { code?: unknown; message?: unknown }
    const code = typeof record.code === 'string' ? record.code : null
    if (typeof record.message === 'string' && record.message) return { message: record.message, code }
    return { message: `Request failed (${status})`, code }
  }
  return { message: `Request failed (${status})`, code: null }
}
