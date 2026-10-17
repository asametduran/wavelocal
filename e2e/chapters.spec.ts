import AxeBuilder from '@axe-core/playwright'
import { expect, test } from '@playwright/test'
import type { Page } from '@playwright/test'
import { PlayerPage, settled, song } from './helpers'
import type { Upload } from './helpers'
import { ascii, buildMp3, buildOgg, cat, w32be } from '../src/test-utils/containers'
import { buildChapterTag, buildMp4WithChpl, tagFrom, textFrame } from '../src/test-utils/chapters'
import type { ChapterSpec } from '../src/test-utils/chapters'
import { withId3 } from '../src/test-utils/id3'

// The chapters of a long recording: read from the file's tags once and kept in the database, named under the seek bar, listed in
// a dialog, drawn as lines on the waveform, and said aloud when a new one begins. Songs have none of it.

const SECONDS = 120
/** MPEG 2.5 layer III, 8 kHz, mono, 8 kbps: 72 ms and 72 bytes a frame, so two minutes of silence is 120 kB. */
const MP3 = { version: 2.5, sampleRate: 8000, bitrateKbps: 8, mode: 'mono', frames: Math.round(SECONDS / (576 / 8000)) } as const

const BOOK: readonly ChapterSpec[] = [
  { startMs: 0, title: 'Prologue' },
  { startMs: 30_000, title: 'The Fall of Rome' },
  { startMs: 60_000, title: 'Interlude' },
  { startMs: 90_000, title: 'Epilogue' },
]

/** A two-minute MP3 with an ID3 tag that holds a title and the chapters. */
const audiobook = (name: string, chapters: readonly ChapterSpec[] = BOOK, title = 'The Long Book'): Upload => ({
  name,
  mimeType: 'audio/mpeg',
  buffer: Buffer.from(withId3(buildChapterTag(chapters, { before: [textFrame('TIT2', title, 0, 3)] }), buildMp3(MP3))),
})

interface Kept {
  v: number
  chapters: { start: number; end: number; title: string }[]
}

/** The pixel columns of the footer's third canvas, the one the chapter lines are drawn on, that have anything painted in them. */
async function markColumns(page: Page): Promise<number[]> {
  return page.evaluate(() => {
    const canvas = document.querySelectorAll<HTMLCanvasElement>('#player .seek canvas')[2]
    const ctx = canvas?.getContext('2d')
    if (!canvas || !ctx || !canvas.width || !canvas.height) return []
    const { width, height } = canvas
    const data = ctx.getImageData(0, 0, width, height).data
    const found: number[] = []
    for (let x = 0; x < width; x++) {
      for (let y = 0; y < height; y++) {
        if ((data[(y * width + x) * 4 + 3] ?? 0) > 0) {
          found.push(x)
          break
        }
      }
    }
    return found
  })
}

/** Everything the page's announcer says from now on, as a function that reads it. The region holds only the latest message, so watch it change. */
async function recordAnnouncements(page: Page): Promise<() => Promise<string[]>> {
  await page.evaluate(() => {
    const said: string[] = []
    Object.assign(window, { __said: said })
    const region = document.querySelector('[data-testid="announcer"]')
    if (region) new MutationObserver(() => said.push(region.textContent ?? '')).observe(region, { childList: true, characterData: true, subtree: true })
  })
  return () => page.evaluate(() => (window as unknown as { __said: string[] }).__said)
}

const TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa', 'best-practice']

