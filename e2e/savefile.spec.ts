import { readFile, readdir } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import AxeBuilder from '@axe-core/playwright'
import { expect, test } from '@playwright/test'
import type { Page } from '@playwright/test'
import { PlayerPage, settled, song, tone } from './helpers'
import type { Upload } from './helpers'
import { androidSeen, installFakeAndroid, methodsCalled, releaseShareSheet, savedBytes, setAndroid } from './android'

// Saving a file: a download on the web, and in the Android app (whose WebView ignores a download link) a file written in slices to
// the app's cache folder and handed to the share sheet, with words that say only what happened. The Android app is played by the fake
// bridge of `android.ts`, under the app's own code and the real `@capacitor/core`.

const TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa', 'best-practice']
const CACHE = 'file:///data/user/0/com.wavelocal.player/cache/'
const DIST = fileURLToPath(new URL('../dist', import.meta.url))

const list = (name: string, text: string): Upload => ({ name, mimeType: 'audio/x-mpegurl', buffer: Buffer.from(text, 'utf8') })
const MUSIC = [song('01-alpha.mp3', { title: 'Alpha', artist: 'Ann' }), song('02-bravo.mp3', { title: 'Bravo', artist: 'Bob' })]

async function open(page: Page, android: boolean): Promise<PlayerPage> {
  if (android) await installFakeAndroid(page)
  const app = new PlayerPage(page)
  await app.open()
  await app.importFiles(...MUSIC)
  await expect(app.rows).toHaveCount(2)
  return app
}

/** A playlist called Out of the two tracks, and the files the page was asked to download so far. */
async function withPlaylist(app: PlayerPage): Promise<string[]> {
  const downloads: string[] = []
  app.page.on('download', (download) => downloads.push(download.suggestedFilename()))
  await app.importFiles(list('Out.m3u8', '02-bravo.mp3\n01-alpha.mp3\n'))
  await expect(app.viewSelect.locator('option', { hasText: 'Out' })).toHaveText('Out (2)')
  return downloads
}

const exportBackup = (app: PlayerPage) => app.tools.getByRole('button', { name: 'Export backup' })

