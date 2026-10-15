import { expect, test } from '@playwright/test'
import { PlayerPage, wav } from './helpers'

test.describe('importing and playback', () => {
  let app: PlayerPage

  test.beforeEach(async ({ page }) => {
    app = new PlayerPage(page)
    await app.open()
  })

  test('shows the empty state before anything is imported', async ({ page }) => {
    await expect(page.getByRole('heading', { name: 'Your music, your device.' })).toBeVisible()
    await expect(app.viewSelect.locator('option[value="all"]')).toHaveText('Library (0)')
    await expect(app.playButton).toBeDisabled()
  })

  test('imports synthetic files and lists them in natural filename order', async () => {
    await app.importFiles(wav('tone-880', 'track10.wav'), wav('tone-440', 'track2.wav'), wav('sweep', 'track1.wav'))
    await expect(app.rows).toHaveCount(3)
    expect(await app.titles()).toEqual(['track1', 'track2', 'track10'])
    await expect(app.viewSelect.locator('option[value="all"]')).toHaveText('Library (3)')
    await expect(app.nowPlayingTitle).toHaveText('track1') // first track is loaded (not playing) after the first import
    await app.expectPaused()
  })

  test('ignores duplicates and non-audio files on re-import', async () => {
    await app.importFiles(wav('tone-440'))
    await expect(app.rows).toHaveCount(1)
    await app.importFiles({ name: 'notes.txt', mimeType: 'text/plain', buffer: Buffer.from('hello') })
    await expect(app.rows).toHaveCount(1)
  })

  test('plays, advances the clock, and pauses', async () => {
    await app.importFiles(wav('long'))
    await app.play('long')
    await expect(app.nowPlayingTitle).toHaveText('long')
    await expect.poll(() => app.position(), { timeout: 8_000 }).toBeGreaterThanOrEqual(1)
    expect(await app.duration()).toBe(30)

    await app.playButton.click()
    await app.expectPaused()
    const frozen = await app.position()
    await app.page.waitForTimeout(700)
    expect(await app.position()).toBe(frozen)
  })

  test('seeks with the slider and with the arrow keys', async () => {
    await app.importFiles(wav('long'))
    await app.play('long')
    await app.playButton.click() // pause so the clock is stable
    await app.seekTo(12)
    await expect.poll(() => app.position()).toBe(12)

    await app.key('ArrowRight')
    await expect.poll(() => app.position()).toBe(17)
    await app.key('ArrowLeft')
    await expect.poll(() => app.position()).toBe(12)
  })

  test('Space toggles playback from the keyboard', async () => {
    await app.importFiles(wav('long'))
    await app.play('long')
    await app.key(' ')
    await app.expectPaused()
    await app.key(' ')
    await app.expectPlaying()
  })

  test('next and previous move through the queue', async () => {
    await app.importFiles(wav('tone-440', 'a.wav'), wav('tone-880', 'b.wav'), wav('sweep', 'c.wav'))
    await app.play('a')
    await app.footer.getByRole('button', { name: 'Next (N)' }).click()
    await expect(app.nowPlayingTitle).toHaveText('b')
    await app.key('n')
    await expect(app.nowPlayingTitle).toHaveText('c')
    await app.key('n') // wraps on a manual skip
    await expect(app.nowPlayingTitle).toHaveText('a')
    await app.footer.getByRole('button', { name: 'Previous (P)' }).click()
    await expect(app.nowPlayingTitle).toHaveText('c')
  })

  test('stops at the end of the queue with repeat off', async () => {
    await app.importFiles(wav('silence'))
    await app.play('silence')
    await expect(app.playButton).toHaveAccessibleName('Play (Space)', { timeout: 10_000 })
    await expect.poll(() => app.position()).toBe(0)
  })

  test('mute toggles from the keyboard and the button', async () => {
    await app.importFiles(wav('tone-440'))
    await app.key('m')
    await expect(app.footer.getByRole('button', { name: 'Unmute (M)' })).toBeVisible()
    await app.footer.getByRole('button', { name: 'Unmute (M)' }).click()
    await expect(app.footer.getByRole('button', { name: 'Mute (M)' })).toBeVisible()
  })

  test('the volume slider changes the level and persists the value', async () => {
    await app.importFiles(wav('tone-440'))
    const volume = app.footer.getByRole('slider', { name: 'Volume' })
    await volume.fill('0.25')
    await expect(volume).toHaveValue('0.25')
    await app.reload()
    await expect(app.footer.getByRole('slider', { name: 'Volume' })).toHaveValue('0.25')
  })
})
