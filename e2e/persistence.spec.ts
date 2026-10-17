import { expect, test } from '@playwright/test'
import { PlayerPage, wav } from './helpers'

test.describe('persistence across reloads', () => {
  let app: PlayerPage

  test.beforeEach(async ({ page }) => {
    app = new PlayerPage(page)
    await app.open()
  })

  test('library, order and playable audio survive a reload', async () => {
    await app.importFiles(wav('tone-440', 'a.wav'), wav('tone-880', 'b.wav'), wav('sweep', 'c.wav'))
    await app.row('c').dragTo(app.row('a'))
    await expect.poll(() => app.titles()).toEqual(['c', 'a', 'b'])
    await app.page.waitForTimeout(400) // let the order write finish

    await app.reload()
    await expect(app.rows).toHaveCount(3)
    expect(await app.titles()).toEqual(['c', 'a', 'b'])
    await expect(app.viewSelect.locator('option[value="all"]')).toHaveText('Library (3)')

    // the stored audio blobs are real: playback works after the reload
    await app.play('b')
    await expect.poll(() => app.position(), { timeout: 8_000 }).toBeGreaterThanOrEqual(1)
  })

  test('playlists survive a reload', async () => {
    await app.importFiles(wav('tone-440', 'a.wav'), wav('tone-880', 'b.wav'))
    await app.viewSelect.selectOption('__new')
    await app.answerDialog(true, 'Keepers')
    await app.viewSelect.selectOption('all')
    await app.row('b').hover()
    await app.row('b').getByRole('button', { name: 'Add b to playlist' }).click()
    await app.page.getByRole('menuitem', { name: 'Keepers' }).click()
    await expect(app.viewSelect.locator('option', { hasText: 'Keepers' })).toHaveText('Keepers (1)')
    await app.page.waitForTimeout(400)

    await app.reload()
    await expect(app.viewSelect.locator('option', { hasText: 'Keepers' })).toHaveText('Keepers (1)')
    await app.viewSelect.selectOption({ label: 'Keepers (1)' })
    expect(await app.titles()).toEqual(['b'])
  })

  test('the current track and playback position are resumed', async () => {
    await app.importFiles(wav('tone-440', 'a.wav'), wav('long', 'z-long.wav'))
    await app.play('z-long')
    await app.playButton.click() // pause: this is what writes the resume point
    await app.seekTo(10)
    await expect.poll(() => app.position()).toBe(10)
    await app.playButton.click()
    await app.playButton.click() // play + pause again so the saved time is the sought one
    await app.expectPaused()
    await app.page.waitForTimeout(500)

    await app.reload()
    await expect(app.nowPlayingTitle).toHaveText('z-long')
    await app.expectPaused() // restoring a session never auto-plays
    await expect.poll(() => app.position(), { timeout: 8_000 }).toBeGreaterThanOrEqual(10)
    expect(await app.position()).toBeLessThan(13)
  })

  test('removed tracks stay removed', async () => {
    await app.importFiles(wav('tone-440', 'a.wav'), wav('tone-880', 'b.wav'))
    await app.row('a').hover()
    await app.row('a').getByRole('button', { name: 'Remove a' }).click()
    await expect(app.rows).toHaveCount(1)
    await app.page.waitForTimeout(400)

    await app.reload()
    await expect(app.rows).toHaveCount(1)
    expect(await app.titles()).toEqual(['b'])
  })

  test('clearing the library persists', async () => {
    await app.importFiles(wav('tone-440', 'a.wav'))
    await app.sidebar.getByRole('button', { name: 'Clear library' }).click()
    await app.answerDialog(true)
    await expect(app.rows).toHaveCount(0)
    await app.page.waitForTimeout(400)

    await app.reload()
    await expect(app.rows).toHaveCount(0)
    await expect(app.viewSelect.locator('option[value="all"]')).toHaveText('Library (0)')
  })

  test('settings (repeat, shuffle, volume, speed, EQ, accent) survive a reload', async () => {
    await app.importFiles(wav('tone-440', 'a.wav'))
    await app.key('r')
    await app.key('r') // off -> all -> one
    await app.key('s')
    await app.footer.getByRole('slider', { name: 'Volume' }).fill('0.4')

    await app.openTools()
    await app.tools.getByRole('button', { name: 'Rock', exact: true }).click()
    await app.tools.getByRole('slider', { name: 'Playback speed' }).fill('1.5')
    await app.tools.getByRole('button', { name: 'Pink' }).click()
    await app.closeTools()

    await app.reload()
    await expect(app.footer.getByRole('button', { name: 'Repeat: one (R)' })).toBeVisible()
    await expect(app.footer.getByRole('button', { name: /^Shuffle/ })).toHaveAttribute('aria-pressed', 'true')
    await expect(app.footer.getByRole('slider', { name: 'Volume' })).toHaveValue('0.4')

    await app.openTools()
    await expect(app.tools.getByRole('button', { name: 'Rock', exact: true })).toHaveAttribute('aria-pressed', 'true')
    await expect(app.tools.getByRole('slider', { name: 'Playback speed' })).toHaveValue('1.5')
    await expect(app.tools.getByRole('button', { name: 'Pink' })).toHaveAttribute('aria-pressed', 'true')
    await expect(app.page.locator('html')).toHaveCSS('--accent-hex', '#f472b6')
  })
})
