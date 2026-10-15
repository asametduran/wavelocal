import { expect, test } from '@playwright/test'
import { GAIN, PlayerPage, tone, wav } from './helpers'
import type { Upload } from './helpers'
import type { FixtureName } from '../src/test-utils/fixtures'
import { bandResponseDb } from '../src/lib/eq'

test.describe('tone, stereo, compressor and limiter', () => {
  let app: PlayerPage
  const pageErrors: string[] = []

  test.beforeEach(async ({ page }) => {
    pageErrors.length = 0
    page.on('pageerror', (e) => pageErrors.push(e.message))
    app = new PlayerPage(page)
    await app.open()
  })

  test.afterEach(() => {
    expect(pageErrors).toEqual([])
  })

  const region = (name: string) => app.tools.getByRole('region', { name, exact: true })
  const slider = (section: string, name: string) => region(section).getByRole('slider', { name, exact: true })
  const toggle = (section: string, name: string) => region(section).getByRole('switch', { name, exact: true })

  /** Import the files, loop the first one (repeat-one) so it never ends mid-test, play it and open the tools. */
  async function start(...files: (FixtureName | Upload)[]) {
    const uploads = files.map((f) => (typeof f === 'string' ? wav(f) : f))
    await app.importFiles(...uploads)
    await app.key('r')
    await app.key('r') // off -> all -> one
    await app.play((uploads[0]?.name ?? '').replace(/\.wav$/, ''))
    await app.openTools()
  }

  /** The text of a gain-reduction read-out (its last span), as a number in dB. */
  const meterDb = async (name: string, section: string) => Number.parseFloat((await region(section).getByRole('group', { name }).locator('span').last().textContent()) ?? '0')

  /** Spectral peaks are read from FFT bins that do not line up with the tones, so allow roughly a decibel of scalloping. */
  const near = (target: number) => ({ min: target - 2, max: target + 2 })

  /** The strongest spectrum reading of each channel at 440 Hz and 880 Hz. */
  const tones = async () => {
    const { left, right } = await app.outputSpectrumDb([440, 880])
    return { l440: left[0] ?? -Infinity, l880: left[1] ?? -Infinity, r440: right[0] ?? -Infinity, r880: right[1] ?? -Infinity }
  }

  test('everything is neutral by default: bypassed dynamics and an identity stereo matrix', async () => {
    await start('stereo-split')
    expect(await app.gainValue(GAIN.compBypass)).toBe(1)
    expect(await app.gainValue(GAIN.compThrough)).toBe(0)
    expect(await app.gainValue(GAIN.limiterBypass)).toBe(1)
    expect(await app.gainValue(GAIN.limiterThrough)).toBe(0)
    expect([GAIN.matrixLL, GAIN.matrixLR, GAIN.matrixRL, GAIN.matrixRR].map((i) => i)).toHaveLength(4)
    expect(await app.gainValue(GAIN.matrixLL)).toBe(1)
    expect(await app.gainValue(GAIN.matrixRR)).toBe(1)
    expect(await app.gainValue(GAIN.matrixLR)).toBe(0)
    expect(await app.gainValue(GAIN.matrixRL)).toBe(0)
    const shelves = await app.toneResponseDb([50, 16000])
    expect(shelves.bass.every((v) => Math.abs(v) < 0.01)).toBe(true)
    expect(shelves.treble.every((v) => Math.abs(v) < 0.01)).toBe(true)
  })

  test.describe('stereo', () => {
    test('the original left/right separation reaches the speakers untouched', async () => {
      await start('stereo-split') // left 440 Hz, right 880 Hz
      await expect.poll(async () => (await tones()).l440 - (await tones()).l880, { timeout: 6_000 }).toBeGreaterThan(40)
      await expect.poll(async () => (await tones()).r880 - (await tones()).r440).toBeGreaterThan(40)
    })

    test('mono downmix puts both tones equally in both ears', async () => {
      await start('stereo-split')
      await toggle('Stereo', 'Mono downmix').click()
      await expect(toggle('Stereo', 'Mono downmix')).toHaveAttribute('aria-checked', 'true')
      await expect(slider('Stereo', 'Stereo width')).toBeDisabled()
      for (const index of [GAIN.matrixLL, GAIN.matrixLR, GAIN.matrixRL, GAIN.matrixRR]) await expect.poll(() => app.gainValue(index)).toBeCloseTo(0.5, 2)

      await expect.poll(async () => Math.abs((await tones()).l440 - (await tones()).l880), { timeout: 6_000 }).toBeLessThan(1.5)
      await expect.poll(async () => Math.abs((await tones()).l440 - (await tones()).r440)).toBeLessThan(1.5)
      await expect.poll(async () => Math.abs((await tones()).l880 - (await tones()).r880)).toBeLessThan(1.5)
    })

    test('widening exaggerates the difference between the channels', async () => {
      await start('stereo-split')
      await slider('Stereo', 'Stereo width').fill('2')
      await expect(region('Stereo').getByText('200% width')).toBeVisible()
      await expect.poll(() => app.gainValue(GAIN.matrixLL)).toBeCloseTo(1.5, 2)
      await expect.poll(() => app.gainValue(GAIN.matrixLR)).toBeCloseTo(-0.5, 2)
      // left = 1.5 * (440 Hz at 0.5) - 0.5 * (880 Hz at 0.5): the leakage is a third of the main tone, i.e. about 9.5 dB down
      const gap = (await Promise.resolve(near(9.5)))
      await expect.poll(async () => (await tones()).l440 - (await tones()).l880, { timeout: 6_000 }).toBeGreaterThan(gap.min)
      await expect.poll(async () => (await tones()).l440 - (await tones()).l880).toBeLessThan(gap.max + 1)
      await expect.poll(async () => (await tones()).r880 - (await tones()).r440).toBeGreaterThan(gap.min)
      await expect.poll(async () => (await tones()).r880 - (await tones()).r440).toBeLessThan(gap.max + 1)
    })

    test('narrowing blends the channels towards mono', async () => {
      await start('stereo-split')
      await slider('Stereo', 'Stereo width').fill('0.5')
      await expect.poll(() => app.gainValue(GAIN.matrixLL)).toBeCloseTo(0.75, 2)
      await expect.poll(() => app.gainValue(GAIN.matrixLR)).toBeCloseTo(0.25, 2)
      await expect.poll(async () => (await tones()).l440 - (await tones()).l880, { timeout: 6_000 }).toBeGreaterThan(near(9.5).min)
      await expect.poll(async () => (await tones()).l440 - (await tones()).l880).toBeLessThan(near(9.5).max + 1)
    })

    test('width presets set the slider', async () => {
      await start('stereo-split')
      const presets = region('Stereo').getByRole('group', { name: 'Stereo width presets' })
      await presets.getByRole('button', { name: 'Wide', exact: true }).click()
      await expect(slider('Stereo', 'Stereo width')).toHaveValue('1.5')
      await expect(presets.getByRole('button', { name: 'Wide', exact: true })).toHaveAttribute('aria-pressed', 'true')
      await presets.getByRole('button', { name: 'Original' }).click()
      await expect.poll(() => app.gainValue(GAIN.matrixLL)).toBeCloseTo(1, 2)
    })

    test('a mono file is centred (the same level in both ears), even with the stereo matrix in the path', async () => {
      await start('long') // a mono WAV
      await expect.poll(async () => (await app.outputLevels()).leftRms, { timeout: 6_000 }).toBeGreaterThan(-60)
      const { leftRms, rightRms } = await app.outputLevels()
      expect(Math.abs(leftRms - rightRms)).toBeLessThan(0.5)
      await slider('Stereo', 'Stereo width').fill('2')
      await app.page.waitForTimeout(300)
      const wide = await app.outputLevels()
      expect(Math.abs(wide.leftRms - wide.rightRms)).toBeLessThan(0.5) // widening cannot move a centred signal
    })
  })

  test.describe('tone', () => {
    test('bass and treble drive real shelving filters', async () => {
      await start('long')
      await slider('Tone', 'Bass').fill('12')
      await slider('Tone', 'Treble').fill('-9')
      await expect(region('Tone').getByText('+12.0 dB')).toBeVisible()
      await expect.poll(async () => (await app.toneResponseDb([30]))?.bass[0]).toBeCloseTo(12, 0)
      await expect.poll(async () => (await app.toneResponseDb([18000]))?.treble[0]).toBeCloseTo(-9, 0)
      // far from each shelf the other end is left alone
      expect(Math.abs((await app.toneResponseDb([10000])).bass[0] ?? 99)).toBeLessThan(0.3)
      expect(Math.abs((await app.toneResponseDb([50])).treble[0] ?? 99)).toBeLessThan(0.3)
    })

    test('a bass boost really makes a low tone louder at the speakers (and leaves a mid tone alone)', async () => {
      await start(tone('low.wav', 8, 60)) // 60 Hz is well inside the 100 Hz bass shelf
      await expect.poll(async () => (await app.outputLevels()).leftRms, { timeout: 6_000 }).toBeGreaterThan(-60)
      const before = (await app.outputLevels()).leftRms
      await slider('Tone', 'Bass').fill('12')
      const expected = bandResponseDb({ type: 'lowshelf', frequency: 100, q: 1, gain: 12 }, 60, await app.sampleRate())
      expect(expected).toBeGreaterThan(8)
      await expect.poll(async () => (await app.outputLevels()).leftRms - before, { timeout: 5_000 }).toBeGreaterThan(expected - 1.5)
      await expect.poll(async () => (await app.outputLevels()).leftRms - before).toBeLessThan(expected + 1.5)
    })

    test('a treble boost lifts a high tone', async () => {
      await start(tone('high.wav', 8, 12000))
      await expect.poll(async () => (await app.outputLevels()).leftRms, { timeout: 6_000 }).toBeGreaterThan(-60)
      const before = (await app.outputLevels()).leftRms
      await slider('Tone', 'Treble').fill('12')
      const expected = bandResponseDb({ type: 'highshelf', frequency: 8000, q: 1, gain: 12 }, 12000, await app.sampleRate())
      expect(expected).toBeGreaterThan(8)
      await expect.poll(async () => (await app.outputLevels()).leftRms - before, { timeout: 5_000 }).toBeGreaterThan(expected - 1.5)
    })

    test('reset returns both to flat', async () => {
      await start('long')
      await slider('Tone', 'Bass').fill('6')
      await region('Tone').getByRole('button', { name: 'Reset' }).click()
      await expect(slider('Tone', 'Bass')).toHaveValue('0')
      await expect.poll(async () => Math.abs((await app.toneResponseDb([30])).bass[0] ?? 99)).toBeLessThan(0.05)
    })
  })

  test.describe('compressor', () => {
    test('is bypassed until enabled, then uses its parameters', async () => {
      await start('loud')
      await expect(toggle('Compressor', 'Enable compressor')).toHaveAttribute('aria-checked', 'false')
      await expect(slider('Compressor', 'Compressor threshold')).toBeDisabled()

      await toggle('Compressor', 'Enable compressor').click()
      await expect.poll(() => app.gainValue(GAIN.compThrough)).toBeCloseTo(1, 2)
      await expect.poll(() => app.gainValue(GAIN.compBypass)).toBeCloseTo(0, 2)
      await slider('Compressor', 'Compressor threshold').fill('-40')
      await slider('Compressor', 'Compressor ratio').fill('12')
      await slider('Compressor', 'Compressor attack').fill('3')
      await slider('Compressor', 'Compressor release').fill('250')
      await slider('Compressor', 'Compressor knee').fill('5')
      await expect.poll(async () => (await app.compressorState(0))?.threshold).toBeCloseTo(-40, 1)
      await expect.poll(async () => (await app.compressorState(0))?.ratio).toBeCloseTo(12, 1)
      await expect.poll(async () => (await app.compressorState(0))?.attack).toBeCloseTo(0.003, 3)
      await expect.poll(async () => (await app.compressorState(0))?.release).toBeCloseTo(0.25, 2)
      await expect.poll(async () => (await app.compressorState(0))?.knee).toBeCloseTo(5, 1)
    })

    test('squashes loud passages towards quiet ones (less dynamic range at the speakers)', async () => {
      await start('loud-then-quiet') // 2 s at -8 dBFS RMS, then 2 s at -30 dBFS RMS
      const levelAt = async (seconds: number) => {
        await app.seekTo(seconds)
        await app.page.waitForTimeout(450)
        return (await app.outputLevels()).leftRms
      }
      const plainLoud = await levelAt(1)
      const plainQuiet = await levelAt(3)
      expect(plainLoud - plainQuiet).toBeGreaterThan(18) // 22 dB apart without processing

      await toggle('Compressor', 'Enable compressor').click()
      await slider('Compressor', 'Compressor threshold').fill('-30')
      await slider('Compressor', 'Compressor ratio').fill('20')
      await slider('Compressor', 'Compressor knee').fill('0')
      await slider('Compressor', 'Compressor attack').fill('0')
      await expect.poll(async () => (await app.compressorState(0))?.ratio).toBeCloseTo(20, 0)
      await app.page.waitForTimeout(400)
      const squashedLoud = await levelAt(1)
      expect(await app.compressorState(0).then((s) => s?.reduction)).toBeLessThan(-8) // it is working hard on the loud part
      const squashedQuiet = await levelAt(3)
      expect(squashedLoud - squashedQuiet).toBeLessThan(plainLoud - plainQuiet - 8) // far smaller gap
    })

    test('make-up gain raises the level by exactly its amount', async () => {
      await start('quiet') // -30 dBFS RMS: below the default -24 dB threshold, so nothing is compressed
      await toggle('Compressor', 'Enable compressor').click()
      await expect.poll(() => app.gainValue(GAIN.compThrough)).toBeCloseTo(1, 2)
      await app.page.waitForTimeout(500)
      const base = (await app.outputLevels()).leftRms
      await slider('Compressor', 'Compressor makeup gain').fill('12')
      await expect.poll(async () => (await app.outputLevels()).leftRms - base, { timeout: 5_000 }).toBeCloseTo(12, 0)
    })

    test('the gain-reduction meter shows the reduction and the transfer curve is drawn', async () => {
      await start('loud')
      await toggle('Compressor', 'Enable compressor').click()
      await slider('Compressor', 'Compressor threshold').fill('-40')
      await slider('Compressor', 'Compressor ratio').fill('20')
      await expect.poll(() => meterDb('Compressor gain reduction', 'Compressor'), { timeout: 6_000 }).toBeLessThan(-5)
      await expect(region('Compressor').getByRole('img', { name: /Compressor curve: threshold -40 dB, ratio 20\.0 to 1/ })).toBeVisible()
    })

    test('disabling restores the untouched signal', async () => {
      await start('loud')
      await app.page.waitForTimeout(400)
      const base = (await app.outputLevels()).leftRms
      await toggle('Compressor', 'Enable compressor').click()
      await slider('Compressor', 'Compressor threshold').fill('-50')
      await slider('Compressor', 'Compressor ratio').fill('20')
      await app.page.waitForTimeout(500)
      await toggle('Compressor', 'Enable compressor').click()
      await expect.poll(async () => Math.abs((await app.outputLevels()).leftRms - base), { timeout: 5_000 }).toBeLessThan(0.7)
      expect(await app.gainValue(GAIN.compBypass)).toBeCloseTo(1, 2)
    })
  })

  test.describe('limiter', () => {
    test('holds the output well under a low ceiling, and lets everything through when off', async () => {
      await start('loud') // 1 kHz, peaks near -5 dBFS
      await expect.poll(async () => (await app.outputLevels()).leftPeak, { timeout: 6_000 }).toBeGreaterThan(-8)
      const plainPeak = (await app.outputLevels()).leftPeak

      await toggle('Limiter', 'Enable limiter').click()
      await slider('Limiter', 'Limiter ceiling').fill('-20')
      await expect(region('Limiter').getByText('-20.0 dB', { exact: true })).toBeVisible()
      await expect.poll(async () => (await app.compressorState(1))?.threshold).toBeCloseTo(-20, 1)
      await expect.poll(async () => (await app.outputLevels()).leftPeak, { timeout: 6_000 }).toBeLessThan(plainPeak - 10)

      await toggle('Limiter', 'Enable limiter').click()
      await expect.poll(async () => (await app.outputLevels()).leftPeak, { timeout: 6_000 }).toBeGreaterThan(plainPeak - 1)
    })

    test('catches what the equalizer would otherwise push into clipping', async () => {
      await start('loud')
      await app.tools.getByRole('region', { name: 'Equalizer' }).getByRole('button', { name: 'Treble Boost' }).click()
      // pile on more gain with the tone control so the peak would exceed full scale
      await slider('Tone', 'Bass').fill('12')
      await toggle('Compressor', 'Enable compressor').click() // adds make-up on top
      await slider('Compressor', 'Compressor makeup gain').fill('12')
      await slider('Compressor', 'Compressor threshold').fill('0')
      await app.page.waitForTimeout(400)
      expect((await app.outputLevels()).leftPeak).toBeGreaterThan(-1) // clearly hot without a limiter

      await toggle('Limiter', 'Enable limiter').click()
      await slider('Limiter', 'Limiter ceiling').fill('-6')
      await expect.poll(async () => (await app.outputLevels()).leftPeak, { timeout: 6_000 }).toBeLessThan(-3)
    })

    test('has its own meter', async () => {
      await start('loud')
      await toggle('Limiter', 'Enable limiter').click()
      await slider('Limiter', 'Limiter ceiling').fill('-20')
      await expect.poll(() => meterDb('Limiter gain reduction', 'Limiter'), { timeout: 6_000 }).toBeLessThan(-3)
    })
  })

  test('settings persist across a reload', async () => {
    await start('long')
    await slider('Tone', 'Bass').fill('5')
    await slider('Stereo', 'Stereo width').fill('1.5')
    await toggle('Compressor', 'Enable compressor').click()
    await slider('Compressor', 'Compressor ratio').fill('8')
    await toggle('Limiter', 'Enable limiter').click()
    await slider('Limiter', 'Limiter ceiling').fill('-4')
    await app.closeTools()

    await app.reload()
    await app.play('long')
    await app.openTools()
    await expect(slider('Tone', 'Bass')).toHaveValue('5')
    await expect(slider('Stereo', 'Stereo width')).toHaveValue('1.5')
    await expect(toggle('Compressor', 'Enable compressor')).toHaveAttribute('aria-checked', 'true')
    await expect(slider('Compressor', 'Compressor ratio')).toHaveValue('8')
    await expect(toggle('Limiter', 'Enable limiter')).toHaveAttribute('aria-checked', 'true')
    await expect(slider('Limiter', 'Limiter ceiling')).toHaveValue('-4')
    await expect.poll(() => app.gainValue(GAIN.compThrough)).toBeCloseTo(1, 2)
    await expect.poll(() => app.gainValue(GAIN.matrixLR)).toBeCloseTo(-0.25, 2)
    await expect.poll(async () => (await app.compressorState(1))?.threshold).toBeCloseTo(-4, 1)
  })

  test('works together with spatial audio and reverb', async () => {
    await start('stereo-split')
    await slider('Stereo', 'Stereo width').fill('1.5')
    await toggle('Compressor', 'Enable compressor').click()
    await toggle('Limiter', 'Enable limiter').click()
    await app.tools.getByRole('region', { name: 'Reverb' }).getByRole('switch', { name: 'Enable reverb' }).click()
    await app.tools.getByRole('region', { name: 'Spatial audio' }).getByRole('switch', { name: 'Enable 3D spatial audio' }).click()
    await expect.poll(() => app.gainValue(GAIN.spatialWet)).toBeCloseTo(1, 2)
    await expect.poll(() => app.gainValue(GAIN.reverbWet)).toBeGreaterThan(0.3)
    await expect.poll(() => app.gainValue(GAIN.limiterThrough)).toBeGreaterThan(0.85) // engaged (a little under unity: it trims the node's built-in make-up)
    await app.closeTools()
    await app.expectPlaying()
  })
})
