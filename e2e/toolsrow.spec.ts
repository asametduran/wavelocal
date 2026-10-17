import AxeBuilder from '@axe-core/playwright'
import { expect, test } from '@playwright/test'
import type { Page } from '@playwright/test'
import { PlayerPage, settled, wav } from './helpers'
import type { Upload } from './helpers'
import { buildMp3 } from '../src/test-utils/containers'
import { buildId3v2, withId3 } from '../src/test-utils/id3'

// The row of loop and bookmark buttons under the seek bar: not there for a song until it is of use (a loop is being set, a bookmark
// exists, the recording is long or has chapters, or the person chose "always"), the same things the L and B keys do, drawn on the
// waveform, and as accessible on a phone as on a desktop.

const TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa', 'best-practice']

/** A recording of 21 minutes (a long one starts at 20): MPEG 2.5 layer III, 8 kHz, mono, 8 kbps is 72 ms and 72 bytes a frame, so it is 1.3 MB. */
const LECTURE: Upload = {
  name: 'lecture.mp3',
  mimeType: 'audio/mpeg',
  buffer: Buffer.from(withId3(buildId3v2({ title: 'The Lecture', artist: 'A Professor' }), buildMp3({ version: 2.5, sampleRate: 8000, bitrateKbps: 8, mode: 'mono', frames: Math.round(1260 / (576 / 8000)) }))),
}

/** Whether anything is painted on the footer's third canvas (the one marks are drawn on) at `share` (0 to 1) of its width, halfway down. */
async function paintedAt(page: Page, share: number): Promise<boolean> {
  return page.evaluate((at) => {
    const canvas = document.querySelectorAll<HTMLCanvasElement>('#player .seek canvas')[2]
    const ctx = canvas?.getContext('2d')
    if (!canvas || !ctx || !canvas.width) return false
    const x = Math.min(canvas.width - 1, Math.round(at * canvas.width))
    return (ctx.getImageData(x, Math.floor(canvas.height / 2), 1, 1).data[3] ?? 0) > 0
  }, share)
}