test.describe('chapters', () => {
  let app: PlayerPage

  // the row under the footer's seek bar, and the list the C key and the row's button open
  const row = () => app.footer.getByRole('group', { name: 'Chapters' })
  const chapterName = () => row().getByTestId('chapter-name')
  const openList = () => row().getByTestId('chapter-open')
  const previous = () => row().getByRole('button', { name: 'Previous chapter (,)' })
  const next = () => row().getByRole('button', { name: 'Next chapter (.)' })
  const list = (page: Page) => page.getByRole('dialog', { name: 'Chapters', exact: true })
  const kept = async (id: string): Promise<Kept | undefined> => (await app.storedMeta(`chapters:${id}`)) as Kept | undefined

  test.beforeEach(({ page }) => {
    app = new PlayerPage(page)
  })

  /** Import a recording, start it and stop it where it is (so every position below is exact), and give back the id the library gave it. */
  async function openBook(file: Upload = audiobook('book.mp3'), title = 'The Long Book'): Promise<string> {
    await app.open()
    await app.importFiles(file)
    await expect(app.rows).toHaveCount(1)
    await expect.poll(() => app.storedTracks().then((tracks) => tracks.length)).toBe(1)
    const id = (await app.storedTracks())[0]?.id ?? ''
    await app.play(title)
    await expect.poll(() => app.duration()).toBe(SECONDS)
    await app.playButton.click()
    await app.expectPaused()
    return id
  }

  test('names the chapter that is playing, follows the playhead, and keeps what it read in the database', async () => {
    const id = await openBook()
    await expect(row()).toBeVisible()
    await expect(chapterName()).toHaveText('Prologue')
    await expect(openList()).toHaveAccessibleName(/Chapter 1 of 4\s*Prologue/)

    await app.seekTo(70)
    await expect(chapterName()).toHaveText('Interlude')
    await expect(openList()).toHaveAccessibleName(/Chapter 3 of 4\s*Interlude/)
    await app.seekTo(119)
    await expect(chapterName()).toHaveText('Epilogue')

    // each chapter ends where the next begins, and the last ends with the file
    await expect.poll(() => kept(id)).toMatchObject({
      v: 1,
      chapters: [
        { start: 0, end: 30, title: 'Prologue' },
        { start: 30, end: 60, title: 'The Fall of Rome' },
        { start: 60, end: 90, title: 'Interlude' },
        { start: 90, title: 'Epilogue' },
      ],
    })
    expect((await kept(id))?.chapters.at(-1)?.end ?? 0).toBeCloseTo(SECONDS, 0)
  })

  test('does not talk about chapters when the recording is only just opened: the track is announced, not its first chapter', async ({ page }) => {
    await app.open()
    const said = await recordAnnouncements(page)
    await app.importFiles(audiobook('book.mp3'))
    await expect(app.rows).toHaveCount(1)
    await app.play('The Long Book')
    await expect(chapterName()).toHaveText('Prologue') // the chapters are known by now
    await page.waitForTimeout(800) // longer than the pause before a chapter would be announced
    const heard = await said()
    expect(heard.some((text) => /Now playing: The Long Book/.test(text)), 'the page said something, so silence is not what passes this').toBe(true)
    expect(heard.filter((text) => text.includes('Chapter'))).toEqual([])
  })

  test('shows nothing for a song, remembers that it looked, and the list says there are none', async ({ page }) => {
    await app.open()
    await app.importFiles(song('plain.mp3', { title: 'Plain', artist: 'Nobody' }))
    await expect(app.rows).toHaveCount(1)
    await expect.poll(() => app.storedTracks().then((tracks) => tracks.length)).toBe(1)
    const id = (await app.storedTracks())[0]?.id ?? ''
    await app.play('Plain')
    await expect.poll(() => kept(id)).toEqual({ v: 1, chapters: [] }) // looked, found none: not looked for again
    await expect(row()).toHaveCount(0)

    await app.key('c')
    await expect(list(page)).toBeVisible()
    await expect(list(page).getByRole('status')).toHaveText('This file has no chapters.')
    await page.keyboard.press('Escape')
    await expect(list(page)).toBeHidden()
  })

  test('the buttons go to the next chapter, and back to the start of this one or to the one before', async () => {
    await openBook()
    await expect(previous()).toBeDisabled() // nothing before the first chapter
    await expect(next()).toBeEnabled()

    await next().click()
    await expect(app.seekBar).toHaveValue('30')
    await expect(chapterName()).toHaveText('The Fall of Rome')
    await expect(previous()).toBeEnabled()

    await app.seekTo(32) // two seconds in: "previous" is still "the one before", the way it is for tracks
    await previous().click()
    await expect(app.seekBar).toHaveValue('0')

    await app.seekTo(45) // fifteen seconds in: "previous" starts this chapter again
    await previous().click()
    await expect(app.seekBar).toHaveValue('30')

    await app.seekTo(100)
    await expect(chapterName()).toHaveText('Epilogue')
    await expect(next()).toBeDisabled() // nothing after the last one
  })

  test('the keys do the same: "." and "," move between chapters, C opens the list', async ({ page }) => {
    await openBook()
    await app.key('.')
    await expect(app.seekBar).toHaveValue('30')
    await app.key('.')
    await expect(app.seekBar).toHaveValue('60')
    await app.key(',') // right at the start of a chapter, "previous" is the chapter before
    await expect(app.seekBar).toHaveValue('30')

    await app.key('c')
    await expect(list(page)).toBeVisible()
    await page.keyboard.press('Escape')
    await expect(list(page)).toBeHidden()
    expect(await app.policyViolations()).toEqual([])
  })

  test('the list shows every chapter with its time, marks the one playing, and choosing one jumps there and closes it', async ({ page }) => {
    await openBook()
    await app.seekTo(65)
    await openList().click()
    const dialog = list(page)
    await expect(dialog).toBeVisible()
    const items = dialog.getByRole('listitem')
    await expect(items).toHaveCount(4)
    await expect(items.nth(0)).toContainText('Prologue')
    await expect(items.nth(0)).toContainText('0:00')
    await expect(items.nth(1)).toContainText('The Fall of Rome')
    await expect(items.nth(1)).toContainText('0:30')
    await expect(items.nth(3)).toContainText('1:30')
    await expect(dialog.getByText('4 chapters')).toBeVisible()

    // the one playing is marked, and has the focus; the page behind cannot be reached
    await expect(items.nth(2).getByRole('button')).toHaveAttribute('aria-current', 'true')
    await expect(items.nth(2).getByRole('button')).toBeFocused()
    await expect(page.locator('#root')).toHaveAttribute('inert', '')

    // the arrow keys are for the list and do not seek the track behind it
    await page.keyboard.press('ArrowRight')
    await expect(app.seekBar).toHaveValue('65')
    await page.keyboard.press('ArrowDown')
    await expect(items.nth(3).getByRole('button')).toBeFocused()
    await page.keyboard.press('Home')
    await expect(items.nth(0).getByRole('button')).toBeFocused()
    await page.keyboard.press('End')
    await expect(items.nth(3).getByRole('button')).toBeFocused()

    await items.nth(1).getByRole('button').click()
    await expect(dialog).toBeHidden()
    await expect(app.seekBar).toHaveValue('30')
    await expect(chapterName()).toHaveText('The Fall of Rome')
    await expect(page.locator('#root')).not.toHaveAttribute('inert', '')
    await expect(openList()).toBeFocused() // back where it was opened from
  })

  test('the browser’s Back button closes the list and leaves the page where it was', async ({ page }) => {
    await openBook()
    await openList().click()
    await expect(list(page)).toBeVisible()
    await page.goBack()
    await expect(list(page)).toBeHidden()
    expect(page.url()).toMatch(/^http:\/\/127\.0\.0\.1/)
    await expect(chapterName()).toBeVisible()
  })

  test('says which chapter a seek landed in, and says when playing reaches the next one', async ({ page }) => {
    await openBook()
    const announcer = page.getByTestId('announcer')
    await app.seekTo(70)
    await expect(announcer).toHaveText('Chapter 3 of 4: Interlude')

    await app.seekTo(28.5)
    await expect(announcer).toHaveText('Chapter 1 of 4: Prologue')
    await app.playButton.click()
    await expect(announcer).toHaveText('Chapter 2 of 4: The Fall of Rome', { timeout: 10_000 })
  })

  test('draws a line where each chapter begins on the waveform, and names the chapter under the pointer', async ({ page }) => {
    await openBook()
    const seek = app.footer.locator('.seek')
    await expect(seek).toHaveAttribute('data-wave', 'on')
    await expect.poll(async () => (await markColumns(page)).length).toBe(3) // none at the very start

    const width = await seek.evaluate((el) => el.clientWidth)
    const columns = await markColumns(page)
    ;[0.25, 0.5, 0.75].forEach((share, i) => expect(Math.abs((columns[i] ?? -99) - share * width), `line ${i + 1}`).toBeLessThanOrEqual(1.5))

    const box = await seek.boundingBox()
    expect(box).not.toBeNull()
    const { x, y, width: w, height: h } = box ?? { x: 0, y: 0, width: 0, height: 0 }
    await page.mouse.move(x + w * 0.4, y + h / 2)
    await expect(seek.getByText(/^0:4[789] · The Fall of Rome$/)).toBeVisible()
    await page.mouse.move(x + w * 0.1, y + h / 2)
    await expect(seek.getByText(/^0:1\d · Prologue$/)).toBeVisible()
  })

  test('keeps to a readable number of lines on a long book of 300 chapters, and the list opens at the one playing', async ({ page }) => {
    const many: ChapterSpec[] = Array.from({ length: 300 }, (_, i) => ({ startMs: i * 400, title: `Part ${i + 1}` }))
    await openBook(audiobook('many.mp3', many))
    const seek = app.footer.locator('.seek')
    await expect.poll(async () => (await markColumns(page)).length).toBeGreaterThan(20)
    const width = await seek.evaluate((el) => el.clientWidth)
    const columns = await markColumns(page)
    expect(columns.length).toBeLessThanOrEqual(Math.floor(width / 4) + 1)
    for (let i = 1; i < columns.length; i++) expect((columns[i] ?? 0) - (columns[i - 1] ?? 0), `gap before line ${i + 1}`).toBeGreaterThanOrEqual(4)

    await app.seekTo(60.1)
    await expect(chapterName()).toHaveText('Part 151')
    await openList().click()
    const dialog = list(page)
    await expect(dialog.getByRole('listitem')).toHaveCount(300)
    const current = dialog.getByRole('button', { name: /Part 151/ })
    await expect(current).toBeFocused()
    await expect(current).toBeInViewport() // not left at the top of a long list
    await page.keyboard.press('End')
    await expect(dialog.getByRole('button', { name: /Part 300/ })).toBeFocused()
  })

  test('uses the list it kept, reads the file again when what it kept is damaged, and forgets chapters of tracks that are gone', async () => {
    const id = await openBook()
    await expect.poll(() => kept(id)).toMatchObject({ v: 1 })

    // a visit that does not read the file shows what was kept: here, a list nobody could have read from this file
    await app.putMeta(`chapters:${id}`, { v: 1, chapters: [{ start: 0, end: SECONDS, title: 'From the database' }] })
    await app.putMeta('chapters:a-track-that-was-removed', { v: 1, chapters: [] })
    await app.reload()
    await app.play('The Long Book')
    await expect(chapterName()).toHaveText('From the database')
    await expect(next()).toBeDisabled()
    // the chapters of a track that is not in the library are cleared out when the browser is idle
    await expect.poll(() => app.storedMeta('chapters:a-track-that-was-removed'), { timeout: 15_000 }).toBeUndefined()
    expect(await kept(id)).toBeDefined()

    // a record that is not exactly what the app writes is not believed: the tags are read again and the record is mended
    for (const damaged of [{ v: 1, chapters: 'broken' }, { v: 2, chapters: [] }, { v: 1, chapters: [{ start: 5, end: 1, title: 'backwards' }] }, 'nonsense']) {
      await app.putMeta(`chapters:${id}`, damaged)
      await app.reload()
      await app.play('The Long Book')
      await expect(chapterName()).toHaveText('Prologue')
      await expect.poll(() => kept(id).then((record) => record?.chapters.length)).toBe(4)
    }
  })

  test('reads an M4B’s chapter atom and an Ogg file’s chapter comments the same way', async () => {
    await app.open()
    const m4b: Upload = {
      name: 'story.m4b',
      mimeType: 'audio/mp4',
      buffer: Buffer.from(
        buildMp4WithChpl(
          [
            { start: 0, title: 'Opening' },
            { start: 12.5, title: 'Middle' },
          ],
          { seconds: 40 },
        ),
      ),
    }
    const ogg: Upload = {
      name: 'talk.ogg',
      mimeType: 'audio/ogg',
      buffer: Buffer.from(
        buildOgg({
          codec: 'vorbis',
          seconds: 40,
          comments: ['TITLE=Spoken word', 'CHAPTER001=00:00:00.000', 'CHAPTER001NAME=Hello', 'CHAPTER002=00:00:20.500', 'CHAPTER002NAME=World'],
        }),
      ),
    }
    await app.importFiles(m4b, ogg)
    await expect(app.rows).toHaveCount(2)
    await expect.poll(() => app.storedTracks().then((tracks) => tracks.length)).toBe(2)
    const stored = await app.storedTracks()
    const idOf = (file: string) => stored.find((track) => track.name === file)?.id ?? ''

    // neither can be decoded by the test browser (the audio inside is not real), but the tags are read all the same
    for (const file of ['story.m4b', 'talk.ogg']) {
      await app.rows.filter({ hasText: file === 'talk.ogg' ? 'Spoken word' : 'story' }).locator('button[aria-current]').click()
      await expect.poll(() => kept(idOf(file)), { message: file }).toMatchObject({ v: 1 })
    }
    expect((await kept(idOf('story.m4b')))?.chapters.map((c) => [c.start, c.title])).toEqual([
      [0, 'Opening'],
      [12.5, 'Middle'],
    ])
    expect((await kept(idOf('talk.ogg')))?.chapters.map((c) => [c.start, c.title])).toEqual([
      [0, 'Hello'],
      [20.5, 'World'],
    ])
  })

  test('plays a file whose chapter frames are damaged like any other, with no chapters', async () => {
    await app.open()
    // a chapter frame that claims to be two gigabytes long, in a tag a few hundred bytes big
    const frames = cat(textFrame('TIT2', 'Damaged Book', 0, 3), ascii('CHAP'), w32be(0x7fffffff), [0, 0], ascii('chp0'), [0])
    await app.importFiles({ name: 'damaged.mp3', mimeType: 'audio/mpeg', buffer: Buffer.from(withId3(tagFrom(frames, 3), buildMp3(MP3))) })
    await expect(app.rows).toHaveCount(1)
    await expect.poll(() => app.storedTracks().then((tracks) => tracks.length)).toBe(1)
    const id = (await app.storedTracks())[0]?.id ?? ''
    await app.rows.first().locator('button[aria-current]').click()
    await app.expectPlaying()
    await expect.poll(() => kept(id)).toEqual({ v: 1, chapters: [] })
    await expect(row()).toHaveCount(0)
    expect(await app.policyViolations()).toEqual([])
  })

  test('works with the plain seek bar too: the chapters do not depend on the waveform', async ({ page }) => {
    await page.addInitScript(() => localStorage.setItem('wl.seekbar', 'plain'))
    await openBook()
    await expect(app.footer.locator('.seek')).toHaveAttribute('data-wave', 'off')
    await expect(app.footer.locator('.seek canvas')).toHaveCount(0)
    await expect(chapterName()).toHaveText('Prologue')
    await next().click()
    await expect(chapterName()).toHaveText('The Fall of Rome')
  })

  test('has no accessibility violations: the chapter row, and the list', async ({ page }) => {
    await openBook()
    await app.seekTo(40)
    await expect(chapterName()).toHaveText('The Fall of Rome')
    await settled(page)
    const row = await new AxeBuilder({ page }).withTags(TAGS).include('#player').analyze()
    expect(row.violations).toEqual([])

    await openList().click()
    await expect(list(page)).toBeVisible()
    await settled(page)
    const dialog = await new AxeBuilder({ page }).withTags(TAGS).analyze()
    expect(dialog.violations).toEqual([])
  })
})

