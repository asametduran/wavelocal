import { expect, test } from '@playwright/test'
import type { Page } from '@playwright/test'
import { PlayerPage, wav } from './helpers'

// The A-B loop: a part of the playing track that repeats. The L key sets its start, then its end, then clears it; while it is
// set, the end of the part jumps back to its start (on the beat, which a media element's coarse position reports alone could
// not manage), and nothing else moves the track on.

/** Where the playing media element is, sampled every `every` ms for `ms` ms: how the playhead moved, not where it ended up. */
async function samplePlayhead(page: Page, ms: number, every = 20): Promise<number[]> {
  return page.evaluate(
    ([ms, every]) =>
      new Promise<number[]>((resolve) => {
        const media = [...window.__probe.media].find((m) => !m.paused) ?? [...window.__probe.media][0]
        const heard: number[] = []
        const timer = setInterval(() => {
          if (media) heard.push(media.currentTime)
        }, every)
        setTimeout(() => {
          clearInterval(timer)
          resolve(heard)
        }, ms)
      }),
    [ms, every] as const,
  )
}

/** The last point the playhead reached before each time it went back by more than half a second between two samples. */
const lastPoints = (heard: readonly number[]): number[] => heard.flatMap((at, i) => (i > 0 && at < (heard[i - 1] ?? 0) - 0.5 ? [heard[i - 1] ?? 0] : []))

/** How many times the playhead went round. */
const rounds = (heard: readonly number[]): number => lastPoints(heard).length

const median = (values: readonly number[]): number => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)] ?? Number.NaN

