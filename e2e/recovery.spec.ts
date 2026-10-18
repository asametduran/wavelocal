import { expect, test } from '@playwright/test'
import type { Page } from '@playwright/test'
import { PlayerPage, failNativeFlacPlayback, flac, song, wav } from './helpers'
import type { Upload } from './helpers'

// A file the browser cannot play must never stop the music, leave the screen saying it plays, or keep the player trying for ever.
// These are the audit's experiment C (a bad file as the next track under gapless and crossfade) and the retry storm found while
// verifying F1. The files are real garbage (bytes every decoder refuses), not a stub: a real browser fires `play` for each attempt,
// which a stub does not, and that is what kept the old failure count from ever reaching its limit.

const garbage = (name: string, seed = 7): Upload => ({
  name,
  mimeType: 'audio/mpeg',
  buffer: Buffer.from(Array.from({ length: 4096 }, (_, i) => (i * 131 + seed) & 0xff)),
})

const MODES = ['Off', 'Gapless', 'Crossfade'] as const

/** Counts every `play()` the page makes, so a loop of attempts shows. Install before `open()`. */
async function countPlays(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const counter = window as unknown as { __plays?: number }
    counter.__plays = 0
    const play = HTMLMediaElement.prototype.play
    HTMLMediaElement.prototype.play = function (this: HTMLMediaElement) {
      counter.__plays = (counter.__plays ?? 0) + 1
      return play.call(this)
    }
  })
}
const plays = (page: Page): Promise<number> => page.evaluate(() => (window as unknown as { __plays?: number }).__plays ?? 0)

/** The kinds of what the page has put in its error log, oldest first. */
const logKinds = (page: Page): Promise<string[]> =>
  page.evaluate(() => ((JSON.parse(localStorage.getItem('wl.diagnostics') ?? 'null') as { entries: { kind: string }[] } | null)?.entries ?? []).map((e) => e.kind))

async function chooseMode(app: PlayerPage, mode: (typeof MODES)[number]): Promise<void> {
  await app.openTools()
  await app.tools.getByRole('radio', { name: mode }).click()
  await app.closeTools()
}

/** Records every title the page has had (`document.title` follows the track on screen), so that a track shown for a moment shows. Install before `open()`. */
async function recordTitles(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const seen: string[] = []
    ;(window as unknown as { __titles: string[] }).__titles = seen
    new MutationObserver(() => {
      if (seen[seen.length - 1] !== document.title) seen.push(document.title)
    }).observe(document, { childList: true, subtree: true, characterData: true })
  })
}
const titlesSeen = (page: Page): Promise<string[]> => page.evaluate(() => (window as unknown as { __titles?: string[] }).__titles ?? [])

/** Makes `play()` fail like an unsupported file does (a rejection and an `error` event) for as many calls as `failNext` says. Install before `open()`. */
async function stubFailingPlays(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const flag = window as unknown as { __failPlays?: number }
    flag.__failPlays = 0
    const play = HTMLMediaElement.prototype.play
    HTMLMediaElement.prototype.play = function (this: HTMLMediaElement) {
      if ((flag.__failPlays ?? 0) > 0) {
        flag.__failPlays = (flag.__failPlays ?? 0) - 1
        setTimeout(() => this.dispatchEvent(new Event('error')), 0)
        return Promise.reject(new DOMException('The element has no supported sources.', 'NotSupportedError'))
      }
      return play.call(this)
    }
  })
}
const failNext = (page: Page, plays: number): Promise<void> => page.evaluate((n) => void ((window as unknown as { __failPlays: number }).__failPlays = n), plays)

/** Makes the browser fail an original FLAC file the moment it is lined up on the idle deck (`load()`), as a WebView that cannot read FLAC does. Install before `open()`. */
async function failFlacLining(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const types = new Map<string, string>()
    const create = URL.createObjectURL.bind(URL)
    URL.createObjectURL = (source: Blob | MediaSource) => {
      const url = create(source)
      if (source instanceof Blob) types.set(url, source.type)
      return url
    }
    const load = HTMLMediaElement.prototype.load
    HTMLMediaElement.prototype.load = function (this: HTMLMediaElement) {
      if (types.get(this.getAttribute('src') ?? '') === 'audio/flac') {
        const counter = window as unknown as { __flacLoads?: number }
        counter.__flacLoads = (counter.__flacLoads ?? 0) + 1
        setTimeout(() => this.dispatchEvent(new Event('error')), 0)
      }
      return load.call(this)
    }
  })
}
const flacLoads = (page: Page): Promise<number> => page.evaluate(() => (window as unknown as { __flacLoads?: number }).__flacLoads ?? 0)

