import AxeBuilder from '@axe-core/playwright'
import { expect, test } from '@playwright/test'
import type { Page } from '@playwright/test'
import { PlayerPage, flac, importWithMtime, tone, wav } from './helpers'
import type { Upload } from './helpers'
import { buildMp3, buildOgg, mp3Seconds } from '../src/test-utils/containers'
import { buildId3v2, withId3 } from '../src/test-utils/id3'

const mp3 = (name: string, bytes: Uint8Array): Upload => ({ name, mimeType: 'audio/mpeg', buffer: Buffer.from(bytes) })
const ogg = (name: string, bytes: Uint8Array): Upload => ({ name, mimeType: 'audio/ogg', buffer: Buffer.from(bytes) })

const MTIME = 1_700_000_000_000

test.describe('what an import reads from the files', () => {
  let app: PlayerPage

  test.beforeEach(async ({ page }) => {
    app = new PlayerPage(page)
    await app.open()
  })

  const lengths = () => app.rows.locator('span.tabular-nums')

  test('shows every track\'s length at once, with a total, and keeps them after a reload', async () => {
    await app.importFiles(wav('long', 'a.wav'), wav('long', 'b.wav'), wav('tone-440', 'c.wav'), wav('silence', 'd.wav'))
    await expect(app.rows).toHaveCount(4)
    // nothing has been played: the lengths come from the file headers
    await expect(lengths()).toHaveText(['0:30', '0:30', '0:04', '0:02'])
    await expect(app.sidebar.getByTestId('library-summary')).toHaveText('4 tracks · 1 min')

    await app.reload()
    await expect(app.rows).toHaveCount(4)
    await expect(lengths()).toHaveText(['0:30', '0:30', '0:04', '0:02'])
  })

  test('reads an MP3: tags from the ID3 tag, the length from the MP3 headers', async () => {
    const tag = buildId3v2({ title: 'Gece Yarısı', artist: 'Şebnem Ferah', album: 'Aşk', track: '3/12', year: '2019', genre: '(13)' })
    const file = mp3('gece.mp3', withId3(tag, buildMp3({ frames: 3000, xing: { tag: 'Info', lame: { delay: 576, padding: 1000 } } })))
    await app.importFiles(file)
    await expect(app.row('Gece Yarısı')).toBeVisible()
    await expect(app.row('Gece Yarısı')).toContainText('Şebnem Ferah')
    await expect(app.row('Gece Yarısı').locator('span.tabular-nums')).toHaveText('1:18') // 3000 frames of 1152 samples at 44.1 kHz, less the encoder delay
  })

  test('reads the tags of FLAC and Ogg Opus files, which jsmediatags cannot, and their lengths', async () => {
    await app.importFiles(
      flac('tone-440', 'a.flac', { vorbis: { vendor: 'test', comments: ['TITLE=Flac Title', 'ARTIST=Flac Artist', 'ALBUM=Flac Album', 'TRACKNUMBER=2', 'DATE=2020'] } }),
      ogg('b.ogg', buildOgg({ codec: 'opus', seconds: 5, comments: ['TITLE=Opus Title', 'ARTIST=Opus Artist'] })),
    )
    await expect(app.row('Flac Title')).toContainText('Flac Artist')
    await expect(app.row('Opus Title')).toContainText('Opus Artist')
    await expect(app.row('Flac Title').locator('span.tabular-nums')).toHaveText('0:04')
    await expect(app.row('Opus Title').locator('span.tabular-nums')).toHaveText('0:05')
  })

  test('shows what the playing file is: format, rate, depth, and a Hi-Res mark above CD quality', async () => {
    await app.importFiles(flac('tone-440', 'lossless.flac'), wav('tone-24bit', 'deep.wav'))
    const badge = app.stage.getByTestId('format-badge')
    await app.play('lossless')
    await expect(badge).toContainText('FLAC · 44.1 kHz · 16-bit')
    await expect(badge).not.toContainText('Hi-Res')
    await app.play('deep')
    await expect(badge).toContainText('WAV · 44.1 kHz · 24-bit')
    await expect(badge).toContainText('Hi-Res')
    await expect(badge.getByText('Audio format: WAV, 44.1 kilohertz, 24-bit, high resolution')).toBeAttached()
  })

  test('agrees with the browser about the length of MP3 files, and is exact where the browser can only guess', async ({ page }) => {
    const files = [
      mp3('info.mp3', buildMp3({ frames: 1500, xing: { tag: 'Info', lame: { delay: 576, padding: 1000 } } })),
      mp3('xing.mp3', buildMp3({ frames: 1500, vbrKbps: [96, 160], xing: { tag: 'Xing' } })),
      mp3('bare.mp3', buildMp3({ frames: 1500 })),
    ]
    await app.importFiles(...files, mp3('vbr.mp3', buildMp3({ frames: 1500, vbrKbps: [96, 160, 128] })))
    const browserSeconds = (bytes: Buffer) =>
      page.evaluate(
        (base64) =>
          new Promise<number>((resolve, reject) => {
            const audio = new Audio()
            audio.onloadedmetadata = () => resolve(audio.duration)
            audio.onerror = () => reject(new Error('the browser cannot read the file'))
            audio.src = URL.createObjectURL(new Blob([Uint8Array.from(atob(base64), (c) => c.charCodeAt(0))], { type: 'audio/mpeg' }))
          }),
        bytes.toString('base64'),
      )
    for (const file of files) {
      const shown = await app.row(file.name.replace('.mp3', '')).locator('span.tabular-nums').innerText()
      const [m, s] = shown.split(':').map(Number)
      expect(Math.abs((m ?? 0) * 60 + (s ?? 0) - (await browserSeconds(file.buffer))), file.name).toBeLessThan(1.05)
    }
    // 96 and 160 kbps frames alternating with no header: only walking every frame gets it right (39.18 s)
    await expect(app.row('vbr').locator('span.tabular-nums')).toHaveText(`0:${Math.floor(mp3Seconds(1500))}`)
  })

  test('two imports started together read everything once and add nothing twice', async () => {
    const [a, b, c] = [tone('a.wav'), tone('b.wav', 0.1, 523), tone('c.wav', 0.1, 660)]
    await Promise.all([importWithMtime(app, [a, b], MTIME), importWithMtime(app, [b, c], MTIME)])
    await expect(app.viewSelect.locator('option[value="all"]')).toHaveText('Library (3)')
    await app.page.waitForTimeout(300)
    await expect(app.viewSelect.locator('option[value="all"]')).toHaveText('Library (3)')
  })

  test('imports a few hundred files and ends with no progress left on screen', async ({ page }) => {
    const files = Array.from({ length: 250 }, (_, i) => tone(`song${String(i).padStart(3, '0')}.wav`, 0.1, 200 + (i % 50) * 10))
    await app.importFiles(...files)
    await expect(app.viewSelect.locator('option[value="all"]')).toHaveText('Library (250)', { timeout: 30_000 })
    await expect(page.getByTestId('import-status')).toHaveCount(0)
    await expect(app.sidebar.getByTestId('library-summary')).toContainText('250 tracks')
  })
})

