import { expect, test } from '@playwright/test'
import { PlayerPage, heldTimes, holdFiles, releaseFiles, wav } from './helpers'

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

  test('a seek made before the browser knows the length of the file is kept and made when it does, not dropped', async ({ page }) => {
    // the track is current but the browser has not read the file yet, so it cannot say how long it is (a slow disk, a busy
    // phone, the page just restored): the library knows the length from the file's header, so the bar can be used already
    await holdFiles(page)
    await app.reload()
    await app.importFiles(wav('long'))
    await expect(app.rows).toHaveCount(1)
    await expect.poll(() => app.duration()).toBe(30)

    await app.seekBar.fill('12')
    await expect(app.seekBar).toHaveValue('12') // the bar goes where it was sent, it does not snap back
    await expect.poll(() => app.position()).toBe(12)

    await releaseFiles(page)
    await expect.poll(async () => Math.max(...(await heldTimes(page)))).toBeCloseTo(12, 0) // and the file is there when it can be
    await expect(app.seekBar).toHaveValue('12')
  })

  test('a seek that was waiting for one track is not carried over to the next one', async ({ page }) => {
    await holdFiles(page)
    await app.reload()
    await app.importFiles(wav('long', 'a.wav'), wav('long', 'b.wav'))
    await expect(app.rows).toHaveCount(2)
    await expect.poll(() => app.duration()).toBe(30)
    await app.seekBar.fill('12') // meant for a, which is not ready

    await app.row('b').locator('button[aria-current]').click() // the person moves on to b before a was ready
    await expect(app.nowPlayingTitle).toHaveText('b')
    await releaseFiles(page)
    await expect.poll(async () => (await heldTimes(page)).length).toBeGreaterThan(0)
    await page.waitForTimeout(800)
    expect(Math.max(...(await heldTimes(page)))).toBeLessThan(6) // b starts at its beginning, not at 12
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
