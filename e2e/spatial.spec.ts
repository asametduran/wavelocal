import { expect, test } from '@playwright/test'
import { GAIN, PlayerPage, wav } from './helpers'

const R_DEFAULT = 2.35 // 1 m + 0.15 * 9 m: the default distance setting

/** Azimuth of a world position in degrees: 0 = front (-z), 90 = right (+x). */
const azimuth = (x: number, z: number) => ((Math.atan2(x, -z) * 180) / Math.PI + 360) % 360
/** Smallest signed difference between two angles in degrees. */
const angleDelta = (from: number, to: number) => ((((to - from) % 360) + 540) % 360) - 180

test.describe('3D spatial audio', () => {
  let app: PlayerPage

  test.beforeEach(async ({ page }) => {
    app = new PlayerPage(page)
    await app.open()
    await app.importFiles(wav('long', 'a.wav'))
    await app.play('a') // the audio graph (and its panner) is created on first playback
    await app.openTools()
  })

  const section = () => app.tools.getByRole('region', { name: 'Spatial audio' })
  const toggle = () => section().getByRole('switch', { name: 'Enable 3D spatial audio' })
  const rotate = () => section().getByRole('switch', { name: 'Auto-rotate (8D)' })
  const pad = () => section().getByRole('slider', { name: 'Sound position' })
  const slider = (name: string) => section().getByRole('slider', { name })

  async function enable() {
    await toggle().click()
    await expect(toggle()).toHaveAttribute('aria-checked', 'true')
  }

  async function expectPosition(x: number, z: number, tolerance = 0.08) {
    await expect.poll(async () => (await app.panner())?.x ?? NaN, { timeout: 4_000 }).toBeCloseTo(x, 0)
    await expect
      .poll(async () => {
        const p = await app.panner()
        return p ? Math.hypot(p.x - x, p.z - z) : Infinity
      })
      .toBeLessThan(tolerance + 0.01)
  }

  test('uses an HRTF panner and stays fully dry until enabled', async () => {
    expect((await app.panner())?.model).toBe('HRTF')
    expect(await app.gainValue(GAIN.spatialDry)).toBe(1)
    expect(await app.gainValue(GAIN.spatialWet)).toBe(0)

    await enable()
    await expect.poll(() => app.gainValue(GAIN.spatialWet)).toBeCloseTo(1, 2)
    await expect.poll(() => app.gainValue(GAIN.spatialDry)).toBeCloseTo(0, 2)
  })

  test('the controls are inert until the effect is switched on', async () => {
    await expect(pad()).toHaveAttribute('aria-disabled', 'true')
    await expect(slider('Distance')).toBeDisabled()
    await expect(rotate()).toBeDisabled()
    await pad().click({ position: { x: 150, y: 88 }, force: true })
    expect((await app.panner())?.x).toBe(0)
  })

  test('quick positions move the source around the listener', async () => {
    await enable()
    const quick = section().getByRole('group', { name: 'Quick positions' })

    await quick.getByRole('button', { name: 'Right' }).click()
    await expectPosition(R_DEFAULT, 0)
    await quick.getByRole('button', { name: 'Behind' }).click()
    await expectPosition(0, R_DEFAULT)
    await quick.getByRole('button', { name: 'Left' }).click()
    await expectPosition(-R_DEFAULT, 0)
    await quick.getByRole('button', { name: 'Front' }).click()
    await expectPosition(0, -R_DEFAULT)
    await expect(quick.getByRole('button', { name: 'Front' })).toHaveAttribute('aria-pressed', 'true')
  })

  test('the distance slider scales how far away the source is', async () => {
    await enable()
    await slider('Distance').fill('1')
    await expect(section().getByText('10.0 m')).toBeVisible()
    await expectPosition(0, -10)

    await slider('Distance').fill('0')
    await expect(section().getByText('1.0 m')).toBeVisible()
    await expectPosition(0, -1)
  })

  test('the wet/dry slider crossfades with equal power', async () => {
    await enable()
    await slider('Wet / dry mix').fill('0.5')
    await expect(section().getByText('50% wet')).toBeVisible()
    await expect.poll(() => app.gainValue(GAIN.spatialDry)).toBeCloseTo(Math.SQRT1_2, 2)
    await expect.poll(() => app.gainValue(GAIN.spatialWet)).toBeCloseTo(Math.SQRT1_2, 2)

    await slider('Wet / dry mix').fill('0')
    await expect.poll(() => app.gainValue(GAIN.spatialDry)).toBeCloseTo(1, 2)
    await expect.poll(() => app.gainValue(GAIN.spatialWet)).toBeCloseTo(0, 2)
  })

  test('switching it off returns to the untouched stereo signal', async () => {
    await enable()
    await slider('Wet / dry mix').fill('0.8')
    await toggle().click()
    await expect(toggle()).toHaveAttribute('aria-checked', 'false')
    await expect.poll(() => app.gainValue(GAIN.spatialDry)).toBeCloseTo(1, 2)
    await expect.poll(() => app.gainValue(GAIN.spatialWet)).toBeCloseTo(0, 2)
  })

  test('the pad is keyboard accessible and does not also seek the track', async () => {
    await app.key(' ') // pause (the modal covers the button) so the clock is stable
    await app.expectPaused()
    await enable()
    await pad().focus()
    await expect(pad()).toHaveAttribute('aria-valuetext', 'Front, 100% out')

    await pad().press('End')
    await expect(pad()).toHaveAttribute('aria-valuetext', 'Behind, 100% out')
    await expectPosition(0, R_DEFAULT)

    await pad().press('Home')
    await pad().press('ArrowRight')
    await pad().press('ArrowRight')
    await pad().press('Shift+ArrowRight')
    await expect.poll(async () => (await app.panner())?.x ?? 0).toBeGreaterThan(0.4)

    await pad().press('PageUp')
    await expect(pad()).toHaveAttribute('aria-valuetext', 'Right, 100% out')
    expect(await app.position()).toBeLessThan(2) // arrow keys on the pad must not have seeked the track
  })

  test('pointing at the pad places the source there', async () => {
    await enable()
    const box = await pad().boundingBox()
    if (!box) throw new Error('pad has no box')
    await pad().click({ position: { x: box.width * 0.92, y: box.height / 2 } }) // far right edge
    await expect.poll(async () => (await app.panner())?.x ?? 0).toBeGreaterThan(2)
    expect(Math.abs((await app.panner())?.z ?? 99)).toBeLessThan(0.4)

    await pad().click({ position: { x: box.width / 2, y: box.height * 0.5 + box.height * 0.2 } }) // slightly behind the head
    await expect.poll(async () => (await app.panner())?.z ?? 0).toBeGreaterThan(0.3)
  })

  test.describe('8D auto-rotate', () => {
    async function startRotating() {
      await enable()
      await section().getByRole('group', { name: 'Quick positions' }).getByRole('button', { name: 'Front' }).click()
      await rotate().click()
      await expect(rotate()).toHaveAttribute('aria-checked', 'true')
      await expect(slider('Orbit time')).toBeEnabled()
    }

    const sample = async () => {
      const p = await app.panner()
      if (!p) throw new Error('no panner')
      return { ...p, az: azimuth(p.x, p.z), radius: Math.hypot(p.x, p.z) }
    }

    test('circles the listener at a constant radius and the configured speed', async () => {
      await startRotating() // default orbit time: 8 s
      await app.page.waitForTimeout(400)
      const a = await sample()
      await app.page.waitForTimeout(900)
      const b = await sample()
      await app.page.waitForTimeout(900)
      const c = await sample()

      for (const s of [a, b, c]) expect(s.radius).toBeCloseTo(R_DEFAULT, 1)
      const degreesPerSecond = 360 / 8
      expect(angleDelta(a.az, b.az)).toBeCloseTo(degreesPerSecond * (b.time - a.time), -1)
      expect(angleDelta(b.az, c.az)).toBeCloseTo(degreesPerSecond * (c.time - b.time), -1)
      expect(angleDelta(a.az, b.az)).toBeGreaterThan(20) // clockwise, i.e. towards the right ear first
    })

    test('the orbit time slider changes the speed without a jump', async () => {
      await startRotating()
      await app.page.waitForTimeout(500)
      const before = await sample()
      await slider('Orbit time').fill('4')
      await expect(section().getByText('4.0 s')).toBeVisible()
      await app.page.waitForTimeout(150)
      const after = await sample()
      const jump = Math.abs(angleDelta(before.az, after.az)) - (360 / 8) * (after.time - before.time)
      expect(jump).toBeLessThan(40) // continuous: only the elapsed time (plus a little fast motion) separates the samples

      await app.page.waitForTimeout(300)
      const start = await sample()
      await app.page.waitForTimeout(1000)
      const end = await sample()
      expect(angleDelta(start.az, end.az)).toBeCloseTo((360 / 4) * (end.time - start.time), -1)
    })

    test('the distance slider resizes the orbit', async () => {
      await startRotating()
      await slider('Distance').fill('1')
      await app.page.waitForTimeout(400)
      expect((await sample()).radius).toBeCloseTo(10, 0)
    })

    test('the pad dot follows the orbiting source', async () => {
      await startRotating()
      const dot = pad().locator('circle.fill-accent')
      const first = await dot.getAttribute('cx')
      await app.page.waitForTimeout(1200)
      const second = await dot.getAttribute('cx')
      expect(Number(second)).not.toBeCloseTo(Number(first), 0)
    })

    test('switching rotation off parks the source at the pad position', async () => {
      await startRotating()
      await app.page.waitForTimeout(600)
      await rotate().click()
      await expect(rotate()).toHaveAttribute('aria-checked', 'false')
      await expectPosition(0, -R_DEFAULT, 0.02) // fully settled on the parked position
      const a = await sample()
      await app.page.waitForTimeout(600)
      const b = await sample()
      expect(Math.hypot(a.x - b.x, a.z - b.z)).toBeLessThan(0.05)
    })

    test('disabling the effect stops the movement', async () => {
      await startRotating()
      await toggle().click()
      await app.page.waitForTimeout(500) // the wet path fades, then the panner is released
      const a = await sample()
      await app.page.waitForTimeout(700)
      const b = await sample()
      expect(Math.hypot(a.x - b.x, a.z - b.z)).toBeLessThan(0.05)
    })
  })

  test('settings persist across a reload and the orbit resumes', async () => {
    await toggle().click()
    await slider('Distance').fill('0.5')
    await slider('Wet / dry mix').fill('0.6')
    await rotate().click()
    await slider('Orbit time').fill('6')
    await app.closeTools()

    await app.reload()
    await app.play('a')
    await app.openTools()
    await expect(toggle()).toHaveAttribute('aria-checked', 'true')
    await expect(rotate()).toHaveAttribute('aria-checked', 'true')
    await expect(slider('Distance')).toHaveValue('0.5')
    await expect(slider('Wet / dry mix')).toHaveValue('0.6')
    await expect(slider('Orbit time')).toHaveValue('6')

    await app.page.waitForTimeout(300)
    const a = await app.panner()
    await app.page.waitForTimeout(700)
    const b = await app.panner()
    expect(Math.hypot((a?.x ?? 0) - (b?.x ?? 0), (a?.z ?? 0) - (b?.z ?? 0))).toBeGreaterThan(0.3)
  })

  test('works together with the equalizer and normalization', async () => {
    await enable()
    await app.tools.getByRole('button', { name: 'Bass Boost' }).click()
    await expect.poll(() => app.filterGain(0)).toBeCloseTo(7, 0)
    await expect.poll(() => app.gainValue(GAIN.spatialWet)).toBeCloseTo(1, 2)
    await app.closeTools()
    await app.expectPlaying()
  })
})
