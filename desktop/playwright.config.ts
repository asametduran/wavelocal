import { defineConfig } from '@playwright/test'

// Electron smoke tests. They drive the real shell against the web app built in ../dist (run `npm run build` first),
// each with a private user-data directory so nothing touches the developer's own library.
export default defineConfig({
  testDir: './e2e',
  timeout: 60_000,
  expect: { timeout: 10_000 },
  workers: 1,
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [['list'], ['github']] : 'list',
})
