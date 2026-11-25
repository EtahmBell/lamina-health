/* E2E environment: paths, roles, ports, and the dev-only guard.
 *
 * The guard runs when the Playwright config loads, before any server starts or browser opens.
 * It refuses unless:
 *   - frontend/e2e/.env.e2e names the DEV Supabase project (E2E_SUPABASE_DEV_URL), and both the
 *     frontend (VITE_SUPABASE_URL) and the API (SUPABASE_JWT_ISSUER) point at that same project;
 *   - the API and the app run on loopback ports owned by the harness;
 *   - the database is the dedicated Postgres e2e one (lamina_e2e on loopback), never the one in .env.
 * Messages never include URLs, keys or tokens. */
import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

export const FRONTEND_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
export const ROOT_DIR = path.resolve(FRONTEND_DIR, '..')
export const E2E_DIR = path.join(FRONTEND_DIR, 'e2e')
export const AUTH_DIR = path.join(E2E_DIR, '.auth')
export const STATE_FILE = path.join(E2E_DIR, '.state', 'seed.json')
/** Run 2: the e2e database is Postgres -- `lamina_e2e` on the local dev container (loopback). */
export const E2E_DATABASE = 'lamina_e2e'
export const API_PORT = 8011
export const APP_PORT = 5183
export const API_URL = `http://127.0.0.1:${API_PORT}`
export const APP_URL = `http://127.0.0.1:${APP_PORT}`
// Demo comparator (synthetic demo mode, no accounts): its own ports.
export const DEMO_API_PORT = 8012
export const DEMO_APP_PORT = 5184
export const DEMO_API_URL = `http://127.0.0.1:${DEMO_API_PORT}`
export const DEMO_APP_URL = `http://127.0.0.1:${DEMO_APP_PORT}`

export const ROLES = ['physician', 'second_physician', 'staff'] as const
export type Role = typeof ROLES[number]
export const ROLE_LABELS: Record<Role, string> = {
  physician: 'physician (practice admin)',
  second_physician: 'second physician (not an admin)',
  staff: 'staff',
}
export const storageStatePath = (role: Role) => path.join(AUTH_DIR, `${role}.json`)

