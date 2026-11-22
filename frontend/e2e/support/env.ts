/* E2E environment: paths, roles, ports, and the dev-only guard.
 *
 * The guard runs when the Playwright config loads, before any server starts or browser opens.
 * It refuses unless:
 *   - frontend/e2e/.env.e2e names the DEV Supabase project (E2E_SUPABASE_DEV_URL), and both the
 *     frontend (VITE_SUPABASE_URL) and the API (SUPABASE_JWT_ISSUER) point at that same project;
 *   - the API and the app run on loopback ports owned by the harness;
 *   - the database is the dedicated e2e one (data/e2e/pilot-e2e.sqlite), never the one in .env.
 * Messages never include URLs, keys or tokens. */
import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

export const FRONTEND_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
export const ROOT_DIR = path.resolve(FRONTEND_DIR, '..')
export const E2E_DIR = path.join(FRONTEND_DIR, 'e2e')
export const AUTH_DIR = path.join(E2E_DIR, '.auth')
export const STATE_FILE = path.join(E2E_DIR, '.state', 'seed.json')
export const E2E_DB = path.join(ROOT_DIR, 'data', 'e2e', 'pilot-e2e.sqlite')
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
  const configuredDb = rootEnv.LAMINA_WORKFLOW_DATABASE ? path.resolve(ROOT_DIR, rootEnv.LAMINA_WORKFLOW_DATABASE) : ''
  if (configuredDb && path.resolve(configuredDb) === path.resolve(E2E_DB)) problems.push('.env points the normal API at the e2e database; keep them separate')
  if (!['127.0.0.1', 'localhost'].includes(hostOf(API_URL)) || !['127.0.0.1', 'localhost'].includes(hostOf(APP_URL))) problems.push('the API and app must run on loopback')
  if (problems.length) throw new Error(`E2E refused to run (dev only):\n  - ${problems.join('\n  - ')}\nSee docs/PILOT_E2E.md.`)
}

export type SeedState = {
  seeded: boolean
  sender_token: string
  public_slug: string
  practice_a: { id: string; name: string; physician_name: string; staff_label: string }
  practice_b: { id: string; name: string }
  referrals: Record<'verify' | 'ready' | 'flag' | 'signoff' | 'redirect' | 'decline' | 'change' | 'conflict_keep' | 'conflict_apply' | 'still_open' | 'declined_notify', string>
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

/** Environment for the e2e API and the seed command: always the dedicated e2e database. */
export function apiEnvironment(): NodeJS.ProcessEnv {
  return {
    ...process.env,
    LAMINA_E2E: '1',
    LAMINA_PRODUCT_MODE: 'pilot',
    LAMINA_DEV_FAKE_NPPES: 'true',
    LAMINA_WORKFLOW_DATABASE: E2E_DB,
    LAMINA_PILOT_DOCUMENT_DIR: path.join(ROOT_DIR, 'data', 'e2e', 'documents'),
    LAMINA_OPENAI_ENABLED: 'false',
    LAMINA_PILOT_LLM_EXTRACTION_ENABLED: 'false',
    LAMINA_MAIL_ADAPTER: 'dev',
    LAMINA_API_PORT: String(API_PORT),
    LAMINA_CORS_ORIGINS: APP_URL,
    PYTHONIOENCODING: 'utf-8',
  }
}
