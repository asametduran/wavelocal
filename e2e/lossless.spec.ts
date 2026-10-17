import { expect, test } from '@playwright/test'
import { PlayerPage, denyNativeLossless, failNativeFlacPlayback, flac, rejectFlacDecoding, tone, wav } from './helpers'
import type { Upload } from './helpers'
import { decodeFlac } from '../src/lib/audio/flac'
import { buildFlac } from '../src/test-utils/fixtures'
import { encodeFlac } from '../src/test-utils/flac-encoder'

/** Size of a 16-bit PCM WAV with the given audio. */
const wavSize = (seconds: number, rate: number, channels: number) => 44 + Math.round(seconds * rate) * channels * 2

test.describe('lossless playback: the browser can play it', () => {
  let app: PlayerPage
  test.beforeEach(async ({ page }) => {
    app = new PlayerPage(page)
    await app.open()
  })

  test('FLAC goes to the media element untouched, with no decoding work', async () => {
    const upload = flac('tone-440')
    await app.importFiles(upload)
    await app.play('tone-440')
    await expect.poll(() => app.playingSource()).toMatchObject({ type: 'audio/flac', size: upload.buffer.length })
    expect(await app.workerCount()).toBe(0)
    await expect.poll(() => app.position(), { timeout: 8_000 }).toBeGreaterThanOrEqual(1)
  })

  test('ordinary WAV files are not converted either', async () => {
    const upload = wav('tone-440')
    await app.importFiles(upload)
    await app.play('tone-440')
    await expect.poll(() => app.playingSource()).toMatchObject({ type: 'audio/wav', size: upload.buffer.length })
    expect(await app.workerCount()).toBe(0)
  })

  test('a file that is not audio at all is skipped without hanging', async () => {
    await app.importFiles({ name: 'a-garbage.flac', mimeType: 'audio/flac', buffer: Buffer.from('this is not audio '.repeat(40)) }, wav('tone-880', 'b-good.wav'))
    await app.play('a-garbage')
    await expect(app.nowPlayingTitle).toHaveText('b-good', { timeout: 10_000 })
    await app.expectPlaying()
  })
})

