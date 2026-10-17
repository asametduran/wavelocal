import AxeBuilder from '@axe-core/playwright'
import { expect, test } from '@playwright/test'
import { PlayerPage, importWithMtime, libraryKey, settled, tone, wav } from './helpers'
import type { Upload } from './helpers'
import { buildMp3 } from '../src/test-utils/containers'
import { buildId3v2, withId3 } from '../src/test-utils/id3'
import { sine } from '../src/test-utils/signals'
import { encodeWav } from '../src/test-utils/wav'

// Long-form listening: a podcast, a lecture or a book is taken up where it was left (three seconds earlier, with a way to start
// over), has a speed of its own, and has buttons that skip 15 seconds back and 30 forward, here and on the lock screen. A song is
// left exactly as it was. What counts as long is chosen in Sound & tools and can be overruled for a single track.

const TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa', 'best-practice']
const MTIME = 1_700_000_000_000

declare global {
  interface Window {
    /** The Media Session action handlers the page registered (the lock screen and notification buttons call these). */
    __ms: Record<string, MediaSessionActionHandler | undefined>
  }
}

/** A recording of `seconds` seconds: a 330 Hz tone at 8 kHz, so 330 s is only 5 MB and a seek lands exactly. */
const recording = (name: string, seconds: number): Upload => ({
  name,
  mimeType: 'audio/wav',
  buffer: Buffer.from(encodeWav([sine({ frequency: 330, amplitude: 0.4, seconds, sampleRate: 8000 })], { sampleRate: 8000 })),
})

/** Longer than the shortest length that can be chosen (5 minutes), shorter than the default (20). */
const PODCAST = recording('podcast.wav', 330)
/** A song: a few seconds of a tone, and a 30 s one for tests that need room to seek. */
const SONG = tone('song.wav', 4)
const SONG_30 = wav('long', 'song30.wav')
/** 21 minutes (the default rule makes it long): MPEG 2.5 layer III, 8 kHz, mono, 8 kbps is 72 ms and 72 bytes a frame, so it is 1.3 MB. */
const LECTURE: Upload = {
  name: 'lecture.mp3',
  mimeType: 'audio/mpeg',
  buffer: Buffer.from(withId3(buildId3v2({ title: 'The Lecture', artist: 'A Professor' }), buildMp3({ version: 2.5, sampleRate: 8000, bitrateKbps: 8, mode: 'mono', frames: Math.round(1260 / (576 / 8000)) }))),
}

interface Kept {
  v: number
  at: number
  t: number | null
  speed: number | null
  mode: string
}

const heardKey = (file: Upload): string => `heard:${libraryKey(file, MTIME)}`

/** The title the library gives a file: its name without the extension. */
const titleOf = (file: Upload): string => file.name.replace(/\.[^.]+$/, '')

