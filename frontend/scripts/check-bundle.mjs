/* Build gate: a deployable bundle must never contain the DEV/E2E test sign-in (src/devTestAuth.ts).
 * It is only compiled in when VITE_LAMINA_DEV_TEST_AUTH=1 (the Playwright dev server). Run after
 * `vite build`; exits 1 if the dev sign-in made it into dist/. */
import { readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'

const dist = path.resolve(process.argv[2] ?? 'dist')
const markers = ['/api/dev/test-auth', 'lamina.devTestAuth']
const offenders = []
const walk = (dir) => {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const file = path.join(dir, entry.name)
    if (entry.isDirectory()) walk(file)
    else if (/\.(js|mjs|html)$/.test(entry.name) && markers.some((marker) => readFileSync(file, 'utf8').includes(marker))) offenders.push(path.relative(dist, file))
  }
}
walk(dist)
if (offenders.length) {
  console.error(`Refusing this build: the dev-only test sign-in is bundled (${offenders.join(', ')}). Build without VITE_LAMINA_DEV_TEST_AUTH.`)
  process.exit(1)
}
console.log('bundle check: no dev-only test sign-in in the build')
