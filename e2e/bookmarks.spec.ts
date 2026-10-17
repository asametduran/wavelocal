import { expect, test } from '@playwright/test'
import type { Page } from '@playwright/test'
import { PlayerPage, importWithMtime, libraryKey, wav } from './helpers'
import type { Upload } from './helpers'

// Bookmarks: named places in a track. The B key (or a button) marks the playhead, a flag is drawn there, the list in the chapters
// dialog jumps to them and renames and deletes them (with an Undo), they are kept for the file in the database, and they travel in
// the backup file.

const MTIME = 1_700_000_000_000
const FILE = wav('long') // 30 s of tone, titled "long"

interface Kept {
  v: number
  at: number
  bookmarks: { id: string; t: number; label: string; at: number }[]
}

/** The centre column (CSS pixels) of each flag on the footer's third canvas, the one the marks are drawn on: the top row of a flag is 7 pixels wide. */
async function flagCentres(page: Page): Promise<number[]> {
  return page.evaluate(() => {
    const canvas = document.querySelectorAll<HTMLCanvasElement>('#player .seek canvas')[2]
    const ctx = canvas?.getContext('2d')
    if (!canvas || !ctx || !canvas.width || !canvas.clientWidth) return []
    const ratio = canvas.width / canvas.clientWidth
    const row = ctx.getImageData(0, 0, canvas.width, 1).data
    const centres: number[] = []
    let from = -1
    for (let x = 0; x <= canvas.width; x++) {
      const painted = x < canvas.width && (row[x * 4 + 3] ?? 0) > 0
      if (painted && from < 0) from = x
      if (!painted && from >= 0) {
        centres.push((from + x - 1) / 2 / ratio)
        from = -1
      }
    }
    return centres
  })
}

