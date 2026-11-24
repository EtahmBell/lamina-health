import { createClient, type SupabaseClient } from '@supabase/supabase-js'

/* Authentication for the app. Supabase is the one real identity provider (email + password, and
 * TOTP two-step sign-in for the pilot).
 *
 * DEV/E2E ONLY: a build made with VITE_LAMINA_DEV_TEST_AUTH=1 (the Playwright dev server, never a
 * deployment) may swap in a local test identity provider for a browser context that opts in, on a
 * loopback host only. In any other build `DEV_TEST_AUTH_BUILD` is the constant `false`, so that
 * code is never bundled or reachable. See docs/PILOT_E2E.md. */

const supabaseUrl = import.meta.env?.VITE_SUPABASE_URL?.trim()
const supabaseAnonKey = import.meta.env?.VITE_SUPABASE_ANON_KEY?.trim()
// `typeof` guard: outside Vite (node tests) there is no import.meta.env.
const DEV_TEST_AUTH_BUILD = typeof import.meta.env !== 'undefined' && import.meta.env.VITE_LAMINA_DEV_TEST_AUTH === '1'

export const authConfigured = Boolean(supabaseUrl && supabaseAnonKey) || DEV_TEST_AUTH_BUILD

export type AuthUser = { id: string; email?: string | null }
export type AuthSession = { access_token: string; user: AuthUser }
export type MfaFactor = { id: string; friendly_name?: string | null; status: 'verified' | 'unverified' }
/** current: what this session has passed; next: what the account could reach (aal2 = has a verified factor). */
export type MfaState = { current: 'aal1' | 'aal2'; next: 'aal1' | 'aal2'; factors: MfaFactor[] }
/** A new authenticator to set up: the QR code (an SVG data URL) and the same key as text. */
export type TotpEnrollment = { factorId: string; qrCode: string | null; secret: string; uri: string }

export interface AuthBackend {
  getSession(): Promise<AuthSession | null>
  onAuthStateChange(listener: (session: AuthSession | null) => void): () => void
  signUp(email: string, password: string, redirectTo: string): Promise<{ session: AuthSession | null }>
  signIn(email: string, password: string): Promise<{ session: AuthSession | null }>
  /** 'local': this browser. 'global': every session of this account (Supabase revokes refresh tokens). */
  signOut(scope: 'local' | 'global'): Promise<void>
  mfaState(): Promise<MfaState>
  enrollTotp(): Promise<TotpEnrollment>
  verifyTotp(factorId: string, code: string): Promise<void>
}

/* -------------------------------------------------------------- Supabase */

let client: SupabaseClient | null = null

function getClient(): SupabaseClient {
  if (!supabaseUrl || !supabaseAnonKey) throw new Error('Supabase authentication is not configured')
  if (!client) {
    client = createClient(supabaseUrl, supabaseAnonKey, {
      auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true },
    })
  }
  return client
}

const fromSupabase = (session: { access_token: string; user: { id: string; email?: string | null } } | null): AuthSession | null =>
  session ? { access_token: session.access_token, user: { id: session.user.id, email: session.user.email ?? null } } : null

