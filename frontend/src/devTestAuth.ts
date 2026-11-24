/* LAMINA-DEV-TEST-AUTH — DEV/E2E ONLY. Never part of a production build.
 *
 * A stand-in for Supabase sign-up, sign-in and TOTP two-step sign-in, backed by the dev-only
 * `/api/dev/test-auth/*` routes that exist only on the DEV pilot launcher when it runs the e2e
 * harness (scripts/dev_pilot_server.py with LAMINA_E2E=1 and LAMINA_E2E_TEST_AUTH=1, refused
 * in production). It lets Playwright create brand-new invitee accounts and set up MFA without
 * touching a real identity provider. authClient.ts loads this module only in a build made with
 * VITE_LAMINA_DEV_TEST_AUTH=1, on a loopback host, for a browser context that opted in. */
import type { AuthBackend, AuthSession, AuthUser, MfaState } from './authClient.ts'

const STORAGE_KEY = 'lamina.devTestAuth.session'
const API = `${(import.meta.env.VITE_API_BASE_URL || 'http://127.0.0.1:8000').replace(/\/$/, '')}/api/dev/test-auth`

type Stored = { access_token: string; expires_at: number; user: AuthUser }

const listeners = new Set<(session: AuthSession | null) => void>()

function read(): Stored | null {
  try {
    const value = JSON.parse(window.localStorage.getItem(STORAGE_KEY) ?? 'null') as Stored | null
    return value && value.expires_at > Date.now() / 1000 ? value : null
  } catch { return null }
}

function write(value: Stored | null) {
  try {
    if (value) window.localStorage.setItem(STORAGE_KEY, JSON.stringify(value))
    else window.localStorage.removeItem(STORAGE_KEY)
  } catch { /* storage unavailable: the session lives only in memory for this page */ }
  const session = value ? { access_token: value.access_token, user: value.user } : null
  for (const listener of listeners) listener(session)
}

async function call<T>(path: string, body: unknown = {}, token?: string): Promise<T> {
  const response = await fetch(`${API}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify(body),
  })
  const data = await response.json().catch(() => ({}))
  if (!response.ok) throw new Error((data?.detail?.message as string | undefined) ?? 'That didn’t work (dev test sign-in).')
  return data as T
}

const token = () => read()?.access_token

export function devTestAuthBackend(): AuthBackend {
  return {
    async getSession() {
      const stored = read()
      return stored ? { access_token: stored.access_token, user: stored.user } : null
    },
    onAuthStateChange(listener) {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
    async signUp(email, password) {
      const stored = await call<Stored>('/sign-up', { email, password })
      write(stored)
      return { session: { access_token: stored.access_token, user: stored.user } }
    },
    async signIn(email, password) {
      const stored = await call<Stored>('/sign-in', { email, password })
      write(stored)
      return { session: { access_token: stored.access_token, user: stored.user } }
    },
    async signOut(scope) {
      const current = token()
      if (scope === 'global' && current) await call('/sign-out', { scope }, current)
      write(null)
    },
    async mfaState() {
      return call<MfaState>('/mfa/state', {}, token())
    },
    async enrollTotp() {
      const enrolled = await call<{ factor_id: string; secret: string; uri: string }>('/mfa/enroll', {}, token())
      return { factorId: enrolled.factor_id, qrCode: null, secret: enrolled.secret, uri: enrolled.uri }
    },
    async verifyTotp(factorId, code) {
      write(await call<Stored>('/mfa/verify', { factor_id: factorId, code }, token()))
    },
  }
}
