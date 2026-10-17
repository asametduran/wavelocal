import AxeBuilder from '@axe-core/playwright'
import { expect, test } from '@playwright/test'
import { PlayerPage, flac, realMp3File, realOggFile } from './helpers'
import type { Upload } from './helpers'
import { concat, silence, sine } from '../src/test-utils/signals'
import { encodeWav } from '../src/test-utils/wav'

// The waveform behind the seek bar: measured once per track off the main thread (the worker for WAV and FLAC, the browser's
// own decoder for everything else), kept in the database, drawn in two canvases, and never in the way of the native range
// input that stays the control.

const RATE = 8000
/** 12 s at 8 kHz: 4 s of a 1 kHz tone at 0.5, 4 s of silence, 4 s of the tone at 0.25. */
const envelope = (name: string): Upload => ({
  name,
  mimeType: 'audio/wav',
  buffer: Buffer.from(
    encodeWav(
      [concat(sine({ frequency: 1000, amplitude: 0.5, seconds: 4, sampleRate: RATE }), silence({ seconds: 4, sampleRate: RATE }), sine({ frequency: 1000, amplitude: 0.25, seconds: 4, sampleRate: RATE }))],
      { sampleRate: RATE },
    ),
  ),
})

// On the dB scale (0 dBFS = 255, -50 dBFS and below = 0) the loud third is at -6 dB = 224, the quiet third at -12 dB = 194.
const LOUD = 224
const QUIET = 194

