import { expect, test } from '@playwright/test'
import { PlayerPage, lrc, wav } from './helpers'

const LINES = [
  [0.3, 'first line'],
  [1.5, 'second line'],
  [2.7, 'third line'],
] as const

test.describe('synced lyrics', () => {
  let app: PlayerPage

  test.beforeEach(async ({ page }) => {
    app = new PlayerPage(page)
    await app.open()
  })

  const lyricsTab = () => app.stage.getByRole('tab', { name: 'Lyrics' })
  const line = (text: string) => app.stage.getByRole('button', { name: text, exact: true })
  const activeLine = () => app.stage.locator('button.scale-105')

  async function openLyrics() {
    await lyricsTab().click()
    await expect(lyricsTab()).toHaveAttribute('aria-selected', 'true')
  }

  test('a sidecar .lrc with the same name is paired and shown', async () => {
    await app.importFiles(wav('tone-440', 'song.wav'), lrc('song.lrc', LINES))
    await openLyrics()
    for (const [, text] of LINES) await expect(line(text)).toBeVisible()
  })

  test('the active line follows playback in real time', async () => {
    await app.importFiles(wav('tone-440', 'song.wav'), lrc('song.lrc', LINES))
    await openLyrics()
    await app.play('song')
    await expect(activeLine()).toHaveText('first line', { timeout: 5_000 })
    await expect(activeLine()).toHaveText('second line', { timeout: 5_000 })
    await expect(activeLine()).toHaveText('third line', { timeout: 5_000 })
  })

  test('seeking moves the highlight', async () => {
    await app.importFiles(wav('tone-440', 'song.wav'), lrc('song.lrc', LINES))
    await openLyrics()
    await app.play('song')
    await app.playButton.click() // pause
    await app.seekTo(2.9)
    await expect(activeLine()).toHaveText('third line')
    await app.seekTo(1)
    await expect(activeLine()).toHaveText('first line')
  })

  test('clicking a line seeks to its timestamp', async () => {
    await app.importFiles(wav('tone-440', 'song.wav'), lrc('song.lrc', LINES))
    await openLyrics()
    await app.play('song')
    await app.playButton.click()
    await expect.poll(() => app.duration()).toBeGreaterThan(3)
    await line('second line').click()
    await expect(activeLine()).toHaveText('second line')
    await expect.poll(() => app.position()).toBe(1)
  })

  test('lyrics are stored with the track and survive a reload', async () => {
    await app.importFiles(wav('tone-440', 'song.wav'), lrc('song.lrc', LINES))
    // wait until the track and its lyrics are saved: a reload before that finds an empty library
    await expect.poll(() => app.storedTracks()).toMatchObject([{ name: 'song.wav', lyrics: true }])
    await app.reload()
    await openLyrics()
    await expect(line('third line')).toBeVisible()
  })
})

test.describe('other lyric sources', () => {
  let app: PlayerPage

  test.beforeEach(async ({ page }) => {
    app = new PlayerPage(page)
    await app.open()
  })

  const lyricsTab = () => app.stage.getByRole('tab', { name: 'Lyrics' })

  test('a track without lyrics offers to load a file, which then attaches to it', async () => {
    await app.importFiles(wav('tone-440', 'bare.wav'))
    await lyricsTab().click()
    await expect(app.stage.getByText('No lyrics for this track.')).toBeVisible()

    await app.stage.locator('input[type=file]').setInputFiles(lrc('whatever.lrc', LINES))
    await expect(app.stage.getByRole('button', { name: 'second line', exact: true })).toBeVisible()
    await expect(app.stage.getByText('No lyrics for this track.')).toHaveCount(0)
  })

  test('an unmatched .lrc imported alone attaches to the current track', async () => {
    await app.importFiles(wav('tone-440', 'only.wav'))
    await app.importFiles(lrc('unrelated-name.lrc', LINES))
    await lyricsTab().click()
    await expect(app.stage.getByRole('button', { name: 'first line', exact: true })).toBeVisible()
  })

  test('plain (unsynced) lyrics are shown but not clickable or highlighted', async () => {
    await app.importFiles(wav('tone-440', 'plain.wav'), {
      name: 'plain.lrc',
      mimeType: 'text/plain',
      buffer: Buffer.from('alpha\nbeta\ngamma'),
    })
    await lyricsTab().click()
    // plain lyrics are text to read, not a wall of disabled buttons
    await expect(app.stage.getByText('alpha', { exact: true })).toBeVisible()
    await expect(app.stage.getByRole('button', { name: 'alpha', exact: true })).toHaveCount(0)
    await expect(app.stage.locator('button.scale-105')).toHaveCount(0)
  })

  test('lyrics follow the selected track', async () => {
    await app.importFiles(wav('tone-440', 'a.wav'), lrc('a.lrc', [[0.2, 'only on a']]), wav('tone-880', 'b.wav'))
    await app.play('a')
    await lyricsTab().click()
    await expect(app.stage.getByRole('button', { name: 'only on a', exact: true })).toBeVisible()

    await app.play('b')
    await expect(app.stage.getByText('No lyrics for this track.')).toBeVisible()
  })
})