test.describe('lossless playback: the browser says it cannot play WAV/FLAC', () => {
  let app: PlayerPage
  const pageErrors: string[] = []

  test.beforeEach(async ({ page }) => {
    pageErrors.length = 0
    page.on('pageerror', (e) => pageErrors.push(e.message))
    await denyNativeLossless(page)
    app = new PlayerPage(page)
    await app.open()
  })

  test.afterEach(() => {
    expect(pageErrors).toEqual([])
  })

  test('FLAC is decoded in a worker and played as 16-bit PCM', async () => {
    const upload = flac('tone-440')
    await app.importFiles(upload)
    await app.play('tone-440')
    await expect.poll(() => app.playingSource(), { timeout: 8_000 }).toMatchObject({ type: 'audio/wav', size: wavSize(4, 44100, 1) })
    expect(await app.workerCount()).toBeGreaterThanOrEqual(1)
    await expect.poll(() => app.position(), { timeout: 8_000 }).toBeGreaterThanOrEqual(1)
    expect(await app.duration()).toBe(4)
    await expect(app.page.getByText(/Decoding lossless audio/)).toHaveCount(0)
  })

  test('WAV files are also routed through the decoder', async () => {
    await app.importFiles(wav('tone-440'))
    await app.play('tone-440')
    await expect.poll(() => app.workerCount(), { timeout: 8_000 }).toBeGreaterThanOrEqual(1)
    await expect.poll(() => app.position(), { timeout: 8_000 }).toBeGreaterThanOrEqual(1)
  })

  test('stereo separation survives the whole path', async () => {
    await app.importFiles(flac('stereo-split'))
    await app.play('stereo-split')
    const tones = async () => {
      const { left, right } = await app.outputSpectrumDb([440, 880])
      return { l440: left[0] ?? -Infinity, l880: left[1] ?? -Infinity, r440: right[0] ?? -Infinity, r880: right[1] ?? -Infinity }
    }
    await expect.poll(async () => (await tones()).l440 - (await tones()).l880, { timeout: 8_000 }).toBeGreaterThan(40)
    await expect.poll(async () => (await tones()).r880 - (await tones()).r440).toBeGreaterThan(40)
  })

  test('24-bit hi-res FLAC plays', async () => {
    await app.importFiles(flac('tone-440', 'hires.flac', { bitsPerSample: 24 }))
    await app.play('hires')
    await expect.poll(() => app.playingSource(), { timeout: 8_000 }).toMatchObject({ type: 'audio/wav' })
    await expect.poll(() => app.position(), { timeout: 8_000 }).toBeGreaterThanOrEqual(1)
    expect(await app.duration()).toBe(4)
  })

  test('seeking, pausing and changing speed work on decoded audio', async () => {
    await app.importFiles(flac('long'))
    await app.play('long')
    await app.playButton.click()
    await app.expectPaused()
    await app.seekTo(12)
    await expect.poll(() => app.position()).toBe(12)
    await app.playButton.click()
    await app.expectPlaying()
    await expect.poll(() => app.position(), { timeout: 8_000 }).toBeGreaterThanOrEqual(13)

    await app.openTools()
    await app.tools.getByRole('slider', { name: 'Playback speed' }).fill('1.5')
    await expect.poll(async () => (await app.mediaSettings()).map((m) => m.rate)).toContain(1.5)
  })

  test('a decoded track crossfades into the next decoded track', async () => {
    await app.importFiles(flac('tone-440', 'a.flac'), flac('tone-880', 'b.flac'))
    await app.openTools()
    await app.tools.getByRole('radio', { name: 'Crossfade' }).click()
    await app.closeTools()
    await app.play('a')
    await expect(app.nowPlayingTitle).toHaveText('b', { timeout: 15_000 })
    await app.expectPlaying()
    await expect.poll(() => app.playingElements(), { timeout: 8_000 }).toBe(1)
  })

  test('a damaged frame is replaced by silence and the track still plays to its full length', async () => {
    const bytes = buildFlac('tone-440', { subframe: 'verbatim', blockSize: 4096 })
    const damaged = Buffer.from(bytes)
    const at = Math.floor(damaged.length / 2)
    damaged[at] = (damaged[at] ?? 0) ^ 0x55
    await app.importFiles({ name: 'damaged.flac', mimeType: 'audio/flac', buffer: damaged })
    await app.play('damaged')
    await expect.poll(() => app.playingSource(), { timeout: 8_000 }).toMatchObject({ type: 'audio/wav', size: wavSize(4, 44100, 1) })
    expect(await app.duration()).toBe(4)
  })

  test('removing a decoded track frees its converted audio', async () => {
    await app.importFiles(flac('tone-440', 'a.flac'), flac('tone-880', 'b.flac'))
    await app.play('a')
    const playing = await expect.poll(() => app.playingSource(), { timeout: 8_000 }).not.toBeNull().then(() => app.playingSource())
    const src = playing?.src ?? ''
    expect(src).toMatch(/^blob:/)
    await app.row('a').hover()
    await app.row('a').getByRole('button', { name: 'Remove a' }).click()
    await expect.poll(() => app.revokedUrls()).toContain(src)
  })

  test('clearing the library frees every converted track', async () => {
    await app.importFiles(flac('tone-440', 'a.flac'))
    await app.play('a')
    await expect.poll(() => app.playingSource(), { timeout: 8_000 }).not.toBeNull()
    const src = (await app.playingSource())?.src ?? ''
    await app.sidebar.getByRole('button', { name: 'Clear library' }).click()
    await app.answerDialog(true)
    await expect.poll(() => app.revokedUrls()).toContain(src)
  })

  test('volume normalization measures a FLAC the browser cannot decode', async ({ page }) => {
    await rejectFlacDecoding(page)
    await page.reload()
    await expect(app.viewSelect).toBeVisible()
    await app.importFiles(flac('quiet', 'quiet.flac'))
    await app.openTools()
    const toggle = app.tools.getByRole('switch', { name: 'Normalize volume between tracks' })
    await toggle.click()
    await app.closeTools()
    await app.play('quiet')
    await app.openTools()
    await expect(app.tools.getByText(/this track: \+12 dB/)).toBeVisible({ timeout: 10_000 })
  })
})

test.describe('lossless playback: the browser claims support but fails', () => {
  let app: PlayerPage

  test.beforeEach(async ({ page }) => {
    await failNativeFlacPlayback(page)
    app = new PlayerPage(page)
    await app.open()
  })

  test('a native error makes the player decode the file itself and carry on', async () => {
    await app.importFiles(flac('tone-440', 'a.flac'), wav('tone-880', 'b.wav'))
    await app.play('a')
    await expect.poll(() => app.playingSource(), { timeout: 10_000 }).toMatchObject({ type: 'audio/wav', size: wavSize(4, 44100, 1) })
    await expect(app.nowPlayingTitle).toHaveText('a') // retried the same track instead of skipping it
    expect(await app.workerCount()).toBeGreaterThanOrEqual(1)
    await expect.poll(() => app.position(), { timeout: 8_000 }).toBeGreaterThanOrEqual(1)
  })

  test('a file that is not really FLAC is skipped, and the next track plays', async () => {
    await app.importFiles({ name: 'a-bad.flac', mimeType: 'audio/flac', buffer: Buffer.from('definitely not a flac stream '.repeat(30)) }, wav('tone-880', 'b-good.wav'))
    await app.play('a-bad')
    await expect(app.nowPlayingTitle).toHaveText('b-good', { timeout: 10_000 })
    await app.expectPlaying()
  })

  test('a queue of unplayable files stops instead of looping forever', async () => {
    const garbage = (name: string): Upload => ({ name, mimeType: 'audio/flac', buffer: Buffer.from('nothing to hear here '.repeat(30)) })
    await app.importFiles(garbage('a-bad.flac'), garbage('b-bad.flac'))
    await app.key('r') // repeat all: the only thing that could make it loop
    await app.play('a-bad').catch(() => undefined)
    await expect(app.page.getByText('None of the next tracks could be played')).toBeVisible({ timeout: 15_000 })
    await app.expectPaused()
  })
})

