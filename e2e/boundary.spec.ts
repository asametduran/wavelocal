import AxeBuilder from '@axe-core/playwright'
import { expect, test } from '@playwright/test'
import type { Locator, Page } from '@playwright/test'
import { PlayerPage, settled, song, wav } from './helpers'

// When the page cannot go on, what is left on screen must work with nothing else: a reload, a fresh start that keeps the music and the
// playlists, and the details of what happened without the names of the person's files. The page is made to fail the way a bad stored
// value would: the app sets the document title in an effect, and from the next load on setting it throws.

const TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa', 'best-practice']
const TITLE = 'Zebra Quartet - Night Train'

declare global {
  interface Window {
    __break: () => void
  }
}

/**
 * Makes setting the document title throw (it carries a title in its words, which no report may hold): on every load while
 * `localStorage` holds `wl-crash`, on the first load of a tab with `?once` in the address, and whenever the test calls `__break()`.
 */
async function breakTitle(page: Page): Promise<void> {
  await page.addInitScript((title) => {
    const crash = (): void => {
      Object.defineProperty(document, 'title', {
        configurable: true,
        get: () => 'Wavelocal', // the title the page was loaded with: a document with none would fail axe for a reason that is not the screen's
        set() {
          throw new Error(`forced crash for "${title}"`)
        },
      })
    }
    window.__break = crash
    if (localStorage.getItem('wl-crash') === '1') crash()
    else if (new URLSearchParams(location.search).has('once') && sessionStorage.getItem('crashed') !== '1') {
      sessionStorage.setItem('crashed', '1')
      crash()
    }
  }, TITLE)
}

const screen = (page: Page): Locator => page.getByRole('heading', { name: 'Wavelocal stopped working' })
const choice = (page: Page, name: string): Locator => page.getByRole('button', { name })

test.describe('a page that cannot go on', () => {
  test('shows a recovery screen instead of a blank page, and Reload brings the app back', async ({ page }) => {
    await breakTitle(page)
    await page.goto('/?once')
    await expect(screen(page)).toBeVisible()
    await expect(page.getByText('Your music and playlists are safe on this device')).toBeVisible()
    await expect(page.getByText(TITLE)).toHaveCount(0) // what the error said is not on the screen
    await expect(choice(page, 'Reload')).toBeFocused()
    await choice(page, 'Reload').click()
    const app = new PlayerPage(page)
    await expect(app.viewSelect).toBeVisible({ timeout: 15_000 }) // the library is there again
    await expect(screen(page)).toBeHidden()
  })

  test('has nothing for axe to find, with the choices on a phone as well as on a desktop', async ({ page }) => {
    await breakTitle(page)
    await page.goto('/?once')
    await expect(screen(page)).toBeVisible()
    await settled(page)
    expect((await new AxeBuilder({ page }).withTags(TAGS).analyze()).violations).toEqual([])
    await choice(page, 'Start fresh…').click()
    await expect(page.getByText('keeps your music and playlists')).toBeVisible()
    await settled(page)
    expect((await new AxeBuilder({ page }).withTags(TAGS).analyze()).violations).toEqual([])

    await page.setViewportSize({ width: 360, height: 640 })
    for (const name of ['Reload', 'Start fresh', 'Cancel', 'Copy details']) {
      const box = (await choice(page, name).boundingBox())!
      expect(box.x, name).toBeGreaterThanOrEqual(0)
      expect(box.x + box.width, name).toBeLessThanOrEqual(360)
      expect(box.height, name).toBeGreaterThanOrEqual(40)
    }
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true)
  })

  test('can be walked with the keyboard, in the order the choices are meant to be read', async ({ page }) => {
    await breakTitle(page)
    await page.goto('/?once')
    await expect(choice(page, 'Reload')).toBeFocused()
    await page.keyboard.press('Tab')
    await expect(choice(page, 'Start fresh…')).toBeFocused()
    await page.keyboard.press('Tab')
    await expect(choice(page, 'Copy details')).toBeFocused()
  })

  test('stops the sound that was playing behind it, and takes the player off the lock screen', async ({ page }) => {
    await breakTitle(page)
    const app = new PlayerPage(page)
    await app.open()
    await app.importFiles(wav('long', '01-a.wav'), wav('long', '02-b.wav'))
    await expect(app.rows).toHaveCount(2)
    await app.play('01-a')
    await expect.poll(() => app.playingElements()).toBe(1)
    await page.evaluate(() => window.__break())
    await app.next() // the title changes, which now throws
    await expect(screen(page)).toBeVisible()
    expect(await app.playingElements()).toBe(0)
    expect(await page.evaluate(() => navigator.mediaSession.metadata)).toBeNull()
    expect(await page.evaluate(() => navigator.mediaSession.playbackState)).toBe('none')
  })

  test('copies details that say what happened without any name', async ({ page, context }) => {
    await context.grantPermissions(['clipboard-read', 'clipboard-write'])
    await breakTitle(page)
    await page.goto('/?once')
    await expect(screen(page)).toBeVisible()
    await choice(page, 'Copy details').click()
    await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toContain('Wavelocal error report')
    const report = await page.evaluate(() => navigator.clipboard.readText())
    expect(report).toContain('· boundary · Error')
    expect(report).toContain('forced crash for <text>')
    expect(report).not.toContain('Zebra')
    expect(report).not.toMatch(/https?:\/\//)
  })

  test('shows the details to copy by hand when the browser will not copy them', async ({ page }) => {
    await page.addInitScript(() => {
      Object.defineProperty(navigator, 'clipboard', { value: { writeText: () => Promise.reject(new DOMException('denied', 'NotAllowedError')) } })
    })
    await breakTitle(page)
    await page.goto('/?once')
    await choice(page, 'Copy details').click()
    await expect(page.getByRole('textbox', { name: 'Details' })).toHaveValue(/Wavelocal error report/)
    await expect(page.getByRole('textbox', { name: 'Details' })).not.toHaveValue(/Zebra/)
  })

  test('is listed in Diagnostics once the app is back', async ({ page }) => {
    await breakTitle(page)
    await page.goto('/?once')
    await expect(screen(page)).toBeVisible()
    await choice(page, 'Reload').click()
    const app = new PlayerPage(page)
    await expect(app.viewSelect).toBeVisible({ timeout: 15_000 })
    await app.openTools()
    const list = app.tools.getByRole('region', { name: 'Diagnostics' }).getByRole('list', { name: 'Recorded errors' })
    await list.scrollIntoViewIfNeeded()
    await expect(list).toContainText('boundary')
    await expect(list).toContainText('Error: forced crash for <text>')
  })
})