test.describe('A-B loop', () => {
  let app: PlayerPage

  test.beforeEach(async ({ page }) => {
    app = new PlayerPage(page)
    await app.open()
  })

  /** A track of 30 s that is playing, then paused where it is; the loop is made from here. */
  async function openLong(name = 'long'): Promise<void> {
    await app.importFiles(wav('long'))
    await app.play(name)
    await app.playButton.click()
    await app.expectPaused()
  }

  test('goes round the part between A and B again and again, and the playhead never leaves it', async ({ page }) => {
    await openLong()
    await app.seekTo(5)
    await app.key('l')
    await expect(app.toast(/Loop start 0:05/)).toBeVisible()
    await app.seekTo(6.2)
    await app.key('l')
    await expect(app.toast('Looping 0:05 to 0:06')).toBeVisible()

    await app.seekTo(5)
    await app.playButton.click()
    await app.expectPlaying()
    const heard = await samplePlayhead(page, 7000)
    expect(heard.length).toBeGreaterThan(150)
    // every sample is inside the part, give or take the time a jump takes
    expect(Math.min(...heard)).toBeGreaterThanOrEqual(5 - 0.2)
    expect(Math.max(...heard)).toBeLessThanOrEqual(6.2 + 0.3)
    // it went round: seven seconds of a part that is 1.2 s long are almost six rounds
    expect(rounds(heard)).toBeGreaterThanOrEqual(4)
    // and it turned on the beat. A media element reports its position about every 265 ms here, and a part 1.2 s long is not a
    // whole number of those: a jump that waited for the next report would be 125 ms late. This one is scheduled for the end itself.
    expect(median(lastPoints(heard)) - 6.2, 'how far past the end it got before turning back').toBeLessThanOrEqual(0.09)
    await app.expectPlaying()
  })

  test('keeps to the part at twice the speed as well: the end comes sooner, and the jump keeps up', async ({ page }) => {
    await openLong()
    await app.openTools()
    await app.tools.getByRole('slider', { name: 'Playback speed' }).fill('2')
    await app.closeTools()
    await app.seekTo(5)
    await app.key('l')
    await app.seekTo(6.2)
    await app.key('l')
    await app.seekTo(5)
    await app.playButton.click()
    const heard = await samplePlayhead(page, 5000)
    expect(Math.min(...heard)).toBeGreaterThanOrEqual(5 - 0.2)
    expect(Math.max(...heard)).toBeLessThanOrEqual(6.2 + 0.5) // at twice the speed the file moves twice as far between two looks
    expect(rounds(heard)).toBeGreaterThanOrEqual(6) // a part that takes 0.6 s to play, for five seconds
    // the wait for the end is counted in the time it takes at this speed: the coarse report would be 0.4 s of file late
    expect(median(lastPoints(heard)) - 6.2, 'how far past the end it got before turning back').toBeLessThanOrEqual(0.2)
  })

  test('is cleared by the third press of L, and playing goes on past where its end was', async ({ page }) => {
    await openLong()
    await app.seekTo(5)
    await app.key('l')
    await app.seekTo(6)
    await app.key('l')
    await expect(app.toast('Looping 0:05 to 0:06')).toBeVisible()
    await app.key('l')
    await expect(app.toast('Loop cleared')).toBeVisible()

    await app.seekTo(5.5)
    await app.playButton.click()
    await expect.poll(() => app.position(), { timeout: 8_000 }).toBeGreaterThanOrEqual(7)
    expect(Math.max(...(await samplePlayhead(page, 300)))).toBeGreaterThan(6.5)
  })

  test('refuses an end that is too close to the start, and says so, keeping the start', async () => {
    await openLong()
    await app.seekTo(5)
    await app.key('l')
    await app.seekTo(5.2)
    await app.key('l')
    await expect(app.toast(/end has to come at least half a second after the start/i)).toBeVisible()
    await app.seekTo(7)
    await app.key('l') // the start was kept, so this makes a loop from 5 to 7
    await expect(app.toast('Looping 0:05 to 0:07')).toBeVisible()
  })

  test('leaves a playhead alone that was moved past the end of the part: the person went somewhere else on purpose', async () => {
    await openLong()
    await app.seekTo(5)
    await app.key('l')
    await app.seekTo(6)
    await app.key('l')
    await app.seekTo(12)
    await app.playButton.click()
    await app.page.waitForTimeout(1500)
    expect(await app.position()).toBeGreaterThanOrEqual(12) // it carried on from 12, it was not taken back to 5
  })

  test('goes round again when the playhead was moved to the end of the file, instead of stopping there', async ({ page }) => {
    await openLong()
    await app.seekTo(5)
    await app.key('l')
    await app.seekTo(6)
    await app.key('l')
    await expect(app.toast('Looping 0:05 to 0:06')).toBeVisible()
    await app.seekTo(29.5)
    await app.playButton.click()
    await app.expectPlaying()
    // half a second later the file ends: with a loop set the track is held, so it goes back into the part and carries on there
    await expect.poll(() => app.position(), { timeout: 8_000 }).toBeLessThanOrEqual(7)
    await app.expectPlaying()
    expect(Math.max(...(await samplePlayhead(page, 2500)))).toBeLessThanOrEqual(6.4) // and keeps to it
  })

  test('holds the track against a crossfade: the next track does not start while a loop goes round across the handover point', async ({ page }) => {
    await app.importFiles(wav('long', 'a.wav'), wav('long', 'b.wav'))
    await expect(app.rows).toHaveCount(2)
    await app.play('a')
    await app.playButton.click()
    await app.expectPaused()
    // the loop comes first: with a crossfade on, a track that is moved to its last seconds starts handing over before any loop exists
    await app.seekTo(23)
    await app.key('l')
    await app.seekTo(28)
    await app.key('l')
    await expect(app.toast('Looping 0:23 to 0:28')).toBeVisible()
    await app.openTools()
    await app.tools.getByRole('radio', { name: 'Crossfade' }).click()
    await app.closeTools()
    await app.seekTo(23) // a crossfade of 5 s begins 5 s before the end of a 30 s track, at 0:25: inside the part
    await app.playButton.click()
    await app.expectPlaying()
    await page.waitForTimeout(8000) // a round and a half
    await expect(app.nowPlayingTitle).toHaveText('a')
    expect(await app.playingElements()).toBe(1) // no second deck fading in
    const heard = await samplePlayhead(page, 600)
    expect(Math.min(...heard)).toBeGreaterThanOrEqual(22.8)
    expect(Math.max(...heard)).toBeLessThanOrEqual(28.3)
  })

  test('goes when another track starts: the first press of L on the next track is a start, not a clear', async () => {
    await app.importFiles(wav('long', 'a.wav'), wav('long', 'b.wav'))
    await app.play('a')
    await app.playButton.click()
    await app.seekTo(2)
    await app.key('l')
    await app.seekTo(4)
    await app.key('l')
    await expect(app.toast('Looping 0:02 to 0:04')).toBeVisible()

    await app.play('b')
    await app.playButton.click()
    await app.seekTo(3)
    await app.key('l')
    await expect(app.toast(/Loop start 0:03/)).toBeVisible()
  })

  test('is not in the way of the keys that belong to typing', async ({ page }) => {
    await openLong()
    await app.seekTo(5)
    await app.search.focus()
    await page.keyboard.type('l')
    await expect(app.toast(/Loop/)).toHaveCount(0)
    await expect(app.search).toHaveValue('l')
  })
})
