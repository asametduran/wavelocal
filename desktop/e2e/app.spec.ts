import { expect, test } from '@playwright/test'
import type { ElectronApplication, Page } from '@playwright/test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { launchShell, toneWav } from './harness'

let userData = ''
let app: ElectronApplication
let page: Page

async function launch(): Promise<void> {
  ;({ app, page } = await launchShell(userData))
}

test.beforeAll(() => {
  userData = mkdtempSync(path.join(tmpdir(), 'wavelocal-e2e-'))
})
test.afterAll(() => rmSync(userData, { recursive: true, force: true }))
test.beforeEach(launch)
test.afterEach(async () => {
  await app.close()
})

test('opens the app from the private app:// origin', async () => {
  expect(page.url()).toBe('app://wavelocal/')
  await expect(page.locator('input[type=file]').first()).toBeAttached()
  expect(await page.evaluate(() => navigator.serviceWorker?.controller ?? null)).toBeNull()
})

test('the window is locked down', async () => {
  const prefs = await app.evaluate(({ BrowserWindow }) => {
    const wc = BrowserWindow.getAllWindows()[0]!.webContents as unknown as { getLastWebPreferences(): Record<string, unknown> }
    const wp = wc.getLastWebPreferences()
    return { sandbox: wp.sandbox, contextIsolation: wp.contextIsolation, nodeIntegration: wp.nodeIntegration, webSecurity: wp.webSecurity }
  })
  expect(prefs).toMatchObject({ sandbox: true, contextIsolation: true, nodeIntegration: false })
  expect(prefs.webSecurity).not.toBe(false)
  // no Node globals leak into the page
  expect(await page.evaluate(() => ({ require: typeof (globalThis as { require?: unknown }).require, process: typeof (globalThis as { process?: unknown }).process }))).toEqual({
    require: 'undefined',
    process: 'undefined',
  })
})

test('exposes only the frozen desktop bridge', async () => {
  const bridge = await page.evaluate(() => {
    const b = (window as unknown as { wavelocalDesktop?: { isDesktop: boolean; platform: string; versions: Record<string, string> } }).wavelocalDesktop
    return b ? { isDesktop: b.isDesktop, platform: b.platform, versions: b.versions, frozen: Object.isFrozen(b), keys: Object.keys(b).sort() } : null
  })
  expect(bridge).not.toBeNull()
  expect(bridge).toMatchObject({ isDesktop: true, platform: process.platform, frozen: true, keys: ['isDesktop', 'platform', 'tray', 'versions'] })
  expect(bridge?.versions.electron).toBeTruthy()
})

test('serves a strict CSP and blocks outside traffic, navigation and new windows', async () => {
  const headers = await page.evaluate(async () => Object.fromEntries([...(await fetch('/')).headers]))
  expect(headers['content-security-policy']).toContain("default-src 'self'")
  expect(headers['content-security-policy']).toContain("object-src 'none'")

  // a real network request never leaves the machine
  const outcome = await page.evaluate(() => fetch('https://example.com/', { mode: 'no-cors' }).then(() => 'reached', () => 'blocked'))
  expect(outcome).toBe('blocked')

  // path traversal and unknown files are 404s
  for (const p of ['/../package.json', '/%2e%2e/package.json', '/nope.txt']) {
    expect(await page.evaluate(async (u) => (await fetch(u)).status, p)).toBe(404)
  }

  // navigating away or opening windows does nothing
  await page.evaluate(() => {
    location.href = 'https://example.com/'
    window.open('https://example.com/')
  })
  await page.waitForTimeout(500)
  expect(page.url()).toBe('app://wavelocal/')
  expect(app.windows()).toHaveLength(1)
})

test('imports a WAV, plays it, and keeps the library across a relaunch', async () => {
  await page.locator('input[type=file]').first().setInputFiles({ name: 'smoke.wav', mimeType: 'audio/wav', buffer: toneWav() })
  const row = page.locator('ul > li', { has: page.locator('div.truncate.text-sm', { hasText: /^smoke$/ }) })
  const play = row.locator('button[aria-current]')
  await expect(play.first()).toBeVisible()
  await play.first().click()
  await expect(page.getByRole('button', { name: 'Pause (Space)' })).toBeVisible()
  await page.waitForTimeout(500) // let the library write finish
  await app.close()

  await launch()
  await expect(page.locator('div.truncate.text-sm', { hasText: /^smoke$/ }).first()).toBeVisible()
})

test('restores the window bounds', async () => {
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.setBounds({ x: 120, y: 90, width: 1000, height: 700 }))
  await page.waitForTimeout(800) // the state is saved after a short debounce
  await app.close()

  await launch()
  const size = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.getBounds())
  expect(size.width).toBe(1000)
  // Windows adds a few pixels of frame to the requested height, so only the width is exact
  expect(Math.abs(size.height - 700)).toBeLessThanOrEqual(8)
})
