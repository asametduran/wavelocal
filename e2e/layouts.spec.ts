import AxeBuilder from '@axe-core/playwright'
import { expect, test } from '@playwright/test'
import type { Locator, Page } from '@playwright/test'
import { PlayerPage, importWithMtime, libraryKey, settled } from './helpers'
import type { Upload } from './helpers'
import { buildMp3 } from '../src/test-utils/containers'
import { buildChapterTag, textFrame } from '../src/test-utils/chapters'
import type { ChapterSpec } from '../src/test-utils/chapters'
import { withId3 } from '../src/test-utils/id3'

// Everything E5 puts under the seek bar, in its widest state (chapters, a loop with hour-long labels, bookmarks and the buttons of
// a long recording) on the length it was made for: a three-hour book, on a phone, a tablet, a desktop and a TV. Nothing may leave
// the screen, overlap, or be too small to hit, the dialogs must fit, a TV remote must get around, and axe must find nothing.

const TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa', 'best-practice']
const MTIME = 1_700_000_000_000
const HOURS = 3

/** MPEG 2.5 layer III, 8 kHz, mono, 8 kbps: 72 ms and 72 bytes a frame, so three hours is 10.8 MB. */
const MP3 = { version: 2.5, sampleRate: 8000, bitrateKbps: 8, mode: 'mono', frames: Math.round((HOURS * 3600) / (576 / 8000)) } as const
const CHAPTERS: readonly ChapterSpec[] = [
  { startMs: 0, title: 'Prologue' },
  { startMs: 1_800_000, title: 'The Fall of Rome' },
  { startMs: 5_400_000, title: 'Interlude' },
  { startMs: 9_000_000, title: 'Epilogue' },
]
const BOOK: Upload = {
  name: 'book.mp3',
  mimeType: 'audio/mpeg',
  buffer: Buffer.from(withId3(buildChapterTag(CHAPTERS, { before: [textFrame('TIT2', 'The Long Book', 0, 3)] }), buildMp3(MP3))),
}
const TITLE = 'The Long Book'

interface Layout {
  name: string
  viewport: { width: number; height: number }
  /** TV mode: larger text and a remote's directional keys. */
  tv?: boolean
  /** The player is the Now playing sheet, not the footer. */
  sheet?: boolean
  /** The smallest side of a button to hit (CSS pixels). */
  target: number
}

const LAYOUTS: readonly Layout[] = [
  { name: 'phone', viewport: { width: 390, height: 844 }, sheet: true, target: 40 },
  { name: 'tablet', viewport: { width: 820, height: 1180 }, target: 24 },
  { name: 'desktop', viewport: { width: 1280, height: 800 }, target: 24 },
  { name: 'TV', viewport: { width: 1920, height: 1080 }, tv: true, target: 36 },
]

/** The buttons of the rows under the seek bar, in the order they are laid out: the skip pair, then the loop and bookmark group. */
const ROW = ['skip-back', 'skip-forward', 'loop-start', 'loop-end', 'loop-clear', 'bookmark-add', 'bookmark-open'] as const

interface Box {
  x: number
  y: number
  width: number
  height: number
}

const overlap = (a: Box, b: Box): boolean => a.x < b.x + b.width - 1 && b.x < a.x + a.width - 1 && a.y < b.y + b.height - 1 && b.y < a.y + a.height - 1

interface Rig {
  app: PlayerPage
  /** Where the player is: the footer, or the Now playing sheet. */
  area: Locator
  seek: (seconds: number) => Promise<void>
}

