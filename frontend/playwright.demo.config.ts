/* Demo comparator screenshots (UI review). The SYNTHETIC demo only: demo-mode API + app on their
 * own loopback ports with a throwaway database; no accounts, no Supabase, no pilot data.
 *
 *   npm run e2e:demo-screens      → ui-review/demo/<viewport>/
 */
import { defineConfig } from '@playwright/test'
import { DEMO_API_URL, DEMO_APP_PORT, DEMO_APP_URL } from './e2e/support/env.ts'

const chrome = { browserName: 'chromium' as const, channel: 'chrome' }

export default defineConfig({
  testDir: './e2e/demo',
  testMatch: /.*\.screens\.ts/,
  workers: 1,
  retries: 0,
  timeout: 10 * 60_000,
  expect: { timeout: 15_000 },
  outputDir: './test-results/demo',
  reporter: [['list']],
  use: { ...chrome, baseURL: DEMO_APP_URL, trace: 'off', video: 'off', screenshot: 'only-on-failure' },
  webServer: [
    { command: 'node e2e/support/start-demo-api.ts', url: `${DEMO_API_URL}/health`, reuseExistingServer: false, timeout: 120_000, stdout: 'ignore', stderr: 'pipe' },
    {
      command: `npx vite --host 127.0.0.1 --port ${DEMO_APP_PORT} --strictPort`,
      url: DEMO_APP_URL, reuseExistingServer: false, timeout: 120_000,
      env: { VITE_LAMINA_PRODUCT_MODE: 'demo', VITE_API_BASE_URL: DEMO_API_URL },
      stdout: 'ignore', stderr: 'pipe',
    },
  ],
  projects: [
    { name: 'demo-1440', use: { ...chrome, viewport: { width: 1440, height: 900 } } },
    { name: 'demo-1280', use: { ...chrome, viewport: { width: 1280, height: 800 } } },
    { name: 'demo-390', use: { ...chrome, viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 } },
  ],
})
