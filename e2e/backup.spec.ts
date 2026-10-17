import AxeBuilder from '@axe-core/playwright'
import { expect, test } from '@playwright/test'
import { PlayerPage, importWithMtime, libraryKey, settled, tone } from './helpers'
import type { Upload } from './helpers'

const MTIME = 1_700_000_000_000
const files = { a: tone('a.wav', 1, 440), b: tone('b.wav', 1, 523), c: tone('c.wav', 1, 660) }

interface EntryOverrides {
  title?: string
  plays?: number
  lastPlayedAt?: number | null
  addedAt?: number
}

const entry = (file: Upload, over: EntryOverrides = {}) => ({
  key: libraryKey(file, MTIME),
  name: file.name,
  path: '',
  title: file.name.replace('.wav', ''),
  artist: 'Unknown Artist',
  album: '',
  duration: 1,
  lyrics: null,
  gainDb: null,
  addedAt: 1_600_000_000_000,
  plays: 0,
  lastPlayedAt: null,
  ...over,
})

const backup = (tracks: ReturnType<typeof entry>[], playlists: { id: string; name: string; files: Upload[] }[] = []) =>
  Buffer.from(
    JSON.stringify({
      format: 'wavelocal-backup',
      version: 1,
      exportedAt: '2026-10-01T10:00:00.000Z',
      tracks,
      playlists: playlists.map((p) => ({ id: p.id, name: p.name, keys: p.files.map((f) => libraryKey(f, MTIME)) })),
    }),
  )