test.describe('waveform seek bar', () => {
  let app: PlayerPage
  const seek = () => app.footer.locator('.seek')

  test.beforeEach(({ page }) => {
    app = new PlayerPage(page)
  })

  async function openWith(file: Upload): Promise<string> {
    await app.open()
    await app.importFiles(file)
    await expect(app.rows).toHaveCount(1)
    await expect.poll(() => app.storedTracks().then((tracks) => tracks.length)).toBe(1)
    return (await app.storedTracks())[0]?.id ?? ''
  }

  /** How many pixels of each column of the footer's waveform are painted (the first canvas is the whole waveform). */
  async function columns(): Promise<number[]> {
    return app.page.evaluate(() => {
      const canvas = document.querySelector<HTMLCanvasElement>('#player .seek canvas')
      const ctx = canvas?.getContext('2d')
      if (!canvas || !ctx) return []
      const { width, height } = canvas
      const data = ctx.getImageData(0, 0, width, height).data
      return Array.from({ length: width }, (_, x) => {
        let painted = 0
        for (let y = 0; y < height; y++) if ((data[(y * width + x) * 4 + 3] ?? 0) > 0) painted++
        return painted
      })
    })
  }

  test('draws the shape of a WAV file behind the seek bar and keeps it in the database', async () => {
    const id = await openWith(envelope('01-shape.wav'))
    await expect(seek()).toHaveAttribute('data-wave', 'on')
    await expect(seek()).toHaveAttribute('data-peaks', 'ready', { timeout: 15_000 })

    const record = await app.storedPeaks(id)
    expect(record).toMatchObject({ v: 1, length: 480 }) // 12 s in windows of 25 ms
    const stored = record as { duration: number; peak: number[]; rms: number[] }
    expect(stored.duration).toBe(12)
    const third = stored.peak.length / 3
    const within = (from: number, to: number) => stored.peak.slice(from, to)
    expect(Math.min(...within(2, third - 2))).toBeGreaterThanOrEqual(LOUD - 1)
    expect(Math.max(...within(2, third - 2))).toBeLessThanOrEqual(LOUD + 1)
    expect(Math.max(...within(third + 2, 2 * third - 2))).toBe(0)
    expect(Math.min(...within(2 * third + 2, stored.peak.length - 2))).toBeGreaterThanOrEqual(QUIET - 1)
    expect(Math.max(...within(2 * third + 2, stored.peak.length - 2))).toBeLessThanOrEqual(QUIET + 1)
    expect(Math.max(...stored.rms)).toBeLessThan(Math.max(...stored.peak)) // the body of a bar is inside its outline
  })

  test('paints that shape: tall bars for the loud part, thin lines for the silence, a little shorter for the quiet part', async () => {
    await openWith(envelope('01-pixels.wav'))
    await expect(seek()).toHaveAttribute('data-peaks', 'ready', { timeout: 15_000 })
    // the bars are drawn when the layer has its size and the peaks: wait for paint instead of guessing
    await expect.poll(async () => Math.max(0, ...(await columns()))).toBeGreaterThan(20)
    const painted = await columns()
    const third = Math.floor(painted.length / 3)
    const tallest = (from: number, to: number) => Math.max(0, ...painted.slice(from, to))
    const margin = Math.round(third * 0.1)
    const loud = tallest(margin, third - margin)
    const silent = tallest(third + margin, 2 * third - margin)
    const quiet = tallest(2 * third + margin, painted.length - margin)
    expect(loud).toBeGreaterThanOrEqual(28)
    expect(silent).toBeLessThanOrEqual(4)
    expect(quiet).toBeGreaterThanOrEqual(22)
    expect(quiet).toBeLessThanOrEqual(loud)
  })

  test('shows how far playback has got in the accent colour, driven by the same value as the slider', async () => {
    await openWith(envelope('01-progress.wav'))
    await expect(seek()).toHaveAttribute('data-peaks', 'ready', { timeout: 15_000 })
    await app.seekTo(6)
    await expect(seek()).toHaveCSS('--p', '50%')
    // the second canvas is the accent-coloured copy, cut off at that point by CSS
    const clip = await seek().locator('canvas').nth(1).evaluate((el) => getComputedStyle(el).clipPath)
    expect(clip).toContain('inset(')
  })

  test('is still the same slider underneath: the keyboard and a click or a drag on the drawing move the playhead', async ({ page }) => {
    await openWith(envelope('01-slider.wav'))
    await expect(seek()).toHaveAttribute('data-peaks', 'ready', { timeout: 15_000 })
    await expect.poll(() => app.duration()).toBe(12)

    await app.seekBar.focus()
    await page.keyboard.press('ArrowRight') // the app's own hotkey: 5 seconds, also while the slider has the focus
    await expect(app.seekBar).toHaveValue('5')
    await page.keyboard.press('ArrowLeft')
    await expect(app.seekBar).toHaveValue('0')
    await page.keyboard.press('End') // the browser's own: the end of the range
    await expect(app.seekBar).toHaveValue('12')
    await page.keyboard.press('Home')
    await expect(app.seekBar).toHaveValue('0')

    const box = await seek().boundingBox()
    expect(box).not.toBeNull()
    const { x, y, width, height } = box ?? { x: 0, y: 0, width: 0, height: 0 }
    await page.mouse.click(x + width * 0.75, y + height / 2)
    await expect.poll(() => app.position()).toBeGreaterThanOrEqual(8)
    await expect.poll(() => app.position()).toBeLessThanOrEqual(10)
    // the playhead of the drawing is the slider's thumb, so the whole width is the whole track
    await page.mouse.click(x + 2, y + height / 2)
    await expect.poll(() => app.position()).toBeLessThanOrEqual(1)
  })

  test('shows the time under the pointer', async ({ page }) => {
    await openWith(envelope('01-hover.wav'))
    await expect(seek()).toHaveAttribute('data-peaks', 'ready', { timeout: 15_000 })
    await expect.poll(() => app.duration()).toBe(12)
    const box = await seek().boundingBox()
    const { x, y, width, height } = box ?? { x: 0, y: 0, width: 0, height: 0 }
    await page.mouse.move(x + width * 0.25, y + height / 2)
    await expect(seek().getByText('0:03', { exact: true })).toBeVisible()
    await page.mouse.move(x - 40, y - 40)
    await expect(seek().getByText('0:03', { exact: true })).toHaveCount(0)
  })

  test('is read from the database the next time, with no new measuring', async () => {
    await openWith(envelope('01-cache.wav'))
    await expect(seek()).toHaveAttribute('data-peaks', 'ready', { timeout: 15_000 })
    expect(await app.workerCount()).toBeGreaterThan(0) // the first time, the worker measured it
    await app.reload()
    await expect(seek()).toHaveAttribute('data-peaks', 'ready', { timeout: 15_000 })
    expect(await app.workerCount()).toBe(0) // now it came from the cache
  })

  test('is measured for a FLAC file too, by the same worker', async () => {
    const id = await openWith(flac('tone-440', '01-lossless.flac'))
    await expect(seek()).toHaveAttribute('data-peaks', 'ready', { timeout: 15_000 })
    const record = (await app.storedPeaks(id)) as { length: number; peak: number[] }
    expect(record.length).toBeGreaterThan(0)
    expect(Math.max(...record.peak)).toBeGreaterThan(100)
  })

  test('is the plain bar when the person chose it: no drawing, no measuring, the same slider', async ({ page }) => {
    await page.addInitScript(() => localStorage.setItem('wl.seekbar', 'plain'))
    const id = await openWith(envelope('01-plain.wav'))
    await expect(seek()).toHaveAttribute('data-wave', 'off')
    await expect(seek().locator('canvas')).toHaveCount(0)
    expect((await seek().boundingBox())?.height ?? 99).toBeLessThan(30)
    await expect(app.seekBar).toBeVisible()
    // nothing is measured in the background for a bar that does not draw it (the measuring starts after a pause of one second)
    await page.waitForTimeout(1500)
    expect(await app.storedPeaks(id)).toBeNull()
    expect(await app.workerCount()).toBe(0)
  })

  test('can be switched off and on again in Sound & tools, and the seek bar follows at once', async ({ page }) => {
    await openWith(envelope('01-switch.wav'))
    await expect(seek()).toHaveAttribute('data-peaks', 'ready', { timeout: 15_000 })
    await app.openTools()
    const style = app.tools.getByRole('radiogroup', { name: 'Seek bar style' })
    await expect(style.getByRole('radio', { name: 'Waveform' })).toHaveAttribute('aria-checked', 'true')

    await style.getByRole('radio', { name: 'Plain bar' }).click()
    await expect(seek()).toHaveAttribute('data-wave', 'off')
    await expect(seek().locator('canvas')).toHaveCount(0)
    expect(await page.evaluate(() => localStorage.getItem('wl.seekbar'))).toBe('plain')

    await style.getByRole('radio', { name: 'Waveform' }).click()
    await expect(seek()).toHaveAttribute('data-wave', 'on')
    await expect(seek()).toHaveAttribute('data-peaks', 'ready')
    await expect(seek().locator('canvas')).toHaveCount(2)
    expect(await page.evaluate(() => localStorage.getItem('wl.seekbar'))).toBe('waveform')
  })

  test('says nothing when the browser cannot decode the file, and does not try that file again', async () => {
    const id = await openWith({ name: '01-noise.mp3', mimeType: 'audio/mpeg', buffer: Buffer.alloc(6000, 7) })
    await expect(seek()).toHaveAttribute('data-peaks', 'none', { timeout: 15_000 })
    expect(await app.storedPeaks(id)).toEqual({ v: 1, none: 'unsupported' })
    await expect(app.seekBar).toBeVisible()
    await app.reload()
    await expect(seek()).toHaveAttribute('data-peaks', 'none', { timeout: 15_000 })
  })

  // Only a real browser can tell whether it decodes these; a tone that is loud for 1.5 s, silent for 1 s, quiet for 1.5 s,
  // so (with 25 ms windows) windows 0-59 are loud, 60-99 silent and 100-159 quiet, give or take the encoder's delay.
  for (const [name, file] of [
    ['MP3', realMp3File('01-real.mp3')],
    ['Ogg Vorbis', realOggFile('01-real.ogg')],
  ] as const) {
    test(`measures a real ${name} file with the browser's own decoder`, async () => {
      const id = await openWith(file)
      await expect(seek()).toHaveAttribute('data-peaks', 'ready', { timeout: 15_000 })
      const record = (await app.storedPeaks(id)) as { duration: number; peak: number[] }
      expect(record.duration).toBeGreaterThan(3.9)
      expect(record.duration).toBeLessThan(4.2)
      const median = (values: number[]) => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)] ?? 0
      expect(median(record.peak.slice(10, 50))).toBeGreaterThanOrEqual(120) // 0.0625 is -24 dB: about 133
      expect(median(record.peak.slice(10, 50))).toBeLessThanOrEqual(145)
      expect(median(record.peak.slice(70, 90))).toBeLessThanOrEqual(15)
      expect(median(record.peak.slice(110, 150))).toBeGreaterThanOrEqual(90) // 0.03125 is -30 dB: about 102
      expect(median(record.peak.slice(110, 150))).toBeLessThanOrEqual(115)
    })
  }

  test('keeps to the page’s own policy: a worker from our own files, canvases and CSS, nothing else', async () => {
    await openWith(envelope('01-policy.wav'))
    await expect(seek()).toHaveAttribute('data-peaks', 'ready', { timeout: 15_000 })
    await app.seekTo(3)
    expect(await app.policyViolations()).toEqual([])
  })

  test('has no accessibility violations, and the slider keeps its name and spoken value', async ({ page }) => {
    await openWith(envelope('01-axe.wav'))
    await expect(seek()).toHaveAttribute('data-peaks', 'ready', { timeout: 15_000 })
    await app.seekTo(6)
    await expect(app.seekBar).toHaveAttribute('aria-valuetext', /6 seconds of 12 seconds|0 minutes 6 seconds|6 seconds/)
    const results = await new AxeBuilder({ page }).include('#player').analyze()
    expect(results.violations).toEqual([])
  })
})

test.describe('waveform seek bar on a phone', () => {
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true })

  test('is taller in the Now playing sheet, and drawn there from the same measurement', async ({ page }) => {
    const app = new PlayerPage(page)
    await app.open()
    await app.importFiles(envelope('01-phone.wav'))
    await expect(app.rows).toHaveCount(1)
    await page.locator('#player-mini').getByRole('button', { name: 'Open now playing' }).click()
    const sheet = page.getByRole('dialog', { name: 'Now playing' })
    const bar = sheet.locator('.seek')
    await expect(bar).toHaveAttribute('data-wave', 'on')
    await expect(bar).toHaveAttribute('data-peaks', 'ready', { timeout: 15_000 })
    const box = await bar.boundingBox()
    expect(box?.height ?? 0).toBeGreaterThan(50)
    expect(box?.height ?? 0).toBeLessThan(64)
    expect((box?.x ?? 0) + (box?.width ?? 0)).toBeLessThanOrEqual(390)
    await expect(bar.locator('canvas')).toHaveCount(2)
    expect(await app.policyViolations()).toEqual([])
  })
})
