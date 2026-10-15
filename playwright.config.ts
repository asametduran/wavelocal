import { defineConfig, devices } from '@playwright/test'

const PORT = 4173
const ci = Boolean(process.env.CI)

/**
 * Headless e2e against the production build (`npm run build` first; `npm run test:e2e` does both).
 * Audio comes from synthetic WAV fixtures generated in code, never from real music files.
 */
export default defineConfig({
  testDir: 'e2e',
  outputDir: 'test-results',
  fullyParallel: true,
  forbidOnly: ci,
  retries: ci ? 1 : 0,
  workers: ci ? 2 : undefined,
  timeout: 30_000,
  expect: { timeout: 8_000 },
  reporter: ci ? [['list'], ['html', { open: 'never' }]] : 'list',
  use: {
    baseURL: `http://127.0.0.1:${PORT}`,
    viewport: { width: 1280, height: 800 },
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    // the PWA service worker would cache between tests and hide regressions
    serviceWorkers: 'block',
    launchOptions: { args: ['--autoplay-policy=no-user-gesture-required', '--mute-audio'] },
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'], viewport: { width: 1280, height: 800 } } }],
  webServer: {
    command: `npx vite preview --host 127.0.0.1 --port ${PORT} --strictPort`,
    url: `http://127.0.0.1:${PORT}`,
    reuseExistingServer: !ci,
    timeout: 60_000,
  },
})
