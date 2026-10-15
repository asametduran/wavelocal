import { expect, test } from '@playwright/test'
import { GAIN, PlayerPage, wav } from './helpers'

test.describe('reverb', () => {
  let app: PlayerPage
  const pageErrors: string[] = []

  test.beforeEach(async ({ page }) => {
    pageErrors.length = 0
    page.on('pageerror', (e) => pageErrors.push(e.message))
    app = new PlayerPage(page)
    await app.open()
    await app.importFiles(wav('long', 'a.wav'))
    await app.play('a') // the audio graph (and its convolver) is created on first playback
    await app.openTools()
  })

  test.afterEach(() => {
    expect(pageErrors).toEqual([])
  })

  const section = () => app.tools.getByRole('region', { name: 'Reverb' })
  const toggle = () => section().getByRole('switch', { name: 'Enable reverb' })
  const room = (name: string) => section().getByRole('radio', { name })
  const slider = (name: string) => section().getByRole('slider', { name })

  async function enable() {
    await toggle().click()
    await expect(toggle()).toHaveAttribute('aria-checked', 'true')
  }

  /** Wait for the (debounced, ducked) impulse swap to finish and report the buffer length in seconds. */
  const bufferSeconds = async () => (await app.reverbNodes())?.seconds ?? 0

  test('is dry and holds no impulse response until enabled', async () => {
    const before = await app.reverbNodes()
    expect(before).toMatchObject({ hasBuffer: false, normalize: true })
    expect(await app.gainValue(GAIN.reverbDry)).toBe(1)
    expect(await app.gainValue(GAIN.reverbWet)).toBe(0)
  })

  test('enabling synthesizes a stereo impulse response for the default room', async () => {
    await enable()
    await expect.poll(async () => (await app.reverbNodes())?.hasBuffer).toBe(true)
    const nodes = await app.reverbNodes()
    expect(nodes?.channels).toBe(2)
    expect(nodes?.seconds).toBeCloseTo(2.4, 1) // concert hall default
    // default mix is 30% wet: equal-power gains
    await expect.poll(() => app.gainValue(GAIN.reverbWet)).toBeCloseTo(Math.sin(0.3 * (Math.PI / 2)), 2)
    await expect.poll(() => app.gainValue(GAIN.reverbDry)).toBeCloseTo(Math.cos(0.3 * (Math.PI / 2)), 2)
    await expect.poll(async () => (await app.reverbNodes())?.preDelaySeconds).toBeCloseTo(0.022, 3)
  })

  test('each room loads its own decay and pre-delay, and sounds different', async () => {
    await enable()
    await expect.poll(bufferSeconds).toBeCloseTo(2.4, 1)

    await room('Cathedral').click()
    await expect(room('Cathedral')).toHaveAttribute('aria-checked', 'true')
    await expect(slider('Reverb decay')).toHaveValue('6')
    await expect(slider('Reverb pre-delay')).toHaveValue('45')
    await expect.poll(bufferSeconds).toBeCloseTo(6, 1)
    await expect.poll(async () => (await app.reverbNodes())?.preDelaySeconds).toBeCloseTo(0.045, 3)
    expect((await app.reverbNodes())?.onsetEnergy).toBe(0) // a cathedral is silent before the first reflection

    await room('Plate').click()
    await expect(slider('Reverb decay')).toHaveValue('2.2')
    await expect(slider('Reverb pre-delay')).toHaveValue('0')
    await expect.poll(bufferSeconds).toBeCloseTo(2.2, 1)
    expect((await app.reverbNodes())?.onsetEnergy).toBeGreaterThan(0.5) // a plate is dense from the first millisecond

    await room('Small room').click()
    await expect(slider('Reverb decay')).toHaveValue('0.6')
    await expect.poll(bufferSeconds).toBeCloseTo(0.6, 1)
  })

  test('the decay slider rebuilds the impulse response to the new length', async () => {
    await enable()
    await slider('Reverb decay').fill('4.5')
    await expect(section().getByText('4.5 s')).toBeVisible()
    await expect.poll(bufferSeconds).toBeCloseTo(4.5, 1)

    await slider('Reverb decay').fill('0.8')
    await expect.poll(bufferSeconds).toBeCloseTo(0.8, 1)
  })

  test('dragging the decay slider ends with the wet signal restored (no stuck mute)', async () => {
    await enable()
    for (const v of ['3', '3.5', '4', '5']) await slider('Reverb decay').fill(v)
    await expect.poll(bufferSeconds).toBeCloseTo(5, 1)
    await expect.poll(() => app.gainValue(GAIN.reverbWet)).toBeCloseTo(Math.sin(0.3 * (Math.PI / 2)), 2)
  })

  test('the pre-delay slider moves the delay line', async () => {
    await enable()
    await slider('Reverb pre-delay').fill('120')
    await expect(section().getByText('120 ms')).toBeVisible()
    await expect.poll(async () => (await app.reverbNodes())?.preDelaySeconds).toBeCloseTo(0.12, 3)
    await slider('Reverb pre-delay').fill('0')
    await expect.poll(async () => (await app.reverbNodes())?.preDelaySeconds).toBeCloseTo(0, 3)
  })

  test('the wet/dry slider crossfades with equal power', async () => {
    await enable()
    await slider('Reverb wet/dry mix').fill('0.5')
    await expect(section().getByText('50% wet')).toBeVisible()
    await expect.poll(() => app.gainValue(GAIN.reverbDry)).toBeCloseTo(Math.SQRT1_2, 2)
    await expect.poll(() => app.gainValue(GAIN.reverbWet)).toBeCloseTo(Math.SQRT1_2, 2)

    await slider('Reverb wet/dry mix').fill('1')
    await expect.poll(() => app.gainValue(GAIN.reverbWet)).toBeCloseTo(1, 2)
    await expect.poll(() => app.gainValue(GAIN.reverbDry)).toBeCloseTo(0, 2)

    await slider('Reverb wet/dry mix').fill('0')
    await expect.poll(() => app.gainValue(GAIN.reverbWet)).toBeCloseTo(0, 2)
    await expect.poll(() => app.gainValue(GAIN.reverbDry)).toBeCloseTo(1, 2)
  })

  test('switching it off returns to the untouched signal', async () => {
    await enable()
    await slider('Reverb wet/dry mix').fill('0.9')
    await toggle().click()
    await expect(toggle()).toHaveAttribute('aria-checked', 'false')
    await expect.poll(() => app.gainValue(GAIN.reverbWet)).toBeCloseTo(0, 2)
    await expect.poll(() => app.gainValue(GAIN.reverbDry)).toBeCloseTo(1, 2)
  })

  test('re-enabling reuses the cached impulse and brings the reverb back', async () => {
    await enable()
    await room('Cathedral').click()
    await expect.poll(bufferSeconds).toBeCloseTo(6, 1)
    await toggle().click()
    await app.page.waitForTimeout(400) // long enough for the convolver to be released
    await toggle().click()
    await expect.poll(() => app.gainValue(GAIN.reverbWet)).toBeGreaterThan(0.3)
    expect(await bufferSeconds()).toBeCloseTo(6, 1)
  })

  test('the controls are dimmed while off but stay usable to pre-configure the room', async () => {
    await room('Plate').click()
    await expect(room('Plate')).toHaveAttribute('aria-checked', 'true')
    await expect(slider('Reverb decay')).toBeDisabled()
    expect((await app.reverbNodes())?.hasBuffer).toBe(false) // nothing is synthesized while off
    await enable()
    await expect.poll(bufferSeconds).toBeCloseTo(2.2, 1)
  })

  test('the decay preview redraws for the selected room', async () => {
    const preview = section().getByRole('img', { name: /^Decay preview/ })
    await expect(preview).toHaveAttribute('aria-label', 'Decay preview: Concert hall, 2.4 seconds')
    const hall = await preview.locator('polygon').getAttribute('points')
    await room('Cathedral').click()
    await expect(preview).toHaveAttribute('aria-label', 'Decay preview: Cathedral, 6.0 seconds')
    expect(await preview.locator('polygon').getAttribute('points')).not.toBe(hall)
  })

  test('rapid toggling and room changes never throw', async () => {
    for (let i = 0; i < 6; i++) {
      await toggle().click()
      await room(i % 2 ? 'Plate' : 'Cathedral').click()
    }
    await enable().catch(() => undefined)
    await app.page.waitForTimeout(600)
    // afterEach asserts that no page error was raised
  })

  test('settings persist across a reload and are applied once the graph exists', async () => {
    await enable()
    await room('Cathedral').click()
    await slider('Reverb decay').fill('3.5')
    await slider('Reverb pre-delay').fill('80')
    await slider('Reverb wet/dry mix').fill('0.6')
    await app.closeTools()

    await app.reload()
    await app.play('a')
    await app.openTools()
    await expect(toggle()).toHaveAttribute('aria-checked', 'true')
    await expect(room('Cathedral')).toHaveAttribute('aria-checked', 'true')
    await expect(slider('Reverb decay')).toHaveValue('3.5')
    await expect(slider('Reverb pre-delay')).toHaveValue('80')
    await expect(slider('Reverb wet/dry mix')).toHaveValue('0.6')
    await expect.poll(bufferSeconds).toBeCloseTo(3.5, 1)
    await expect.poll(async () => (await app.reverbNodes())?.preDelaySeconds).toBeCloseTo(0.08, 3)
    await expect.poll(() => app.gainValue(GAIN.reverbWet)).toBeCloseTo(Math.sin(0.6 * (Math.PI / 2)), 2)
  })

  test('works alongside spatial audio and the equalizer', async () => {
    await enable()
    await app.tools.getByRole('switch', { name: 'Enable 3D spatial audio' }).click()
    await app.tools.getByRole('button', { name: 'Bass Boost' }).click()
    await expect.poll(() => app.filterGain(0)).toBeCloseTo(7, 0)
    await expect.poll(() => app.gainValue(GAIN.spatialWet)).toBeCloseTo(1, 2)
    await expect.poll(() => app.gainValue(GAIN.reverbWet)).toBeGreaterThan(0.3)
    await app.closeTools()
    await app.expectPlaying()
  })
})