for (const mode of MODES) {
  test.describe(`transitions: ${mode}`, () => {
    test('a file that cannot be played is skipped, named in a notice, and the next track plays', async ({ page }) => {
      await recordTitles(page)
      const app = new PlayerPage(page)
      await app.open()
      await app.importFiles(wav('tone-440', '01-a.wav'), garbage('02-bad.mp3'), wav('sweep', '03-c.wav'))
      await expect(app.rows).toHaveCount(3)
      await chooseMode(app, mode)
      await app.play('01-a')
      await expect(app.toast(/Skipped "02-bad"/)).toBeVisible({ timeout: 15_000 })
      await expect(app.nowPlayingTitle).toHaveText('03-c', { timeout: 15_000 })
      await app.expectPlaying()
      await expect.poll(() => app.playingElements()).toBe(1) // something is audible, and not two decks over each other
      // a lined-up transition finds a bad file out while the track before it still plays, and goes straight to the one after it: the
      // screen never shows the bad file as the track that plays (with transitions Off it is loaded when its turn comes, and skipped)
      if (mode !== 'Off') expect((await titlesSeen(page)).filter((title) => title.includes('02-bad'))).toEqual([])
      // and the failure is in the error log once, as the browser's verdict (whichever deck found it; the decoder fallback that was tried
      // and found no WAV or FLAC adds nothing), without the file's name
      await expect.poll(() => logKinds(page)).toEqual(['play'])
      const log = JSON.stringify(await page.evaluate(() => JSON.parse(localStorage.getItem('wl.diagnostics') ?? 'null')))
      expect(log).toContain('MediaError')
      expect(log).not.toContain('02-bad')
    })

    test('a queue with nothing that can be played ends with one notice and no more attempts', async ({ page }) => {
      await countPlays(page)
      const app = new PlayerPage(page)
      await app.open()
      await app.importFiles(garbage('a-bad.mp3', 7), garbage('b-bad.mp3', 11))
      await expect(app.rows).toHaveCount(2)
      // making the first track ready already shows that neither can be played: one notice, and the first track stays selected
      const none = app.toast('None of the next tracks could be played')
      await expect(none).toBeVisible({ timeout: 15_000 })
      await expect(none).toBeHidden({ timeout: 15_000 })
      await chooseMode(app, mode)
      await app.key('r') // repeat all: the only thing that could keep it going
      const before = await plays(page)
      // asked for by hand, a track is tried again; nothing here can ever start, so there is no "Pause" to wait for
      // (`app.play` would wait for one for longer than the notice stays up)
      await app.row('a-bad').locator('button[aria-current]').click()
      await expect(none).toBeVisible({ timeout: 15_000 })
      await app.expectPaused()
      const attempts = (await plays(page)) - before
      expect(attempts).toBeGreaterThanOrEqual(1) // the track that was asked for was tried
      expect(attempts).toBeLessThanOrEqual(3) // and no track again and again
      await page.waitForTimeout(1500)
      expect((await plays(page)) - before).toBe(attempts)
      await app.expectPaused()
    })
  })
}

test('asking for a track that could not be played tries it again, and says so again', async ({ page }) => {
  await countPlays(page)
  const app = new PlayerPage(page)
  await app.open()
  await app.importFiles(garbage('a-bad.mp3', 7), garbage('b-bad.mp3', 11))
  await expect(app.rows).toHaveCount(2)
  const none = app.toast('None of the next tracks could be played') // already said once, while the first track was made ready
  await expect(none).toBeVisible({ timeout: 15_000 })
  await expect(none).toBeHidden({ timeout: 15_000 })
  await app.row('a-bad').locator('button[aria-current]').click()
  await expect(none).toBeVisible({ timeout: 15_000 })
  const first = await plays(page)
  await app.page.waitForTimeout(500)
  await app.row('b-bad').locator('button[aria-current]').click() // the person asks for this one
  await expect.poll(() => plays(page)).toBeGreaterThan(first)
  await expect(app.toast(/Skipped "b-bad"/)).toBeVisible({ timeout: 15_000 })
})

