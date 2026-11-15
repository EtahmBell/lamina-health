/* npm entry points for the e2e harness (Node 24 runs this TypeScript directly).
 *   node e2e/support/run.ts e2e [playwright args…]
 *   node e2e/support/run.ts capture [role…]
 *   node e2e/support/run.ts screens [run-name] */
import { spawnSync } from 'node:child_process'
import { FRONTEND_DIR, ROLES } from './env.ts'

const [mode = 'e2e', ...rest] = process.argv.slice(2)
const env = { ...process.env }
let args: string[]
if (mode === 'capture') {
  const roles = rest.filter(Boolean)
  const unknown = roles.filter((role) => !(ROLES as readonly string[]).includes(role))
  if (unknown.length) { console.error(`Unknown role(s): ${unknown.join(', ')}. Use: ${ROLES.join(', ')}`); process.exit(2) }
  env.E2E_CAPTURE = '1'
  env.E2E_ROLES = roles.join(',')
  args = ['--project=capture', '--headed', '--reporter=list']
} else if (mode === 'screens') {
  if (rest[0]) env.E2E_RUN_NAME = rest[0]
  args = ['--project=screens-1440', '--project=screens-1280', '--project=screens-390', '--reporter=list']
} else if (mode === 'e2e') {
  args = ['--project=e2e', ...rest]
} else {
  console.error('Usage: run.ts e2e|capture|screens'); process.exit(2)
}
const result = spawnSync('npx', ['playwright', 'test', ...args], { cwd: FRONTEND_DIR, env, stdio: 'inherit', shell: process.platform === 'win32' })
process.exit(result.status ?? 1)