function readEnvFile(file: string): Record<string, string> {
  if (!existsSync(file)) return {}
  const values: Record<string, string> = {}
  for (const raw of readFileSync(file, 'utf8').split(/\r?\n/)) {
    const line = raw.trim()
    if (!line || line.startsWith('#') || !line.includes('=')) continue
    const index = line.indexOf('=')
    values[line.slice(0, index).trim()] = line.slice(index + 1).trim().replace(/^['"]|['"]$/g, '')
  }
  return values
}

const hostOf = (value: string | undefined) => {
  try { return value ? new URL(value).hostname.toLowerCase() : '' } catch { return '' }
}

/** Throws (refusing to run) unless everything points at dev/local. */
export function assertDevEnvironment(): void {
  const problems: string[] = []
  const declared = readEnvFile(path.join(E2E_DIR, '.env.e2e'))
  const frontendEnv = { ...readEnvFile(path.join(FRONTEND_DIR, '.env')), ...process.env }
  const rootEnv = { ...readEnvFile(path.join(ROOT_DIR, '.env')), ...process.env }
  const devHost = hostOf(declared.E2E_SUPABASE_DEV_URL)
  if (!devHost) problems.push('frontend/e2e/.env.e2e must set E2E_SUPABASE_DEV_URL to the DEV Supabase project URL')
  if (devHost && hostOf(frontendEnv.VITE_SUPABASE_URL) !== devHost) problems.push('the frontend Supabase project is not the declared dev project')
  if (devHost && hostOf(rootEnv.SUPABASE_JWT_ISSUER) !== devHost) problems.push('the API verifies tokens from a project other than the declared dev project')
  if (devHost && declared.E2E_CONFIRM_DEV_PROJECT !== 'yes') problems.push('frontend/e2e/.env.e2e must set E2E_CONFIRM_DEV_PROJECT=yes (you confirm it is not production)')
  const admin = rootEnv.LAMINA_TEST_DATABASE_URL ?? ''
  if (!admin) problems.push('LAMINA_TEST_DATABASE_URL (the local dev Postgres) is not set in .env; see docs/PILOT_E2E.md')
  else if (!['127.0.0.1', 'localhost'].includes(hostOf(admin))) problems.push('the e2e Postgres must be on loopback')
  if ((rootEnv.LAMINA_DATABASE_URL ?? '').includes(`/${E2E_DATABASE}`)) problems.push('.env points the normal API at the e2e database; keep them separate')
  if (!['127.0.0.1', 'localhost'].includes(hostOf(API_URL)) || !['127.0.0.1', 'localhost'].includes(hostOf(APP_URL))) problems.push('the API and app must run on loopback')
  if (problems.length) throw new Error(`E2E refused to run (dev only):\n  - ${problems.join('\n  - ')}\nSee docs/PILOT_E2E.md.`)
}

export type SeedState = {
  seeded: boolean
  sender_token: string
  public_slug: string
  practice_a: { id: string; name: string; physician_name: string; staff_label: string }
  practice_b: { id: string; name: string }
  referrals: Record<'verify' | 'ready' | 'flag' | 'signoff' | 'redirect' | 'decline' | 'change' | 'conflict_keep' | 'conflict_apply' | 'still_open' | 'declined_notify', string> & { auto_draft?: string; unverified?: string }
  history: string[]
  practice_b_referrals: { accepted: string; declined: string }
  practice_proposal_id: string
  private_markers: string[]
}

export function seedState(): SeedState {
  if (!existsSync(STATE_FILE)) throw new Error('No seed state: the e2e API seeds on start. Run through `npm run e2e`.')
  const state = JSON.parse(readFileSync(STATE_FILE, 'utf8')) as SeedState
  if (!state.seeded) throw new Error('The e2e database is not seeded: capture the three sessions first (npm run e2e:capture).')
  return state
}

/** The repo's virtualenv Python (Windows or POSIX layout). */
export function pythonExecutable(): string {
  const windows = path.join(ROOT_DIR, '.venv', 'Scripts', 'python.exe')
  return existsSync(windows) ? windows : path.join(ROOT_DIR, '.venv', 'bin', 'python')
}

/** The three captured DEV Supabase accounts (user ids only; no tokens). */
export function capturedUserIds(): string[] {
  const file = path.join(AUTH_DIR, 'accounts.json')
  if (!existsSync(file)) return []
  const accounts = JSON.parse(readFileSync(file, 'utf8')) as Record<string, { user_id?: string }>
  return ROLES.map((role) => accounts[role]?.user_id ?? '').filter(Boolean)
}

/** The dedicated e2e database URL (same local server as the admin URL; never printed). */
export function e2eDatabaseUrl(): string {
  const admin = { ...readEnvFile(path.join(ROOT_DIR, '.env')), ...process.env }.LAMINA_TEST_DATABASE_URL ?? ''
  const url = new URL(admin)
  url.pathname = `/${E2E_DATABASE}`
  return url.toString()
}

/** Environment for the e2e API and the seed command: always the dedicated e2e database.
 * LAMINA_E2E_TEST_AUTH turns on the dev-only test sign-in (new invitee accounts + TOTP) on the DEV
 * launcher; the API refuses it outside this harness and in production (backend/dev_test_auth.py).
 * The captured accounts were signed in before MFA was required: they alone count as MFA-verified
 * here (the explicit, gated bypass) -- every new account in the specs sets up real TOTP. */
export function apiEnvironment(): NodeJS.ProcessEnv {
  return {
    ...process.env,
    LAMINA_E2E: '1',
    LAMINA_PROFILE: 'e2e',
    LAMINA_E2E_TEST_AUTH: '1',
    LAMINA_E2E_MFA_EXEMPT_USER_IDS: capturedUserIds().join(','),
    LAMINA_PRODUCT_MODE: 'pilot',
    LAMINA_DEV_FAKE_NPPES: 'true',
    LAMINA_DATABASE_URL: e2eDatabaseUrl(),
    LAMINA_TEST_DATABASE_URL: { ...readEnvFile(path.join(ROOT_DIR, '.env')), ...process.env }.LAMINA_TEST_DATABASE_URL ?? '',
    LAMINA_PILOT_DOCUMENT_DIR: path.join(ROOT_DIR, 'data', 'e2e', 'documents'),
    LAMINA_OPENAI_ENABLED: 'false',
    LAMINA_PILOT_LLM_EXTRACTION_ENABLED: 'false',
    LAMINA_MAIL_ADAPTER: 'dev',
    LAMINA_API_PORT: String(API_PORT),
    LAMINA_CORS_ORIGINS: APP_URL,
    PYTHONIOENCODING: 'utf-8',
  }
}