test.describe('the loop and bookmark buttons', () => {
  let app: PlayerPage

  test.beforeEach(({ page }) => {
    app = new PlayerPage(page)
  })

  const row = () => app.footer.getByRole('group', { name: 'Loop and bookmarks' })
  const buttonA = () => row().getByTestId('loop-start')
  const buttonB = () => row().getByTestId('loop-end')
  const clear = () => row().getByTestId('loop-clear')
  const add = () => row().getByTestId('bookmark-add')
  const opener = () => row().getByTestId('bookmark-open')

  /** Import a song of 30 s, start it and stop it where it is, so every position below is exact. */
  async function openSong(file: Upload = wav('long'), title = 'long'): Promise<void> {
    await app.open()
    await app.importFiles(file)
    await expect(app.rows).toHaveCount(1)
    await app.play(title)
    await app.playButton.click()
    await app.expectPaused()
  }

  test('a song has no row until it is of use: setting a loop brings it, clearing the loop takes it away', async () => {
    await openSong()
    await expect(row()).toHaveCount(0)

    await app.seekTo(5)
    await app.key('l')
    await expect(app.toast('Loop start 0:05')).toBeVisible()
    await expect(row()).toBeVisible()
    await expect(buttonA()).toHaveAccessibleName('A 0:05, set loop start here')
    await expect(buttonB()).toHaveAccessibleName('B, set loop end here')
    await expect(clear()).toBeEnabled()

    await app.seekTo(7)
    await app.key('l')
    await expect(buttonB()).toHaveAccessibleName('B 0:07, set loop end here')
    await app.key('l')
    await expect(app.toast('Loop cleared')).toBeVisible()
    await expect(row()).toHaveCount(0) // a song as it always looked
  })

  test('the buttons do what the keys do, and the part that repeats is drawn on the waveform', async ({ page }) => {
    await page.addInitScript(() => localStorage.setItem('wl.seektools', 'always'))
    await openSong()
    await expect(row()).toBeVisible()
    await expect(clear()).toBeDisabled() // nothing to clear
    await expect(opener()).toHaveAccessibleName('Chapters and bookmarks')

    await buttonB().click() // the end needs a start
    await expect(app.toast('Set the start of the loop first (A).')).toBeVisible()

    await app.seekTo(5)
    await buttonA().click()
    await expect(app.toast('Loop start 0:05. Set the end with B.')).toBeVisible()
    await expect(buttonA()).toHaveText('A 0:05')
    await expect.poll(() => paintedAt(page, 5 / 30)).toBe(true) // the start waits for its end as a line
    await expect.poll(() => paintedAt(page, 0.5)).toBe(false)

    await app.seekTo(7.5)
    await buttonB().click()
    await expect(app.toast('Looping 0:05 to 0:07')).toBeVisible()
    await expect(buttonB()).toHaveText('B 0:07')
    await expect.poll(() => paintedAt(page, 0.2)).toBe(true) // between the ends, shaded
    expect(await paintedAt(page, 0.5)).toBe(false) // and outside them, not

    await app.seekTo(6)
    await buttonA().click() // the start moves, the end stays
    await expect(app.toast('Looping 0:06 to 0:07')).toBeVisible()
    await expect(buttonA()).toHaveText('A 0:06')

    await app.seekTo(20)
    await buttonA().click() // a start after the end: the loop gives way to a start that waits for its end
    await expect(app.toast(/Loop start 0:20/)).toBeVisible()
    await expect(buttonB()).toHaveAccessibleName('B, set loop end here')
    await expect.poll(() => paintedAt(page, 0.2)).toBe(false)
    await expect.poll(() => paintedAt(page, 20 / 30)).toBe(true)

    await clear().click()
    await expect(app.toast('Loop cleared')).toBeVisible()
    await expect(clear()).toBeDisabled()
    await expect.poll(() => paintedAt(page, 20 / 30)).toBe(false)
  })

  test('a loop made with the buttons holds the playhead the same as one made with the key', async () => {
    await openSong()
    await app.openTools()
    await app.tools.getByRole('radiogroup', { name: 'Loop and bookmark buttons' }).getByRole('radio', { name: 'Always' }).click()
    await app.closeTools()
    await app.seekTo(5)
    await buttonA().click()
    await app.seekTo(6.2)
    await buttonB().click()
    await app.seekTo(5)
    await app.playButton.click()
    await app.expectPlaying()
    await app.page.waitForTimeout(3000) // three rounds of a part 1.2 s long
    expect(await app.position()).toBeLessThanOrEqual(6)
    expect(await app.position()).toBeGreaterThanOrEqual(5)
    await app.expectPlaying()
  })

  test('the bookmark buttons add a bookmark at the playhead and open the list', async ({ page }) => {
    await page.addInitScript(() => localStorage.setItem('wl.seektools', 'always'))
    await openSong()
    await app.seekTo(9)
    await add().click()
    await expect(app.toast('Bookmark 1 at 0:09')).toBeVisible()
    await expect(opener()).toHaveAccessibleName('Chapters and bookmarks, 1 bookmark')
    await opener().click()
    const dialog = page.getByRole('dialog', { name: 'Chapters and bookmarks', exact: true })
    await expect(dialog).toBeVisible()
    await expect(dialog.getByRole('list', { name: 'Bookmarks of this track' }).getByRole('listitem')).toHaveCount(1)
    await page.keyboard.press('Escape')
    await expect(dialog).toBeHidden()
    await expect(opener()).toBeFocused() // back where it was opened from
  })

  test('the setting "Always" puts the row under every track, and is kept; "When useful" takes it away again', async ({ page }) => {
    await openSong()
    await expect(row()).toHaveCount(0)

    await app.openTools()
    const group = app.tools.getByRole('radiogroup', { name: 'Loop and bookmark buttons' })
    await expect(group.getByRole('radio', { name: 'When useful' })).toHaveAttribute('aria-checked', 'true')
    await group.getByRole('radio', { name: 'Always' }).click()
    await expect(group.getByRole('radio', { name: 'Always' })).toHaveAttribute('aria-checked', 'true')
    await expect(app.tools.getByText(/This is how to reach them for a song on a phone/)).toBeVisible()
    await app.closeTools()
    await expect(row()).toBeVisible()
    expect(await page.evaluate(() => localStorage.getItem('wl.seektools'))).toBe('always')

    await app.reload()
    await expect(row()).toBeVisible() // kept
    await app.openTools()
    await group.getByRole('radio', { name: 'When useful' }).click()
    await app.closeTools()
    await expect(row()).toHaveCount(0)
    expect(await page.evaluate(() => localStorage.getItem('wl.seektools'))).toBe('auto')
  })

  test('the choice can be made with the arrow keys, like the seek bar style next to it', async ({ page }) => {
    await openSong()
    await app.openTools()
    const group = app.tools.getByRole('radiogroup', { name: 'Loop and bookmark buttons' })
    await group.getByRole('radio', { name: 'When useful' }).focus()
    await page.keyboard.press('ArrowRight')
    await expect(group.getByRole('radio', { name: 'Always' })).toBeFocused()
    await page.keyboard.press('Enter')
    await expect(group.getByRole('radio', { name: 'Always' })).toHaveAttribute('aria-checked', 'true')
  })

  test('a long recording has the row by itself, with no setting and no bookmark', async () => {
    await openSong(LECTURE, 'The Lecture')
    await expect.poll(() => app.duration()).toBeGreaterThan(1200)
    await expect(row()).toBeVisible()
  })

  test('works with the plain seek bar: the row and the announcements are the same, and nothing is drawn', async ({ page }) => {
    await page.addInitScript(() => localStorage.setItem('wl.seekbar', 'plain'))
    await openSong()
    await app.seekTo(5)
    await app.key('l')
    await app.seekTo(8)
    await app.key('l')
    await expect(app.toast('Looping 0:05 to 0:08')).toBeVisible()
    await expect(row()).toBeVisible()
    await expect(buttonA()).toHaveAccessibleName('A 0:05, set loop start here')
    await expect(app.footer.locator('.seek canvas')).toHaveCount(0)
    expect(await app.policyViolations()).toEqual([])
  })

  test('has no accessibility violations: the row with a loop and a bookmark, the list, and the setting', async ({ page }) => {
    await page.addInitScript(() => localStorage.setItem('wl.seektools', 'always'))
    await openSong()
    await app.seekTo(5)
    await buttonA().click()
    await app.seekTo(8)
    await buttonB().click()
    await add().click()
    await expect(opener()).toHaveAccessibleName('Chapters and bookmarks, 1 bookmark')
    await settled(page)
    const bar = await new AxeBuilder({ page }).withTags(TAGS).include('#player').analyze()
    expect(bar.violations).toEqual([])

    await opener().click()
    await expect(page.getByRole('dialog', { name: 'Chapters and bookmarks', exact: true })).toBeVisible()
    await settled(page)
    const dialog = await new AxeBuilder({ page }).withTags(TAGS).analyze()
    expect(dialog.violations).toEqual([])
    await page.keyboard.press('Escape')

    await app.openTools()
    await expect(app.tools.getByRole('radiogroup', { name: 'Loop and bookmark buttons' })).toBeVisible()
    await settled(page)
    const tools = await new AxeBuilder({ page }).withTags(TAGS).analyze()
    expect(tools.violations).toEqual([])
  })
})

