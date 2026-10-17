import { expect, test } from '@playwright/test'
import { PlayerPage, wav } from './helpers'

test.describe('playlists', () => {
  let app: PlayerPage

  test.beforeEach(async ({ page }) => {
    app = new PlayerPage(page)
    await app.open()
    await app.importFiles(wav('tone-440', 'a.wav'), wav('tone-880', 'b.wav'), wav('sweep', 'c.wav'))
    await expect(app.rows).toHaveCount(3)
  })

  /** Create a playlist through the view selector and return its option locator. */
  async function createPlaylist(name: string) {
    await app.viewSelect.selectOption('__new')
    await app.answerDialog(true, name)
    const option = app.viewSelect.locator('option', { hasText: name })
    await expect(option).toHaveText(`${name} (0)`)
    return option
  }

  async function addToPlaylist(track: string, playlist: string) {
    await app.row(track).hover()
    await app.row(track).getByRole('button', { name: `Add ${track} to playlist` }).click()
    await app.page.getByRole('menuitem', { name: playlist }).click()
  }

  test('creating a playlist switches to it and shows the empty state', async () => {
    await createPlaylist('Road Trip')
    await expect(app.rows).toHaveCount(0)
    await expect(app.sidebar.getByText('This playlist is empty.')).toBeVisible()
  })

  test('cancelling the name prompt creates nothing', async () => {
    await app.viewSelect.selectOption('__new')
    await app.answerDialog(false)
    // Library + the four smart playlists + "New playlist…", and no playlist of the user's own
    await expect(app.viewSelect.locator('option')).toHaveCount(6)
    await expect(app.viewSelect.locator('option', { hasText: /\(\d+\)/ })).toHaveCount(5)
  })

  test('adds tracks from the library and shows them in the playlist', async () => {
    const option = await createPlaylist('Road Trip')
    await app.viewSelect.selectOption('all')
    await addToPlaylist('c', 'Road Trip')
    await addToPlaylist('a', 'Road Trip')
    await expect(option).toHaveText('Road Trip (2)')

    await app.viewSelect.selectOption({ label: 'Road Trip (2)' })
    await expect.poll(() => app.titles()).toEqual(['c', 'a']) // insertion order, not library order
  })

  test('adding the same track twice is ignored', async () => {
    const option = await createPlaylist('Dupes')
    await app.viewSelect.selectOption('all')
    await addToPlaylist('b', 'Dupes')
    await addToPlaylist('b', 'Dupes')
    await expect(option).toHaveText('Dupes (1)')
  })

  test('"New playlist…" in a row menu creates a playlist containing that track', async () => {
    await app.row('b').hover()
    await app.row('b').getByRole('button', { name: 'Add b to playlist' }).click()
    await app.page.getByRole('menuitem', { name: /New playlist/ }).click()
    await app.answerDialog(true, 'Fresh')
    await expect(app.viewSelect.locator('option', { hasText: 'Fresh' })).toHaveText('Fresh (1)')
  })

  test('playback stays inside the playlist and wraps around', async () => {
    await createPlaylist('Pair')
    await app.viewSelect.selectOption('all')
    await addToPlaylist('c', 'Pair')
    await addToPlaylist('a', 'Pair')
    await app.viewSelect.selectOption({ label: 'Pair (2)' })

    await app.play('c')
    await app.footer.getByRole('button', { name: 'Next (N)' }).click()
    await expect(app.nowPlayingTitle).toHaveText('a')
    await app.footer.getByRole('button', { name: 'Next (N)' }).click()
    await expect(app.nowPlayingTitle).toHaveText('c') // never "b": it is not in this playlist
  })

  test('removing a track from a playlist keeps it in the library', async () => {
    const option = await createPlaylist('Temp')
    await app.viewSelect.selectOption('all')
    await addToPlaylist('a', 'Temp')
    await app.viewSelect.selectOption({ label: 'Temp (1)' })

    await app.row('a').hover()
    await app.row('a').getByRole('button', { name: 'Remove a' }).click()
    await expect(option).toHaveText('Temp (0)')

    await app.viewSelect.selectOption('all')
    await expect.poll(() => app.titles()).toEqual(['a', 'b', 'c'])
  })

  test('reordering inside a playlist does not touch the library order', async () => {
    await createPlaylist('Order')
    await app.viewSelect.selectOption('all')
    for (const t of ['a', 'b', 'c']) await addToPlaylist(t, 'Order')
    await app.viewSelect.selectOption({ label: 'Order (3)' })

    await app.row('c').dragTo(app.row('a'))
    await expect.poll(() => app.titles()).toEqual(['c', 'a', 'b'])

    await app.viewSelect.selectOption('all')
    expect(await app.titles()).toEqual(['a', 'b', 'c'])
  })

  test('deleting a playlist returns to the library, and the toast takes it back', async () => {
    await createPlaylist('Doomed')
    await app.playlistAction('Delete playlist')
    await expect(app.viewSelect.locator('option', { hasText: 'Doomed' })).toHaveCount(0)
    await expect(app.viewSelect).toHaveValue('all')
    await expect(app.rows).toHaveCount(3)

    await app.toast('Deleted “Doomed”').getByRole('button', { name: 'Undo' }).click()
    await expect(app.viewSelect.locator('option', { hasText: 'Doomed' })).toHaveCount(1)
    await expect(app.viewSelect).toHaveValue(/^pl/) // and it is open again, as it was when it was deleted
  })

  test('deleting a library track also removes it from playlists', async () => {
    const option = await createPlaylist('Shrinking')
    await app.viewSelect.selectOption('all')
    await addToPlaylist('b', 'Shrinking')
    await expect(option).toHaveText('Shrinking (1)')

    await app.row('b').hover()
    await app.row('b').getByRole('button', { name: 'Remove b' }).click()
    await expect(option).toHaveText('Shrinking (0)')
  })

  test('renaming a playlist starts from its name, keeps it when cancelled and changes it when confirmed', async () => {
    await createPlaylist('Old')
    await app.playlistAction('Rename…')
    await expect(app.question.getByRole('textbox', { name: 'Playlist name' })).toHaveValue('Old')
    await app.answerDialog(false)
    await expect(app.viewSelect.locator('option', { hasText: 'Old' })).toHaveCount(1)

    await app.playlistAction('Rename…')
    await app.answerDialog(true, '  Brand   new ')
    await expect(app.viewSelect.locator('option', { hasText: 'Brand new' })).toHaveText('Brand new (0)')
    await expect(app.viewSelect.locator('option', { hasText: 'Old' })).toHaveCount(0)
    await expect(app.sidebar.getByRole('button', { name: 'Playlist actions' })).toBeFocused()
  })

  test('a blank name leaves the playlist as it was', async () => {
    await createPlaylist('Keep me')
    await app.playlistAction('Rename…')
    await app.answerDialog(true, '   ')
    await expect(app.viewSelect.locator('option', { hasText: 'Keep me' })).toHaveText('Keep me (0)')
  })

  test('duplicating a playlist copies its tracks right after it, and Undo takes the copy back', async () => {
    await createPlaylist('Mix')
    await app.viewSelect.selectOption('all')
    await addToPlaylist('a', 'Mix')
    await addToPlaylist('c', 'Mix')
    await app.viewSelect.selectOption({ label: 'Mix (2)' })

    await app.playlistAction('Duplicate')
    const copy = app.viewSelect.locator('option', { hasText: 'Mix copy' })
    await expect(copy).toHaveText('Mix copy (2)')
    const names = await app.viewSelect.locator('option').allTextContents()
    expect(names.indexOf('Mix copy (2)')).toBe(names.indexOf('Mix (2)') + 1)

    await app.toast('Duplicated as “Mix copy”').getByRole('button', { name: 'Undo' }).click()
    await expect(copy).toHaveCount(0)
    await expect(app.viewSelect.locator('option', { hasText: 'Mix (2)' })).toHaveCount(1)
  })

  test('the playlist menu is a menu: arrows move, Escape closes it and gives focus back', async ({ page }) => {
    await createPlaylist('Menu')
    const trigger = app.sidebar.getByRole('button', { name: 'Playlist actions' })
    await trigger.focus()
    await page.keyboard.press('Enter')
    const menu = page.getByRole('menu', { name: 'Menu playlist actions' })
    await expect(menu).toBeVisible()
    await expect(menu.getByRole('menuitem', { name: 'Rename…' })).toBeFocused()
    await page.keyboard.press('ArrowDown')
    await expect(menu.getByRole('menuitem', { name: 'Duplicate' })).toBeFocused()
    // an empty playlist has nothing to save as a file
    await expect(menu.getByRole('menuitem', { name: 'Save as M3U8 file' })).toBeDisabled()
    await expect(menu.getByRole('menuitem', { name: 'Save as PLS file' })).toBeDisabled()
    await page.keyboard.press('Escape')
    await expect(menu).toHaveCount(0)
    await expect(trigger).toBeFocused()
  })

  test('deleting a playlist hands focus to the list chooser, and Undo brings back its tracks', async () => {
    await createPlaylist('Gone')
    await app.viewSelect.selectOption('all')
    await addToPlaylist('b', 'Gone')
    await app.viewSelect.selectOption({ label: 'Gone (1)' })
    await app.playlistAction('Delete playlist')
    await expect(app.viewSelect).toBeFocused()
    await expect(app.toast('Deleted “Gone”')).toBeVisible()
    await app.page.keyboard.press('Control+z') // the chooser is a list, not a text field: Ctrl+Z is for the toast's Undo
    await expect(app.viewSelect.locator('option', { hasText: 'Gone' })).toHaveText('Gone (1)')
    await expect(app.viewSelect.locator('option:checked')).toHaveText('Gone (1)')
    await expect(app.rows).toHaveCount(1)
  })
})
