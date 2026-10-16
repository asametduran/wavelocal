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
    app.answerNextDialog(true, name)
    await app.viewSelect.selectOption('__new')
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
    app.answerNextDialog(false)
    await app.viewSelect.selectOption('__new')
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
    app.answerNextDialog(true, 'Fresh')
    await app.page.getByRole('menuitem', { name: /New playlist/ }).click()
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

  test('deleting a playlist asks first, then returns to the library', async () => {
    await createPlaylist('Doomed')
    const del = app.sidebar.getByRole('button', { name: 'Delete playlist' })

    app.answerNextDialog(false)
    await del.click()
    await expect(app.viewSelect.locator('option', { hasText: 'Doomed' })).toHaveCount(1)

    app.answerNextDialog(true)
    await del.click()
    await expect(app.viewSelect.locator('option', { hasText: 'Doomed' })).toHaveCount(0)
    await expect(app.viewSelect).toHaveValue('all')
    await expect(app.rows).toHaveCount(3)
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
})
