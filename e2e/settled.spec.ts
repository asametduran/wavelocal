import { expect, test } from '@playwright/test'
import { settled } from './helpers'

// `settled` is what keeps an accessibility scan from reading the colours of a dialog that is still fading in. It is a helper
// of the tests, but a wrong one would put the flake back without anyone noticing, so it is tested like code.

test.describe('settled (waiting for animations before an accessibility scan)', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('about:blank')
    await page.setContent('<div id="box" style="width:10px;height:10px"></div>')
  })

  test('returns at once when nothing is animating', async ({ page }) => {
    const started = Date.now()
    await settled(page)
    expect(Date.now() - started).toBeLessThan(500)
  })

  test('waits until a running animation has ended, and not much longer', async ({ page }) => {
    await page.evaluate(() => {
      document.getElementById('box')?.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 900 })
    })
    const started = Date.now()
    await settled(page)
    const waited = Date.now() - started
    expect(waited).toBeGreaterThanOrEqual(700)
    expect(waited).toBeLessThan(2500)
    expect(await page.evaluate(() => document.getAnimations().length)).toBe(0)
  })

  test('does not wait for an animation that never ends, such as a spinner', async ({ page }) => {
    await page.evaluate(() => {
      document.getElementById('box')?.animate([{ transform: 'rotate(0deg)' }, { transform: 'rotate(360deg)' }], { duration: 400, iterations: Infinity })
    })
    const started = Date.now()
    await settled(page)
    expect(Date.now() - started).toBeLessThan(500)
  })

  test('waits for the animation that the end of the first one starts', async ({ page }) => {
    await page.evaluate(() => {
      const box = document.getElementById('box')
      const first = box?.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 300 })
      first?.addEventListener('finish', () => {
        box?.animate([{ width: '10px' }, { width: '50px' }], { duration: 400 })
      })
    })
    await settled(page)
    expect(await page.evaluate(() => document.getAnimations().length)).toBe(0)
  })
})
