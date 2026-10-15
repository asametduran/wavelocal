import { expect, test } from '@playwright/test'
import { PlayerPage, tone, wav } from './helpers'

test.describe('queue management', () => {
  let app: PlayerPage

  test.beforeEach(async ({ page }) => {
    app = new PlayerPage(page)
    await app.open()
    await app.importFiles(wav('tone-440', 'a.wav'), wav('tone-880', 'b.wav'), wav('sweep', 'c.wav'))
    await expect(app.rows).toHaveCount(3)
  })

  test('drag and drop reorders the queue and the new order drives playback', async () => {
    await app.row('c').dragTo(app.row('a'))
    await expect.poll(() => app.titles()).toEqual(['c', 'a', 'b'])

    await app.play('c')
    await app.footer.getByRole('button', { name: 'Next (N)' }).click()
    await expect(app.nowPlayingTitle).toHaveText('a')
  })

  test('moving a track down works too', async () => {
    await app.row('a').dragTo(app.row('c'))
    await expect.poll(() => app.titles()).toEqual(['b', 'c', 'a'])
  })

  test('search filters by title and artist, and shows a message when nothing matches', async () => {
    await app.search.fill('b')
    await expect.poll(() => app.titles()).toEqual(['b'])

    await app.search.fill('unknown') // every track has the "Unknown Artist" fallback
    await expect(app.rows).toHaveCount(3)

    await app.search.fill('zzz-no-such-track')
    await expect(app.rows).toHaveCount(0)
    await expect(app.sidebar.getByText('No tracks match your search.')).toBeVisible()
  })

  test('Escape clears the search and the "/" shortcut focuses it', async () => {
    await app.search.fill('a')
    await app.search.press('Escape')
    await expect(app.search).toHaveValue('')
    await expect(app.rows).toHaveCount(3)

    await app.key('/')
    await expect(app.search).toBeFocused()
  })

  test('rows are not draggable while a search is active', async () => {
    await expect(app.rows.first()).toHaveAttribute('draggable', 'true')
    await app.search.fill('a')
    await expect(app.rows.first()).toHaveAttribute('draggable', 'false')
  })

  test('removing a track updates the library', async () => {
    await app.row('b').hover()
    await app.row('b').getByRole('button', { name: 'Remove b' }).click()
    await expect.poll(() => app.titles()).toEqual(['a', 'c'])
    await expect(app.viewSelect.locator('option[value="all"]')).toHaveText('Library (2)')
  })

  test('removing the playing track moves on to the next one and keeps playing', async () => {
    await app.play('a')
    await app.row('a').hover()
    await app.row('a').getByRole('button', { name: 'Remove a' }).click()
    await expect(app.nowPlayingTitle).toHaveText('b')
    await app.expectPlaying()
    await expect.poll(() => app.titles()).toEqual(['b', 'c'])
  })

  test('removing the last remaining track empties the player', async ({ page }) => {
    await app.sidebar.getByRole('button', { name: 'Clear library' }).click({ trial: true })
    for (const name of ['c', 'b', 'a']) {
      await app.row(name).hover()
      await app.row(name).getByRole('button', { name: `Remove ${name}` }).click()
    }
    await expect(app.rows).toHaveCount(0)
    await expect(app.nowPlayingTitle).toHaveText('Nothing playing')
    await expect(page.getByRole('heading', { name: 'Your music, your device.' })).toBeVisible()
  })

  test('clearing the library asks for confirmation', async () => {
    const clear = app.sidebar.getByRole('button', { name: 'Clear library' })

    app.answerNextDialog(false)
    await clear.click()
    await expect(app.rows).toHaveCount(3)

    app.answerNextDialog(true)
    await clear.click()
    await expect(app.rows).toHaveCount(0)
    await expect(app.viewSelect.locator('option[value="all"]')).toHaveText('Library (0)')
  })
})

test.describe('large libraries', () => {
  test('only a window of rows is rendered, yet every track is reachable', async ({ page }) => {
    const app = new PlayerPage(page)
    await app.open()
    const count = 300
    await app.importFiles(...Array.from({ length: count }, (_, i) => tone(`song-${String(i).padStart(4, '0')}.wav`)))
    await expect(app.viewSelect.locator('option[value="all"]')).toHaveText(`Library (${count})`, { timeout: 20_000 })

    const rendered = await app.rows.count()
    expect(rendered).toBeGreaterThan(5)
    expect(rendered).toBeLessThan(60) // virtualized: nowhere near 300 DOM rows

    await app.sidebar.locator('ul').evaluate((el) => el.scrollTo({ top: el.scrollHeight }))
    await expect(app.row(`song-${String(count - 1).padStart(4, '0')}`)).toBeVisible()
    await expect(app.row('song-0000')).toHaveCount(0)
  })
})