test.describe('bookmarks', () => {
  let app: PlayerPage

  test.beforeEach(({ page }) => {
    app = new PlayerPage(page)
  })

  const row = () => app.footer.getByRole('group', { name: 'Loop and bookmarks' })
  const opener = () => row().getByTestId('bookmark-open')
  const list = (page: Page) => page.getByRole('dialog', { name: 'Chapters and bookmarks', exact: true })
  const items = (page: Page) => list(page).getByRole('list', { name: 'Bookmarks of this track' }).getByRole('listitem')
  const kept = async (key: string): Promise<Kept | undefined> => (await app.storedMeta(`listen:${key}`)) as Kept | undefined
  const labels = async (key: string): Promise<string[]> => ((await kept(key))?.bookmarks ?? []).map((b) => b.label)
  const times = async (key: string): Promise<number[]> => ((await kept(key))?.bookmarks ?? []).map((b) => b.t)

  /** Import the file with a fixed modified time (so it has the same library key every time), play it and stop it: every position below is exact. */
  async function openTrack(file: Upload = FILE): Promise<string> {
    await app.open()
    await importWithMtime(app, [file], MTIME)
    await expect(app.rows).toHaveCount(1)
    await expect.poll(() => app.storedTracks().then((tracks) => tracks.length)).toBe(1)
    await app.play('long')
    await app.playButton.click()
    await app.expectPaused()
    return libraryKey(file, MTIME)
  }

  /** A bookmark at each of `seconds`, made with the B key. */
  async function markAt(...seconds: number[]): Promise<void> {
    for (const at of seconds) {
      await app.seekTo(at)
      await app.key('b')
    }
  }

  test('B bookmarks the playhead: the toast says where, the row shows the count, a flag is drawn there, and it is kept', async ({ page }) => {
    const key = await openTrack()
    await expect(row()).toHaveCount(0) // a song has no row of buttons until there is something in it
    await app.seekTo(12)
    await app.key('b')
    await expect(app.toast('Bookmark 1 at 0:12')).toBeVisible()

    await expect.poll(() => kept(key)).toMatchObject({ v: 1, bookmarks: [{ t: 12, label: 'Bookmark 1' }] })
    expect(Object.keys((await kept(key)) ?? {}).sort()).toEqual(['at', 'bookmarks', 'v'])
    expect(Object.keys((await kept(key))?.bookmarks[0] ?? {}).sort()).toEqual(['at', 'id', 'label', 't'])

    await expect(row()).toBeVisible()
    await expect(opener()).toHaveAccessibleName('Chapters and bookmarks, 1 bookmark')
    const seek = app.footer.locator('.seek')
    await expect(seek).toHaveAttribute('data-wave', 'on')
    const width = await seek.evaluate((el) => el.clientWidth)
    await expect.poll(async () => Math.abs(((await flagCentres(page))[0] ?? -999) - 0.4 * width)).toBeLessThanOrEqual(1.5)
    expect(await app.policyViolations()).toEqual([])
  })

  test('keeps the bookmarks for the file: across a reload, and when the same file is removed and added again', async () => {
    const key = await openTrack()
    await markAt(7, 21)
    await expect.poll(() => times(key)).toEqual([7, 21])

    await app.reload()
    await app.play('long')
    await expect(opener()).toHaveAccessibleName('Chapters and bookmarks, 2 bookmarks')

    // taken out of the library the file leaves its bookmarks where they are: they belong to the file, not to the library's entry for it
    await app.row('long').getByRole('button', { name: 'Remove long' }).click()
    await expect(app.rows).toHaveCount(0)
    expect(await times(key)).toEqual([7, 21])
    await importWithMtime(app, [FILE], MTIME)
    await expect(app.rows).toHaveCount(1)
    await app.play('long')
    await expect(opener()).toHaveAccessibleName('Chapters and bookmarks, 2 bookmarks')
  })

  test('says that a place is marked already instead of marking it twice', async () => {
    const key = await openTrack()
    await markAt(12)
    await expect(app.toast('Bookmark 1 at 0:12')).toBeVisible()
    await app.seekTo(12.2)
    await app.key('b')
    await expect(app.toast('Already marked: Bookmark 1 at 0:12')).toBeVisible()
    await expect.poll(() => times(key)).toEqual([12])
  })

  test('the list shows the bookmarks with their times, chooses one to jump there, and adds one at the playhead', async ({ page }) => {
    const key = await openTrack()
    await markAt(5, 15, 25)
    await expect.poll(() => times(key)).toEqual([5, 15, 25])

    await app.seekTo(2)
    await app.key('c')
    const dialog = list(page)
    await expect(dialog).toBeVisible()
    await expect(dialog.getByRole('status')).toHaveText('This file has no chapters.')
    await expect(dialog.getByText('3 bookmarks')).toBeVisible()
    await expect(items(page)).toHaveCount(3)
    await expect(items(page).nth(0)).toContainText('0:05')
    await expect(items(page).nth(0)).toContainText('Bookmark 1')
    await expect(items(page).nth(2)).toContainText('0:25')

    await dialog.getByTestId('bookmark-here').click() // at the playhead, 2 s: it goes first and takes the first free number
    await expect(items(page)).toHaveCount(4)
    await expect(items(page).nth(0)).toContainText('0:02')
    await expect(items(page).nth(0)).toContainText('Bookmark 4')

    await items(page).nth(2).locator('[data-bookmark]').click() // 15 s
    await expect(dialog).toBeHidden()
    await expect(app.seekBar).toHaveValue('15')
  })

  test('a bookmark is renamed with a question that starts on its name, and the name is kept; cancelling changes nothing', async ({ page }) => {
    const key = await openTrack()
    await markAt(5, 15)
    await app.key('c')
    await expect(list(page)).toBeVisible()

    await items(page).nth(0).getByRole('button', { name: 'Rename bookmark Bookmark 1' }).click()
    await expect(app.question.getByRole('textbox')).toHaveValue('Bookmark 1')
    await app.answerDialog(false)
    await expect(items(page).nth(0)).toContainText('Bookmark 1')

    await items(page).nth(0).getByRole('button', { name: 'Rename bookmark Bookmark 1' }).click()
    await app.answerDialog(true, '  The   plot\u0000 thickens ')
    await expect(items(page).nth(0)).toContainText('The plot thickens')
    await expect.poll(() => labels(key)).toEqual(['The plot thickens', 'Bookmark 2'])

    await items(page).nth(1).getByRole('button', { name: 'Rename bookmark Bookmark 2' }).click()
    await app.answerDialog(true, '   ')
    await expect(app.toast('A bookmark needs a name.')).toBeVisible()
    await expect(items(page).nth(1)).toContainText('Bookmark 2')
    await expect(list(page)).toBeVisible() // the question closed over the list without closing it
  })

  test('deleting a bookmark offers an Undo that puts it back in its place; the focus moves on to the next one', async ({ page }) => {
    const key = await openTrack()
    await markAt(5, 15, 25)
    await app.key('c')
    await expect(items(page)).toHaveCount(3)

    await items(page).nth(1).getByRole('button', { name: 'Delete bookmark Bookmark 2' }).click()
    await expect(app.toast('Deleted bookmark “Bookmark 2”')).toBeVisible()
    await expect(items(page)).toHaveCount(2)
    await expect(items(page).nth(1).locator('[data-bookmark]')).toBeFocused() // the one that took its place, not the page behind
    await expect.poll(() => times(key)).toEqual([5, 25])

    await app.toast(/Deleted bookmark/).getByRole('button', { name: 'Undo' }).click()
    await expect(items(page)).toHaveCount(3)
    await expect(items(page).nth(1)).toContainText('Bookmark 2')
    await expect.poll(() => times(key)).toEqual([5, 15, 25])
  })

  test('the keys work in the list: arrows move between bookmarks, F2 renames, Delete removes, and Ctrl+Z brings it back', async ({ page }) => {
    const key = await openTrack()
    await markAt(5, 15, 25)
    await app.key('c')
    const first = items(page).nth(0).locator('[data-bookmark]')
    await expect(first).toBeVisible()
    await first.focus()

    await page.keyboard.press('ArrowDown')
    await expect(items(page).nth(1).locator('[data-bookmark]')).toBeFocused()
    expect(await app.position()).toBe(25) // the arrows were for the list: the track behind it did not seek

    await page.keyboard.press('F2')
    await expect(app.question.getByRole('textbox')).toHaveValue('Bookmark 2')
    await app.answerDialog(true, 'Middle')
    await expect(items(page).nth(1)).toContainText('Middle')

    await items(page).nth(1).locator('[data-bookmark]').focus()
    await page.keyboard.press('Delete')
    await expect(items(page)).toHaveCount(2)
    await expect(items(page).nth(1).locator('[data-bookmark]')).toBeFocused()
    await page.keyboard.press('Control+z')
    await expect(items(page)).toHaveCount(3)
    await expect(items(page).nth(1)).toContainText('Middle')
    await expect.poll(() => labels(key)).toEqual(['Bookmark 1', 'Middle', 'Bookmark 3'])
  })

  test('reads what is stored as untrusted: a damaged record shows what can be read, and the next change mends it', async () => {
    const key = await openTrack()
    await app.putMeta(`listen:${key}`, {
      v: 1,
      at: 'long ago',
      bookmarks: [null, 4, { t: -1, label: 'before the start' }, { t: 'soon' }, { t: 9, label: 'Keep\u0000 me', id: 'a', extra: true }, { t: 9.1, label: 'same place', id: 'b' }, { t: 22, id: 5 }],
    })
    await app.reload()
    await app.play('long')
    await expect(opener()).toHaveAccessibleName('Chapters and bookmarks, 2 bookmarks')
    await app.playButton.click()
    await app.expectPaused()

    await app.seekTo(14)
    await app.key('b')
    await expect.poll(() => times(key)).toEqual([9, 14, 22])
    const record = await kept(key)
    expect(record?.v).toBe(1)
    expect(record?.at).toEqual(expect.any(Number))
    // the one read without a name was called "Bookmark 1" when it was read; the new one takes the next free number
    expect(record?.bookmarks.map((b) => b.label)).toEqual(['Keep me', 'Bookmark 2', 'Bookmark 1'])
    expect(new Set(record?.bookmarks.map((b) => b.id)).size).toBe(3)
    expect(record?.bookmarks.every((b) => Object.keys(b).sort().join() === 'at,id,label,t')).toBe(true)
  })

  test('goes into a backup file as a place and a name, and comes back from it without doubling', async ({ page }) => {
    const key = await openTrack()
    await markAt(7, 21)
    await expect.poll(() => times(key)).toEqual([7, 21])

    await app.openTools()
    const [download] = await Promise.all([page.waitForEvent('download'), app.tools.getByRole('button', { name: 'Export backup' }).click()])
    const chunks: Buffer[] = []
    for await (const chunk of await download.createReadStream()) chunks.push(chunk as Buffer)
    const raw = Buffer.concat(chunks)
    const data = JSON.parse(raw.toString('utf8')) as { tracks: { key: string; bookmarks?: unknown[] }[] }
    expect(data.tracks[0]?.key).toBe(key)
    expect(data.tracks[0]?.bookmarks).toEqual([
      { t: 7, label: 'Bookmark 1' },
      { t: 21, label: 'Bookmark 2' },
    ])
    await app.closeTools()

    // delete them both, then restore the file
    await app.key('c')
    await items(page).nth(1).getByRole('button', { name: 'Delete bookmark Bookmark 2' }).click()
    await items(page).nth(0).getByRole('button', { name: 'Delete bookmark Bookmark 1' }).click()
    await expect(items(page)).toHaveCount(0)
    await page.keyboard.press('Escape')
    await expect(row()).toHaveCount(0)
    await expect.poll(() => kept(key)).toBeUndefined()

    await app.openTools()
    await app.tools.getByLabel('Backup file').setInputFiles({ name: 'backup.json', mimeType: 'application/json', buffer: raw })
    const preview = app.tools.getByRole('group', { name: 'Restore preview' })
    await expect(preview).toContainText('Bookmarks: 2 bookmarks in 1 track; the ones you do not have yet will be added.')
    await preview.getByRole('button', { name: 'Restore' }).click()
    await expect(app.tools.getByText('Bookmarks: 2 new bookmarks added.')).toBeVisible()
    await expect.poll(() => times(key)).toEqual([7, 21])
    await app.closeTools()
    await expect(opener()).toHaveAccessibleName('Chapters and bookmarks, 2 bookmarks') // on screen at once, without a reload

    // the same file again adds nothing, and a bookmark made now is not lost to an older list
    await app.openTools()
    await app.tools.getByLabel('Backup file').setInputFiles({ name: 'backup.json', mimeType: 'application/json', buffer: raw })
    await preview.getByRole('button', { name: 'Restore' }).click()
    await expect(app.tools.getByText('Bookmarks: 0 new bookmarks added (the others were there already).')).toBeVisible()
    await app.closeTools()
    await app.seekTo(14)
    await app.key('b')
    await expect.poll(() => times(key)).toEqual([7, 14, 21])
  })

  test('restores the bookmarks of a file that is not in the library yet: they are there when the file is added', async () => {
    await app.open()
    const file = wav('long')
    const key = libraryKey(file, MTIME)
    const backup = Buffer.from(
      JSON.stringify({
        format: 'wavelocal-backup',
        version: 1,
        exportedAt: '2026-10-01T10:00:00.000Z',
        tracks: [{ key, name: 'long.wav', title: 'long', duration: 30, bookmarks: [{ t: 9, label: 'From the backup' }, { t: 500, label: 'beyond the end' }, 'junk'] }],
        playlists: [],
      }),
    )
    await app.openTools()
    await app.tools.getByLabel('Backup file').setInputFiles({ name: 'backup.json', mimeType: 'application/json', buffer: backup })
    const preview = app.tools.getByRole('group', { name: 'Restore preview' })
    await expect(preview).toContainText('Bookmarks: 1 bookmark in 1 track')
    await preview.getByRole('button', { name: 'Restore' }).click()
    await expect(app.tools.getByText('Bookmarks: 1 new bookmark added.')).toBeVisible()
    await app.closeTools()
    await expect.poll(() => labels(key)).toEqual(['From the backup'])

    await importWithMtime(app, [file], MTIME)
    await expect(app.rows).toHaveCount(1)
    await app.play('long')
    await expect(opener()).toHaveAccessibleName('Chapters and bookmarks, 1 bookmark')
  })
})
