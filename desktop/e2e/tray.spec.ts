import { expect, test } from '@playwright/test'
import type { ElectronApplication, Page } from '@playwright/test'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { launchShell, toneWav } from './harness'
import type { TrayInfo } from './harness'

let userData = ''
let app: ElectronApplication
let page: Page

/** Call one of the main process's test hooks (`exposeTestHooks` in main.ts). */
const hook = <T>(name: 'tray' | 'activate' | 'settings' | 'windowVisible', ...args: unknown[]): Promise<T> =>
  app.evaluate((_electron, [fn, params]) => (globalThis as unknown as { __wavelocalTest: Record<string, (...a: unknown[]) => unknown> }).__wavelocalTest[fn as string]!(...(params as unknown[])), [name, args] as const) as Promise<T>

const trayInfo = () => hook<TrayInfo | null>('tray')
const tooltip = async () => (await trayInfo())?.tooltip
const activate = (label: string) => hook<boolean>('activate', label)
const windowVisible = () => hook<boolean>('windowVisible')
const closeToTray = async () => (await hook<{ closeToTray: boolean }>('settings')).closeToTray
const row = (title: string) => page.locator('ul > li', { has: page.locator('div.truncate.text-sm', { hasText: new RegExp(`^${title}$`) }) })
const pauseButton = () => page.getByRole('button', { name: 'Pause (Space)' })
const playButton = () => page.getByRole('button', { name: 'Play (Space)' })

async function importTracks(...titles: string[]) {
  await page.locator('input[type=file]').first().setInputFiles(titles.map((t, i) => ({ name: `${t}.wav`, mimeType: 'audio/wav', buffer: toneWav(3, 440 + 110 * i) })))
}

async function play(title: string) {
  await row(title).locator('button[aria-current]').first().click()
  await expect(pauseButton()).toBeVisible()
}

test.beforeAll(() => {
  userData = mkdtempSync(path.join(tmpdir(), 'wavelocal-tray-'))
})
test.afterAll(() => rmSync(userData, { recursive: true, force: true }))
test.beforeEach(async () => {
  rmSync(path.join(userData, 'desktop-settings.json'), { force: true })
  ;({ app, page } = await launchShell(userData))
})
test.afterEach(async () => {
  await app.close().catch(() => undefined)
})

test('the tray starts idle with the transport disabled', async () => {
  const info = await trayInfo()
  expect(info?.tooltip).toBe('Wavelocal')
  expect(info?.menu).toEqual(['Nothing playing', 'Play', 'Next', 'Previous', 'Hide Wavelocal', 'Close to tray', 'Quit Wavelocal'])
  expect(await activate('Next')).toBe(false) // disabled entries do nothing
})

test('the tooltip and menu follow the player', async () => {
  await importTracks('alpha')
  await play('alpha')
  await expect.poll(tooltip).toContain('alpha')
  expect((await trayInfo())?.menu[1]).toBe('Pause')

  await pauseButton().click()
  await expect.poll(tooltip).toMatch(/^⏸ .*alpha/)
  expect((await trayInfo())?.menu[1]).toBe('Play')
})

test('tray commands drive the player: play/pause, next and previous', async () => {
  await importTracks('one', 'two')
  await play('one')
  await expect.poll(tooltip).toContain('one')

  expect(await activate('Pause')).toBe(true)
  await expect(playButton()).toBeVisible()
  expect(await activate('Play')).toBe(true)
  await expect(pauseButton()).toBeVisible()

  expect(await activate('Next')).toBe(true)
  await expect.poll(tooltip).toContain('two')
  expect(await activate('Previous')).toBe(true)
  await expect.poll(tooltip).toContain('one')
})

test('closing the window hides it to the tray and the tray brings it back', async () => {
  expect(await windowVisible()).toBe(true)
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.close())
  await expect.poll(windowVisible).toBe(false)
  expect((await trayInfo())?.menu).toContain('Show Wavelocal')

  expect(await activate('Show Wavelocal')).toBe(true)
  await expect.poll(windowVisible).toBe(true)
  expect((await trayInfo())?.menu).toContain('Hide Wavelocal')
})

test('music keeps playing while the window is hidden', async () => {
  await importTracks('bg')
  await play('bg')
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.hide())
  await page.waitForTimeout(1000)
  await expect(pauseButton()).toBeVisible() // still playing, and the page is still responsive
  expect(await page.evaluate(() => performance.now())).toBeGreaterThan(0)
})

test('"Close to tray" can be turned off, is remembered, and then closing quits', async () => {
  expect(await closeToTray()).toBe(true)
  expect(await activate('Close to tray')).toBe(true) // toggles the checkbox
  await expect.poll(closeToTray).toBe(false)
  await expect
    .poll(() => {
      try {
        return JSON.parse(readFileSync(path.join(userData, 'desktop-settings.json'), 'utf8')) as unknown
      } catch {
        return null
      }
    })
    .toEqual({ closeToTray: false })

  const closed = app.waitForEvent('close')
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.close())
  await closed // the last window is gone, so the app exits
})

test('quitting from the tray menu exits the app', async () => {
  const closed = app.waitForEvent('close')
  expect(await activate('Quit Wavelocal')).toBe(true)
  await closed
})
