import { expect, test } from '@playwright/test'
import type { Page } from '@playwright/test'
import { PlayerPage, song } from './helpers'
import { androidSeen, hasBackListener, installFakeAndroid, pressBack } from './android'
import type { FakeAndroidOptions } from './android'

// The hardware Back button in the Android app. Capacitor's `App` plugin (played by the fake bridge of `android.ts`, under the app's
// own code and the real `@capacitor/core`) tells the page when it is pressed and whether the WebView has an entry to go back to; the
// page closes the topmost layer (a sheet, a question, an album page) or, at the root, asks to be sent to the background so that the
// music goes on, which is what a music player's Back button is for.

const MUSIC = [
  song('01-come.mp3', { title: 'Come Together', artist: 'Beatles', album: 'Abbey Road', track: '1' }),
  song('02-help.mp3', { title: 'Help', artist: 'Beatles', album: 'Help', track: '1' }),
]

/** Where the page is in its history (the Navigation API counts entries, whatever pushed them). */
const entry = (page: Page) => page.evaluate(() => (window as unknown as { navigation: { currentEntry: { index: number } } }).navigation.currentEntry.index)
const minimized = async (page: Page): Promise<number> => (await androidSeen(page)).minimized

/** The app on a fake Android device, with two albums in it, once the shell is listening for the button. */
async function open(page: Page, options?: FakeAndroidOptions): Promise<PlayerPage> {
  await installFakeAndroid(page, options)
  const app = new PlayerPage(page)
  await app.open()
  await app.importFiles(...MUSIC)
  await expect(app.rows).toHaveCount(2)
  if (options?.app !== false) await expect.poll(() => hasBackListener(page)).toBe(true)
  return app
}

const albums = (app: PlayerPage) => app.sidebar.getByRole('list', { name: 'Albums' })
const heading = (app: PlayerPage, name: string) => app.sidebar.getByRole('heading', { level: 2, name, exact: true })

async function openAlbum(app: PlayerPage, name: string): Promise<void> {
  await app.showMode('Albums')
  await albums(app)
    .getByRole('button', { name: new RegExp(`^${name}, `) })
    .click()
  await expect(heading(app, name)).toBeVisible()
}

test.describe('the hardware Back button in the Android app', () => {
  test('at the root sends the app to the background, and leaves the page and the history as they were', async ({ page }) => {
    const app = await open(page)
    expect(await page.evaluate(() => (window as unknown as { navigation: { canGoBack: boolean } }).navigation.canGoBack)).toBe(false) // the root, as a WebView sees it
    const start = await entry(page)
    expect(await pressBack(page)).toBe(true)
    await expect.poll(() => minimized(page)).toBe(1)
    expect((await androidSeen(page)).exits).toBe(0) // minimized, never closed: closing would end the music
    expect(await entry(page)).toBe(start)
    await expect(app.rows).toHaveCount(2)
    await pressBack(page)
    await expect.poll(() => minimized(page)).toBe(2) // and again, as often as it is pressed
  })

  test('closes Sound & tools first, and the next press leaves for the background', async ({ page }) => {
    const app = await open(page)
    await app.openTools()
    await pressBack(page)
    await expect(app.tools).toBeHidden()
    expect(await minimized(page)).toBe(0) // closing the sheet was all it did
    await pressBack(page)
    await expect.poll(() => minimized(page)).toBe(1)
  })

  test('cancels a question and leaves the sheet under it open; the next press closes the sheet', async ({ page }) => {
    const app = await open(page)
    await app.play('Help')
    await app.openTools()
    await app.tools.getByRole('button', { name: 'Save preset…' }).click()
    await expect(app.question).toBeVisible()

    await pressBack(page)
    await expect(app.question).toBeHidden()
    await expect(app.tools).toBeVisible()
    await expect(app.tools.getByRole('button', { name: 'Save preset…' })).toBeVisible() // cancelled, not confirmed

    await pressBack(page)
    await expect(app.tools).toBeHidden()
    expect(await minimized(page)).toBe(0)
  })

  test('closes an album page instead of leaving the library, and then leaves for the background', async ({ page }) => {
    const app = await open(page)
    await openAlbum(app, 'Help')
    expect(await page.evaluate(() => (window as unknown as { navigation: { canGoBack: boolean } }).navigation.canGoBack)).toBe(true) // the page is an entry of the history

    await pressBack(page)
    await expect(albums(app)).toBeVisible()
    await expect(heading(app, 'Help')).toHaveCount(0)
    expect(await minimized(page)).toBe(0)

    await pressBack(page)
    await expect.poll(() => minimized(page)).toBe(1)
  })

  test('takes the layers one at a time, the topmost first: a sheet over an album page', async ({ page }) => {
    const app = await open(page)
    await openAlbum(app, 'Abbey Road')
    await app.openTools()

    await pressBack(page)
    await expect(app.tools).toBeHidden()
    await expect(heading(app, 'Abbey Road')).toBeVisible()

    await pressBack(page)
    await expect(heading(app, 'Abbey Road')).toHaveCount(0)
    expect(await minimized(page)).toBe(0)

    await pressBack(page)
    await expect.poll(() => minimized(page)).toBe(1)
  })

  test('is heard again after the page is reloaded', async ({ page }) => {
    const app = await open(page)
    await app.reload()
    await expect.poll(() => hasBackListener(page)).toBe(true)
    await pressBack(page)
    await expect.poll(() => minimized(page)).toBe(1)
  })

  test('does not stop playback: a track plays on while Back closes things and minimizes', async ({ page }) => {
    const app = await open(page)
    await app.play('Help')
    await app.expectPlaying()
    await app.openTools()
    await pressBack(page)
    await expect(app.tools).toBeHidden()
    await pressBack(page)
    await expect.poll(() => minimized(page)).toBe(1)
    await app.expectPlaying()
  })
})

test.describe('a build without the App plugin', () => {
  test('works as before, has nothing listening, and keeps why in the error log', async ({ page }) => {
    const app = await open(page, { app: false })
    expect(await hasBackListener(page)).toBe(false)
    expect(await pressBack(page)).toBe(false) // nobody to tell
    await app.openTools()
    const log = app.tools.getByRole('region', { name: 'Diagnostics' }).getByRole('list', { name: 'Recorded errors' })
    await log.scrollIntoViewIfNeeded()
    await expect(log).toContainText('shell')
    await expect(log).toContainText('is not implemented on android')
    await expect(app.rows).toHaveCount(2) // and the app itself is untouched
  })
})

test.describe('the web', () => {
  test('is as it was: no listener, and the browser’s Back button closes a page', async ({ page }) => {
    const app = new PlayerPage(page)
    await app.open()
    await app.importFiles(...MUSIC)
    await expect(app.rows).toHaveCount(2)
    expect(await page.evaluate(() => 'Capacitor' in window || '__android' in window)).toBe(false)
    await openAlbum(app, 'Help')
    await page.goBack()
    await expect(albums(app)).toBeVisible()
    await expect(heading(app, 'Help')).toHaveCount(0)
  })
})
