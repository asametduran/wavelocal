import { expect, test } from '@playwright/test'
import { PlayerPage, denyNativeLossless, slowDecoding, song, wav } from './helpers'
import type { Upload } from './helpers'

/** Tracks about fifteen seconds long, so nothing ends (and uses up the queue) while a test is looking around. */
const long = (name: string, title: string, extra: Record<string, string> = {}): Upload => song(name, { title, artist: 'Tester', ...extra }, 600)

const LIST = [long('a.mp3', 'a'), long('b.mp3', 'b'), long('c.mp3', 'c'), long('d.mp3', 'd')]

test.describe('Up Next', () => {
  let app: PlayerPage

  test.beforeEach(async ({ page }) => {
    app = new PlayerPage(page)
    await app.open()
    await app.importFiles(...LIST)
    await expect(app.rows).toHaveCount(4)
  })

  test('Play next plays a track right after the current one, and the list then carries on where it was', async () => {
    await app.play('a')
    await app.queueTrack('c', 'Play next')
    await expect(app.toast('Playing next: c')).toBeVisible()

    await app.next()
    await expect(app.nowPlayingTitle).toHaveText('c')
    await app.next()
    await expect(app.nowPlayingTitle).toHaveText('b') // the track after a, not after c
    await app.next()
    await expect(app.nowPlayingTitle).toHaveText('c')
    await app.next()
    await expect(app.nowPlayingTitle).toHaveText('d')
  })

  test('the latest Play next plays first, and Add to queue goes after everything queued', async () => {
    await app.play('a')
    await app.queueTrack('d', 'Add to queue')
    await app.queueTrack('c', 'Play next')
    await expect(app.toast('Added to the queue: d')).toBeVisible()

    await app.showUpNext()
    await expect.poll(() => app.upNextTitles()).toEqual(['c', 'd'])
    await app.next()
    await expect(app.nowPlayingTitle).toHaveText('c')
    await app.next()
    await expect(app.nowPlayingTitle).toHaveText('d')
    await app.next()
    await expect(app.nowPlayingTitle).toHaveText('b')
    await expect(app.upNextTab).toHaveAccessibleName('Up Next')
  })

  test('a track queued twice plays twice', async () => {
    await app.play('a')
    await app.queueTrack('c', 'Play next')
    await app.queueTrack('c', 'Play next')
    await app.showUpNext()
    await expect.poll(() => app.upNextTitles()).toEqual(['c', 'c'])
    await app.next()
    await app.next()
    await expect(app.nowPlayingTitle).toHaveText('c')
    await app.next()
    await expect(app.nowPlayingTitle).toHaveText('b')
  })

  test('Previous from a queued track goes back to what was playing, not to the track above it in the list', async () => {
    await app.play('a')
    await app.queueTrack('c', 'Play next')
    await app.next()
    await expect(app.nowPlayingTitle).toHaveText('c')
    await app.previous()
    await expect(app.nowPlayingTitle).toHaveText('a')
    await app.next()
    await expect(app.nowPlayingTitle).toHaveText('b')
  })

  test('choosing a track in the list during the queue puts the list back in charge', async () => {
    await app.play('a')
    await app.queueTrack('c', 'Play next')
    await app.next()
    await expect(app.nowPlayingTitle).toHaveText('c')
    await app.play('b')
    await app.next()
    await expect(app.nowPlayingTitle).toHaveText('c') // the list carries on after b
  })

  test('the Up Next tab counts the queue, lists it, and Clear empties it until Undo puts it back', async () => {
    await app.play('a')
    await app.queueTrack('c', 'Play next')
    await app.queueTrack('d', 'Add to queue')
    await expect(app.upNextTab).toHaveAccessibleName('Up Next (2 queued)')

    await app.showUpNext()
    await expect(app.stage.getByTestId('upnext-summary')).toContainText('2 tracks')
    await expect.poll(() => app.upNextTitles()).toEqual(['c', 'd'])

    await app.stage.getByRole('button', { name: 'Clear' }).click()
    await expect(app.upNextList).toHaveCount(0)
    await expect(app.stage.getByText('Nothing is queued.')).toBeVisible()
    await expect(app.upNextTab).toHaveAccessibleName('Up Next')

    await app.toast('Cleared 2 queued tracks').getByRole('button', { name: 'Undo' }).click()
    await expect.poll(() => app.upNextTitles()).toEqual(['c', 'd'])
  })

  test('Ctrl+Z takes back the latest queueing', async ({ page }) => {
    await app.play('a')
    await app.queueTrack('c', 'Play next')
    await expect(app.upNextTab).toHaveAccessibleName('Up Next (1 queued)')
    await expect(app.toast('Playing next: c')).toBeVisible()
    await app.blur()
    await page.keyboard.press('Control+z')
    await expect(app.upNextTab).toHaveAccessibleName('Up Next')
    await expect(app.toast('Playing next: c')).toHaveCount(0)
    await app.next()
    await expect(app.nowPlayingTitle).toHaveText('b')
  })

  test('queued tracks are moved with the arrow buttons, Alt+Arrow or dragging, and focus stays with the one moved', async ({ page }) => {
    await app.play('a')
    for (const title of ['b', 'c', 'd']) await app.queueTrack(title, 'Add to queue')
    await app.showUpNext()
    await expect.poll(() => app.upNextTitles()).toEqual(['b', 'c', 'd'])

    await app.upNextList.getByRole('button', { name: 'Move d up' }).click()
    await expect.poll(() => app.upNextTitles()).toEqual(['b', 'd', 'c'])
    await expect(app.upNextList.getByRole('button', { name: 'Move d up' })).toBeFocused()
    await expect(page.getByTestId('announcer')).toHaveText('d moved to position 2 of 3')

    await app.upNextList.getByRole('button', { name: 'Play d now' }).focus()
    await page.keyboard.press('Alt+ArrowUp')
    await expect.poll(() => app.upNextTitles()).toEqual(['d', 'b', 'c'])
    await expect(app.upNextList.getByRole('button', { name: 'Play d now' })).toBeFocused()

    await app.upNextList.getByRole('listitem').nth(2).dragTo(app.upNextList.getByRole('listitem').first())
    await expect.poll(() => app.upNextTitles()).toEqual(['c', 'd', 'b'])

    await app.next()
    await expect(app.nowPlayingTitle).toHaveText('c')
  })

  test('the first row cannot go up and the last cannot go down', async () => {
    await app.play('a')
    await app.queueTrack('b', 'Add to queue')
    await app.queueTrack('c', 'Add to queue')
    await app.showUpNext()
    await expect(app.upNextList.getByRole('button', { name: 'Move b up' })).toBeDisabled()
    await expect(app.upNextList.getByRole('button', { name: 'Move c down' })).toBeDisabled()
    await expect(app.upNextList.getByRole('button', { name: 'Move b down' })).toBeEnabled()
  })

  test('a queued track is taken out with its button, and the toast puts it back where it was', async () => {
    await app.play('a')
    for (const title of ['b', 'c', 'd']) await app.queueTrack(title, 'Add to queue')
    await app.showUpNext()

    await app.upNextList.getByRole('button', { name: 'Remove c from the queue' }).click()
    await expect.poll(() => app.upNextTitles()).toEqual(['b', 'd'])
    await app.toast('Removed from the queue: c').getByRole('button', { name: 'Undo' }).click()
    await expect.poll(() => app.upNextTitles()).toEqual(['b', 'c', 'd'])
  })

  test('choosing a queued track plays it now and takes it out of the queue', async () => {
    await app.play('a')
    for (const title of ['b', 'c', 'd']) await app.queueTrack(title, 'Add to queue')
    await app.showUpNext()

    await app.upNextList.getByRole('button', { name: 'Play c now' }).click()
    await expect(app.nowPlayingTitle).toHaveText('c')
    await expect.poll(() => app.upNextTitles()).toEqual(['b', 'd'])
    await app.next()
    await expect(app.nowPlayingTitle).toHaveText('b')
    await app.next()
    await expect(app.nowPlayingTitle).toHaveText('d')
    await app.next()
    await expect(app.nowPlayingTitle).toHaveText('b') // the list, after a, which was playing when the queue took over
  })

  test('what is queued survives a reload', async () => {
    await app.play('a')
    await app.queueTrack('d', 'Play next')
    await app.queueTrack('c', 'Play next')
    await expect.poll(() => app.storedMeta('upNext')).toHaveLength(2) // saved a moment after it changes on screen
    await app.reload()
    await expect(app.upNextTab).toHaveAccessibleName('Up Next (2 queued)')
    await app.showUpNext()
    await expect.poll(() => app.upNextTitles()).toEqual(['c', 'd'])
  })

  test('a track removed from the library leaves the queue', async () => {
    await app.play('a')
    await app.queueTrack('c', 'Play next')
    await app.queueTrack('d', 'Add to queue')
    await app.row('c').hover()
    await app.row('c').getByRole('button', { name: 'Remove c' }).click()
    await expect(app.upNextTab).toHaveAccessibleName('Up Next (1 queued)')
    await app.showUpNext()
    await expect.poll(() => app.upNextTitles()).toEqual(['d'])
  })

  test('the Up Next tab has no accessibility violations to speak of: tabs, list, buttons and names', async ({ page }) => {
    await app.play('a')
    await app.queueTrack('b', 'Add to queue')
    await app.queueTrack('c', 'Add to queue')
    await app.showUpNext()
    await expect(app.stage.getByRole('tabpanel')).toHaveAccessibleName(/Up Next/)
    await expect(app.upNextList.getByRole('listitem')).toHaveCount(2)
    for (const button of await app.upNextList.getByRole('button').all()) await expect(button).toHaveAccessibleName(/\S/)
    const labelled = await page.evaluate(() => [...document.querySelectorAll('[role="tabpanel"]')].every((p) => p.getAttribute('aria-labelledby')))
    expect(labelled).toBe(true)
  })
})