test.describe('Start fresh', () => {
  test('keeps the music and the playlists, forgets the settings, where you were and the queue, and gets the app going again', async ({ page }) => {
    await breakTitle(page)
    const app = new PlayerPage(page)
    await app.open()
    await app.importFiles(song('01-a.mp3', { title: '01-a' }, 200), song('02-b.mp3', { title: '02-b' }, 200), song('03-c.mp3', { title: '03-c' }, 200))
    await expect(app.rows).toHaveCount(3)
    await expect.poll(async () => (await app.storedTracks()).length).toBe(3)
    const ids = (await app.storedTracks()).map((t) => t.id)
    await app.putMeta('playlists', [{ id: 'plKeep', name: 'Mine', trackIds: [ids[0]] }])
    await app.queueTrack('03-c', 'Add to queue')
    await expect.poll(() => app.storedMeta('upNext')).toHaveLength(1)
    await app.play('02-b') // where you were: the second track
    await app.playButton.click()
    await expect.poll(async () => ((await app.storedMeta('resume')) as { id: string } | undefined)?.id).toBe(ids[1])
    await page.evaluate(() => {
      localStorage.setItem('wl-accent', '#e11d48')
      localStorage.setItem('wl-crash', '1') // from now on every start fails
    })

    await app.reload().catch(() => undefined) // the page that loads is the recovery screen, not the app
    await expect(screen(page)).toBeVisible()
    await choice(page, 'Reload').click() // reloading does not help: the stored value is still there
    await expect(screen(page)).toBeVisible()

    await choice(page, 'Start fresh…').click()
    await choice(page, 'Start fresh').click()
    await expect(app.viewSelect).toBeVisible({ timeout: 15_000 })

    // the music and the playlists are all there
    await expect(app.rows).toHaveCount(3)
    await expect(app.viewSelect.locator('option', { hasText: 'Mine' })).toHaveText('Mine (1)')
    // the settings are gone (the value that crashed it with them), and the error log is not
    expect(await page.evaluate(() => [localStorage.getItem('wl-accent'), localStorage.getItem('wl-crash')])).toEqual([null, null])
    expect(await page.evaluate(() => JSON.parse(localStorage.getItem('wl.diagnostics') ?? 'null')?.entries?.[0]?.kind)).toBe('boundary')
    // where you were and the queue were not taken up: the first track is ready, and nothing is queued
    await expect(app.nowPlayingTitle).toHaveText('01-a')
    await expect.poll(() => app.storedMeta('upNext')).toEqual([])
    await app.showUpNext()
    expect(await app.upNextTitles()).toEqual([])
    // and only for that start: the next one takes up what is saved again
    expect(await page.evaluate(() => sessionStorage.getItem('wl.safe'))).toBeNull()
  })

  test('can be backed out of, and does nothing until it is confirmed', async ({ page }) => {
    await breakTitle(page)
    await page.goto('/?once')
    await page.evaluate(() => localStorage.setItem('wl-accent', '#e11d48'))
    await choice(page, 'Start fresh…').click()
    await expect(page.getByText('forgets your settings, where you were and what was queued')).toBeVisible()
    await choice(page, 'Cancel').click()
    await expect(choice(page, 'Start fresh…')).toBeVisible()
    expect(await page.evaluate(() => localStorage.getItem('wl-accent'))).toBe('#e11d48')
    expect(await page.evaluate(() => sessionStorage.getItem('wl.safe'))).toBeNull()
  })
})