test.describe('progress and cancel', () => {
  let app: PlayerPage

  test.beforeEach(async ({ page }) => {
    // slow every read of a file down, so there is time to watch the import and to cancel it
    await page.addInitScript(() => {
      const read = Blob.prototype.arrayBuffer
      Blob.prototype.arrayBuffer = function (this: Blob) {
        return new Promise<ArrayBuffer>((resolve) => setTimeout(resolve, 120)).then(() => read.call(this))
      }
    })
    app = new PlayerPage(page)
    await app.open()
  })

  const libraryCount = async (): Promise<number> => Number(/\((\d+)\)/.exec(await app.viewSelect.locator('option[value="all"]').innerText())?.[1] ?? Number.NaN)

  test('reports progress with an accessible bar, and stops when cancelled, keeping what was read', async ({ page }) => {
    test.setTimeout(60_000)
    await app.importFiles(...Array.from({ length: 80 }, (_, i) => tone(`t${String(i).padStart(2, '0')}.wav`, 0.1, 220 + i)))
    const status = page.getByTestId('import-status')
    const bar = page.getByRole('progressbar', { name: 'Reading files' })
    await expect(status).toBeVisible()
    await expect(status).toContainText(/Reading tags… \d+ \/ 80/)
    await expect(bar).toHaveAttribute('aria-valuemax', '80')
    const { violations } = await new AxeBuilder({ page }).include('[data-testid=import-status]').analyze()
    expect(violations.map((v) => v.id)).toEqual([])

    // wait for a few files to be done: the bar's value is polled, because the numbers jump when the machine is busy
    await expect
      .poll(async () => Number((await bar.getAttribute('aria-valuenow', { timeout: 500 }).catch(() => null)) ?? 0), { intervals: [50], timeout: 30_000 })
      .toBeGreaterThanOrEqual(6)
    await status.getByRole('button', { name: 'Cancel import' }).click()
    await expect(status).toHaveCount(0)
    await expect(page.getByText(/Import cancelled: \d+ of 80 files added/)).toBeVisible()

    const kept = await libraryCount()
    expect(kept).toBeGreaterThanOrEqual(6)
    expect(kept).toBeLessThan(80)

    // the app is not left stuck, and what was read was saved
    await app.rows.first().locator('button[aria-current]').click()
    await app.expectPlaying()
    await app.reload()
    await expect(app.viewSelect.locator('option[value="all"]')).toHaveText(`Library (${kept})`)
  })
})