test.describe('Up Next from albums and artists', () => {
  const ALBUMS: Upload[] = [
    long('01-help.mp3', 'Help!', { album: 'Help', track: '1/2' }),
    long('02-yesterday.mp3', 'Yesterday', { album: 'Help', track: '2/2' }),
    long('03-queen.mp3', 'Dancing Queen', { album: 'Arrival', track: '1/2', artist: 'ABBA' }),
    long('04-money.mp3', 'Money, Money, Money', { album: 'Arrival', track: '2/2', artist: 'ABBA' }),
  ]
  let app: PlayerPage

  test.beforeEach(async ({ page }) => {
    app = new PlayerPage(page)
    await app.open()
    await app.importFiles(...ALBUMS)
    await expect(app.rows).toHaveCount(4)
    await app.showMode('Albums')
  })

  const card = (title: string) => app.sidebar.getByRole('list', { name: 'Albums' }).getByRole('button', { name: new RegExp(`^${title}, `) })

  test('an album page queues the whole album, in its order, after or before what is queued', async () => {
    await card('Help').click()
    await app.sidebar.getByRole('button', { name: 'Add to queue: Help' }).click()
    await expect(app.toast('Added 2 tracks to the queue')).toBeVisible()
    await app.sidebar.getByRole('button', { name: 'Back to Albums' }).click()
    await card('Arrival').click()
    await app.sidebar.getByRole('button', { name: 'Play next: Arrival' }).click()
    await expect(app.toast('2 tracks will play next')).toBeVisible()

    await app.showUpNext()
    await expect.poll(() => app.upNextTitles()).toEqual(['Dancing Queen', 'Money, Money, Money', 'Help!', 'Yesterday'])
  })

  test('an artist page queues all of the artist, and the toast takes it back', async () => {
    await app.showMode('Artists')
    await app.sidebar.getByRole('list', { name: 'Artists' }).getByRole('button', { name: /^ABBA, / }).click()
    await app.sidebar.getByRole('button', { name: 'Add to queue: ABBA' }).click()
    await expect(app.upNextTab).toHaveAccessibleName('Up Next (2 queued)')
    await app.toast('Added 2 tracks to the queue').getByRole('button', { name: 'Undo' }).click()
    await expect(app.upNextTab).toHaveAccessibleName('Up Next')
  })
})