test('a run of files that cannot be played is named once and then counted, and the first one that can be is made ready', async ({ page }) => {
  const app = new PlayerPage(page)
  await app.open()
  await app.importFiles(garbage('01-bad.mp3', 3), garbage('02-bad.mp3', 5), garbage('03-bad.mp3', 9), wav('long', '04-good.wav'))
  await expect(app.rows).toHaveCount(4)
  // making the first track ready already goes past the three that cannot be played, without playing anything
  await expect(app.toast(/Skipped "01-bad"/)).toBeVisible({ timeout: 15_000 })
  await expect(app.toast(/Skipped 3 tracks that could not be played/)).toBeVisible({ timeout: 15_000 })
  expect(await app.toast(/Skipped "0[23]-bad"/).count()).toBe(0) // only the first of the run is named (counted now: `toHaveCount(0)` would wait for the notices to go)
  await expect(app.nowPlayingTitle).toHaveText('04-good')
  await app.expectPaused()
  await page.waitForTimeout(1200) // a track that was set playing by mistake would have moved on by now (it is long, so it cannot just have ended)
  expect(await app.position()).toBe(0)
  expect(await app.playingElements()).toBe(0)
  await app.playButton.click()
  await app.expectPlaying()
})

test('a track that failed once plays when it is asked for again, and the queue takes it back', async ({ page }) => {
  await stubFailingPlays(page)
  const app = new PlayerPage(page)
  await app.open()
  await app.importFiles(song('01-a.mp3', { title: '01-a' }, 200), song('02-b.mp3', { title: '02-b' }, 200))
  await expect(app.rows).toHaveCount(2)
  await app.key('r') // repeat all, so that going on from the last track comes round to the first
  await failNext(page, 1) // the next play() fails, once
  await app.row('01-a').locator('button[aria-current]').click()
  await expect(app.toast(/Skipped "01-a"/)).toBeVisible({ timeout: 15_000 })
  await expect(app.nowPlayingTitle).toHaveText('02-b', { timeout: 15_000 })
  await app.expectPlaying()
  await app.play('01-a') // asked for again: it plays this time
  await expect(app.nowPlayingTitle).toHaveText('01-a')
  await app.expectPlaying()
  await app.next()
  await expect(app.nowPlayingTitle).toHaveText('02-b')
  await app.next() // and round to the first again: it is not skipped any more
  await expect(app.nowPlayingTitle).toHaveText('01-a')
  await app.expectPlaying()
})

test('a lossless file whose decoded copy fails too is given up on, skipped, and logged once', async ({ page }) => {
  await stubFailingPlays(page)
  const app = new PlayerPage(page)
  await app.open()
  await app.importFiles(wav('tone-440', '01-a.wav'), wav('sweep', '02-b.wav'))
  await expect(app.rows).toHaveCount(2)
  await failNext(page, 2) // the original file fails, and so does the decoded copy the app then tries in its place
  await app.row('01-a').locator('button[aria-current]').click()
  await expect(app.toast(/Skipped "01-a"/)).toBeVisible({ timeout: 15_000 })
  await expect(app.nowPlayingTitle).toHaveText('02-b', { timeout: 15_000 })
  await app.expectPlaying()
  await expect.poll(() => logKinds(page)).toEqual(['play'])
})

test('while playing, a run of files that cannot be played is named once and counted when the next good one starts', async ({ page }) => {
  const app = new PlayerPage(page)
  await app.open()
  await app.importFiles(wav('tone-440', '01-good.wav'), garbage('02-bad.mp3', 5), garbage('03-bad.mp3', 9), wav('sweep', '04-good.wav'))
  await expect(app.rows).toHaveCount(4)
  await app.play('01-good')
  await expect(app.toast(/Skipped "02-bad"/)).toBeVisible({ timeout: 15_000 })
  await expect(app.nowPlayingTitle).toHaveText('04-good', { timeout: 15_000 })
  await expect(app.toast(/Skipped 2 tracks that could not be played/)).toBeVisible({ timeout: 15_000 })
  await app.expectPlaying()
})

test('a FLAC that cannot be lined up in advance is not given up on: it is decoded when its turn comes', async ({ page }) => {
  await failNativeFlacPlayback(page) // the browser claims FLAC but cannot play it ...
  await failFlacLining(page) // ... nor line it up on the idle deck
  const app = new PlayerPage(page)
  await app.open()
  await app.importFiles(wav('tone-440', '01-a.wav'), flac('tone-880', '02-b.flac'))
  await expect(app.rows).toHaveCount(2)
  await chooseMode(app, 'Gapless')
  await app.play('01-a')
  await expect(app.nowPlayingTitle).toHaveText('02-b', { timeout: 15_000 })
  await expect.poll(() => app.playingSource(), { timeout: 15_000 }).toMatchObject({ type: 'audio/wav' }) // the decoded copy: the original cannot play
  await app.expectPlaying()
  expect(await app.toast(/Skipped/).count()).toBe(0) // it was never given up on
  expect(await flacLoads(page)).toBeLessThanOrEqual(2) // lined up once, not again at every tick of the clock
})

