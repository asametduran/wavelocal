import { expect, test } from '@playwright/test'
import { PlayerPage, denyNativeLossless, flac, song, tone } from './helpers'
import { POLICY, serializePolicy } from '../scripts/csp.mjs'

/** A valid 1x1 PNG. */
const PNG_1PX = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64')

test.describe('Content-Security-Policy', () => {
  let app: PlayerPage

  test.beforeEach(async ({ page }) => {
    app = new PlayerPage(page)
  })

  test('the built page declares exactly the policy kept in the repository, before anything else loads', async ({ page }) => {
    await app.open()
    const declared = await page.evaluate(() => {
      const meta = document.querySelector<HTMLMetaElement>('meta[http-equiv="Content-Security-Policy" i]')
      const head = [...document.head.children]
      return { content: meta?.content ?? null, position: meta ? head.indexOf(meta) : -1, firstLoader: head.findIndex((el) => el.tagName === 'SCRIPT' || el.tagName === 'LINK') }
    })
    expect(declared.content).toBe(serializePolicy(POLICY))
    expect(declared.position).toBeGreaterThanOrEqual(0)
    expect(declared.position).toBeLessThan(declared.firstLoader)
  })

  test('refuses what the app never needs: inline code, eval, other sites, inline style attributes, frames', async ({ page }) => {
    // eval has to be tried by a script of the page: code the test runner evaluates over the DevTools protocol is exempt
    await page.route('**/csp-probe.js', (route) =>
      route.fulfill({
        contentType: 'text/javascript',
        body: `try { window.__eval = String(new Function('return 1')()) } catch (e) { window.__eval = e.name }
try { window.__indirectEval = String((0, eval)('1 + 1')) } catch (e) { window.__indirectEval = e.name }`,
      }),
    )
    await app.open()
    await page.evaluate(() => document.body.append(Object.assign(document.createElement('script'), { src: '/csp-probe.js' })))
    await expect.poll(() => page.evaluate(() => (window as unknown as { __eval?: string }).__eval)).toBe('EvalError')
    expect(await page.evaluate(() => (window as unknown as { __indirectEval?: string }).__indirectEval)).toBe('EvalError')

    await page.evaluate(() => {
      const attempts: (() => unknown)[] = [
        () => document.body.append(Object.assign(document.createElement('script'), { textContent: 'window.name = "ran"' })),
        () => Object.assign(new Image(), { src: 'https://example.com/pixel.png' }),
        () => fetch('https://example.com/').catch(() => undefined),
        () => document.body.setAttribute('style', 'color: red'),
        () => document.body.append(Object.assign(document.createElement('iframe'), { src: 'https://example.com/' })),
        () => new WebSocket('wss://example.com/socket'),
      ]
      for (const attempt of attempts) {
        try {
          attempt()
        } catch {
          // the throw is the policy working (eval)
        }
      }
    })
    await expect.poll(async () => (await app.policyViolations()).length, { timeout: 10_000 }).toBeGreaterThanOrEqual(7)
    const violations = await app.policyViolations()
    const refused = (directive: RegExp) => violations.filter((v) => directive.test(v.directive))
    expect(refused(/^script-src$/).some((v) => v.blocked === 'eval'), 'eval').toBe(true)
    expect(refused(/^script-src-elem$/).some((v) => v.blocked === 'inline'), 'inline script').toBe(true)
    expect(refused(/^img-src$/).some((v) => v.blocked.includes('example.com'))).toBe(true)
    expect(refused(/^connect-src$/).filter((v) => v.blocked.includes('example.com')).length, 'fetch and WebSocket').toBeGreaterThanOrEqual(2)
    expect(refused(/^style-src(-attr)?$/).length, 'inline style attribute').toBeGreaterThanOrEqual(1)
    expect(refused(/^(frame|child)-src$/).some((v) => v.blocked.includes('example.com'))).toBe(true)
    expect(await page.evaluate(() => window.name)).not.toBe('ran')
  })

  test('is never broken by the app itself: covers, lyrics, the decoder worker, every panel and dialog', async ({ page }) => {
    const refusals: string[] = []
    page.on('console', (message) => {
      if (/Content Security Policy|Refused to/i.test(message.text())) refusals.push(message.text())
    })
    page.on('pageerror', (error) => refusals.push(error.message))
    await denyNativeLossless(page) // WAV and FLAC then take the decoder-worker path
    await app.open()

    const covered: Upload = song('01-covered.mp3', { title: 'Covered', artist: 'The Artists', album: 'Album One', year: '2001', track: '1/2', picture: { mime: 'image/png', data: PNG_1PX }, lyrics: '[00:00.50]first line\n[00:01.50]second line' }, 120)
    await app.importFiles(covered, tone('02-tone.wav', 3), flac('tone-440', '03-lossless.flac'))
    await expect(app.rows).toHaveCount(3)

    // artwork: a blob: image the policy has to allow
    await expect.poll(() => page.evaluate(() => [...document.images].some((img) => img.src.startsWith('blob:') && img.complete && img.naturalWidth > 0))).toBe(true)

    // playback from a blob: URL, then through the module worker that decodes lossless files
    await app.play('Covered')
    await app.expectPlaying()
    await app.play('03-lossless')
    await app.expectPlaying()
    expect(await app.workerCount()).toBeGreaterThan(0)

    // every panel, including the lazy ones that arrive as separate chunks
    await app.openTools()
    for (const heading of await app.tools.getByRole('heading', { level: 3 }).all()) await heading.scrollIntoViewIfNeeded()
    await expect(app.tools.getByRole('region', { name: 'Storage' })).toBeVisible()
    await app.closeTools()

    await page.keyboard.press('?')
    await expect(page.getByRole('dialog', { name: /shortcuts/i })).toBeVisible()
    await page.keyboard.press('Escape')

    await app.row('Covered').hover()
    await app.row('Covered').getByRole('button', { name: 'Edit tags of Covered' }).click()
    await expect(page.getByRole('dialog', { name: 'Edit tags' })).toBeVisible()
    await page.keyboard.press('Escape')

    await app.showMode('Albums')
    await app.showMode('Folders')
    await app.showMode('Tracks')

    await app.viewSelect.selectOption('__new')
    await app.answerDialog(true, 'Policy check')
    await expect(app.viewSelect.locator('option', { hasText: 'Policy check' })).toHaveCount(1)

    expect(await app.policyViolations()).toEqual([])
    expect(refusals).toEqual([])
  })
})

type Upload = ReturnType<typeof song>