test.describe('long-form listening', () => {
  let app: PlayerPage

  test.beforeEach(({ page }) => {
    app = new PlayerPage(page)
  })

  const skipBack = () => app.footer.getByTestId('skip-back')
  const skipForward = () => app.footer.getByTestId('skip-forward')
  const kept = async (file: Upload): Promise<Kept | undefined> => (await app.storedMeta(heardKey(file))) as Kept | undefined
  const place = async (file: Upload): Promise<number | null> => (await kept(file))?.t ?? null
  const rates = () => app.mediaSettings().then((all) => all.map((m) => m.rate))
  const allPlayAt = async (rate: number): Promise<boolean> => (await rates()).every((r) => r === rate)
  /** The playhead is within a second of `seconds` (the clock shows whole seconds, and a seek lands on a sample). */
  const expectPositionNear = (seconds: number) => expect.poll(async () => Math.abs((await app.position()) - seconds)).toBeLessThanOrEqual(1)

  /** Open the app with the length that makes a recording long set to five minutes, and import the files with known keys. */
  async function open(files: readonly Upload[], threshold: string | null = '5'): Promise<void> {
    if (threshold !== null) await app.page.addInitScript((value) => localStorage.setItem('wl.longform', value), threshold)
    await app.open()
    await importWithMtime(app, files, MTIME)
    await expect(app.rows).toHaveCount(files.length)
    await expect.poll(async () => (await app.storedTracks()).length).toBe(files.length)
  }

  /** Play a track, put its playhead at `seconds`, and stop it there: the place is kept the moment playing stops. */
  async function listenTo(file: Upload, seconds: number): Promise<void> {
    await app.play(titleOf(file))
    await app.seekTo(seconds)
    await app.playButton.click()
    await app.expectPaused()
  }

  test('a long recording is taken up three seconds before where it was left, after a reload, and the person is told', async () => {
    await open([PODCAST, SONG])
    await listenTo(PODCAST, 100)
    await expect.poll(() => place(PODCAST)).toBeGreaterThanOrEqual(100)
    const left = (await place(PODCAST)) ?? 0
    expect(left).toBeLessThan(104) // a moment of playing after the seek, not seconds

    await app.reload()
    await expect(app.toast(/Resumed at 1:[34]\d/)).toBeVisible()
    await expect(app.toast(/Resumed at/).getByRole('button', { name: 'Start over' })).toBeVisible()
    await expect.poll(async () => Math.abs((await app.position()) - (left - 3))).toBeLessThan(1.01)
    expect(await app.policyViolations()).toEqual([])
  })

  test('"Start over" goes to the beginning and forgets the place', async () => {
    await open([PODCAST, SONG])
    await listenTo(PODCAST, 100)
    await expect.poll(() => place(PODCAST)).not.toBeNull()
    await app.reload()
    const toast = app.toast(/Resumed at/)
    await toast.getByRole('button', { name: 'Start over' }).click()
    await expect.poll(() => app.position()).toBe(0)
    await expect.poll(() => kept(PODCAST)).toBeUndefined()
    await expect(toast).toBeHidden()
  })

  test('a long recording is picked up where it was left after other tracks played, and a song never gets a place', async () => {
    await open([PODCAST, SONG])
    await listenTo(PODCAST, 100)
    await app.play(titleOf(SONG))
    await expect.poll(() => app.nowPlayingTitle.innerText()).toContain('song')
    await app.playButton.click()
    await app.expectPaused()

    await app.play(titleOf(PODCAST))
    await expect(app.toast(/Resumed at 1:[34]\d/)).toBeVisible()
    await expect.poll(() => app.position()).toBeGreaterThanOrEqual(96)
    expect(await app.position()).toBeLessThanOrEqual(108)
    expect(await kept(SONG)).toBeUndefined() // a place was kept for the podcast above, so the writing has happened for sure
  })

  test('the place follows the playhead while it plays: later in the recording is later in the record', async () => {
    test.setTimeout(60_000)
    await open([PODCAST, SONG])
    await app.play(titleOf(PODCAST))
    await app.seekTo(20)
    await expect.poll(() => place(PODCAST), { timeout: 15_000 }).toBeGreaterThanOrEqual(20)
    const first = (await place(PODCAST)) ?? 0
    await app.seekTo(120)
    await expect.poll(() => place(PODCAST), { timeout: 15_000 }).toBeGreaterThan(first + 90)
    await app.playButton.click()
    await app.expectPaused()
  })

  test('a recording heard to its end is forgotten, so it starts from the beginning next time', async () => {
    test.setTimeout(60_000)
    await open([PODCAST, SONG])
    await listenTo(PODCAST, 100)
    await expect.poll(() => place(PODCAST)).not.toBeNull()
    await app.seekTo(325)
    await app.playButton.click()
    await app.expectPlaying()
    await expect.poll(() => place(PODCAST), { timeout: 20_000 }).toBeNull()
  })

  test.describe('speed', () => {
    test('a long recording has a speed of its own, and a song goes back to the usual one', async ({ page }) => {
      await open([PODCAST, SONG])
      await app.play(titleOf(PODCAST))
      await app.openTools()
      await app.tools.getByRole('slider', { name: 'Playback speed' }).fill('1.5')
      await app.closeTools()
      await expect.poll(rates).toContain(1.5)
      await expect.poll(async () => (await kept(PODCAST))?.speed).toBe(1.5)

      await app.play(titleOf(SONG))
      await expect.poll(() => allPlayAt(1)).toBe(true)
      expect(await page.evaluate(() => localStorage.getItem('wl.usualspeed'))).toBe('1')

      await app.play(titleOf(PODCAST))
      await expect.poll(() => allPlayAt(1.5)).toBe(true)
    })

    test('a speed chosen on a song is the usual speed: a recording that has none of its own plays at it', async ({ page }) => {
      await open([PODCAST, SONG])
      await app.play(titleOf(SONG))
      await app.openTools()
      await app.tools.getByRole('slider', { name: 'Playback speed' }).fill('1.25')
      await app.closeTools()
      await expect.poll(() => page.evaluate(() => localStorage.getItem('wl.usualspeed'))).toBe('1.25')

      await app.play(titleOf(PODCAST))
      await expect.poll(() => allPlayAt(1.25)).toBe(true)
      expect((await kept(PODCAST))?.speed ?? null).toBeNull() // the usual speed was not taken for the recording's own

      await app.openTools()
      await app.tools.getByRole('slider', { name: 'Playback speed' }).fill('1.75')
      await app.closeTools()
      await expect.poll(async () => (await kept(PODCAST))?.speed).toBe(1.75)
      await app.play(titleOf(SONG))
      await expect.poll(() => allPlayAt(1.25)).toBe(true) // the song's speed is untouched by the recording's
    })

    test("a recording's own speed comes back after a reload, from what was kept", async () => {
      await open([PODCAST, SONG])
      await app.play(titleOf(PODCAST))
      await app.openTools()
      await app.tools.getByRole('slider', { name: 'Playback speed' }).fill('1.75')
      await app.closeTools()
      await expect.poll(async () => (await kept(PODCAST))?.speed).toBe(1.75)
      await app.play(titleOf(SONG))
      await expect.poll(() => allPlayAt(1)).toBe(true)
      await app.playButton.click()
      await app.expectPaused()

      await app.reload() // the song is what was playing, at the usual speed
      await app.play(titleOf(PODCAST))
      await expect.poll(() => allPlayAt(1.75)).toBe(true)
    })
  })

  test.describe('skipping', () => {
    test('a long recording has buttons that go 15 seconds back and 30 forward, and a song has none', async () => {
      await open([PODCAST, SONG_30])
      await app.play(titleOf(PODCAST))
      await app.playButton.click()
      await app.expectPaused()
      await app.seekTo(100)
      await expect(skipBack()).toHaveAccessibleName('Back 15 seconds')
      await expect(skipForward()).toHaveAccessibleName('Forward 30 seconds')

      await skipForward().click()
      await expectPositionNear(130)
      await skipBack().click()
      await expectPositionNear(115)

      await app.play(titleOf(SONG_30))
      await expect(skipBack()).toHaveCount(0)
      await expect(skipForward()).toHaveCount(0)
    })

    test('the buttons of the lock screen and the notification shade skip as far, and 10 seconds for a song', async ({ page }) => {
      await page.addInitScript(() => {
        const handlers: Window['__ms'] = {}
        window.__ms = handlers
        const original = navigator.mediaSession.setActionHandler.bind(navigator.mediaSession)
        navigator.mediaSession.setActionHandler = (action, handler) => {
          handlers[action] = handler ?? undefined
          original(action, handler)
        }
      })
      await open([PODCAST, SONG_30])
      await app.play(titleOf(PODCAST))
      await app.playButton.click()
      await app.expectPaused()
      await app.seekTo(100)
      await page.evaluate(() => window.__ms.seekforward?.({ action: 'seekforward' }))
      await expectPositionNear(130)
      await page.evaluate(() => window.__ms.seekbackward?.({ action: 'seekbackward' }))
      await expectPositionNear(115)
      await page.evaluate(() => window.__ms.seekforward?.({ action: 'seekforward', seekOffset: 7 })) // what the platform asks for wins
      await expectPositionNear(122)

      await app.play(titleOf(SONG_30))
      await app.playButton.click()
      await app.expectPaused()
      await app.seekTo(5)
      await page.evaluate(() => window.__ms.seekforward?.({ action: 'seekforward' }))
      await expectPositionNear(15)
    })
  })

  test.describe('which tracks are long', () => {
    test('the default is twenty minutes: a lecture of 21 is long, with its place kept and skip buttons, and a recording of 330 s is not', async () => {
      await open([LECTURE, PODCAST], null)
      await app.play(titleOf(PODCAST))
      await app.playButton.click()
      await app.expectPaused()
      await expect(skipBack()).toHaveCount(0)

      await app.play('The Lecture')
      await expect.poll(() => app.duration()).toBeGreaterThan(1200)
      await expect(skipBack()).toBeVisible()
      await app.seekTo(600)
      await app.playButton.click()
      await app.expectPaused()
      await expect.poll(() => place(LECTURE)).toBeGreaterThan(590)
      expect((await place(LECTURE)) ?? 0).toBeLessThan(620)
    })

    test('the length is chosen in Sound & tools, applies at once, and is kept', async ({ page }) => {
      await open([PODCAST, SONG], null)
      await app.play(titleOf(PODCAST))
      await expect(skipBack()).toHaveCount(0)

      await app.openTools()
      const group = app.tools.getByRole('radiogroup', { name: 'Remember where I stopped' })
      await expect(group.getByRole('radio', { name: 'Over 20 min' })).toHaveAttribute('aria-checked', 'true')
      await group.getByRole('radio', { name: 'Over 5 min' }).click()
      await expect(group.getByRole('radio', { name: 'Over 5 min' })).toHaveAttribute('aria-checked', 'true')
      await expect(app.tools.getByText(/Files longer than 5 minutes/)).toBeVisible()
      expect(await page.evaluate(() => localStorage.getItem('wl.longform'))).toBe('5')
      await app.closeTools()
      await expect(skipBack()).toBeVisible()

      await app.reload()
      await expect(skipBack()).toBeVisible()
      await app.openTools()
      await app.tools.getByRole('radiogroup', { name: 'Remember where I stopped' }).getByRole('radio', { name: 'Never' }).click()
      await app.closeTools()
      await expect(skipBack()).toHaveCount(0)
      expect(await page.evaluate(() => localStorage.getItem('wl.longform'))).toBe('never')
    })

    test('a single track can be told to always or never keep its place, in its list of chapters and bookmarks', async () => {
      await open([PODCAST, SONG], null) // twenty minutes: the 330 s recording is not long
      await app.play(titleOf(PODCAST))
      await app.seekTo(100)
      await app.playButton.click()
      await app.expectPaused()
      await expect(skipBack()).toHaveCount(0)

      await app.key('c')
      const dialog = app.page.getByRole('dialog', { name: 'Chapters and bookmarks', exact: true })
      const group = dialog.getByRole('radiogroup', { name: 'Remember where I stop in this track' })
      await expect(group.getByRole('radio', { name: 'Automatic' })).toHaveAttribute('aria-checked', 'true')
      await expect(dialog.getByTestId('remembering')).toContainText('not long enough')
      await group.getByRole('radio', { name: 'Always' }).click()
      await expect(dialog.getByTestId('remembering')).toContainText('kept for this track')
      await expect.poll(async () => (await kept(PODCAST))?.mode).toBe('always')
      await app.page.keyboard.press('Escape')
      await expect(dialog).toBeHidden()
      await expect(skipBack()).toBeVisible() // it counts as a long recording now

      await app.playButton.click()
      await app.expectPlaying()
      await app.seekTo(150)
      await app.playButton.click()
      await app.expectPaused()
      await expect.poll(() => place(PODCAST)).toBeGreaterThanOrEqual(150)

      await app.key('c')
      await group.getByRole('radio', { name: 'Never' }).click()
      await expect(dialog.getByTestId('remembering')).toContainText('always starts from the beginning')
      await expect.poll(async () => (await kept(PODCAST))?.t ?? null).toBeNull() // "never" forgets what was kept
      expect((await kept(PODCAST))?.mode).toBe('never')
      await app.page.keyboard.press('Escape')
      await expect(skipBack()).toHaveCount(0)
    })

    test('the arrow keys move through the three choices, like the other settings', async ({ page }) => {
      await open([PODCAST, SONG])
      await app.play(titleOf(PODCAST))
      await app.key('c')
      const group = page.getByRole('dialog', { name: 'Chapters and bookmarks', exact: true }).getByRole('radiogroup', { name: 'Remember where I stop in this track' })
      await group.getByRole('radio', { name: 'Automatic' }).focus()
      await page.keyboard.press('ArrowRight')
      await expect(group.getByRole('radio', { name: 'Always' })).toBeFocused()
      await expect(group.getByRole('radio', { name: 'Always' })).toHaveAttribute('aria-checked', 'true')
    })
  })

  test.describe('what is kept', () => {
    test('"Forget saved places" says how many recordings it is about, asks first, and removes them', async () => {
      await open([PODCAST, SONG])
      await listenTo(PODCAST, 100)
      await expect.poll(() => place(PODCAST)).not.toBeNull()

      await app.openTools()
      const section = app.tools.getByRole('region', { name: 'Long recordings' })
      await expect(section.getByText('Kept for 1 recording.')).toBeVisible()
      await section.getByTestId('forget-places').click()
      await expect(app.question).toContainText('1 recording')
      await app.answerDialog(false) // asked first: a "no" changes nothing
      expect(await place(PODCAST)).not.toBeNull()

      await section.getByTestId('forget-places').click()
      await app.answerDialog(true)
      await expect(app.toast('Forgot where you stopped in 1 recording.')).toBeVisible()
      await expect.poll(() => kept(PODCAST)).toBeUndefined()
      await expect(section.getByText('Nothing is kept yet.')).toBeVisible()
      await expect(section.getByTestId('forget-places')).toBeDisabled()
    })

    test('places that nobody came back to for half a year are forgotten, the rest stay', async () => {
      test.setTimeout(60_000)
      await open([PODCAST, SONG])
      const old = { v: 1, at: Date.now() - 300 * 86_400_000, t: 500, speed: null, mode: 'auto' }
      await app.putMeta('heard:stale.mp3|1|1', old)
      await app.putMeta('heard:kept-choice.mp3|1|1', { ...old, t: null, mode: 'never' })
      await app.putMeta('heard:recent.mp3|1|1', { ...old, at: Date.now() - 86_400_000 })
      await app.reload()
      await expect.poll(async () => app.storedMeta('heard:stale.mp3|1|1'), { timeout: 25_000 }).toBeUndefined()
      expect(await app.storedMeta('heard:recent.mp3|1|1')).toBeDefined()
      expect(await app.storedMeta('heard:kept-choice.mp3|1|1')).toBeDefined() // a choice made for a track is not a place
    })

    test('a damaged record reads as nothing: the track plays from the beginning and the app carries on', async () => {
      await open([PODCAST, SONG])
      await app.putMeta(heardKey(PODCAST), { v: 7, t: 'soon', speed: 99, mode: 'sometimes' })
      await app.reload()
      await app.play(titleOf(PODCAST))
      await expect(skipBack()).toBeVisible()
      await app.page.waitForTimeout(400) // a resume would have shown by now
      await expect(app.toast(/Resumed at/)).toHaveCount(0)
      expect(await app.policyViolations()).toEqual([])
    })
  })

  test('has no accessibility violations: the buttons under the seek bar, the setting, and the choice for a track', async ({ page }) => {
    await open([PODCAST, SONG])
    await listenTo(PODCAST, 100)
    await expect(skipBack()).toBeVisible()
    await settled(page)
    const bar = await new AxeBuilder({ page }).withTags(TAGS).include('#player').analyze()
    expect(bar.violations).toEqual([])

    await app.key('c')
    await expect(page.getByRole('dialog', { name: 'Chapters and bookmarks', exact: true })).toBeVisible()
    await settled(page)
    const dialog = await new AxeBuilder({ page }).withTags(TAGS).analyze()
    expect(dialog.violations).toEqual([])
    await page.keyboard.press('Escape')

    await app.openTools()
    await expect(app.tools.getByRole('radiogroup', { name: 'Remember where I stopped' })).toBeVisible()
    await settled(page)
    const tools = await new AxeBuilder({ page }).withTags(TAGS).analyze()
    expect(tools.violations).toEqual([])
    expect(await app.policyViolations()).toEqual([])
  })
})

