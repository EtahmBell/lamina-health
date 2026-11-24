/* Lamina pilot end-to-end tests. DEV ONLY, synthetic data only. See docs/PILOT_E2E.md.
 *
 * Projects:
 *   capture   one-time manual sign-in per role (headed); saves storageState to e2e/.auth/ (gitignored)
 *   sessions  refreshes each saved session once per run, before any spec uses it
 *   e2e       the multi-role specs (serial: they share one seeded database)
 *   screens-* UI-review screenshots at 1440×900, 1280×800 and 390×844 into ui-review/<run-name>/
 */
import { defineConfig } from '@playwright/test'
import { API_URL, APP_PORT, APP_URL, assertDevEnvironment } from './e2e/support/env.ts'

assertDevEnvironment()

const chrome = { browserName: 'chromium' as const, channel: 'chrome' }

export default defineConfig({
  testDir: './e2e',
  // One seeded database: specs run one at a time, in file order.
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 90_000,
  expect: { timeout: 10_000 },
  outputDir: './test-results/e2e',
  reporter: [['list'], ['html', { open: 'never', outputFolder: './playwright-report' }]],
  use: {
    ...chrome,
    baseURL: APP_URL,
    viewport: { width: 1440, height: 900 },
    // Traces and videos record network headers and typed input: never keep them (tokens, passwords).
    trace: 'off',
    video: 'off',
    screenshot: 'only-on-failure',
  },
  webServer: [
    {
      command: 'node e2e/support/start-api.ts',
      url: `${API_URL}/health`,
      reuseExistingServer: false,
      timeout: 120_000,
      stdout: 'ignore',
      stderr: 'pipe',
    },
    {
      command: `npx vite --host 127.0.0.1 --port ${APP_PORT} --strictPort`,
      url: APP_URL,
      reuseExistingServer: false,
      timeout: 120_000,
      // VITE_LAMINA_DEV_TEST_AUTH: this dev server only (never a build) may use the dev test sign-in,
      // for browser contexts that opt in (the invitee fixtures).
      env: { VITE_LAMINA_PRODUCT_MODE: 'pilot', VITE_API_BASE_URL: API_URL, VITE_LAMINA_DEV_TEST_AUTH: '1' },
      stdout: 'ignore',
      stderr: 'pipe',
    },
  ],
  projects: [
    { name: 'capture', testMatch: /capture\.manual\.ts/, timeout: 20 * 60_000, use: { ...chrome, headless: false } },
    { name: 'sessions', testMatch: /sessions\.setup\.ts/ },
    { name: 'e2e', testMatch: /specs\/.*\.spec\.ts/, dependencies: ['sessions'] },
    { name: 'screens-1440', testMatch: /screens\/.*\.screens\.ts/, dependencies: ['sessions'], use: { ...chrome, viewport: { width: 1440, height: 900 } } },
    { name: 'screens-1280', testMatch: /screens\/.*\.screens\.ts/, dependencies: ['sessions'], use: { ...chrome, viewport: { width: 1280, height: 800 } } },
    { name: 'screens-390', testMatch: /screens\/.*\.screens\.ts/, dependencies: ['sessions'], use: { ...chrome, viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 } },
  ],
})