test.describe('backup and restore', () => {
  let app: PlayerPage

  test.beforeEach(async ({ page }) => {
    app = new PlayerPage(page)
    await app.open()
  })

  const option = (label: RegExp) => app.viewSelect.locator('option', { hasText: label })
  const preview = () => app.tools.getByRole('group', { name: 'Restore preview' })

  /** Open the panel, choose a backup file and wait for the preview. */
  async function choose(content: Buffer, name = 'backup.json'): Promise<void> {
    if (!(await app.tools.isVisible())) await app.openTools()
    await app.tools.getByLabel('Backup file').setInputFiles({ name, mimeType: 'application/json', buffer: content })
  }

  async function restore(content: Buffer): Promise<void> {
    await choose(content)
    await expect(preview()).toBeVisible()
    await preview().getByRole('button', { name: 'Restore' }).click()
    await expect(app.tools.getByText('Backup restored.')).toBeVisible()
  }

  test('exports tags, counts and playlists as a small JSON file with no audio in it', async () => {
    await importWithMtime(app, [files.a, files.b], MTIME)
    await expect(app.rows).toHaveCount(2)
    await app.viewSelect.selectOption('__new')
    await app.answerDialog(true, 'Faves')
    await app.viewSelect.selectOption('all')
    await app.row('b').hover()
    await app.row('b').getByRole('button', { name: 'Add b to playlist' }).click()
    await app.page.getByRole('menuitem', { name: 'Faves' }).click()

    await app.openTools()
    const [download] = await Promise.all([app.page.waitForEvent('download'), app.tools.getByRole('button', { name: 'Export backup' }).click()])
    expect(download.suggestedFilename()).toMatch(/^wavelocal-backup-\d{4}-\d{2}-\d{2}\.json$/)
    const stream = await download.createReadStream()
    const chunks: Buffer[] = []
    for await (const chunk of stream) chunks.push(chunk as Buffer)
    const raw = Buffer.concat(chunks)
    const data = JSON.parse(raw.toString('utf8'))
    expect(data).toMatchObject({ format: 'wavelocal-backup', version: 1 })
    expect(data.tracks.map((t: { key: string }) => t.key).sort()).toEqual([libraryKey(files.a, MTIME), libraryKey(files.b, MTIME)])
    expect(data.playlists).toEqual([{ id: expect.any(String), name: 'Faves', keys: [libraryKey(files.b, MTIME)] }])
    expect(raw.length).toBeLessThan(files.a.buffer.length) // the audio is not in there
  })

  test('is disabled until there is something to back up', async () => {
    await app.openTools()
    await expect(app.tools.getByRole('button', { name: 'Export backup' })).toBeDisabled()
  })

  test('restores tags, play counts and playlists onto the tracks you already have', async () => {
    await importWithMtime(app, [files.a, files.b], MTIME)
    await expect(app.rows).toHaveCount(2)
    const data = backup(
      [entry(files.a, { title: 'Alpha Renamed', plays: 5, lastPlayedAt: 1_700_000_100_000 }), entry(files.b)],
      [{ id: 'p1', name: 'Mix', files: [files.b, files.a] }],
    )
    await choose(data)
    await expect(preview()).toContainText('2 tracks in the backup: 2 already in your library, 0 not yet.')
    await expect(preview()).toContainText('Will update tags, lyrics or play counts of 2 tracks.')
    await expect(preview()).toContainText('add 1 playlist')
    await preview().getByRole('button', { name: 'Restore' }).click()
    await expect(app.tools.getByText('Backup restored.')).toBeVisible()
    await app.closeTools()

    await expect(option(/^Mix \(2\)/)).toHaveCount(1)
    await expect(option(/^Most played \(1\)/)).toHaveCount(1)
    await app.viewSelect.selectOption({ label: 'Mix (2)' })
    expect(await app.titles()).toEqual(['b', 'Alpha Renamed'])
    await app.viewSelect.selectOption('smart:top')
    expect(await app.titles()).toEqual(['Alpha Renamed'])
    await expect(app.sidebar.getByText('5 plays')).toBeVisible()
  })

  test('restoring the same backup twice changes nothing the second time', async () => {
    await importWithMtime(app, [files.a], MTIME)
    const data = backup([entry(files.a, { title: 'Alpha Renamed', plays: 2 })], [{ id: 'p1', name: 'Mix', files: [files.a] }])
    await restore(data)
    await app.tools.getByLabel('Backup file').setInputFiles({ name: 'backup.json', mimeType: 'application/json', buffer: data })
    await expect(preview()).toContainText('The tracks you have already match the backup.')
    await expect(preview()).toContainText('merge 1 playlist')
    await expect(preview()).not.toContainText('Will update')
    await app.closeTools()
    await expect(app.viewSelect.locator('option', { hasText: /^Mix/ })).toHaveCount(1) // merged, not duplicated
  })

  test('keeps what it cannot apply yet and completes it as the files come back, even across a reload', async () => {
    const data = backup(
      [entry(files.a), entry(files.b, { plays: 3, lastPlayedAt: 1_700_000_200_000 }), entry(files.c, { title: 'See' })],
      [{ id: 'p1', name: 'Mix', files: [files.c, files.a, files.b] }],
    )
    await restore(data)
    await expect(app.tools.getByText('0 already in your library, 3 not yet')).toBeVisible()
    await expect(app.tools.getByText('3 tracks from a backup are waiting for their files.')).toBeVisible()
    await app.closeTools()
    await expect(option(/^Mix \(0\)/)).toHaveCount(1)

    await app.reload()
    await app.openTools()
    await expect(app.tools.getByText('3 tracks from a backup are waiting for their files.')).toBeVisible()
    await app.closeTools()

    await importWithMtime(app, [files.a, files.b], MTIME)
    await expect(option(/^Mix \(2\)/)).toHaveCount(1)
    await expect(option(/^Most played \(1\)/)).toHaveCount(1)
    await app.viewSelect.selectOption({ label: 'Mix (2)' })
    expect(await app.titles()).toEqual(['a', 'b'])

    await importWithMtime(app, [files.c], MTIME)
    await expect(option(/^Mix \(3\)/)).toHaveCount(1)
    await app.viewSelect.selectOption({ label: 'Mix (3)' }) // adding files switched the view to the library
    expect(await app.titles()).toEqual(['See', 'a', 'b']) // c is back at the front, where it was
    await app.openTools()
    await expect(app.tools.getByText(/waiting for their files/)).toHaveCount(0)
  })

  test('"Stop waiting" forgets the tracks a restore was still waiting for', async () => {
    await restore(backup([entry(files.a)], [{ id: 'p1', name: 'Mix', files: [files.a] }]))
    await app.tools.getByRole('button', { name: 'Stop waiting' }).click()
    await expect(app.tools.getByText(/waiting for their files/)).toHaveCount(0)
    await app.closeTools()
    await importWithMtime(app, [files.a], MTIME)
    await expect(app.rows).toHaveCount(1)
    await expect(option(/^Mix \(0\)/)).toHaveCount(1) // the playlist stays, but the slot is not filled
  })

  test('does not touch anything the backup does not mention', async () => {
    await importWithMtime(app, [files.a, files.b], MTIME)
    await app.viewSelect.selectOption('__new')
    await app.answerDialog(true, 'Mine')
    await restore(backup([entry(files.a)]))
    await app.closeTools()
    await expect(app.viewSelect.locator('option[value="all"]')).toHaveText('Library (2)')
    await expect(option(/^Mine \(0\)/)).toHaveCount(1)
  })

  test('explains files that are not backups', async () => {
    await choose(Buffer.from('hello, I am a text file'), 'notes.txt')
    await expect(app.tools.getByRole('alert')).toContainText('not valid JSON')
    await choose(Buffer.from(JSON.stringify({ hello: 'world' })))
    await expect(app.tools.getByRole('alert')).toContainText('not a Wavelocal backup')
    await choose(Buffer.from(JSON.stringify({ format: 'wavelocal-backup', version: 7, tracks: [], playlists: [] })))
    await expect(app.tools.getByRole('alert')).toContainText('newer version')
    await expect(preview()).toHaveCount(0)
  })

  test('skips damaged entries and says so', async () => {
    const good = entry(files.a)
    const raw = Buffer.from(JSON.stringify({ format: 'wavelocal-backup', version: 1, tracks: [good, { nope: true }, 5], playlists: [] }))
    await choose(raw)
    await expect(preview()).toContainText('2 damaged entries in the file will be skipped')
    await expect(preview()).toContainText('1 track in the backup')
  })

  test('cancelling the preview changes nothing', async () => {
    await importWithMtime(app, [files.a], MTIME)
    await choose(backup([entry(files.a, { title: 'Nope' })], [{ id: 'p', name: 'Ghost', files: [files.a] }]))
    await preview().getByRole('button', { name: 'Cancel' }).click()
    await expect(preview()).toHaveCount(0)
    await app.closeTools()
    expect(await app.titles()).toEqual(['a'])
    await expect(option(/^Ghost/)).toHaveCount(0)
  })

  test('a backup made on one device restores onto another that has the same files', async ({ browser, baseURL }) => {
    await importWithMtime(app, [files.a, files.b], MTIME)
    await app.viewSelect.selectOption('__new')
    await app.answerDialog(true, 'Faves')
    await app.viewSelect.selectOption('all')
    await app.row('a').hover()
    await app.row('a').getByRole('button', { name: 'Add a to playlist' }).click()
    await app.page.getByRole('menuitem', { name: 'Faves' }).click()
    await app.openTools()
    const [download] = await Promise.all([app.page.waitForEvent('download'), app.tools.getByRole('button', { name: 'Export backup' }).click()])
    const chunks: Buffer[] = []
    for await (const chunk of await download.createReadStream()) chunks.push(chunk as Buffer)
    const exported = Buffer.concat(chunks)

    const context = await browser.newContext({ baseURL, serviceWorkers: 'block', viewport: { width: 1280, height: 800 } })
    try {
      const other = new PlayerPage(await context.newPage())
      await other.open()
      await importWithMtime(other, [files.a, files.b], MTIME)
      await expect(other.rows).toHaveCount(2)
      await other.openTools()
      await other.tools.getByLabel('Backup file').setInputFiles({ name: 'backup.json', mimeType: 'application/json', buffer: exported })
      await other.tools.getByRole('group', { name: 'Restore preview' }).getByRole('button', { name: 'Restore' }).click()
      await other.closeTools()
      await expect(other.viewSelect.locator('option', { hasText: /^Faves \(1\)/ })).toHaveCount(1)
    } finally {
      await context.close()
    }
  })

  test('the panel has no accessibility violations', async () => {
    await importWithMtime(app, [files.a], MTIME)
    await choose(backup([entry(files.a, { title: 'Alpha' }), entry(files.b)], [{ id: 'p', name: 'Mix', files: [files.a, files.b] }]))
    await expect(preview()).toBeVisible()
    const scan = async (state: string) => {
      await settled(app.page)
      const { violations } = await new AxeBuilder({ page: app.page }).include('section[aria-label="Backup and restore"]').withTags(['wcag2a', 'wcag2aa', 'wcag21aa', 'wcag22aa', 'best-practice']).analyze()
      expect(violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(' ')).join(', ')}`), state).toEqual([])
    }
    await scan('preview')
    await preview().getByRole('button', { name: 'Restore' }).click()
    await expect(app.tools.getByText('Backup restored.')).toBeVisible()
    await scan('restored with tracks waiting')
  })
})
