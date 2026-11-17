/* Playwright webServer for the DEMO comparator: the synthetic demo API (anonymous cookie
 * workspaces, no accounts) on its own port with a throwaway database under data/e2e/.
 * Never the walkthrough or .env database. Run with Node 24 (native TS). */
import { spawn } from 'node:child_process'
import { mkdirSync, rmSync } from 'node:fs'
import path from 'node:path'
import { DEMO_API_PORT, DEMO_APP_URL, pythonExecutable, ROOT_DIR } from './env.ts'

const dir = path.join(ROOT_DIR, 'data', 'e2e')
const db = path.join(dir, 'demo-e2e.sqlite')
mkdirSync(dir, { recursive: true })
for (const suffix of ['', '-wal', '-shm', '-journal']) rmSync(db + suffix, { force: true })

const env = {
  ...process.env,
  LAMINA_PRODUCT_MODE: 'demo',
  LAMINA_WORKFLOW_DATABASE: db,
  LAMINA_OPENAI_ENABLED: 'false',
  LAMINA_DEMO_COOKIE_SECURE: 'false',
  LAMINA_CORS_ORIGINS: DEMO_APP_URL,
  PYTHONIOENCODING: 'utf-8',
}
const server = spawn(pythonExecutable(), ['-m', 'uvicorn', 'backend.main:app', '--host', '127.0.0.1', '--port', String(DEMO_API_PORT)],
  { cwd: ROOT_DIR, env, stdio: 'inherit' })
const stop = () => { if (!server.killed) server.kill() }
process.on('SIGINT', stop)
process.on('SIGTERM', stop)
process.on('exit', stop)
server.on('exit', (code) => process.exit(code ?? 0))