test.describe('the Android app saves a playlist', () => {
  test('writes it to the cache folder and hands it to the share sheet, and says it was shared and not exported', async ({ page }) => {
    const app = await open(page, true)
    const downloads = await withPlaylist(app)
    await app.playlistAction('Save as M3U8 file')
    await expect(app.toast('Shared Out.m3u8.')).toBeVisible()

    const seen = await androidSeen(page)
    expect(seen.shared).toEqual([{ title: 'Out.m3u8', files: [`${CACHE}wavelocal-share/Out.m3u8`], dialogTitle: 'Save or send' }])
    // the same text a browser would have downloaded
    expect(savedBytes(seen, 'wavelocal-share/Out.m3u8').toString('utf8')).toMatch(/^#EXTM3U\n#PLAYLIST:Out\n#EXTINF:[1-9]\d*,Bob - Bravo\n02-bravo\.mp3\n#EXTINF:[1-9]\d*,Ann - Alpha\n01-alpha\.mp3\n$/)
    // the folder was made by the first write and the file was shared only after it was written
    expect(methodsCalled(seen, 'Filesystem')).toEqual(['Filesystem.readdir', 'Filesystem.writeFile'])
    expect(methodsCalled(seen)).toEqual(['Filesystem.readdir', 'Filesystem.writeFile', 'Share.share'])
    expect(downloads).toEqual([]) // no download link was clicked: the WebView would have ignored it
    await expect(app.page.getByText(/Exported/)).toHaveCount(0)
  })

  test('is a PLS file as well', async ({ page }) => {
    const app = await open(page, true)
    await withPlaylist(app)
    await app.playlistAction('Save as PLS file')
    await expect(app.toast('Shared Out.pls.')).toBeVisible()
    expect(savedBytes(await androidSeen(page), 'wavelocal-share/Out.pls').toString('utf8')).toContain('[playlist]')
  })

  test('says so when the share sheet was closed, and nothing is claimed', async ({ page }) => {
    const app = await open(page, true)
    await withPlaylist(app)
    await setAndroid(page, { share: 'cancel' })
    await app.playlistAction('Save as M3U8 file')
    await expect(app.toast('Not saved: the share sheet was closed.')).toBeVisible()
    await expect(app.page.getByText(/Shared|Exported/)).toHaveCount(0)
  })

  test('says when the device has no room left, and leaves nothing half written', async ({ page }) => {
    const app = await open(page, true)
    await withPlaylist(app)
    await setAndroid(page, { failWritesFrom: 0 })
    await app.playlistAction('Save as M3U8 file')
    await expect(app.toast('Could not save Out.m3u8: this device has no room left.')).toBeVisible()
    const seen = await androidSeen(page)
    expect(seen.shared).toEqual([])
    expect(seen.files).toEqual({})
  })

  test('says when another save is still open, and a second one touches nothing', async ({ page }) => {
    const app = await open(page, true)
    await withPlaylist(app)
    await setAndroid(page, { share: 'hold' }) // the share sheet of the first stays open
    await app.playlistAction('Save as M3U8 file')
    await expect.poll(async () => (await androidSeen(page)).shared.length).toBe(1)
    const before = methodsCalled(await androidSeen(page)).length
    await app.playlistAction('Save as M3U8 file')
    await expect(app.toast('Could not save Out.m3u8: another save is still open.')).toBeVisible()
    expect(methodsCalled(await androidSeen(page)).length).toBe(before) // not a read of the folder, not a write, not a share
    await releaseShareSheet(page)
    await expect(app.toast('Shared Out.m3u8.')).toBeVisible()
  })

  test('says what went wrong when the share sheet cannot be shown, and points at Diagnostics', async ({ page }) => {
    const app = await open(page, true)
    await withPlaylist(app)
    await setAndroid(page, { share: 'error' })
    await app.playlistAction('Save as M3U8 file')
    await expect(app.toast(/Could not save Out\.m3u8: something went wrong, and the details are in Sound & tools → Diagnostics\./)).toBeVisible()
    await app.openTools()
    const log = app.tools.getByRole('region', { name: 'Diagnostics' }).getByRole('list', { name: 'Recorded errors' })
    await log.scrollIntoViewIfNeeded()
    await expect(log).toContainText('save')
    await expect(log).toContainText('only file urls are supported')
  })
})

test.describe('the Android app saves the backup', () => {
  test('hands the JSON to the share sheet and says it was shared', async ({ page }) => {
    const app = await open(page, true)
    await app.openTools()
    await exportBackup(app).click()
    await expect(app.toast(/^Shared wavelocal-backup-\d{4}-\d{2}-\d{2}\.json\.$/)).toBeVisible()
    const seen = await androidSeen(page)
    const [path] = Object.keys(seen.files)
    expect(path).toMatch(/^wavelocal-share\/wavelocal-backup-\d{4}-\d{2}-\d{2}\.json$/)
    const backup = JSON.parse(savedBytes(seen, path ?? '').toString('utf8')) as { tracks?: unknown[] }
    expect(Array.isArray(backup.tracks)).toBe(true)
    expect(seen.shared).toHaveLength(1)
  })

  test('says in its own panel that nothing was saved when the device is full, and passes axe', async ({ page }) => {
    const app = await open(page, true)
    await setAndroid(page, { failWritesFrom: 0 })
    await app.openTools()
    await exportBackup(app).click()
    const alert = app.tools.getByRole('region', { name: 'Backup and restore' }).getByRole('alert')
    await expect(alert).toContainText(/^Could not save wavelocal-backup-\d{4}-\d{2}-\d{2}\.json: this device has no room left\.$/)
    await settled(page)
    // the panel, not the whole dialog: an effect that is switched off is dimmed to half in its own section further up, which is not what this scans
    expect((await new AxeBuilder({ page }).include('section[aria-label="Backup and restore"]').withTags(TAGS).analyze()).violations).toEqual([])
    // and the next try, with room, works and takes the message away
    await setAndroid(page, { failWritesFrom: null })
    await exportBackup(app).click()
    await expect(alert).toHaveCount(0)
    await expect(app.toast(/^Shared wavelocal-backup-/)).toBeVisible()
  })

  test('says so when the share sheet was closed', async ({ page }) => {
    const app = await open(page, true)
    await setAndroid(page, { share: 'cancel' })
    await app.openTools()
    await exportBackup(app).click()
    await expect(app.toast('Not saved: the share sheet was closed.')).toBeVisible()
  })
})

test.describe('the Android app saves a copy of a track', () => {
  const BIG = tone('big.wav', 30, 330) // 30 s of 16-bit mono at 44.1 kHz, about 2.6 MB: four slices of 768 KiB

  async function openEditor(app: PlayerPage, title: string) {
    await app.row(title).hover()
    await app.row(title).getByRole('button', { name: `Edit tags of ${title}` }).click()
    await expect(app.page.getByRole('dialog', { name: 'Edit tags' })).toBeVisible()
  }

  test('writes every byte, in slices, and shares it', async ({ page }) => {
    await installFakeAndroid(page)
    const app = new PlayerPage(page)
    await app.open()
    await app.importFiles(BIG)
    await expect(app.rows).toHaveCount(1)
    await openEditor(app, 'big')
    await app.page.getByRole('dialog', { name: 'Edit tags' }).getByRole('button', { name: 'Download copy' }).click()
    await expect(app.toast('Shared big.wav.')).toBeVisible()

    const seen = await androidSeen(page)
    const slices = seen.files['wavelocal-share/big.wav'] ?? []
    expect(slices).toHaveLength(Math.ceil(BIG.buffer.length / (768 * 1024)))
    expect(slices.length).toBeGreaterThan(2)
    expect(slices.slice(0, -1).some((slice) => slice.includes('='))).toBe(false) // padding only at the very end
    expect(savedBytes(seen, 'wavelocal-share/big.wav').equals(BIG.buffer)).toBe(true)
    // one write, then the others appended, then the share
    expect(methodsCalled(seen)).toEqual(['Filesystem.readdir', 'Filesystem.writeFile', ...slices.slice(1).map(() => 'Filesystem.appendFile'), 'Share.share'])
  })

  test('leaves no half file when the device fills up part way, and says so in the editor', async ({ page }) => {
    await installFakeAndroid(page)
    const app = new PlayerPage(page)
    await app.open()
    await app.importFiles(BIG)
    await expect(app.rows).toHaveCount(1)
    await setAndroid(page, { failWritesFrom: 2 }) // the first slice and the second are written, the third is not
    await openEditor(app, 'big')
    const dialog = app.page.getByRole('dialog', { name: 'Edit tags' })
    await dialog.getByRole('button', { name: 'Download copy' }).click()
    await expect(dialog.getByRole('alert')).toContainText('Could not save big.wav: this device has no room left.')
    const seen = await androidSeen(page)
    expect(seen.files).toEqual({})
    expect(seen.shared).toEqual([])
  })

  test('says it is preparing while the file is written and the share sheet is open, asks for nothing twice, and works again after', async ({ page }) => {
    await installFakeAndroid(page)
    const app = new PlayerPage(page)
    await app.open()
    await app.importFiles(BIG)
    await expect(app.rows).toHaveCount(1)
    await setAndroid(page, { share: 'hold' })
    await openEditor(app, 'big')
    const dialog = app.page.getByRole('dialog', { name: 'Edit tags' })
    await dialog.getByRole('button', { name: 'Download copy' }).click()

    const preparing = dialog.getByRole('button', { name: 'Preparing…' })
    await expect(preparing).toBeVisible()
    await expect(preparing).toHaveAttribute('aria-disabled', 'true')
    await expect(preparing).toBeFocused() // aria-disabled, not disabled: focus stays where the person put it
    await expect.poll(async () => (await androidSeen(page)).shared.length).toBe(1)
    const before = methodsCalled(await androidSeen(page)).length
    await preparing.click({ force: true }) // Playwright will not click an aria-disabled button on its own; a person can
    await settled(page)
    expect(methodsCalled(await androidSeen(page)).length).toBe(before) // a second click asks the device for nothing
    await expect(preparing).toBeVisible() // and it is not taken for a failure: still preparing, and no "another save is still open" in the dialog
    await expect(dialog.getByRole('alert')).toHaveCount(0)

    await releaseShareSheet(page)
    await expect(app.toast('Shared big.wav.')).toBeVisible()
    await expect(dialog.getByRole('button', { name: 'Download copy' })).toBeEnabled()
    await expect(dialog.getByRole('button', { name: 'Preparing…' })).toHaveCount(0)
  })

  test('lets Esc close the editor while a copy is being prepared, and the news still comes', async ({ page }) => {
    await installFakeAndroid(page)
    const app = new PlayerPage(page)
    await app.open()
    await app.importFiles(BIG)
    await expect(app.rows).toHaveCount(1)
    await setAndroid(page, { share: 'hold' })
    await openEditor(app, 'big')
    const dialog = app.page.getByRole('dialog', { name: 'Edit tags' })
    await dialog.getByRole('button', { name: 'Download copy' }).click()
    await expect(dialog.getByRole('button', { name: 'Preparing…' })).toBeFocused()
    await page.keyboard.press('Escape')
    await expect(dialog).toBeHidden()
    await expect.poll(async () => (await androidSeen(page)).shared.length).toBe(1) // the sheet is open: releasing one that is not yet would do nothing
    await releaseShareSheet(page)
    await expect(app.toast('Shared big.wav.')).toBeVisible()
  })

  test('removes what the last save left, when the next one begins', async ({ page }) => {
    const app = await open(page, true)
    await withPlaylist(app)
    await app.playlistAction('Save as M3U8 file')
    await expect(app.toast('Shared Out.m3u8.')).toBeVisible()
    expect(Object.keys((await androidSeen(page)).files)).toEqual(['wavelocal-share/Out.m3u8']) // kept after its own save: a target may still be reading it
    await app.playlistAction('Save as PLS file')
    await expect(app.toast('Shared Out.pls.')).toBeVisible()
    expect(Object.keys((await androidSeen(page)).files)).toEqual(['wavelocal-share/Out.pls'])
  })
})

/** The chunks that only the Android app fetches: the runtime of Capacitor, the saver and the shell (see `vite.config.js`). */
const ANDROID_CHUNK = /\/assets\/(capacitor|plugins|androidshell)-[\w-]+\.js/
const fetched = (urls: readonly string[], name: string): string[] => urls.filter((url) => new RegExp(`/assets/${name}-[\\w-]+\\.js`).test(url))

test.describe('the web and the desktop shell are as they were', () => {
  test('a playlist is still a download, and nothing of Capacitor, of the Android saver or of its shell is fetched', async ({ page }) => {
    const urls: string[] = []
    page.on('request', (request) => urls.push(request.url()))
    const app = await open(page, false)
    await withPlaylist(app)
    const download = page.waitForEvent('download')
    await app.playlistAction('Save as M3U8 file')
    expect((await download).suggestedFilename()).toBe('Out.m3u8')
    await expect(app.toast('Exported 2 tracks as Out.m3u8')).toBeVisible()
    expect(await page.evaluate(() => 'Capacitor' in window)).toBe(false)
    expect(urls.filter((url) => ANDROID_CHUNK.test(url))).toEqual([])
  })

  test('the Android app fetches the saver as a chunk of its own, the first time it saves; its shell and Capacitor come once the page has loaded', async ({ page }) => {
    const urls: string[] = []
    page.on('request', (request) => urls.push(request.url()))
    const app = await open(page, true)
    await withPlaylist(app)
    await expect.poll(() => fetched(urls, 'androidshell')).toHaveLength(1)
    expect(fetched(urls, 'capacitor')).toHaveLength(1)
    expect(fetched(urls, 'plugins')).toEqual([]) // nothing of the saver until a file is saved
    await app.playlistAction('Save as M3U8 file')
    await expect(app.toast('Shared Out.m3u8.')).toBeVisible()
    expect(fetched(urls, 'plugins')).toHaveLength(1)
    expect(fetched(urls, 'capacitor')).toHaveLength(1) // shared by the shell and the saver, not fetched twice
  })

  test('the Capacitor runtime is in no file the first load fetches, only in a lazy chunk of its own', async () => {
    const html = await readFile(`${DIST}/index.html`, 'utf8')
    const initial = [...html.matchAll(/(?:src|href)="([^"]*\/assets\/[^"]+\.js)"/g)].map((match) => (match[1] ?? '').slice((match[1] ?? '').indexOf('assets/')))
    expect(initial.length).toBeGreaterThan(0)
    for (const file of initial) expect(await readFile(`${DIST}/${file}`, 'utf8'), file).not.toContain('androidBridge')
    // `androidBridge` is how `@capacitor/core` tells Android: it is in the runtime's chunk and nowhere else
    const files = await readdir(`${DIST}/assets`)
    const holders: string[] = []
    for (const name of files.filter((file) => file.endsWith('.js'))) if ((await readFile(`${DIST}/assets/${name}`, 'utf8')).includes('androidBridge')) holders.push(name)
    expect(holders).toHaveLength(1)
    expect(holders[0]).toMatch(/^capacitor-[\w-]+\.js$/)
  })
})