test.describe('the loop and bookmark buttons on a phone', () => {
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true })

  test('are above the seek bar in the Now playing sheet, big enough to touch, and work by touch; the list fits the screen', async ({ page }) => {
    await page.addInitScript(() => localStorage.setItem('wl.seektools', 'always'))
    const app = new PlayerPage(page)
    await app.open()
    await app.importFiles(wav('long'))
    await expect(app.rows).toHaveCount(1)
    await page.locator('#player-mini').getByRole('button', { name: 'Open now playing' }).click()
    const sheet = page.getByRole('dialog', { name: 'Now playing' })
    const group = sheet.getByRole('group', { name: 'Loop and bookmarks' })
    await expect(group).toBeVisible({ timeout: 15_000 })
    await settled(page) // the sheet slides up: measure it where it stays

    const rowBox = await group.boundingBox()
    const barBox = await sheet.locator('.seek').boundingBox()
    expect((rowBox?.y ?? 0) + (rowBox?.height ?? 0)).toBeLessThanOrEqual((barBox?.y ?? 0) + 1) // above the bar
    expect((rowBox?.x ?? -1)).toBeGreaterThanOrEqual(0)
    expect((rowBox?.x ?? 0) + (rowBox?.width ?? 0)).toBeLessThanOrEqual(390)
    for (const id of ['loop-start', 'loop-end', 'loop-clear', 'bookmark-add', 'bookmark-open']) {
      const box = await group.getByTestId(id).boundingBox()
      expect(box?.height ?? 0, id).toBeGreaterThanOrEqual(40)
      expect(box?.width ?? 0, id).toBeGreaterThanOrEqual(40)
    }

    const seek = sheet.getByRole('slider', { name: 'Seek' })
    await expect.poll(() => seek.getAttribute('max').then(Number)).toBeGreaterThan(20)
    await seek.fill('4')
    await group.getByTestId('loop-start').tap()
    await seek.fill('9')
    await group.getByTestId('loop-end').tap()
    await expect(page.getByRole('status').filter({ hasText: 'Looping 0:04 to 0:09' })).toBeVisible()
    await group.getByTestId('bookmark-add').tap()
    await expect(group.getByTestId('bookmark-open')).toHaveAccessibleName('Chapters and bookmarks, 1 bookmark')

    await group.getByTestId('bookmark-open').tap()
    const dialog = page.getByRole('dialog', { name: 'Chapters and bookmarks', exact: true })
    await expect(dialog).toBeVisible()
    await settled(page)
    const box = await dialog.boundingBox()
    expect(box?.x ?? -1).toBeGreaterThanOrEqual(0)
    expect((box?.x ?? 0) + (box?.width ?? 0)).toBeLessThanOrEqual(390)
    expect(box?.y ?? -1).toBeGreaterThanOrEqual(0)
    expect((box?.y ?? 0) + (box?.height ?? 0)).toBeLessThanOrEqual(844)
    const results = await new AxeBuilder({ page }).withTags(TAGS).analyze()
    expect(results.violations).toEqual([])
    expect(await app.policyViolations()).toEqual([])
  })
})