/** Three 4 s tones: short enough to let them end by themselves, long enough to look around while they play. */
const TONES = [wav('tone-440', 'a.wav'), wav('tone-880', 'b.wav'), wav('sweep', 'c.wav')]

/** Wait for track a to end, and check that the track that took over is exactly `title` (read once, so a wrong one cannot be waited out). */
async function expectNextAfterA(app: PlayerPage, title: string) {
  await expect(app.nowPlayingTitle).not.toHaveText('a', { timeout: 15_000 })
  expect(await app.nowPlayingTitle.innerText()).toBe(title)
}

async function chooseTransition(app: PlayerPage, label: 'Off' | 'Gapless' | 'Crossfade') {
  await app.openTools()
  await app.tools.getByRole('radio', { name: label }).click()
  await expect(app.tools.getByRole('radio', { name: label })).toHaveAttribute('aria-checked', 'true')
  await app.closeTools()
}

test.describe('Up Next when a track ends by itself', () => {
  let app: PlayerPage

  test.beforeEach(async ({ page }) => {
    app = new PlayerPage(page)
    await app.open()
    await app.importFiles(...TONES)
    await expect(app.rows).toHaveCount(3)
  })

  for (const mode of ['Off', 'Gapless', 'Crossfade'] as const) {
    test(`transitions ${mode.toLowerCase()}: the queued track follows the one that ends, and the list carries on after the track it interrupted`, async () => {
      if (mode !== 'Off') await chooseTransition(app, mode)
      await app.play('a')
      await app.queueTrack('c', 'Play next')
      await expectNextAfterA(app, 'c') // not b, though b is what follows a in the list
      await app.expectPlaying()
      await expect(app.upNextTab).toHaveAccessibleName('Up Next') // used up
      await expect(app.nowPlayingTitle).toHaveText('b', { timeout: 10_000 }) // the track after a, not after c
    })
  }

  test('a track queued after the next one was already lined up takes its place', async () => {
    await chooseTransition(app, 'Gapless')
    await app.play('a') // b is lined up as soon as a starts: a is only 4 s long
    await app.queueTrack('c', 'Play next')
    await expectNextAfterA(app, 'c')
    await app.expectPlaying()
  })
})

test.describe('Up Next and audio that is not ready yet', () => {
  test('a queued track that is still being prepared when its turn comes is played, not skipped', async ({ page }) => {
    test.setTimeout(60_000)
    await denyNativeLossless(page) // every WAV goes through the decoder worker...
    await slowDecoding(page, 7_000) // ...which takes its time over everything after the first track
    const app = new PlayerPage(page)
    await app.open()
    await app.importFiles(...TONES)
    await expect(app.rows).toHaveCount(3)
    // a crossfade starts its handover two seconds before the end, so the moment c is not ready is certain to be met
    // (a gapless one waits for a `timeupdate` in the last 0.4 s, which the browser does not promise)
    await chooseTransition(app, 'Crossfade')

    await app.play('a')
    await app.queueTrack('c', 'Play next')
    // a ends while c is still being converted: c is still what comes next. (Were it dropped from the queue, b would play
    // first and c only after it, as b's successor in the list: so it is the very first track after a that is checked.)
    await expectNextAfterA(app, 'c')
    await expect(app.upNextTab).toHaveAccessibleName('Up Next')
    await expect(app.playButton).toHaveAccessibleName('Pause (Space)', { timeout: 15_000 })
  })
})