const supabaseBackend: AuthBackend = {
  async getSession() {
    const { data, error } = await getClient().auth.getSession()
    if (error) throw error
    return fromSupabase(data.session)
  },
  onAuthStateChange(listener) {
    const { data } = getClient().auth.onAuthStateChange((_event, session) => listener(fromSupabase(session)))
    return () => data.subscription.unsubscribe()
  },
  async signUp(email, password, redirectTo) {
    const { data, error } = await getClient().auth.signUp({ email, password, options: { emailRedirectTo: redirectTo } })
    if (error) throw error
    return { session: fromSupabase(data.session) }
  },
  async signIn(email, password) {
    const { data, error } = await getClient().auth.signInWithPassword({ email, password })
    if (error) throw error
    return { session: fromSupabase(data.session) }
  },
  async signOut(scope) {
    const { error } = await getClient().auth.signOut({ scope })
    if (error) throw error
  },
  async mfaState() {
    const auth = getClient().auth.mfa
    const [{ data: level, error: levelError }, { data: factors, error: factorError }] = await Promise.all([auth.getAuthenticatorAssuranceLevel(), auth.listFactors()])
    if (levelError) throw levelError
    if (factorError) throw factorError
    return {
      current: level?.currentLevel === 'aal2' ? 'aal2' : 'aal1',
      next: level?.nextLevel === 'aal2' ? 'aal2' : 'aal1',
      factors: (factors?.all ?? []).filter((factor) => factor.factor_type === 'totp')
        .map((factor) => ({ id: factor.id, friendly_name: factor.friendly_name ?? null, status: factor.status === 'verified' ? 'verified' : 'unverified' })),
    }
  },
  async enrollTotp() {
    const auth = getClient().auth.mfa
    // An earlier, abandoned setup leaves an unverified factor behind: clear it first.
    const { data: existing } = await auth.listFactors()
    for (const factor of existing?.all ?? []) {
      if (factor.factor_type === 'totp' && factor.status !== 'verified') await auth.unenroll({ factorId: factor.id })
    }
    const { data, error } = await auth.enroll({ factorType: 'totp', friendlyName: `Lamina ${new Date().toISOString().slice(0, 10)}` })
    if (error) throw error
    return { factorId: data.id, qrCode: data.totp.qr_code ?? null, secret: data.totp.secret, uri: data.totp.uri }
  },
  async verifyTotp(factorId, code) {
    const { error } = await getClient().auth.mfa.challengeAndVerify({ factorId, code })
    if (error) throw error
  },
}

/* ------------------------------------------------------------ selection */

/** DEV/E2E ONLY: a browser context opts in (localStorage flag) on a loopback host, in a dev-test build. */
function devTestAuthRequested(): boolean {
  if (!DEV_TEST_AUTH_BUILD || typeof window === 'undefined') return false
  const loopback = ['127.0.0.1', 'localhost', '[::1]'].includes(window.location.hostname)
  try { return loopback && window.localStorage.getItem('lamina.devTestAuth') === '1' } catch { return false }
}

let backendPromise: Promise<AuthBackend> | null = null

export function authBackend(): Promise<AuthBackend> {
  if (!backendPromise) {
    backendPromise = DEV_TEST_AUTH_BUILD && devTestAuthRequested()
      ? import('./devTestAuth.ts').then((module) => module.devTestAuthBackend())
      : Promise.resolve(supabaseBackend)
  }
  return backendPromise
}

/* ------------------------------------------------------------------ API */

/** Where the email-confirmation link should land: this same origin, at the page's own
 * `?return=` path (e.g. a staff invitation), never an external URL. Supabase honours it
 * only if it is in the project's Redirect URLs allow-list; otherwise it uses the Site URL. */
export function confirmationRedirectUrl(location: Pick<Location, 'origin' | 'search'> = window.location): string {
  const requested = new URLSearchParams(location.search).get('return') ?? ''
  const path = requested.startsWith('/') && !requested.startsWith('//') && !requested.includes('\\') ? requested : '/me'
  return `${location.origin}${path}`
}

export async function signUp(email: string, password: string) {
  return (await authBackend()).signUp(email, password, confirmationRedirectUrl())
}

export async function signIn(email: string, password: string) {
  return (await authBackend()).signIn(email, password)
}

export async function signOut() {
  if (!authConfigured) return
  await (await authBackend()).signOut('local')
}

/** Sign out on every device: Supabase revokes all refresh tokens of this account. */
export async function signOutEverywhere() {
  await (await authBackend()).signOut('global')
}

export async function getSession(): Promise<AuthSession | null> {
  if (!authConfigured) return null
  return (await authBackend()).getSession()
}

export async function getAccessToken(): Promise<string | null> {
  return (await getSession())?.access_token ?? null
}

export function onAuthStateChange(listener: (session: AuthSession | null) => void) {
  if (!authConfigured) return () => undefined
  let unsubscribe: (() => void) | null = null
  let cancelled = false
  void authBackend().then((backend) => { if (!cancelled) unsubscribe = backend.onAuthStateChange(listener) })
  return () => { cancelled = true; unsubscribe?.() }
}

export const mfaState = async () => (await authBackend()).mfaState()
export const enrollTotp = async () => (await authBackend()).enrollTotp()
export const verifyTotp = async (factorId: string, code: string) => (await authBackend()).verifyTotp(factorId, code)
