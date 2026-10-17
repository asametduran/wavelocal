import { readFile } from 'node:fs/promises'
import { expect, test } from '@playwright/test'
import { PlayerPage, song } from './helpers'
import type { Upload } from './helpers'

/** A playlist file as an upload. */
const list = (name: string, text: string, mimeType = 'audio/x-mpegurl'): Upload => ({ name, mimeType, buffer: Buffer.from(text, 'utf8') })

/** Tagged MP3s, numbered because an import adds files in name order (and that is the order the library keeps them in). */
const MUSIC = [
  song('01-alpha.mp3', { title: 'Alpha', artist: 'Ann' }),
  song('02-bravo.mp3', { title: 'Bravo', artist: 'Bob' }),
  song('03-charlie.mp3', { title: 'Charlie', artist: 'Cy' }),
]

test.describe('playlist files', () => {
  let app: PlayerPage

  test.beforeEach(async ({ page }) => {
    app = new PlayerPage(page)
    await app.open()
    await app.importFiles(...MUSIC)
    await expect(app.rows).toHaveCount(3)
  })

  const option = (text: string) => app.viewSelect.locator('option', { hasText: text })

  test('an M3U8 file becomes a playlist of the tracks it names, in its order', async () => {
    await app.importFiles(list('Road trip.m3u8', '#EXTM3U\n#EXTINF:5,Cy - Charlie\n03-charlie.mp3\n#EXTINF:5,Ann - Alpha\n01-alpha.mp3\n'))
    await expect(app.toast('Imported “Road trip”: 2 tracks')).toBeVisible()
    await expect(option('Road trip')).toHaveText('Road trip (2)')
    await expect(app.viewSelect).toHaveValue(/^pl/)
    expect(await app.titles()).toEqual(['Charlie', 'Alpha'])
  })

  test('paths from another system, another extension and another name are all found', async () => {
    await app.importFiles(
      list(
        'Mixed.m3u',
        [
          'C:\\Users\\me\\Music\\Rock\\02-bravo.flac', // Windows path, different extension
          '#EXTINF:5,Cy - Charlie',
          '/storage/emulated/0/renamed-by-the-phone.mp3', // only the artist and title tell
          '',
        ].join('\r\n'),
      ),
    )
    await expect(option('Mixed')).toHaveText('Mixed (2)')
    expect(await app.titles()).toEqual(['Bravo', 'Charlie'])
  })

  test('tracks the library does not have are listed, and the rest still makes the playlist', async ({ page }) => {
    await app.importFiles(list('Partial.m3u8', '#EXTM3U\n01-alpha.mp3\nnot-here-1.mp3\n#EXTINF:5,Zed - Not here either\nsomewhere/else.mp3\n'))
    const notice = page.getByRole('dialog', { name: 'Imported “Partial”' })
    await expect(notice).toBeVisible()
    await expect(notice).toContainText('1 of 3 tracks were found')
    await expect(notice).toContainText('not-here-1.mp3')
    await expect(notice).toContainText('Zed - Not here either')
    await app.answerDialog(true)
    await expect(option('Partial')).toHaveText('Partial (1)')
  })

  test('a playlist whose tracks are all missing says so and makes nothing', async ({ page }) => {
    const before = await app.viewSelect.locator('option').count()
    await app.importFiles(list('Empty hand.m3u8', 'nowhere/one.mp3\nnowhere/two.mp3\n'))
    const notice = page.getByRole('dialog', { name: /Nothing to import/ })
    await expect(notice).toContainText('None of its 2 tracks are in your library yet')
    await app.answerDialog(true)
    await expect(app.viewSelect.locator('option')).toHaveCount(before)
  })

  test('a PLS file works too, and internet streams in it are skipped and said so', async ({ page }) => {
    await app.importFiles(
      list(
        'Radio.pls',
        ['[playlist]', 'File1=02-bravo.mp3', 'Title1=Bob - Bravo', 'Length1=5', 'File2=http://example.com/stream', 'Title2=Some radio', 'Length2=-1', 'NumberOfEntries=2', 'Version=2'].join('\n'),
        'audio/x-scpls',
      ),
    )
    const notice = page.getByRole('dialog', { name: 'Imported “Radio”' })
    await expect(notice).toContainText('skipped')
    await app.answerDialog(true)
    await expect(option('Radio')).toHaveText('Radio (1)')
    expect(await app.titles()).toEqual(['Bravo'])
  })

  test('music and a playlist chosen together: the music goes in first, so the playlist finds it', async () => {
    const fresh = [song('10-delta.mp3', { title: 'Delta', artist: 'Di' }), song('11-echo.mp3', { title: 'Echo', artist: 'Ed' })]
    await app.importFiles(...fresh, list('Both.m3u8', '11-echo.mp3\n10-delta.mp3\n'))
    await expect(option('Both')).toHaveText('Both (2)')
    expect(await app.titles()).toEqual(['Echo', 'Delta'])
  })

  test('two playlist files with the same name do not overwrite each other', async () => {
    await app.importFiles(list('Same.m3u8', '01-alpha.mp3\n'))
    await expect(option('Same')).toHaveText('Same (1)')
    await app.importFiles(list('Same.m3u8', '02-bravo.mp3\n'))
    await expect(option('Same 2')).toHaveText('Same 2 (1)')
  })

  test('a file that is not a playlist, or that has nothing in it, is told so', async () => {
    await app.importFiles(list('Blank.m3u8', '#EXTM3U\n\n'))
    await expect(app.toast('Blank.m3u8 has no tracks in it')).toBeVisible()
  })

  test('a playlist is saved as an M3U8 file that other players read, and reading it back finds the same tracks', async ({ page }) => {
    await app.importFiles(list('Out.m3u8', '03-charlie.mp3\n01-alpha.mp3\n'))
    await expect(option('Out')).toHaveText('Out (2)')

    const download = page.waitForEvent('download')
    await app.playlistAction('Save as M3U8 file')
    const file = await download
    expect(file.suggestedFilename()).toBe('Out.m3u8')
    const text = await readFile(await file.path(), 'utf8')
    // the lengths are the whole seconds each file lasts: the import reads them from the headers, so none is "unknown" (-1)
    expect(text).toMatch(/^#EXTM3U\n#PLAYLIST:Out\n#EXTINF:[1-9]\d*,Cy - Charlie\n03-charlie\.mp3\n#EXTINF:[1-9]\d*,Ann - Alpha\n01-alpha\.mp3\n$/)
    await expect(app.toast('Exported 2 tracks as Out.m3u8')).toBeVisible()

    // delete it, then read the saved file back in
    await app.playlistAction('Delete playlist')
    await expect(option('Out')).toHaveCount(0)
    await app.importFiles({ name: 'Out.m3u8', mimeType: 'audio/x-mpegurl', buffer: Buffer.from(text, 'utf8') })
    await expect(option('Out')).toHaveText('Out (2)')
    expect(await app.titles()).toEqual(['Charlie', 'Alpha'])
  })

  test('a playlist is saved as a PLS file too', async ({ page }) => {
    await app.importFiles(list('Out.m3u8', '02-bravo.mp3\n'))
    const download = page.waitForEvent('download')
    await app.playlistAction('Save as PLS file')
    const file = await download
    expect(file.suggestedFilename()).toBe('Out.pls')
    const text = await readFile(await file.path(), 'utf8')
    expect(text).toContain('[playlist]')
    expect(text).toContain('File1=02-bravo.mp3')
    expect(text).toContain('NumberOfEntries=1')
  })
})