test.describe('long-form listening on a phone', () => {
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true })

  test('the skip buttons are in the Now playing sheet, big enough to touch, and the row still fits', async ({ page }) => {
    await page.addInitScript(() => localStorage.setItem('wl.longform', '5'))
    const app = new PlayerPage(page)
    await app.open()
    await app.importFiles(PODCAST)
    await expect(app.rows).toHaveCount(1)
    await page.locator('#player-mini').getByRole('button', { name: 'Open now playing' }).click()
    const sheet = page.getByRole('dialog', { name: 'Now playing' })
    const back = sheet.getByTestId('skip-back')
    const forward = sheet.getByTestId('skip-forward')
    await expect(back).toBeVisible({ timeout: 15_000 })
    await settled(page)

    for (const button of [back, forward]) {
      const box = await button.boundingBox()
      expect(box?.height ?? 0).toBeGreaterThanOrEqual(40)
      expect(box?.width ?? 0).toBeGreaterThanOrEqual(40)
      expect(box?.x ?? -1).toBeGreaterThanOrEqual(0)
      expect((box?.x ?? 0) + (box?.width ?? 0)).toBeLessThanOrEqual(390)
    }
    const seek = sheet.getByRole('slider', { name: 'Seek' })
    await expect.poll(() => seek.getAttribute('max').then(Number)).toBeGreaterThan(300)
    await seek.fill('100')
    await forward.tap()
    await expect.poll(() => seek.inputValue().then(Number)).toBeGreaterThanOrEqual(129)
    await back.tap()
    await expect.poll(() => seek.inputValue().then(Number)).toBeLessThanOrEqual(116)

    const results = await new AxeBuilder({ page }).withTags(TAGS).analyze()
    expect(results.violations).toEqual([])
    expect(await app.policyViolations()).toEqual([])
  })
})