test.describe('the JavaScript decoder agrees with the browser\'s own FLAC decoder', () => {
  let app: PlayerPage
  test.beforeEach(async ({ page }) => {
    app = new PlayerPage(page)
    await app.open()
  })

  const mono = (length: number, bits: number, seed: number) => {
    const peak = 2 ** (bits - 1) - 1
    let state = seed
    return Int32Array.from({ length }, (_, i) => {
      state = (state * 1664525 + 1013904223) >>> 0
      return Math.round(peak * (0.5 * Math.sin(i / 17) + 0.25 * Math.sin(i / 3.1) + 0.04 * (state / 2 ** 32 - 0.5)))
    })
  }

  const cases: { name: string; bits: number; rate: number; channels: number; options: Partial<Parameters<typeof encodeFlac>[1]> }[] = [
    { name: '16-bit stereo, automatic modes', bits: 16, rate: 44100, channels: 2, options: {} },
    { name: '16-bit stereo, LPC order 12, mid/side', bits: 16, rate: 48000, channels: 2, options: { subframe: 'lpc', order: 12, stereo: 'midside' } },
    { name: '16-bit stereo, left/side', bits: 16, rate: 44100, channels: 2, options: { subframe: 'fixed', order: 3, stereo: 'leftside' } },
    { name: '16-bit stereo, right/side', bits: 16, rate: 44100, channels: 2, options: { subframe: 'lpc', order: 4, stereo: 'rightside' } },
    { name: '24-bit stereo at 96 kHz', bits: 24, rate: 96000, channels: 2, options: { blockSize: 2048 } },
    { name: '24-bit mono, LPC order 32', bits: 24, rate: 48000, channels: 1, options: { subframe: 'lpc', order: 32, lpcPrecision: 15 } },
    { name: '8-bit mono', bits: 8, rate: 44100, channels: 1, options: {} },
    { name: 'variable block sizes', bits: 16, rate: 44100, channels: 2, options: { blockSizes: [1000, 333, 4096, 256], subframe: 'fixed', order: 2 } },
    { name: 'verbatim subframes', bits: 16, rate: 44100, channels: 1, options: { subframe: 'verbatim' } },
    { name: 'wasted bits', bits: 16, rate: 44100, channels: 1, options: { subframe: 'fixed', order: 1 } },
  ]

  for (const c of cases) {
    test(c.name, async ({ page }) => {
      let channels = Array.from({ length: c.channels }, (_, i) => mono(14000, c.bits, i + 1))
      if (c.name === 'wasted bits') channels = channels.map((ch) => ch.map((v) => v & ~7))
      const bytes = encodeFlac(channels, { sampleRate: c.rate, bitsPerSample: c.bits, blockSize: 4096, ...c.options })

      // what our decoder produces
      const ours = decodeFlac(bytes, { verifyMd5: true })
      expect(ours.md5Status).toBe('verified')

      // what the browser's own FLAC decoder produces for the same bytes
      const native = await page.evaluate(
        async ([data, rate, count]) => {
          const ctx = new OfflineAudioContext(count as number, 1, rate as number)
          const buffer = await ctx.decodeAudioData(new Uint8Array(data as number[]).buffer)
          return Array.from({ length: buffer.numberOfChannels }, (_, ch) => Array.from(buffer.getChannelData(ch)))
        },
        [Array.from(bytes), c.rate, c.channels] as const,
      )

      expect(native).toHaveLength(c.channels)
      // Chromium turns 16-bit samples into floats asymmetrically (positive / 32767, negative / 32768); undo exactly that
      // convention so the comparison is between whole-number samples and nothing is hidden in a tolerance
      const scale = 2 ** (c.bits - 1)
      const toInteger = (value: number) => Math.round(c.bits === 16 ? value * (value < 0 ? 32768 : 32767) : value * scale)
      let mismatches = 0
      native.forEach((channel, ch) => {
        expect(channel).toHaveLength(ours.length)
        channel.forEach((value, i) => {
          if (toInteger(value) !== ours.pcm[ch]?.[i]) mismatches++
        })
      })
      expect(mismatches).toBe(0)
    })
  }
})