/** Open the app in a layout with the book imported, and put a loop, two bookmarks and a playhead at hour-scale places. */
async function prepare(page: Page, layout: Layout): Promise<Rig> {
  if (layout.tv) await page.addInitScript(() => localStorage.setItem('wl-tv', '1'))
  const app = new PlayerPage(page)
  await app.open()
  // A deliberately wide font (set through the CSSOM: the page's policy refuses a style tag), so that the proof does not depend on which
  // fonts the machine has. It failed on the CI runner (Linux, DejaVu Sans) while passing on the Windows machine it was written on:
  // the last button of the loop and bookmark row wrapped onto a line of its own there, which is what this test exists to prevent.
  await page.evaluate(() => {
    const sheet = new CSSStyleSheet()
    sheet.replaceSync('*{font-family:Verdana,"DejaVu Sans",sans-serif !important}')
    document.adoptedStyleSheets = [...document.adoptedStyleSheets, sheet]
  })
  await importWithMtime(app, [BOOK], MTIME)
  await expect(app.rows).toHaveCount(1)
  await expect.poll(async () => (await app.storedTracks()).length).toBe(1)

  let area: Locator = app.footer
  let seek = (seconds: number): Promise<void> => app.seekTo(seconds)
  if (layout.sheet) {
    await page.locator('#player-mini').getByRole('button', { name: 'Open now playing' }).click()
    const sheet = page.getByRole('dialog', { name: 'Now playing' })
    const slider = sheet.getByRole('slider', { name: 'Seek' })
    area = sheet
    seek = async (seconds) => {
      await expect.poll(() => slider.getAttribute('max').then(Number)).toBeGreaterThan(seconds)
      await slider.fill(String(seconds))
    }
  }
  await expect(area.getByTestId('chapter-open')).toBeVisible({ timeout: 15_000 })
  await settled(page)

  await seek(5025) // 1:23:45
  await area.getByTestId('loop-start').click()
  await seek(5050) // 1:24:10
  await area.getByTestId('loop-end').click()
  await seek(5030)
  await area.getByTestId('bookmark-add').click()
  await seek(7000)
  await area.getByTestId('bookmark-add').click()
  await expect(area.getByTestId('loop-start')).toHaveText('A 1:23:45')
  await expect(area.getByTestId('loop-end')).toHaveText('B 1:24:10')
  await expect(area.getByTestId('bookmark-open')).toHaveAccessibleName('Chapters and bookmarks, 2 bookmarks')
  // the toasts of the clicks above stay several seconds, over the row: a person puts them away, and the checks below look at the row
  const dismiss = page.getByRole('button', { name: 'Dismiss' })
  for (let i = 0; i < 6 && (await dismiss.count()) > 0; i++) await dismiss.first().click()
  await expect(dismiss).toHaveCount(0)
  return { app, area, seek }
}

