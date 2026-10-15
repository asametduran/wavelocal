import { expect, test } from '@playwright/test'
import { PlayerPage, wav } from './helpers'

test.describe('track transitions', () => {
  let app: PlayerPage

  test.beforeEach(async ({ page }) => {
    app = new PlayerPage(page)
    await app.open()
    await app.importFiles(wav('tone-440', 'a.wav'), wav('tone-880', 'b.wav'), wav('sweep', 'c.wav'))
    await expect(app.rows).toHaveCount(3)
  })

  async function chooseTransition(label: 'Off' | 'Gapless' | 'Crossfade') {
    await app.openTools()
    await app.tools.getByRole('radio', { name: label }).click()
    await expect(app.tools.getByRole('radio', { name: label })).toHaveAttribute('aria-checked', 'true')
    await app.closeTools()
  }

  test('with transitions off, the next track starts when the current one ends', async () => {
    await app.play('a')
    await expect(app.nowPlayingTitle).toHaveText('b', { timeout: 10_000 })
    await app.expectPlaying()
  })

  test('crossfade overlaps two decks and then settles on the next track', async ({ page }) => {
    await chooseTransition('Crossfade')
    await app.play('a')

    // 4 s tracks => a 2 s overlap: both media elements must be audible at the same time
    await page.waitForFunction(() => [...window.__probe.media].filter((m) => !m.paused).length === 2, undefined, { timeout: 10_000 })
    await expect(app.nowPlayingTitle).toHaveText('b')

    await expect.poll(() => app.playingElements(), { timeout: 8_000 }).toBe(1) // the faded-out deck is released
    await app.expectPlaying()
  })

  test('gapless hands over to the next track without stopping playback', async () => {
    await chooseTransition('Gapless')
    await app.play('a')
    await expect(app.nowPlayingTitle).toHaveText('b', { timeout: 10_000 })
    await app.expectPlaying()
    await expect.poll(() => app.position()).toBeLessThan(3)
  })

  test('the transition mode is remembered across a reload', async () => {
    await chooseTransition('Crossfade')
    await app.reload()
    await app.openTools()
    await expect(app.tools.getByRole('radio', { name: 'Crossfade' })).toHaveAttribute('aria-checked', 'true')
  })

  test('repeat-one loops the same track', async () => {
    await app.key('r')
    await app.key('r')
    await expect(app.footer.getByRole('button', { name: 'Repeat: one (R)' })).toBeVisible()
    await app.play('a')
    await app.page.waitForTimeout(6000) // longer than the 4 s track
    await expect(app.nowPlayingTitle).toHaveText('a')
    await app.expectPlaying()
  })

  test('repeat-all wraps from the last track to the first', async () => {
    await app.key('r') // off -> all
    await expect(app.footer.getByRole('button', { name: 'Repeat: all (R)' })).toBeVisible()
    await app.play('c')
    await expect(app.nowPlayingTitle).toHaveText('a', { timeout: 10_000 })
    await app.expectPlaying()
  })

  test('shuffle never repeats the current track on next', async () => {
    await app.key('s')
    await expect(app.footer.getByRole('button', { name: /^Shuffle/ })).toHaveAttribute('aria-pressed', 'true')
    await app.play('a')
    let previous = 'a'
    for (let i = 0; i < 6; i++) {
      await app.key('n')
      await expect(app.nowPlayingTitle).not.toHaveText(previous)
      previous = await app.nowPlayingTitle.innerText()
    }
  })

  test('previous in shuffle mode walks back through the tracks just played', async () => {
    await app.key('s')
    await app.play('a')
    await app.key('n')
    const second = await app.nowPlayingTitle.innerText()
    await app.key('n')
    await expect(app.nowPlayingTitle).not.toHaveText(second)

    // pause first: Previous within 3 s of a track's start steps back through the shuffle history
    await app.playButton.click()
    await app.footer.getByRole('button', { name: 'Previous (P)' }).click()
    await expect(app.nowPlayingTitle).toHaveText(second)
  })
})