test.describe('chapters on a phone', () => {
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true })

  test('the Now playing sheet has the chapter row above the seek bar, and the list fits on the screen over it', async ({ page }) => {
    const app = new PlayerPage(page)
    await app.open()
    await app.importFiles(audiobook('book.mp3'))
    await expect(app.rows).toHaveCount(1)
    await page.locator('#player-mini').getByRole('button', { name: 'Open now playing' }).click()
    const sheet = page.getByRole('dialog', { name: 'Now playing' })
    const group = sheet.getByRole('group', { name: 'Chapters' })
    await expect(group).toBeVisible({ timeout: 15_000 })
    await expect(group.getByTestId('chapter-name')).toHaveText('Prologue')

    await settled(page) // the sheet slides up: measure it where it stays, not on the way
    const rowBox = await group.boundingBox()
    const barBox = await sheet.locator('.seek').boundingBox()
    expect((rowBox?.y ?? 0) + (rowBox?.height ?? 0)).toBeLessThanOrEqual((barBox?.y ?? 0) + 1) // above the bar, not below it
    expect((rowBox?.x ?? 0) + (rowBox?.width ?? 0)).toBeLessThanOrEqual(390)

    await group.getByTestId('chapter-open').click()
    const dialog = page.getByRole('dialog', { name: 'Chapters', exact: true })
    await expect(dialog).toBeVisible()
    await expect(dialog.getByRole('listitem')).toHaveCount(4)
    await settled(page)
    const box = await dialog.boundingBox()
    expect(box?.x ?? -1).toBeGreaterThanOrEqual(0)
    expect((box?.x ?? 0) + (box?.width ?? 0)).toBeLessThanOrEqual(390)
    expect((box?.y ?? -1)).toBeGreaterThanOrEqual(0)
    expect((box?.y ?? 0) + (box?.height ?? 0)).toBeLessThanOrEqual(844)

    await settled(page)
    const results = await new AxeBuilder({ page }).withTags(TAGS).analyze()
    expect(results.violations).toEqual([])

    // choosing a chapter closes the list and leaves the sheet it was opened over
    await dialog.getByRole('button', { name: /Interlude/ }).click()
    await expect(dialog).toBeHidden()
    await expect(sheet).toBeVisible()
    await expect(group.getByTestId('chapter-name')).toHaveText('Interlude')
    expect(await app.policyViolations()).toEqual([])
  })
})