for (const layout of LAYOUTS) {
  test.describe(`${layout.name}: a three-hour book`, () => {
    test.use({ viewport: layout.viewport, hasTouch: layout.sheet === true })

    test('every button under the seek bar is on the screen, big enough to hit, and clear of the others', async ({ page }) => {
      const { area } = await prepare(page, layout)
      const boxes = new Map<string, Box>()
      for (const id of ['chapter-open', ...ROW]) {
        const box = await area.getByTestId(id).boundingBox()
        expect(box, `${id} is drawn`).not.toBeNull()
        if (box) boxes.set(id, box)
      }
      for (const [id, box] of boxes) {
        expect(box.x, `${id} starts on the screen`).toBeGreaterThanOrEqual(-0.5)
        expect(box.x + box.width, `${id} ends on the screen`).toBeLessThanOrEqual(layout.viewport.width + 0.5)
        const side = id === 'chapter-open' ? 24 : layout.target // the name of the chapter is a wide strip, not a thumb target
        expect(Math.min(box.width, box.height), `${id} is big enough`).toBeGreaterThanOrEqual(side)
      }
      const ids = [...boxes.keys()]
      for (const [i, a] of ids.entries()) for (const b of ids.slice(i + 1)) expect(overlap(boxes.get(a) as Box, boxes.get(b) as Box), `${a} and ${b} do not overlap`).toBe(false)
      // wherever the row has to wrap, the two skip buttons stay together and the loop and bookmark buttons stay on one line:
      // a button left alone on a line of its own is a row that was never looked at at this width
      const line = (id: string): number => boxes.get(id)?.y ?? Number.NaN
      expect(Math.abs(line('skip-back') - line('skip-forward')), 'the skip buttons are on one line').toBeLessThan(3)
      for (const id of ROW.filter((id) => id.startsWith('loop') || id.startsWith('bookmark'))) expect(Math.abs(line(id) - line('loop-start')), `${id} is on the line of the loop buttons`).toBeLessThan(3)
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth)
      expect(overflow).toBe(false)
      await settled(page)
      const results = await new AxeBuilder({ page }).withTags(TAGS).analyze()
      expect(results.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(' ')).join(', ')}`)).toEqual([])
    })

    test('the chapters dialog, with the choice for this track, and the setting for long recordings fit the screen and pass axe', async ({ page }) => {
      const { app, area } = await prepare(page, layout)

      await area.getByTestId('chapter-open').click()
      const dialog = page.getByRole('dialog', { name: 'Chapters and bookmarks', exact: true })
      await expect(dialog).toBeVisible()
      await settled(page)
      const box = await dialog.boundingBox()
      expect(box?.x ?? -1).toBeGreaterThanOrEqual(0)
      expect(box?.y ?? -1).toBeGreaterThanOrEqual(0)
      expect((box?.x ?? 0) + (box?.width ?? 0)).toBeLessThanOrEqual(layout.viewport.width)
      expect((box?.y ?? 0) + (box?.height ?? 0)).toBeLessThanOrEqual(layout.viewport.height)
      const group = dialog.getByRole('radiogroup', { name: 'Remember where I stop in this track' })
      await group.scrollIntoViewIfNeeded()
      for (const name of ['Automatic', 'Always', 'Never']) await expect(group.getByRole('radio', { name })).toBeVisible()
      await expect(dialog.getByTestId('remembering')).toContainText('counts as a long recording')
      await expect(dialog.getByRole('list', { name: 'Chapters of this track' }).getByRole('listitem')).toHaveCount(CHAPTERS.length)
      const chapters = await new AxeBuilder({ page }).withTags(TAGS).analyze()
      expect(chapters.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(' ')).join(', ')}`)).toEqual([])
      await page.keyboard.press('Escape')
      await expect(dialog).toBeHidden()

      if (layout.sheet) await area.getByRole('button', { name: 'Equalizer and tools' }).click()
      else await app.openTools()
      await expect(app.tools).toBeVisible()
      const section = app.tools.getByRole('region', { name: 'Long recordings' })
      await section.scrollIntoViewIfNeeded()
      await expect(section.getByRole('radio', { name: 'Over 20 min' })).toHaveAttribute('aria-checked', 'true')
      for (const radio of await section.getByRole('radio').all()) {
        const chip = await radio.boundingBox()
        expect(chip?.x ?? -1).toBeGreaterThanOrEqual(0)
        expect((chip?.x ?? 0) + (chip?.width ?? 0)).toBeLessThanOrEqual(layout.viewport.width)
        expect(chip?.height ?? 0).toBeGreaterThanOrEqual(24)
      }
      await settled(page)
      const tools = await new AxeBuilder({ page }).withTags(TAGS).analyze()
      expect(tools.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(' ')).join(', ')}`)).toEqual([])
      expect(await app.policyViolations()).toEqual([])
    })
  })
}

test.describe('TV: a three-hour book with a remote', () => {
  const tv = LAYOUTS.find((l) => l.tv) as Layout
  test.use({ viewport: tv.viewport })

  test('the directional keys walk along the row under the seek bar, and OK on a skip button skips', async ({ page }) => {
    const { app, area } = await prepare(page, tv)
    await area.getByTestId('skip-back').focus()
    for (const id of ROW.slice(1)) {
      await page.keyboard.press('ArrowRight')
      await expect(area.getByTestId(id), `the right key reaches ${id}`).toBeFocused()
    }
    for (const id of [...ROW].reverse().slice(1, -1)) {
      await page.keyboard.press('ArrowLeft')
      await expect(area.getByTestId(id), `the left key reaches ${id}`).toBeFocused()
    }
    const before = await app.position()
    await page.keyboard.press('Enter') // the focus is on skip-forward again
    await expect.poll(async () => (await app.position()) - before).toBeGreaterThanOrEqual(29)
  })

  test('the choice for this track moves one step per press with the remote, and Back closes the dialog', async ({ page }) => {
    const { area } = await prepare(page, tv)
    await area.getByTestId('chapter-open').focus()
    await page.keyboard.press('Enter')
    const dialog = page.getByRole('dialog', { name: 'Chapters and bookmarks', exact: true })
    await expect(dialog).toBeVisible()
    const group = dialog.getByRole('radiogroup', { name: 'Remember where I stop in this track' })
    await group.getByRole('radio', { name: 'Automatic' }).focus()
    await page.keyboard.press('ArrowRight')
    await expect(group.getByRole('radio', { name: 'Always' })).toBeFocused() // one step, not two: the roving keys and the remote's navigator do not both move it
    await page.keyboard.press('ArrowLeft')
    await expect(group.getByRole('radio', { name: 'Automatic' })).toBeFocused()
    await page.keyboard.press('Escape')
    await expect(dialog).toBeHidden()
    await expect(area.getByTestId('chapter-open')).toBeFocused()
  })
})

test.describe('a three-hour book', () => {
  const heardKey = `heard:${libraryKey(BOOK, MTIME)}`

  test('its waveform is measured, window by window, and kept; its place is kept and taken up at hour scale, and the clocks have room for hours', async ({ page }) => {
    test.setTimeout(120_000)
    const app = new PlayerPage(page)
    await app.open()
    await importWithMtime(app, [BOOK], MTIME)
    await expect(app.rows).toHaveCount(1)
    await expect.poll(async () => (await app.storedTracks()).length).toBe(1)
    const [stored] = await app.storedTracks()
    await expect.poll(async () => app.storedPeaks(stored?.id ?? ''), { timeout: 60_000, message: 'the waveform of three hours of MP3 is measured and kept' }).toMatchObject({ v: 1, length: 1024 })
    expect(Math.abs(((await app.storedPeaks(stored?.id ?? '')) as { duration: number }).duration - HOURS * 3600)).toBeLessThan(5)
    await app.play(TITLE)
    await app.seekTo(5025)
    await app.playButton.click()
    await app.expectPaused()
    await expect.poll(async () => ((await app.storedMeta(heardKey)) as { t: number | null } | undefined)?.t ?? 0).toBeGreaterThanOrEqual(5000)
    const left = ((await app.storedMeta(heardKey)) as { t: number }).t
    expect(left).toBeLessThan(5100) // an MP3 without a table of contents is sought by its bit rate, so a little off is the format, not the app

    await app.reload()
    await expect(app.toast(/Resumed at 1:\d\d:\d\d/)).toBeVisible()
    await expect.poll(async () => Math.abs((await app.position()) - (left - 3))).toBeLessThan(2)
    // the clock shows "1:23:42" and "3:00:00" whole
    const clocked = await app.footer.locator('span:is(.w-10, .w-14)[aria-hidden="true"]').evaluateAll((els) => els.map((el) => ({ text: el.textContent, clipped: el.scrollWidth > el.clientWidth })))
    expect(clocked.map((c) => c.text)).toEqual([expect.stringMatching(/^1:\d\d:\d\d$/), '3:00:00'])
    expect(clocked.some((c) => c.clipped)).toBe(false)

    await app.key('c')
    const dialog = page.getByRole('dialog', { name: 'Chapters and bookmarks', exact: true })
    await expect(dialog.getByTestId('remembering')).toContainText(/Saved place 1:\d\d:\d\d\./)
    expect(await app.policyViolations()).toEqual([])
  })
})