test('a track in Up Next that cannot be played leaves the queue, and is never handed over to', async ({ page }) => {
  await recordTitles(page)
  const app = new PlayerPage(page)
  await app.open()
  await app.importFiles(wav('tone-440', '01-a.wav'), wav('sweep', '02-b.wav'), garbage('03-bad.mp3'))
  await expect(app.rows).toHaveCount(3)
  await chooseMode(app, 'Gapless')
  await app.queueTrack('03-bad', 'Play next') // it would play right after 01-a, before 02-b
  await app.play('01-a')
  await expect(app.toast(/Skipped "03-bad"/)).toBeVisible({ timeout: 15_000 })
  await expect(app.nowPlayingTitle).toHaveText('02-b', { timeout: 15_000 }) // the list carries on
  await app.expectPlaying()
  expect((await titlesSeen(page)).filter((title) => title.includes('03-bad'))).toEqual([])
  await app.showUpNext()
  expect(await app.upNextTitles()).toEqual([]) // and the queue does not go on showing a track that will never play
})

test('Play on an album page tries a track that failed before, and the queue takes it back', async ({ page }) => {
  await stubFailingPlays(page)
  const app = new PlayerPage(page)
  await app.open()
  await app.importFiles(
    song('01-a.mp3', { title: '01-a', artist: 'Band', album: 'Rec', track: '1' }, 200),
    song('02-b.mp3', { title: '02-b', artist: 'Band', album: 'Rec', track: '2' }, 200),
  )
  await expect(app.rows).toHaveCount(2)
  await app.key('r') // repeat all
  await failNext(page, 1)
  await app.row('01-a').locator('button[aria-current]').click()
  await expect(app.toast(/Skipped "01-a"/)).toBeVisible({ timeout: 15_000 })
  await expect(app.nowPlayingTitle).toHaveText('02-b', { timeout: 15_000 })
  await app.expectPlaying()
  await app.showMode('Albums')
  await app.sidebar.getByRole('list', { name: 'Albums' }).getByRole('button', { name: /^Rec, / }).click()
  await app.sidebar.getByRole('button', { name: 'Play Rec' }).click() // asked for by hand: the album starts at its first track
  await expect(app.nowPlayingTitle).toHaveText('01-a')
  await app.expectPlaying()
  await app.next()
  await expect(app.nowPlayingTitle).toHaveText('02-b')
  await app.next()
  await expect(app.nowPlayingTitle).toHaveText('01-a') // round to the first again: it is not skipped any more
})

const ASKS: readonly (readonly [string, (app: PlayerPage) => Promise<void>])[] = [
  ['play/pause', (app) => app.playButton.click()],
  ['its row', (app) => app.row('only').locator('button[aria-current]').click()],
  [
    'the Play button of its album page',
    async (app) => {
      await app.showMode('Albums')
      await app.sidebar.getByRole('list', { name: 'Albums' }).getByRole('button', { name: /^Rec, / }).click()
      await app.sidebar.getByRole('button', { name: 'Play Rec' }).click()
    },
  ],
]

for (const [how, ask] of ASKS) {
  test(`${how} tries a track that could not be played again, and the queue takes it back`, async ({ page }) => {
    await stubFailingPlays(page)
    const app = new PlayerPage(page)
    await app.open()
    await app.importFiles(song('only.mp3', { title: 'only', artist: 'Band', album: 'Rec', track: '1' }, 200))
    await expect(app.rows).toHaveCount(1)
    await failNext(page, 1)
    await app.row('only').locator('button[aria-current]').click()
    await expect(app.toast('None of the next tracks could be played')).toBeVisible({ timeout: 15_000 })
    await app.expectPaused()
    await ask(app) // asked for again
    await app.expectPlaying()
    await app.next() // the only track comes round to itself: it is not skipped as a track that failed
    await app.expectPlaying()
    await expect(app.nowPlayingTitle).toHaveText('only')
  })
}

test('a file that fails while it plays stops the player, which says so, when nothing else can be played', async ({ page }) => {
  const app = new PlayerPage(page)
  await app.open()
  await app.importFiles(song('only.mp3', { title: 'only' }, 1200))
  await app.play('only')
  await expect.poll(() => app.playingElements()).toBe(1)
  // the browser reports a decoding error some seconds into the file, with the element still playing as far as it can tell
  await page.evaluate(() => [...window.__probe.media].find((media) => !media.paused)?.dispatchEvent(new Event('error')))
  await expect(app.toast('None of the next tracks could be played')).toBeVisible({ timeout: 15_000 })
  await app.expectPaused()
  expect(await app.playingElements()).toBe(0) // and nothing goes on sounding behind a button that says Play
})
