import { expect, test } from '@playwright/test'
import type { Locator } from '@playwright/test'
import { GAIN, PlayerPage, wav } from './helpers'
import { bandResponseDb, graphicBands } from '../src/lib/eq'

const BASS_BOOST = [7, 6, 5, 3, 1, 0, 0, 0, 0, 0]

/** Log-spaced probe frequencies across the audible range. */
const PROBES = Array.from({ length: 40 }, (_, i) => Math.round(30 * (18000 / 30) ** (i / 39)))

test.describe('equalizer: parametric view', () => {
  let app: PlayerPage
  const pageErrors: string[] = []

  test.beforeEach(async ({ page }) => {
    pageErrors.length = 0
    page.on('pageerror', (e) => pageErrors.push(e.message))
    app = new PlayerPage(page)
    await app.open()
    await app.importFiles(wav('long', 'a.wav'))
    await app.play('a') // the audio graph (and its filter chain) is built on first playback
    await app.openTools()
  })

  test.afterEach(() => {
    expect(pageErrors).toEqual([])
  })

  const section = () => app.tools.getByRole('region', { name: 'Equalizer' })
  const viewTab = (name: 'Graphic' | 'Parametric') => section().getByRole('tab', { name })
  const curve = () => section().getByRole('group', { name: 'Equalizer response curve' })
  const handle = (n: number) => curve().getByRole('slider', { name: `Band ${n}`, exact: true })
  const chips = () => section().getByRole('group', { name: 'Bands' }).getByRole('button')
  const editor = (n: number) => section().getByRole('group', { name: `Band ${n} settings` })
  const slider = (name: string) => section().getByRole('slider', { name, exact: true })

  async function parametric() {
    await viewTab('Parametric').click()
    await expect(viewTab('Parametric')).toHaveAttribute('aria-selected', 'true')
  }

  /** Wait until the browser's own measured response equals the model's, for the given bands. */
  async function expectChainMatches(bands: ReturnType<typeof graphicBands>) {
    const rate = await app.sampleRate()
    await expect
      .poll(
        async () => {
          const measured = await app.chainResponseDb(PROBES)
          return Math.max(...measured.map((m, i) => Math.abs(m - bands.reduce((sum, b) => sum + bandResponseDb(b, PROBES[i] ?? 1000, rate), 0))))
        },
        { timeout: 6_000 },
      )
      .toBeLessThan(0.1)
  }

  test('the graphic and parametric views edit the same bands', async () => {
    await section().getByRole('slider', { name: '1k Hz gain' }).fill('6')
    await parametric()
    await expect(chips()).toHaveCount(11) // ten bands + "Add band"
    await expect(handle(6)).toHaveAttribute('aria-valuetext', 'Peak, 1.0 kHz, +6.0 dB, Q 1.1')
    await expect(handle(1)).toHaveAttribute('aria-valuetext', 'Low shelf, 31 Hz, 0.0 dB')
    await expect(handle(10)).toHaveAttribute('aria-valuetext', 'High shelf, 16 kHz, 0.0 dB')
  })

  test('the chosen view is remembered', async () => {
    await parametric()
    await app.reload()
    await app.play('a')
    await app.openTools()
    await expect(viewTab('Parametric')).toHaveAttribute('aria-selected', 'true')
    await expect(curve()).toBeVisible()
  })

  test('the on-screen curve model matches the response the browser measures on the live filters', async () => {
    await parametric()
    await section().getByRole('button', { name: 'Bass Boost' }).click()
    await expectChainMatches(graphicBands(BASS_BOOST))
    expect(await app.liveEqFilters()).toHaveLength(10)

    await section().getByRole('button', { name: 'Electronic' }).click()
    await expectChainMatches(graphicBands([5, 4, 1, 0, -2, 2, 1, 2, 5, 5]))
  })

  test('sliders edit the selected band and the real filter follows', async () => {
    await parametric()
    await chips().nth(5).click() // band 6, 1 kHz
    await expect(editor(6)).toBeVisible()
    await slider('Band gain').fill('7.5')
    await slider('Band frequency').fill('0.5') // exactly the geometric middle of 20 Hz - 20 kHz
    await expect(handle(6)).toHaveAttribute('aria-valuetext', /^Peak, 632 Hz, \+7\.5 dB/)

    await expect.poll(async () => (await app.liveEqFilters())[5]?.gain).toBeCloseTo(7.5, 1)
    await expect.poll(async () => (await app.liveEqFilters())[5]?.frequency).toBeCloseTo(632, -1)
    const bands = graphicBands().map((b, i) => (i === 5 ? { ...b, frequency: 632, gain: 7.5 } : b))
    await expectChainMatches(bands)
  })

  test('the Q slider narrows and widens a peak', async () => {
    await parametric()
    await chips().nth(5).click()
    await slider('Band gain').fill('10')
    await slider('Band Q').fill('0.9')
    await expect.poll(async () => (await app.liveEqFilters())[5]?.q).toBeGreaterThan(8)
    await slider('Band Q').fill('0.1')
    await expect.poll(async () => (await app.liveEqFilters())[5]?.q).toBeLessThan(0.3)
  })

  test('band types: shelves hide Q, notches hide gain and cut deeply', async () => {
    await parametric()
    await section().getByRole('button', { name: 'Reset', exact: true }).click()
    await chips().nth(5).click()

    await section().getByRole('radio', { name: 'Notch' }).click()
    await expect(section().getByRole('radio', { name: 'Notch' })).toHaveAttribute('aria-checked', 'true')
    await expect(slider('Band gain')).toHaveCount(0)
    await expect(slider('Band Q')).toBeVisible()
    await expect.poll(async () => (await app.liveEqFilters())[5]?.type).toBe('notch')
    await slider('Band Q').fill('0.7')
    await expect.poll(async () => (await app.chainResponseDb([1000]))[0]).toBeLessThan(-30)

    await section().getByRole('radio', { name: 'High shelf' }).click()
    await expect(slider('Band Q')).toHaveCount(0)
    await expect(slider('Band gain')).toBeVisible()
    await slider('Band gain').fill('9')
    await expect.poll(async () => (await app.liveEqFilters())[5]?.type).toBe('highshelf')
    await expect.poll(async () => (await app.chainResponseDb([16000]))[0]).toBeGreaterThan(8)

    await section().getByRole('radio', { name: 'Low shelf' }).click()
    await expect.poll(async () => (await app.liveEqFilters())[5]?.type).toBe('lowshelf')
    await expect.poll(async () => (await app.chainResponseDb([40]))[0]).toBeGreaterThan(8)
  })

  test('adding a band extends the live chain without interrupting playback', async () => {
    await parametric()
    await section().getByRole('button', { name: '+ Add band' }).click()
    await expect(chips()).toHaveCount(12) // 11 bands + "Add band"
    await expect(handle(11)).toHaveAttribute('aria-valuetext', 'Peak, 1.0 kHz, 0.0 dB, Q 1.0')
    await expect.poll(async () => (await app.liveEqFilters()).length).toBe(11)
    await expect(editor(11)).toBeVisible() // the new band is selected
    await app.expectPlaying()
    expect(await app.gainValue(GAIN.eqThrough)).toBe(1)

    await slider('Band gain').fill('-6')
    await slider('Band frequency').fill('0.5')
    const bands = [...graphicBands(), { id: 'b1', type: 'peaking' as const, frequency: 632, q: 1, gain: -6 }]
    await expectChainMatches(bands)
  })

  test('the number of bands is capped', async () => {
    await parametric()
    const add = section().getByRole('button', { name: '+ Add band' })
    await add.click()
    await add.click()
    await expect(chips()).toHaveCount(13) // 12 bands + "Add band"
    await expect(add).toBeDisabled()
    await expect.poll(async () => (await app.liveEqFilters()).length).toBe(12)
  })

  test('removing a band fades it out of the chain', async () => {
    await parametric()
    await section().getByRole('button', { name: 'Bass Boost' }).click()
    await chips().first().click() // the 31 Hz low shelf, +7 dB
    await section().getByRole('button', { name: 'Remove band' }).click()
    await expect(chips()).toHaveCount(10) // 9 bands + "Add band"
    await expect.poll(async () => (await app.liveEqFilters()).length, { timeout: 4_000 }).toBe(9)
    await expectChainMatches(graphicBands(BASS_BOOST).slice(1))
    await app.expectPlaying()
  })

  test('removing every band leaves a flat equalizer', async () => {
    await parametric()
    for (let i = 0; i < 10; i++) {
      await section().getByRole('button', { name: 'Remove band' }).click()
    }
    await expect(section().getByText(/No bands/)).toBeVisible()
    await expect.poll(async () => (await app.liveEqFilters()).length, { timeout: 4_000 }).toBe(0)
    await expect.poll(async () => Math.max(...(await app.chainResponseDb([100, 1000, 10000])).map(Math.abs))).toBeLessThan(0.01)
  })

  test.describe('the response curve', () => {
    const center = async (locator: Locator) => {
      const box = await locator.boundingBox()
      if (!box) throw new Error('no bounding box')
      return { x: box.x + box.width / 2, y: box.y + box.height / 2 }
    }

    test('dragging a handle changes frequency and gain', async ({ page }) => {
      await parametric()
      const before = await center(handle(6))
      await page.mouse.move(before.x, before.y)
      await page.mouse.down()
      await page.mouse.move(before.x + 90, before.y - 40, { steps: 8 })
      await page.mouse.up()

      const text = (await handle(6).getAttribute('aria-valuetext')) ?? ''
      const [, frequency, gain] = /^Peak, (\d+) Hz|^Peak, ([\d.]+) kHz/.test(text) ? [text, ...(text.match(/(\d[\d.]*) (k?Hz), ([+-][\d.]+) dB/)?.slice(1, 4) ?? [])] : []
      expect(Number(frequency)).toBeGreaterThan(0)
      expect(Number(text.match(/([+-][\d.]+) dB/)?.[1])).toBeGreaterThan(3) // dragged up
      expect(text).toMatch(/kHz/) // dragged right of 1 kHz
      expect(gain).toBeDefined()
      await expect.poll(async () => (await app.liveEqFilters())[5]?.gain).toBeGreaterThan(3)
      await expect.poll(async () => (await app.liveEqFilters())[5]?.frequency).toBeGreaterThan(1500)
    })

    test('dragging a notch only moves its frequency', async ({ page }) => {
      await parametric()
      await chips().nth(5).click()
      await section().getByRole('radio', { name: 'Notch' }).click()
      const before = await center(handle(6))
      await page.mouse.move(before.x, before.y)
      await page.mouse.down()
      await page.mouse.move(before.x - 80, before.y - 50, { steps: 6 })
      await page.mouse.up()
      await expect(handle(6)).toHaveAttribute('aria-valuetext', /^Notch, \d+ Hz, Q 1\.1$/)
      await expect.poll(async () => (await app.liveEqFilters())[5]?.frequency).toBeLessThan(900)
    })

    test('keyboard: arrows move, +/- change Q, and the track is not seeked', async () => {
      await app.key(' ') // pause so the playback position is stable
      await app.expectPaused()
      await parametric()
      await handle(6).focus()
      await handle(6).press('ArrowRight') // one semitone up
      await expect(handle(6)).toHaveAttribute('aria-valuetext', /^Peak, 1\.1 kHz, 0\.0 dB/)
      await handle(6).press('ArrowUp')
      await handle(6).press('ArrowUp')
      await expect(handle(6)).toHaveAttribute('aria-valuetext', /\+1\.0 dB/)
      await handle(6).press('Shift+ArrowDown') // -2 dB
      await expect(handle(6)).toHaveAttribute('aria-valuetext', /-1\.0 dB/)
      await handle(6).press('+')
      await handle(6).press('+')
      await expect(handle(6)).toHaveAttribute('aria-valuetext', /Q 1\.4$/)
      await handle(6).press('-')
      await expect(handle(6)).toHaveAttribute('aria-valuetext', /Q 1\.2$/)
      expect(await app.position()).toBeLessThan(2) // arrow keys on a handle must not also seek the track
    })

    test('Delete removes the focused band', async () => {
      await parametric()
      await handle(4).focus()
      await handle(4).press('Delete')
      await expect(chips()).toHaveCount(10) // 9 bands + "Add band"
      await expect.poll(async () => (await app.liveEqFilters()).length, { timeout: 4_000 }).toBe(9)
    })

    test('scrolling over a handle changes its Q', async ({ page }) => {
      await parametric()
      const c = await center(handle(6))
      await page.mouse.move(c.x, c.y)
      await page.mouse.wheel(0, -120) // up = narrower
      await expect.poll(async () => (await app.liveEqFilters())[5]?.q).toBeGreaterThan(1.2)
      for (let i = 0; i < 3; i++) await page.mouse.wheel(0, 120) // down = wider
      await expect.poll(async () => (await app.liveEqFilters())[5]?.q).toBeLessThan(1)
    })

    test('double-clicking a handle flattens it; double-clicking empty space adds a band', async ({ page }) => {
      await parametric()
      await handle(6).focus()
      for (let i = 0; i < 8; i++) await handle(6).press('ArrowUp')
      await expect(handle(6)).toHaveAttribute('aria-valuetext', /\+4\.0 dB/)
      await handle(6).dblclick()
      await expect(handle(6)).toHaveAttribute('aria-valuetext', /, 0\.0 dB/)

      const box = await curve().boundingBox()
      if (!box) throw new Error('no box')
      await page.mouse.dblclick(box.x + box.width * 0.5, box.y + box.height * 0.2) // upper middle: a boost near 600 Hz
      await expect(handle(11)).toBeVisible()
      const text = (await handle(11).getAttribute('aria-valuetext')) ?? ''
      expect(Number(text.match(/([+-][\d.]+) dB/)?.[1])).toBeGreaterThan(5)
      await expect.poll(async () => (await app.liveEqFilters()).length).toBe(11)
    })

    test('the drawn curve peaks near the boosted band', async () => {
      await parametric()
      await section().getByRole('button', { name: 'Reset', exact: true }).click()
      await chips().nth(5).click()
      await slider('Band gain').fill('12')
      const path = curve().locator('path.stroke-accent')
      const d = (await path.getAttribute('d')) ?? ''
      const ys = [...d.matchAll(/L? ?([\d.]+),([\d.]+)/g)].map((m) => ({ x: Number(m[1]), y: Number(m[2]) }))
      const top = ys.reduce((a, b) => (b.y < a.y ? b : a))
      const zero = ys[0]?.y ?? 0
      expect(top.y).toBeLessThan(zero - 30) // clearly above the 0 dB line
    })
  })

  test.describe('graphic view with a custom layout', () => {
    test('explains why the sliders are unavailable and offers a reset', async () => {
      await parametric()
      await section().getByRole('button', { name: '+ Add band' }).click()
      await viewTab('Graphic').click()
      await expect(section().getByText(/custom bands, which the ten fixed sliders cannot show/)).toBeVisible()
      await expect(section().getByRole('slider', { name: '1k Hz gain' })).toHaveCount(0)

      await section().getByRole('button', { name: 'Reset to 10-band layout' }).click()
      await expect(section().getByRole('slider', { name: '1k Hz gain' })).toBeVisible()
      await expect.poll(async () => (await app.liveEqFilters()).length, { timeout: 4_000 }).toBe(10)
    })

    test('picking a built-in preset restores the standard layout', async () => {
      await parametric()
      await section().getByRole('button', { name: '+ Add band' }).click()
      await section().getByRole('button', { name: 'Rock', exact: true }).click()
      await expect(chips()).toHaveCount(11)
      await viewTab('Graphic').click()
      await expect(section().getByRole('slider', { name: '31 Hz gain' })).toHaveValue('5')
    })
  })

  test.describe('custom presets', () => {
    async function customise() {
      await parametric()
      await chips().nth(2).click()
      await slider('Band gain').fill('6')
      await slider('Band frequency').fill('0.4')
    }

    test('save, reset and load a custom curve', async () => {
      await customise()
      const edited = (await handle(3).getAttribute('aria-valuetext')) ?? ''
      await section().getByRole('button', { name: 'Save preset…' }).click()
      await app.answerDialog(true, 'My curve')
      const preset = section().getByRole('button', { name: 'My curve', exact: true })
      await expect(preset).toBeVisible()
      await expect(preset).toHaveAttribute('aria-pressed', 'true') // the current curve is that preset

      await section().getByRole('button', { name: 'Reset', exact: true }).click()
      await expect(handle(3)).toHaveAttribute('aria-valuetext', 'Peak, 125 Hz, 0.0 dB, Q 1.1')
      await expect(preset).toHaveAttribute('aria-pressed', 'false')

      await preset.click()
      await expect(handle(3)).toHaveAttribute('aria-valuetext', edited)
      await expect(preset).toHaveAttribute('aria-pressed', 'true')
      await expect.poll(async () => (await app.liveEqFilters())[2]?.gain).toBeCloseTo(6, 1)
    })

    test('presets keep a custom band layout, not just gains', async () => {
      await parametric()
      await section().getByRole('button', { name: '+ Add band' }).click()
      await slider('Band gain').fill('4')
      await section().getByRole('button', { name: 'Save preset…' }).click()
      await app.answerDialog(true, 'Eleven')
      await section().getByRole('button', { name: 'Reset', exact: true }).click()
      await expect(chips()).toHaveCount(11) // 10 bands + "Add band"
      await section().getByRole('button', { name: 'Eleven', exact: true }).click()
      await expect(chips()).toHaveCount(12)
      await expect.poll(async () => (await app.liveEqFilters()).length).toBe(11)
    })

    test('saving under an existing name (any case) overwrites it', async () => {
      await customise()
      await section().getByRole('button', { name: 'Save preset…' }).click()
      await app.answerDialog(true, 'Dup')
      await slider('Band gain').fill('-4')
      await section().getByRole('button', { name: 'Save preset…' }).click()
      await app.answerDialog(true, 'dUP')
      await expect(section().getByRole('button', { name: /^dup$/i })).toHaveCount(1)
      await section().getByRole('button', { name: 'Reset', exact: true }).click()
      await section().getByRole('button', { name: 'Dup', exact: true }).click()
      await expect(handle(3)).toHaveAttribute('aria-valuetext', /-4\.0 dB/)
    })

    test('cancelling the name prompt saves nothing', async () => {
      await customise()
      await section().getByRole('button', { name: 'Save preset…' }).click()
      await app.answerDialog(false)
      await expect(section().getByRole('group', { name: /^Custom preset/ })).toHaveCount(0)
    })

    test('presets can be deleted', async () => {
      await customise()
      await section().getByRole('button', { name: 'Save preset…' }).click()
      await app.answerDialog(true, 'Temp')
      await expect(section().getByRole('button', { name: 'Temp', exact: true })).toBeVisible()
      await section().getByRole('button', { name: 'Delete preset Temp' }).click()
      await expect(section().getByRole('button', { name: 'Temp', exact: true })).toHaveCount(0)
    })

    test('presets and the current curve survive a reload', async () => {
      await customise()
      await section().getByRole('button', { name: 'Save preset…' }).click()
      await app.answerDialog(true, 'Keeper')
      const edited = (await handle(3).getAttribute('aria-valuetext')) ?? ''
      await app.closeTools()

      await app.reload()
      await app.play('a')
      await app.openTools()
      await expect(handle(3)).toHaveAttribute('aria-valuetext', edited)
      await expect(section().getByRole('button', { name: 'Keeper', exact: true })).toHaveAttribute('aria-pressed', 'true')
      await expect.poll(async () => (await app.liveEqFilters())[2]?.gain).toBeCloseTo(6, 1)
    })
  })

  test('settings saved by the old graphic-only equalizer are migrated', async ({ page }) => {
    await app.closeTools()
    await page.addInitScript(() => localStorage.setItem('wl-settings', JSON.stringify({ eq: [7, 6, 5, 3, 1, 0, 0, 0, 0, 0], eqOn: true })))
    await app.reload()
    await app.play('a')
    await app.openTools()
    await expect(section().getByRole('slider', { name: '31 Hz gain' })).toHaveValue('7')
    await expect(section().getByRole('button', { name: 'Bass Boost' })).toHaveAttribute('aria-pressed', 'true')
    await expectChainMatches(graphicBands(BASS_BOOST))
  })

  test('the equalizer off switch bypasses a notch too', async () => {
    await parametric()
    await section().getByRole('button', { name: 'Reset', exact: true }).click()
    await chips().nth(5).click()
    await section().getByRole('radio', { name: 'Notch' }).click()
    await slider('Band Q').fill('0.7')
    await expect.poll(async () => (await app.chainResponseDb([1000]))[0]).toBeLessThan(-30)

    await section().getByRole('switch', { name: 'Enable equalizer' }).click()
    await expect.poll(() => app.gainValue(GAIN.eqBypass)).toBeCloseTo(1, 2)
    await expect.poll(() => app.gainValue(GAIN.eqThrough)).toBeCloseTo(0, 2)
    // the filters themselves are untouched, so switching back restores the notch
    await section().getByRole('switch', { name: 'Enable equalizer' }).click()
    await expect.poll(() => app.gainValue(GAIN.eqThrough)).toBeCloseTo(1, 2)
    await expect.poll(async () => (await app.chainResponseDb([1000]))[0]).toBeLessThan(-30)
  })
})
