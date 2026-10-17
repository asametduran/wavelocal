import { expect, test } from '@playwright/test'
import { PlayerPage, wav } from './helpers'

test.describe('per-track equalizer memory', () => {
  let app: PlayerPage
  const pageErrors: string[] = []

  test.beforeEach(async ({ page }) => {
    pageErrors.length = 0
    page.on('pageerror', (e) => pageErrors.push(e.message))
    app = new PlayerPage(page)
    await app.open()
    await app.importFiles(wav('tone-440', 'a.wav'), wav('tone-880', 'b.wav'))
    await app.play('a') // build the audio graph on the first track
    await app.openTools()
  })

  test.afterEach(() => {
    expect(pageErrors).toEqual([])
  })

  const section = () => app.tools.getByRole('region', { name: 'Equalizer', exact: true })
  const remember = () => section().getByRole('switch', { name: 'Remember EQ for this track' })
  const preset = (name: string) => section().getByRole('button', { name, exact: true })
  /** Gain of the n-th live equalizer filter (band 0 = 31 Hz low shelf, band 9 = 16 kHz high shelf). */
  const liveGain = async (band: number) => (await app.liveEqFilters())[band]?.gain ?? Number.NaN
  const goTo = async (title: string, key: 'n' | 'p') => {
    await app.key(key)
    await expect(app.nowPlayingTitle).toHaveText(title)
  }

  test('is off by default, so edits change the one shared equalizer', async () => {
    await expect(remember()).toHaveAttribute('aria-checked', 'false')
    await preset('Bass Boost').click()
    await expect.poll(() => liveGain(0)).toBeCloseTo(7, 0)
    await goTo('b', 'n')
    await expect.poll(() => liveGain(0)).toBeCloseTo(7, 0) // b shares it
    await expect(remember()).toHaveAttribute('aria-checked', 'false')
  })

  test('a track can have its own curve while the others keep the shared one', async () => {
    await remember().click()
    await expect(remember()).toHaveAttribute('aria-checked', 'true')
    await expect(section().getByText(/Using its own curve for "a"/)).toBeVisible()
    await preset('Treble Boost').click()
    await expect.poll(() => liveGain(9)).toBeCloseTo(7, 0)
    await expect.poll(() => liveGain(0)).toBeCloseTo(0, 0)

    await goTo('b', 'n') // no memory: back to the shared (flat) EQ
    await expect(remember()).toHaveAttribute('aria-checked', 'false')
    await expect.poll(() => liveGain(9)).toBeCloseTo(0, 0)

    await goTo('a', 'p') // and a gets its own curve back
    await expect(remember()).toHaveAttribute('aria-checked', 'true')
    await expect.poll(() => liveGain(9)).toBeCloseTo(7, 0)
  })

  test('the track\'s own curve starts as a copy of the curve in effect', async () => {
    await preset('Bass Boost').click()
    await remember().click()
    await expect(section().getByRole('slider', { name: '31 Hz gain' })).toHaveValue('7') // started from the shared curve
    await preset('Rock').click()
    await expect.poll(() => liveGain(0)).toBeCloseTo(5, 0)

    await goTo('b', 'n')
    await expect(section().getByRole('slider', { name: '31 Hz gain' })).toHaveValue('7') // shared EQ untouched by a's edit
    await expect.poll(() => liveGain(0)).toBeCloseTo(7, 0)
  })

  test('turning it off hands the track back to the shared equalizer', async () => {
    await preset('Bass Boost').click() // shared
    await remember().click()
    await preset('Treble Boost').click() // a's own
    await expect.poll(() => liveGain(9)).toBeCloseTo(7, 0)

    await remember().click()
    await expect(remember()).toHaveAttribute('aria-checked', 'false')
    await expect.poll(() => liveGain(0)).toBeCloseTo(7, 0)
    await expect.poll(() => liveGain(9)).toBeCloseTo(0, 0)
  })

  test('works in the parametric view with a different number of bands per track', async () => {
    await remember().click()
    await section().getByRole('tab', { name: 'Parametric' }).click()
    await section().getByRole('button', { name: '+ Add band' }).click()
    await expect.poll(async () => (await app.liveEqFilters()).length).toBe(11)

    await goTo('b', 'n')
    await expect.poll(async () => (await app.liveEqFilters()).length, { timeout: 4_000 }).toBe(10)
    await goTo('a', 'p')
    await expect.poll(async () => (await app.liveEqFilters()).length, { timeout: 4_000 }).toBe(11)
    await app.expectPlaying()
  })

  test('survives a reload', async () => {
    await remember().click()
    await preset('Treble Boost').click()
    await app.page.waitForTimeout(400)
    await app.closeTools()

    await app.reload()
    await app.play('a')
    await app.openTools()
    await expect(remember()).toHaveAttribute('aria-checked', 'true')
    await expect.poll(() => liveGain(9)).toBeCloseTo(7, 0)
    await goTo('b', 'n')
    await expect(remember()).toHaveAttribute('aria-checked', 'false')
    await expect.poll(() => liveGain(9)).toBeCloseTo(0, 0)
  })

  test('removing a track forgets its curve', async () => {
    await remember().click()
    await preset('Treble Boost').click()
    await app.page.waitForTimeout(300)
    await app.closeTools()

    await app.row('a').hover()
    await app.row('a').getByRole('button', { name: 'Remove a' }).click()
    await expect(app.rows).toHaveCount(1)
    await app.importFiles(wav('tone-440', 'a.wav')) // the same audio comes back as a brand-new track
    await app.play('a')
    await app.openTools()
    await expect(remember()).toHaveAttribute('aria-checked', 'false')
    await expect.poll(() => liveGain(9)).toBeCloseTo(0, 0)
  })

  test('clearing the library forgets every curve', async () => {
    await remember().click()
    await preset('Treble Boost').click()
    await app.page.waitForTimeout(300)
    await app.closeTools()
    await app.sidebar.getByRole('button', { name: 'Clear library' }).click()

    await app.answerDialog(true)
    await expect(app.rows).toHaveCount(0)
    await app.importFiles(wav('tone-440', 'a.wav'))
    await app.play('a')
    await app.openTools()
    await expect(remember()).toHaveAttribute('aria-checked', 'false')
  })

  test('the switch only appears when there is a track', async ({ page }) => {
    await app.closeTools()
    await app.sidebar.getByRole('button', { name: 'Clear library' }).click()
    await app.answerDialog(true)
    await expect(app.rows).toHaveCount(0)
    await app.openTools()
    await expect(section()).toBeVisible()
    await expect(remember()).toHaveCount(0)
    await expect(page.getByText('Remember EQ for this track')).toHaveCount(0)
  })
})
