import { expect, test } from '@playwright/test'
import { GAIN, PlayerPage, wav } from './helpers'

test.describe('sound tools', () => {
  let app: PlayerPage

  test.beforeEach(async ({ page }) => {
    app = new PlayerPage(page)
    await app.open()
  })

  test.describe('equalizer', () => {
    test('a preset moves the band sliders and the real filter gains', async () => {
      await app.importFiles(wav('tone-440', 'a.wav'))
      await app.play('a') // the audio graph is built on first playback
      await app.openTools()

      await app.tools.getByRole('button', { name: 'Bass Boost' }).click()
      await expect(app.tools.getByRole('button', { name: 'Bass Boost' })).toHaveAttribute('aria-pressed', 'true')
      await expect(app.tools.getByRole('slider', { name: '31 Hz gain' })).toHaveValue('7')
      await expect(app.tools.getByRole('slider', { name: '16k Hz gain' })).toHaveValue('0')
      await expect.poll(() => app.filterGain(0)).toBeCloseTo(7, 0)
      await expect.poll(() => app.filterGain(9)).toBeCloseTo(0, 0)

      await app.tools.getByRole('button', { name: 'Treble Boost' }).click()
      await expect.poll(() => app.filterGain(0)).toBeCloseTo(0, 0)
      await expect.poll(() => app.filterGain(9)).toBeCloseTo(7, 0)
    })

    test('an individual band can be set, and double-click resets it', async () => {
      await app.importFiles(wav('tone-440', 'a.wav'))
      await app.play('a')
      await app.openTools()

      const band = app.tools.getByRole('slider', { name: '1k Hz gain' })
      await band.fill('-5')
      await expect(band).toHaveValue('-5')
      await expect.poll(() => app.filterGain(5)).toBeCloseTo(-5, 0)
      await expect(app.tools.getByRole('button', { name: 'Flat' })).toHaveAttribute('aria-pressed', 'false')

      await band.dblclick()
      await expect(band).toHaveValue('0')
      await expect.poll(() => app.filterGain(5)).toBeCloseTo(0, 0)
      await expect(app.tools.getByRole('button', { name: 'Flat' })).toHaveAttribute('aria-pressed', 'true')
    })

    test('switching the equalizer off bypasses the filters but keeps the settings', async () => {
      await app.importFiles(wav('tone-440', 'a.wav'))
      await app.play('a')
      await app.openTools()
      await app.tools.getByRole('button', { name: 'Rock', exact: true }).click()
      await expect.poll(() => app.filterGain(0)).toBeCloseTo(5, 0)

      await expect.poll(() => app.gainValue(GAIN.eqThrough)).toBe(1)
      await expect.poll(() => app.gainValue(GAIN.eqBypass)).toBe(0)

      const toggle = app.tools.getByRole('switch', { name: 'Enable equalizer' })
      await toggle.click()
      await expect(toggle).toHaveAttribute('aria-checked', 'false')
      await expect.poll(() => app.gainValue(GAIN.eqBypass)).toBeCloseTo(1, 2) // the dry path takes over...
      await expect.poll(() => app.gainValue(GAIN.eqThrough)).toBeCloseTo(0, 2)
      await expect(app.tools.getByRole('slider', { name: '31 Hz gain' })).toHaveValue('5') // ...and the settings are kept

      await toggle.click()
      await expect.poll(() => app.gainValue(GAIN.eqThrough)).toBeCloseTo(1, 2)
      await expect.poll(() => app.gainValue(GAIN.eqBypass)).toBeCloseTo(0, 2)
      await expect.poll(() => app.filterGain(0)).toBeCloseTo(5, 0)
    })

    test('a preset chosen before the first playback is applied once the graph exists', async () => {
      await app.importFiles(wav('tone-440', 'a.wav'))
      await app.openTools()
      await app.tools.getByRole('button', { name: 'Vocal' }).click()
      await app.closeTools()
      await app.play('a')
      await expect.poll(() => app.filterGain(0)).toBeCloseTo(-3, 0)
      await expect.poll(() => app.filterGain(5)).toBeCloseTo(4, 0)
    })
  })

  test.describe('speed and pitch', () => {
    test('speed changes the playback rate of the media elements', async () => {
      await app.importFiles(wav('long', 'a.wav'))
      await app.play('a')
      await app.openTools()

      const speed = app.tools.getByRole('slider', { name: 'Playback speed' })
      await speed.fill('1.5')
      await expect(app.tools.getByText('1.50x')).toBeVisible()
      await expect.poll(async () => (await app.mediaSettings()).map((m) => m.rate)).toContain(1.5)

      await app.tools.getByRole('region', { name: 'Speed and pitch' }).getByRole('button', { name: 'Reset' }).click()
      await expect(app.tools.getByText('1.00x')).toBeVisible()
      await expect.poll(async () => (await app.mediaSettings()).every((m) => m.rate === 1)).toBe(true)
    })

    test('playback actually runs faster at 2x', async () => {
      await app.importFiles(wav('long', 'a.wav'))
      await app.openTools()
      await app.tools.getByRole('slider', { name: 'Playback speed' }).fill('2')
      await app.closeTools()
      await app.play('a')

      // measure the media clock against the wall clock instead of trusting the whole-second display
      const sample = () =>
        app.page.evaluate(() => {
          const playing = [...window.__probe.media].find((m) => !m.paused)
          return { media: playing?.currentTime ?? 0, wall: performance.now() }
        })
      const start = await sample()
      await app.page.waitForTimeout(2500)
      const end = await sample()
      const rate = (end.media - start.media) / ((end.wall - start.wall) / 1000)
      // ~2.0 on an idle machine; the media clock can lag when the CPU is saturated, but 1x would never exceed 1.0
      expect(rate).toBeGreaterThan(1.3)
      expect(rate).toBeLessThan(2.6)
    })

    test('"keep original pitch" toggles preservesPitch', async () => {
      await app.importFiles(wav('long', 'a.wav'))
      await app.play('a')
      await app.openTools()
      const toggle = app.tools.getByRole('switch', { name: 'Keep original pitch' })
      await expect(toggle).toHaveAttribute('aria-checked', 'true')
      await expect.poll(async () => (await app.mediaSettings()).every((m) => m.preservesPitch)).toBe(true)

      await toggle.click()
      await expect(toggle).toHaveAttribute('aria-checked', 'false')
      await expect.poll(async () => (await app.mediaSettings()).every((m) => !m.preservesPitch)).toBe(true)
    })
  })

  test.describe('volume normalization', () => {
    test('measures loudness on first play and applies the gain to the audio graph', async () => {
      await app.importFiles(wav('quiet', 'a-quiet.wav'), wav('loud', 'b-loud.wav'))
      await app.openTools()
      const toggle = app.tools.getByRole('switch', { name: 'Normalize volume between tracks' })
      await toggle.click()
      await expect(toggle).toHaveAttribute('aria-checked', 'true')
      await app.closeTools()

      await app.play('a-quiet') // -30 dBFS RMS => boosted, clamped to +12 dB
      await app.openTools()
      await expect(app.tools.getByText(/this track: \+12 dB/)).toBeVisible()
      await expect.poll(() => app.gainValue(GAIN.deck0Norm)).toBeCloseTo(10 ** (12 / 20), 1)
      await app.closeTools()

      await app.play('b-loud') // -8 dBFS RMS => cut by 10 dB
      await app.openTools()
      await expect(app.tools.getByText(/this track: -10 dB/)).toBeVisible()
      await expect.poll(() => app.gainValue(GAIN.deck0Norm)).toBeCloseTo(10 ** (-10 / 20), 2)
    })

    test('is off by default and leaves the gain at unity', async () => {
      await app.importFiles(wav('quiet', 'a.wav'))
      await app.play('a')
      await expect.poll(() => app.gainValue(GAIN.deck0Norm)).toBe(1)
    })

    test('turning it off restores unity gain', async () => {
      await app.importFiles(wav('quiet', 'a.wav'))
      await app.openTools()
      const toggle = app.tools.getByRole('switch', { name: 'Normalize volume between tracks' })
      await toggle.click()
      await app.closeTools()
      await app.play('a')
      await expect.poll(() => app.gainValue(GAIN.deck0Norm)).toBeGreaterThan(2)

      await app.openTools()
      await toggle.click()
      await expect.poll(() => app.gainValue(GAIN.deck0Norm)).toBe(1)
    })
  })

  test.describe('accent color', () => {
    test('a preset sets the CSS variable and persists', async () => {
      await app.openTools()
      await app.tools.getByRole('button', { name: 'Teal' }).click()
      await expect(app.page.locator('html')).toHaveCSS('--accent-hex', '#2dd4bf')
      await app.reload()
      await expect(app.page.locator('html')).toHaveCSS('--accent-hex', '#2dd4bf')
    })

    test('reset returns to the default accent', async () => {
      await app.openTools()
      await app.tools.getByRole('button', { name: 'Red' }).click()
      await app.tools.getByRole('region', { name: 'Accent color' }).getByRole('button', { name: 'Reset' }).click()
      await expect(app.page.locator('html')).toHaveCSS('--accent-hex', '#a78bfa')
    })
  })

  test.describe('sleep timer', () => {
    test('counts down, can be cancelled, and stops playback when it fires', async ({ page }) => {
      await app.importFiles(wav('long', 'a.wav'))
      await app.play('a')
      await page.clock.install() // fake timers: the 15-minute timer fires on demand

      await app.openTools()
      await app.tools.getByRole('button', { name: '30 min' }).click()
      await expect(app.tools.getByRole('status')).toContainText('Stopping in 30:00')
      await app.tools.getByRole('button', { name: 'Off', exact: true }).click()
      await expect(app.tools.getByRole('status')).toHaveCount(0)

      await app.tools.getByRole('button', { name: '15 min' }).click()
      await expect(app.tools.getByRole('status')).toContainText('Stopping in 15:00')
      await app.closeTools()
      await app.expectPlaying()

      await page.clock.fastForward('16:00')
      await app.expectPaused()
      await expect(page.getByRole('status').filter({ hasText: 'Sleep timer: playback stopped' })).toBeVisible()
      await expect(app.footer.getByRole('button', { name: /^Equalizer, sleep timer/ })).not.toContainText(':')
    })
  })
})