test.describe('a library saved before the details were read', () => {
  let app: PlayerPage

  test.beforeEach(async ({ page }) => {
    app = new PlayerPage(page)
    await app.open()
  })

  /** Rewrite every stored record the way a version without the analysis saved it. */
  const makeLegacy = (page: Page) =>
    page.evaluate(
      () =>
        new Promise<void>((resolve, reject) => {
          const open = indexedDB.open('wavelocal', 1)
          open.onsuccess = () => {
            const tx = open.result.transaction('tracks', 'readwrite')
            const store = tx.objectStore('tracks')
            store.getAll().onsuccess = (e) => {
              for (const rec of (e.target as IDBRequest<Record<string, unknown>[]>).result) {
                for (const key of ['albumArtist', 'trackNo', 'trackTotal', 'discNo', 'discTotal', 'year', 'genre', 'compilation', 'audio', 'indexed']) delete rec[key]
                rec.duration = 0
                store.put(rec)
              }
            }
            tx.oncomplete = () => resolve()
            tx.onerror = () => reject(tx.error)
          }
          open.onerror = () => reject(open.error)
        }),
    )

  const stored = (page: Page) =>
    page.evaluate(
      () =>
        new Promise<{ name: string; duration: number; indexed: number; container: string | null }[]>((resolve, reject) => {
          const open = indexedDB.open('wavelocal', 1)
          open.onsuccess = () => {
            const req = open.result.transaction('tracks', 'readonly').objectStore('tracks').getAll()
            req.onsuccess = () =>
              resolve(
                (req.result as { file: File; duration: number; indexed?: number; audio?: { container: string } | null }[])
                  .map((r) => ({ name: r.file.name, duration: r.duration, indexed: r.indexed ?? 0, container: r.audio?.container ?? null }))
                  .sort((a, b) => a.name.localeCompare(b.name)),
              )
            req.onerror = () => reject(req.error)
          }
          open.onerror = () => reject(open.error)
        }),
    )

  test('is brought up to date in the background, once, without playing anything', async ({ page }) => {
    await app.importFiles(wav('long', 'old1.wav'), wav('tone-440', 'old2.wav'), flac('tone-440', 'old3.flac'))
    await expect(app.rows).toHaveCount(3)
    await makeLegacy(page)
    expect((await stored(page)).map((r) => [r.duration, r.indexed])).toEqual([[0, 0], [0, 0], [0, 0]])

    await app.reload()
    // the upgrade starts by itself: the lengths appear without anything being played
    await expect(app.rows.locator('span.tabular-nums')).toHaveText(['0:30', '0:04', '0:04'], { timeout: 15_000 })
    await expect.poll(async () => (await stored(page)).map((r) => [r.duration, r.indexed >= 1, r.container])).toEqual([
      [30, true, 'wav'],
      [4, true, 'wav'],
      [4, true, 'flac'],
    ])

    // it is not done again: the next start has everything at once
    await app.reload()
    await expect(app.rows.locator('span.tabular-nums')).toHaveText(['0:30', '0:04', '0:04'])
    await expect(page.getByTestId('upgrade-status')).toHaveCount(0)

    await app.play('old3')
    await expect(app.stage.getByTestId('format-badge')).toContainText('FLAC · 44.1 kHz · 16-bit')
  })

  test('keeps the music playing while it works', async ({ page }) => {
    await app.importFiles(wav('long', 'a.wav'), ...Array.from({ length: 40 }, (_, i) => tone(`t${String(i).padStart(2, '0')}.wav`, 0.1, 200 + i)))
    await expect(app.rows.first()).toBeVisible()
    await makeLegacy(page)
    await app.reload()
    await app.play('a')
    await expect.poll(() => app.position(), { timeout: 8_000 }).toBeGreaterThanOrEqual(1)
    await expect(app.rows.locator('span.tabular-nums').first()).toHaveText('0:30', { timeout: 15_000 })
    await app.expectPlaying()
  })
})
