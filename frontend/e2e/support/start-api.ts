/* Playwright webServer for the API: reset + seed the dedicated e2e database, then run the
 * DEV pilot server (fictional NPPES) on the e2e port. Run with Node 24 (native TS). */
import { spawn, spawnSync } from 'node:child_process'
import { apiEnvironment, assertDevEnvironment, pythonExecutable, ROOT_DIR } from './env.ts'

assertDevEnvironment()
const env = apiEnvironment()
const python = pythonExecutable()
const seed = spawnSync(python, ['-m', 'scripts.e2e_seed', 'reset'], { cwd: ROOT_DIR, env, stdio: 'inherit' })
if (seed.status !== 0) process.exit(seed.status ?? 1)
const server = spawn(python, ['-m', 'scripts.dev_pilot_server'], { cwd: ROOT_DIR, env, stdio: 'inherit' })
const stop = () => { if (!server.killed) server.kill() }
process.on('SIGINT', stop)
process.on('SIGTERM', stop)
process.on('exit', stop)
server.on('exit', (code) => process.exit(code ?? 0))
