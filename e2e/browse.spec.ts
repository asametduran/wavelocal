import AxeBuilder from '@axe-core/playwright'
import { expect, test } from '@playwright/test'
import type { Locator, Page } from '@playwright/test'
import { PlayerPage, song, wav } from './helpers'
import type { Upload } from './helpers'
import type { Id3Fields } from '../src/test-utils/id3'

/** Tracks are about five seconds long: long enough that nothing ends while a test is looking around. */
const tagged = (name: string, tags: Id3Fields, frames = 200): Upload => song(name, tags, frames)

/**
 * A small library with everything browsing has to cope with (the tagged files are numbered because an import adds files in
 * name order, which is the order the library is stored in; digits sort before the loose file's letters): an artist with three albums (one on two discs), an artist
 * with one, a Turkish title, a compilation by various artists, and a file with no tags at all.
 */
const LIBRARY: Upload[] = [
  tagged('01-help.mp3', { title: 'Help!', artist: 'The Beatles', album: 'Help', track: '1/2', year: '1965', genre: 'Rock' }),
  tagged('02-yesterday.mp3', { title: 'Yesterday', artist: 'The Beatles', album: 'Help', track: '2/2', year: '1965', genre: 'Rock' }),
  tagged('03-come-together.mp3', { title: 'Come Together', artist: 'The Beatles', album: 'Abbey Road', track: '1', year: '1969' }),
  tagged('04-something.mp3', { title: 'Something', artist: 'The Beatles', album: 'Abbey Road', track: '2', year: '1969' }),
  tagged('05-dancing-queen.mp3', { title: 'Dancing Queen', artist: 'ABBA', album: 'Arrival', track: '1', year: '1976', genre: 'Pop' }),
  tagged('06-money.mp3', { title: 'Money, Money, Money', artist: 'ABBA', album: 'Arrival', track: '2', year: '1976', genre: 'Pop' }),
  tagged('07-istanbul.mp3', { title: 'İstanbul', artist: 'Şebnem Ferah', album: 'Aşk', track: '1', year: '2019', genre: 'Pop' }),
  tagged('08-ussr.mp3', { title: 'Back in the U.S.S.R.', artist: 'The Beatles', album: 'The White Album', disc: '1/2', track: '1', year: '1968' }),
  tagged('09-birthday.mp3', { title: 'Birthday', artist: 'The Beatles', album: 'The White Album', disc: '2/2', track: '1', year: '1968' }),
  tagged('10-summer-1.mp3', { title: 'Summer Wine', artist: 'Nancy', album: 'Summer Hits', albumArtist: 'Various Artists', track: '1', compilation: '1', year: '1990' }),
  tagged('11-summer-2.mp3', { title: 'Sunny', artist: 'Bobby', album: 'Summer Hits', albumArtist: 'Various Artists', track: '2', compilation: '1', year: '1990' }),
  wav('tone-440', 'jingle.wav'),
]

const escapeRegExp = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

async function load(app: PlayerPage, files: readonly Upload[] = LIBRARY): Promise<void> {
  await app.importFiles(...files)
  await expect(app.viewSelect.locator('option[value="all"]')).toHaveText(`Library (${files.length})`, { timeout: 30_000 })
}

/** The helpers every test below uses, tied to one page. */
function browse(page: Page) {
  const app = new PlayerPage(page)
  const grid = (): Locator => app.sidebar.getByRole('list', { name: 'Albums' })
  const cards = (): Locator => grid().locator('[data-main]')
  const albumCard = (title: string): Locator => grid().getByRole('button', { name: new RegExp(`^${escapeRegExp(title)}, `) })
  const artistList = (): Locator => app.sidebar.getByRole('list', { name: 'Artists' })
  const artistRow = (name: string): Locator => artistList().getByRole('button', { name: new RegExp(`^${escapeRegExp(name)}, `) })
  const names = (list: Locator): Promise<(string | null)[]> => list.locator('[data-main]').evaluateAll((els) => els.map((el) => el.getAttribute('aria-label')))
  const heading = (name: string, level = 2): Locator => app.sidebar.getByRole('heading', { level, name, exact: true })
  const summary = (): Locator => app.sidebar.getByTestId('library-summary')
  const announcer = (): Locator => page.getByTestId('announcer')
  const sortTracks = (): Locator => app.sidebar.getByRole('button', { name: /^Sort tracks:/ })
  const sortAlbums = (): Locator => app.sidebar.getByRole('button', { name: /^Sort albums:/ })
  const choose = async (menu: Locator, item: string): Promise<void> => {
    await menu.click()
    await app.sidebar.getByRole('menuitemradio', { name: item, exact: true }).click()
  }
  const titles = (): Locator => app.rows.locator('div.truncate.text-sm')
  return { app, grid, cards, albumCard, artistList, artistRow, names, heading, summary, announcer, sortTracks, sortAlbums, choose, titles }
}

const ALBUM_ORDER = ['Arrival, ABBA · 1976', 'Aşk, Şebnem Ferah · 2019', 'Help, The Beatles · 1965', 'The White Album, The Beatles · 1968', 'Abbey Road, The Beatles · 1969', 'Summer Hits, Various Artists · 1990', 'Unknown album, 1 track']

test.describe('search', () => {
  let b: ReturnType<typeof browse>

  test.beforeEach(async ({ page }) => {
    b = browse(page)
    await b.app.open()
    await load(b.app)
  })

  test('finds Turkish titles typed without the dots and accents, in either case', async () => {
    for (const text of ['istanbul', 'ISTANBUL', 'İSTANBUL', 'sebnem', 'ask']) {
      await b.app.search.fill(text)
      await expect(b.titles(), text).toHaveText(['İstanbul'])
    }
  })

  test('needs every word to match, in any order, across title, artist and album', async () => {
    await b.app.search.fill('beatles yesterday')
    await expect(b.titles()).toHaveText(['Yesterday'])
    await b.app.search.fill('yesterday beatles')
    await expect(b.titles()).toHaveText(['Yesterday'])
    await b.app.search.fill('abba yesterday')
    await expect(b.app.rows).toHaveCount(0)
    await expect(b.app.sidebar.getByText('No tracks match your search.')).toBeVisible()
  })

  test('narrows to a field, a range of years, a phrase, or leaves a word out', async () => {
    await b.app.search.fill('artist:abba')
    await expect(b.titles()).toHaveText(['Dancing Queen', 'Money, Money, Money'])
    await b.app.search.fill('year:1960..1969')
    await expect(b.titles()).toHaveText(['Help!', 'Yesterday', 'Come Together', 'Something', 'Back in the U.S.S.R.', 'Birthday'])
    await b.app.search.fill('album:"white album" -birthday')
    await expect(b.titles()).toHaveText(['Back in the U.S.S.R.'])
    await b.app.search.fill('genre:pop year:>=2000')
    await expect(b.titles()).toHaveText(['İstanbul'])
  })

  test('says how many tracks match', async () => {
    await b.app.search.fill('artist:abba')
    await expect(b.announcer()).toHaveText('2 tracks match')
    await b.app.search.fill('zzz')
    await expect(b.announcer()).toHaveText('No tracks match your search')
  })

  test('explains what it understands and adds an example to the box on request', async () => {
    const tips = b.app.sidebar.getByRole('button', { name: 'Search tips' })
    await expect(tips).toHaveAttribute('aria-expanded', 'false')
    await tips.click()
    await expect(tips).toHaveAttribute('aria-expanded', 'true')
    await expect(b.app.sidebar.getByRole('group', { name: 'Search tips' })).toContainText('istanbul')
    await b.app.sidebar.getByRole('button', { name: /^Add artist:/ }).click()
    await expect(b.app.search).toHaveValue('artist:')
    await b.app.search.pressSequentially('abba')
    await expect(b.titles()).toHaveText(['Dancing Queen', 'Money, Money, Money'])
    await b.app.sidebar.getByRole('button', { name: /^Add -live/ }).click()
    await expect(b.app.search).toHaveValue('artist:abba -live')
  })

  test('Escape closes the tips first, then clears the search', async () => {
    await b.app.sidebar.getByRole('button', { name: 'Search tips' }).click()
    await b.app.search.fill('abba')
    await b.app.search.press('Escape')
    await expect(b.app.search).toHaveValue('')
    await expect(b.app.sidebar.getByRole('group', { name: 'Search tips' })).toHaveCount(0)
  })

  test('the same search narrows the albums, the artists and the folders', async () => {
    await b.app.search.fill('yesterday')
    await b.app.showMode('Albums')
    await expect(b.grid().locator('[data-main]')).toHaveCount(1)
    expect(await b.names(b.grid())).toEqual(['Help, The Beatles · 1965'])
    await expect(b.summary()).toHaveText('1 album · 2 tracks')
    await b.app.showMode('Artists')
    await expect(b.artistList().locator('[data-main]')).toHaveCount(1)
    expect(await b.names(b.artistList())).toEqual(['The Beatles, 3 albums · 6 tracks']) // an artist is shown whole, like an album
    await b.app.showMode('Folders')
    await expect(b.app.sidebar.getByRole('tree', { name: 'Library folders' })).toContainText('Yesterday')
    await expect(b.app.sidebar.getByRole('tree', { name: 'Library folders' })).not.toContainText('Dancing Queen')
  })
})

test.describe('sorting tracks', () => {
  let b: ReturnType<typeof browse>

  test.beforeEach(async ({ page }) => {
    b = browse(page)
    await b.app.open()
    await load(b.app)
  })

  test('starts in the order the library is stored in', async () => {
    await expect(b.sortTracks()).toHaveAccessibleName('Sort tracks: Library order')
    await expect(b.titles()).toHaveText(['Help!', 'Yesterday', 'Come Together', 'Something', 'Dancing Queen', 'Money, Money, Money', 'İstanbul', 'Back in the U.S.S.R.', 'Birthday', 'Summer Wine', 'Sunny', 'jingle'])
  })

  test('sorts by title, and flips the direction with the button next to the menu', async () => {
    await b.choose(b.sortTracks(), 'Title')
    await expect(b.sortTracks()).toHaveAccessibleName('Sort tracks: Title, A to Z')
    await expect(b.titles()).toHaveText(['Back in the U.S.S.R.', 'Birthday', 'Come Together', 'Dancing Queen', 'Help!', 'İstanbul', 'jingle', 'Money, Money, Money', 'Something', 'Summer Wine', 'Sunny', 'Yesterday'])
    await expect(b.app.sidebar.getByRole('button', { name: 'Sort order: A to Z. Switch to Z to A' })).toBeVisible()
    await b.app.sidebar.getByRole('button', { name: 'Sort order: A to Z. Switch to Z to A' }).click()
    await expect(b.titles()).toHaveText(['Yesterday', 'Sunny', 'Summer Wine', 'Something', 'Money, Money, Money', 'jingle', 'İstanbul', 'Help!', 'Dancing Queen', 'Come Together', 'Birthday', 'Back in the U.S.S.R.'])
    await expect(b.announcer()).toHaveText('Sorted by Title, Z to A')
  })

  test('sorts by year with the unknown years last, and says why each row is where it is', async () => {
    await b.choose(b.sortTracks(), 'Year')
    await expect(b.titles()).toHaveText(['Help!', 'Yesterday', 'Back in the U.S.S.R.', 'Birthday', 'Come Together', 'Something', 'Dancing Queen', 'Money, Money, Money', 'Summer Wine', 'Sunny', 'İstanbul', 'jingle'])
    await expect(b.app.row('Help!')).toContainText('The Beatles · 1965')
    await expect(b.app.row('İstanbul')).toContainText('2019')
    await expect(b.app.row('jingle')).not.toContainText('·')
  })

  test('is remembered after a reload', async () => {
    await b.choose(b.sortTracks(), 'Date added')
    await expect(b.sortTracks()).toHaveAccessibleName('Sort tracks: Date added, newest first')
    await b.app.reload()
    await expect(b.sortTracks()).toHaveAccessibleName('Sort tracks: Date added, newest first')
  })

  test('rows cannot be dragged while the list is sorted, and can again in the stored order', async () => {
    await expect(b.app.rows.first()).toHaveAttribute('draggable', 'true')
    await b.choose(b.sortTracks(), 'Title')
    await expect(b.app.rows.first()).toHaveAttribute('draggable', 'false')
    await expect(b.app.rows.first().locator('button[aria-current]')).not.toHaveAttribute('aria-keyshortcuts', /Alt/)
    await b.choose(b.sortTracks(), 'Library order')
    await expect(b.announcer()).toHaveText('Back to library order')
    await expect(b.app.rows.first()).toHaveAttribute('draggable', 'true')
  })

  test('next and previous follow the sorted order', async () => {
    await b.choose(b.sortTracks(), 'Title')
    await b.app.play('Back in the U.S.S.R.')
    await b.app.key('n')
    await expect(b.app.nowPlayingTitle).toHaveText('Birthday')
    await b.app.key('n')
    await expect(b.app.nowPlayingTitle).toHaveText('Come Together')
    await b.app.key('p')
    await expect(b.app.nowPlayingTitle).toHaveText('Birthday')
  })

  test('a playlist is sorted too, and calls its own order the playlist order', async () => {
    await b.app.viewSelect.selectOption('__new')
    await b.app.answerDialog(true, 'Mix')
    await b.app.viewSelect.selectOption('all')
    for (const title of ['Yesterday', 'Birthday', 'Sunny']) {
      await b.app.row(title).hover()
      await b.app.row(title).getByRole('button', { name: `Add ${title} to playlist` }).click()
      await b.app.page.getByRole('menuitem', { name: 'Mix' }).click()
    }
    await b.app.viewSelect.selectOption({ label: 'Mix (3)' })
    await expect(b.titles()).toHaveText(['Yesterday', 'Birthday', 'Sunny'])
    await b.choose(b.sortTracks(), 'Title')
    await expect(b.titles()).toHaveText(['Birthday', 'Sunny', 'Yesterday'])
    await b.choose(b.sortTracks(), 'Playlist order')
    await expect(b.titles()).toHaveText(['Yesterday', 'Birthday', 'Sunny'])
  })

  test('smart lists order themselves and offer no sort', async () => {
    await b.app.viewSelect.selectOption('smart:recent')
    await expect(b.sortTracks()).toHaveCount(0)
  })

  test('the menu works from the keyboard: arrows move, Enter chooses, Escape closes and gives focus back', async ({ page }) => {
    await b.sortTracks().focus()
    await page.keyboard.press('Enter')
    const menu = b.app.sidebar.getByRole('menu', { name: 'Sort tracks by' })
    await expect(menu).toBeVisible()
    await expect(menu.getByRole('menuitemradio', { name: 'Library order' })).toBeFocused()
    await page.keyboard.press('ArrowDown')
    await expect(menu.getByRole('menuitemradio', { name: 'Title' })).toBeFocused()
    await page.keyboard.press('Enter')
    await expect(menu).toHaveCount(0)
    await expect(b.sortTracks()).toBeFocused()
    await expect(b.sortTracks()).toHaveAccessibleName('Sort tracks: Title, A to Z')
    await page.keyboard.press('Enter')
    await page.keyboard.press('Escape')
    await expect(menu).toHaveCount(0)
    await expect(b.sortTracks()).toBeFocused()
  })
})

test.describe('albums', () => {
  let b: ReturnType<typeof browse>

  test.beforeEach(async ({ page }) => {
    b = browse(page)
    await b.app.open()
    await load(b.app)
    await b.app.showMode('Albums')
  })

  test('lists every album with its artist and year, the unknown ones last, and counts them', async () => {
    await expect(b.cards()).toHaveCount(ALBUM_ORDER.length)
    expect(await b.names(b.grid())).toEqual(ALBUM_ORDER)
    await expect(b.summary()).toHaveText('7 albums · 12 tracks')
  })

  test('opens an album as a page: title, artist, totals and its tracks in track order', async () => {
    await b.albumCard('Abbey Road').click()
    await expect(b.heading('Abbey Road')).toBeFocused()
    await expect(b.app.sidebar.getByRole('button', { name: 'The Beatles', exact: true })).toBeVisible()
    await expect(b.app.sidebar.getByTestId('page-meta')).toHaveText('1969 · 2 tracks · < 1 min')
    await expect(b.titles()).toHaveText(['Come Together', 'Something'])
    await expect(b.app.rows.locator('div.grid.tabular-nums')).toHaveText(['1', '2'])
    await expect(b.app.sidebar.getByRole('list', { name: 'Tracks on Abbey Road' })).toBeVisible()
  })

  test('puts a heading before each disc of a multi-disc album', async () => {
    await b.albumCard('The White Album').click()
    await expect(b.app.sidebar.getByRole('heading', { level: 3 })).toHaveText(['Disc 1', 'Disc 2'])
    await expect(b.titles()).toHaveText(['Back in the U.S.S.R.', 'Birthday'])
  })

  test('Play starts at the first track and Shuffle turns shuffle on', async () => {
    await b.albumCard('Abbey Road').click()
    await b.app.sidebar.getByRole('button', { name: 'Play Abbey Road' }).click()
    await expect(b.app.nowPlayingTitle).toHaveText('Come Together')
    await b.app.expectPlaying()
    await expect(b.app.footer.getByRole('button', { name: /^Shuffle/ })).toHaveAttribute('aria-pressed', 'false')
    await b.app.sidebar.getByRole('button', { name: 'Shuffle Abbey Road' }).click()
    await expect(b.app.footer.getByRole('button', { name: /^Shuffle/ })).toHaveAttribute('aria-pressed', 'true')
    await expect(b.app.nowPlayingTitle).toHaveText(/^(Come Together|Something)$/)
  })

  test('pressing a track plays from that track and stays inside the album', async () => {
    await b.albumCard('Help').click()
    await b.app.play('Yesterday')
    await b.app.key('n')
    await expect(b.app.nowPlayingTitle).toHaveText('Help!') // wraps round inside the album, not on to the next one in the library
  })

  test('a card plays its album without opening it', async () => {
    await b.albumCard('Arrival').hover()
    await b.app.sidebar.getByRole('button', { name: 'Play Arrival' }).click()
    await expect(b.app.nowPlayingTitle).toHaveText('Dancing Queen')
    await b.app.expectPlaying()
    await expect(b.grid()).toBeVisible()
  })

  test('marks the album that is playing', async () => {
    await b.albumCard('Arrival').hover()
    await b.app.sidebar.getByRole('button', { name: 'Play Arrival' }).click()
    await b.app.expectPlaying()
    await expect(b.albumCard('Arrival')).toHaveAttribute('aria-current', 'true')
    await expect(b.albumCard('Help')).not.toHaveAttribute('aria-current', 'true')
  })

  test('Back returns to the albums with the card you opened focused', async () => {
    await b.albumCard('Help').click()
    await b.app.sidebar.getByRole('button', { name: 'Back to Albums' }).click()
    await expect(b.grid()).toBeVisible()
    await expect(b.albumCard('Help')).toBeFocused()
  })

  test('Escape and the browser Back button close the page', async ({ page }) => {
    await b.albumCard('Help').click()
    await expect(b.heading('Help')).toBeVisible()
    await page.keyboard.press('Escape')
    await expect(b.grid()).toBeVisible()
    await b.albumCard('Aşk').click()
    await expect(b.heading('Aşk')).toBeVisible()
    await page.goBack()
    await expect(b.grid()).toBeVisible()
    await expect(b.heading('Aşk')).toHaveCount(0)
  })

  test('playing an album keeps playing it while you look at another one', async () => {
    await b.albumCard('Abbey Road').click()
    await b.app.sidebar.getByRole('button', { name: 'Play Abbey Road' }).click()
    await expect(b.app.nowPlayingTitle).toHaveText('Come Together')
    await b.app.sidebar.getByRole('button', { name: 'Back to Albums' }).click()
    await b.albumCard('Arrival').click()
    await expect(b.heading('Arrival')).toBeVisible()
    await b.app.key('n')
    await expect(b.app.nowPlayingTitle).toHaveText('Something') // still Abbey Road
  })

  test('playing a track from the track list goes back to following that list', async () => {
    await b.albumCard('Abbey Road').click()
    await b.app.sidebar.getByRole('button', { name: 'Play Abbey Road' }).click()
    await expect(b.app.nowPlayingTitle).toHaveText('Come Together')
    await b.app.showMode('Tracks')
    await b.app.play('Dancing Queen')
    await b.app.key('n')
    await expect(b.app.nowPlayingTitle).toHaveText('Money, Money, Money')
    await b.app.key('n')
    await expect(b.app.nowPlayingTitle).toHaveText('İstanbul') // the library order, not an album
  })

  test('adds a whole album to a playlist, and only the tracks it does not have yet', async () => {
    await b.albumCard('Help').click()
    await b.app.sidebar.getByRole('button', { name: 'Add to playlist: Help' }).click()
    await b.app.sidebar.getByRole('menuitem', { name: /New playlist/ }).click()
    await b.app.answerDialog(true, 'Beatles mix')
    await expect(b.app.viewSelect.locator('option', { hasText: 'Beatles mix' })).toHaveText('Beatles mix (2)')
    await expect(b.announcer()).toHaveText('Created playlist Beatles mix with 2 tracks')

    await b.app.sidebar.getByRole('button', { name: 'Add to playlist: Help' }).click()
    await b.app.sidebar.getByRole('menuitem', { name: 'Beatles mix' }).click()
    await expect(b.announcer()).toHaveText('Beatles mix already has all of these tracks')
    await expect(b.app.viewSelect.locator('option', { hasText: 'Beatles mix' })).toHaveText('Beatles mix (2)')
  })

  test('gathers tracks with no album tag on one "Unknown album"', async () => {
    await b.albumCard('Unknown album').click()
    await expect(b.titles()).toHaveText(['jingle'])
  })

  test('keeps a compilation together under Various Artists, without a page for them', async () => {
    await b.albumCard('Summer Hits').click()
    await expect(b.titles()).toHaveText(['Summer Wine', 'Sunny'])
    await expect(b.app.sidebar.getByText('Various Artists')).toBeVisible()
    await expect(b.app.sidebar.getByRole('button', { name: 'Various Artists' })).toHaveCount(0)
  })

  test('sorts by artist, album, year or date added, and remembers it across a reload', async () => {
    await expect(b.sortAlbums()).toHaveAccessibleName('Sort albums: Artist, A to Z')
    await b.choose(b.sortAlbums(), 'Year')
    await expect.poll(() => b.names(b.grid())).toEqual(['Help, The Beatles · 1965', 'The White Album, The Beatles · 1968', 'Abbey Road, The Beatles · 1969', 'Arrival, ABBA · 1976', 'Summer Hits, Various Artists · 1990', 'Aşk, Şebnem Ferah · 2019', 'Unknown album, 1 track'])
    await b.choose(b.sortAlbums(), 'Album')
    await expect.poll(async () => (await b.names(b.grid())).map((n) => n?.split(',')[0])).toEqual(['Abbey Road', 'Arrival', 'Aşk', 'Help', 'Summer Hits', 'The White Album', 'Unknown album'])
    await b.app.sidebar.getByRole('button', { name: /^Sort order: A to Z/ }).click()
    await expect.poll(async () => (await b.names(b.grid())).map((n) => n?.split(',')[0])).toEqual(['The White Album', 'Summer Hits', 'Help', 'Aşk', 'Arrival', 'Abbey Road', 'Unknown album'])
    await b.app.reload()
    await expect(b.sortAlbums()).toHaveAccessibleName('Sort albums: Album, Z to A')
  })

  test('the panel remembers it was in the albums view across a reload', async () => {
    await b.app.reload()
    await expect(b.app.tab('Albums')).toHaveAttribute('aria-selected', 'true')
    await expect(b.cards()).toHaveCount(ALBUM_ORDER.length)
  })

  test('opens the albums of a playlist rather than of the whole library', async () => {
    await b.app.viewSelect.selectOption('__new')
    await b.app.answerDialog(true, 'Pair')
    await b.app.viewSelect.selectOption('all')
    await b.app.showMode('Tracks')
    for (const title of ['Yesterday', 'Sunny']) {
      await b.app.row(title).hover()
      await b.app.row(title).getByRole('button', { name: `Add ${title} to playlist` }).click()
      await b.app.page.getByRole('menuitem', { name: 'Pair' }).click()
    }
    await b.app.viewSelect.selectOption({ label: 'Pair (2)' })
    await b.app.showMode('Albums')
    await expect(b.cards()).toHaveCount(2)
    expect(await b.names(b.grid())).toEqual(['Help, The Beatles · 1965', 'Summer Hits, Various Artists · 1990'])
    await expect(b.summary()).toHaveText('2 albums · 2 tracks')
    await b.albumCard('Help').click()
    await expect(b.titles()).toHaveText(['Yesterday']) // only the playlist's track of it
  })

  test('a page closes by itself when its tracks move to another album', async () => {
    await b.albumCard('Aşk').click()
    await expect(b.heading('Aşk')).toBeVisible()
    await b.app.row('İstanbul').hover()
    await b.app.row('İstanbul').getByRole('button', { name: 'Edit tags of İstanbul' }).click()
    const dialog = b.app.page.getByRole('dialog')
    await dialog.getByLabel('Album').fill('Şehir')
    await dialog.getByRole('button', { name: 'Save' }).click()
    await expect(dialog).toHaveCount(0)
    // the track now belongs to another album: the page it was opened on is gone, and the albums are back
    await expect(b.grid()).toBeVisible()
    await expect(b.albumCard('Şehir')).toBeVisible()
  })
})

test.describe('albums with the keyboard', () => {
  let b: ReturnType<typeof browse>

  test.beforeEach(async ({ page }) => {
    b = browse(page)
    await b.app.open()
    await load(b.app)
    await b.app.showMode('Albums')
    await expect(b.cards()).toHaveCount(ALBUM_ORDER.length)
  })

  /** How many cards share the first card's row. */
  const columns = async (): Promise<number> => {
    const tops = await b.cards().evaluateAll((els) => els.map((el) => Math.round(el.getBoundingClientRect().top)))
    return tops.filter((top) => top === tops[0]).length
  }

  test('exactly one card is in the Tab order', async () => {
    await expect(b.grid().locator('[data-main][tabindex="0"]')).toHaveCount(1)
    await expect(b.grid().locator('[data-main][tabindex="-1"]')).toHaveCount(ALBUM_ORDER.length - 1)
  })

  test('arrow keys, Home and End move between cards, Enter opens one', async ({ page }) => {
    const cols = await columns()
    expect(cols).toBeGreaterThanOrEqual(2)
    await b.cards().first().focus()
    await page.keyboard.press('ArrowRight')
    await expect(b.cards().nth(1)).toBeFocused()
    await page.keyboard.press('ArrowLeft')
    await expect(b.cards().first()).toBeFocused()
    await page.keyboard.press('ArrowDown')
    await expect(b.cards().nth(cols)).toBeFocused()
    await page.keyboard.press('ArrowUp')
    await expect(b.cards().first()).toBeFocused()
    await page.keyboard.press('End')
    await expect(b.cards().last()).toBeFocused()
    await page.keyboard.press('Home')
    await expect(b.cards().first()).toBeFocused()
    await page.keyboard.press('Enter')
    await expect(b.heading('Arrival')).toBeFocused()
  })

  test('the Play button of the focused card is a Tab stop, those of the others are not', async ({ page }) => {
    await b.cards().first().focus()
    await page.keyboard.press('Tab')
    await expect(b.app.sidebar.getByRole('button', { name: 'Play Arrival' })).toBeFocused()
    await page.keyboard.press('Enter')
    await expect(b.app.nowPlayingTitle).toHaveText('Dancing Queen')
  })

  test('"Show playing album" scrolls to the card and focuses it', async () => {
    await b.albumCard('Summer Hits').hover()
    await b.app.sidebar.getByRole('button', { name: 'Play Summer Hits' }).click()
    await b.app.expectPlaying()
    await b.albumCard('Arrival').focus()
    await b.app.sidebar.getByRole('button', { name: 'Show playing album' }).click()
    await expect(b.albumCard('Summer Hits')).toBeFocused()
  })
})

test.describe('artists', () => {
  let b: ReturnType<typeof browse>

  test.beforeEach(async ({ page }) => {
    b = browse(page)
    await b.app.open()
    await load(b.app)
    await b.app.showMode('Artists')
    await expect(b.artistList().locator('[data-main]')).toHaveCount(6)
  })

  test('lists the artists alphabetically with their albums and tracks', async () => {
    expect(await b.names(b.artistList())).toEqual([
      'ABBA, 1 album · 2 tracks',
      'Bobby, 1 album · 1 track',
      'Nancy, 1 album · 1 track',
      'Şebnem Ferah, 1 album · 1 track',
      'The Beatles, 3 albums · 6 tracks',
      'Unknown Artist, 1 track',
    ])
    await expect(b.summary()).toHaveText('6 artists · 12 tracks')
  })

  test('an artist page lists their albums oldest first, each with their tracks', async () => {
    await b.artistRow('The Beatles').click()
    await expect(b.heading('The Beatles')).toBeFocused()
    await expect(b.app.sidebar.getByTestId('page-meta')).toHaveText('3 albums · 6 tracks · < 1 min')
    await expect(b.app.sidebar.getByRole('heading', { level: 3 })).toHaveText([/^Help1965 · 2 tracks$/, /^The White Album1968 · 2 tracks$/, /^Abbey Road1969 · 2 tracks$/])
    await expect(b.titles()).toHaveText(['Help!', 'Yesterday', 'Back in the U.S.S.R.', 'Birthday', 'Come Together', 'Something'])
  })

  test('a heading opens its album, and Back returns to the artist', async () => {
    await b.artistRow('The Beatles').click()
    await b.app.sidebar.getByRole('heading', { level: 3, name: /Abbey Road/ }).getByRole('button').click()
    await expect(b.heading('Abbey Road')).toBeVisible()
    await expect(b.titles()).toHaveText(['Come Together', 'Something'])
    await b.app.sidebar.getByRole('button', { name: 'Back to The Beatles' }).click()
    await expect(b.heading('The Beatles')).toBeVisible()
  })

  test('a heading plays just its own album', async () => {
    await b.artistRow('The Beatles').click()
    await b.app.sidebar.getByRole('button', { name: 'Play Abbey Road' }).click()
    await expect(b.app.nowPlayingTitle).toHaveText('Come Together')
  })

  test('Play walks the whole discography, album by album', async () => {
    await b.artistRow('The Beatles').click()
    await b.app.sidebar.getByRole('button', { name: 'Play The Beatles' }).click()
    await expect(b.app.nowPlayingTitle).toHaveText('Help!')
    await b.app.key('n')
    await expect(b.app.nowPlayingTitle).toHaveText('Yesterday')
    await b.app.key('n')
    await expect(b.app.nowPlayingTitle).toHaveText('Back in the U.S.S.R.')
  })

  test('an album links to its artist, and Back returns to the album', async () => {
    await b.app.showMode('Albums')
    await b.albumCard('Abbey Road').click()
    await b.app.sidebar.getByRole('button', { name: 'The Beatles', exact: true }).click()
    await expect(b.heading('The Beatles')).toBeVisible()
    await b.app.sidebar.getByRole('button', { name: 'Back to Abbey Road' }).click()
    await expect(b.heading('Abbey Road')).toBeVisible()
    await b.app.sidebar.getByRole('button', { name: 'Back to Albums' }).click()
    await expect(b.grid()).toBeVisible()
  })

  test('a row plays the artist without opening the page', async () => {
    await b.artistRow('ABBA').hover()
    await b.app.sidebar.getByRole('button', { name: 'Play ABBA' }).click()
    await expect(b.app.nowPlayingTitle).toHaveText('Dancing Queen')
    await expect(b.artistList()).toBeVisible()
    await expect(b.artistRow('ABBA')).toHaveAttribute('aria-current', 'true')
  })
})

test.describe('a large library', () => {
  test('keeps only the albums in view in the page, and reaches the last one from the keyboard', async ({ page }) => {
    test.setTimeout(90_000)
    const b = browse(page)
    await b.app.open()
    const files = Array.from({ length: 300 }, (_, i) => tagged(`t${String(i).padStart(3, '0')}.mp3`, { title: `Song ${i}`, artist: `Artist ${String(i % 25).padStart(2, '0')}`, album: `Album ${String(i).padStart(3, '0')}`, track: '1', year: String(1960 + (i % 60)) }, 12))
    await load(b.app, files)
    await b.app.showMode('Albums')
    await expect(b.summary()).toHaveText('300 albums · 300 tracks')
    const rendered = await b.cards().count()
    expect(rendered).toBeGreaterThan(4)
    expect(rendered).toBeLessThan(60)
    await b.cards().first().focus()
    await page.keyboard.press('End')
    await expect(b.grid().locator('li:has([data-main]:focus)')).toHaveAttribute('aria-posinset', '300')
    expect(await b.cards().count()).toBeLessThan(60)
    await page.keyboard.press('Home')
    await expect(b.grid().locator('li:has([data-main]:focus)')).toHaveAttribute('aria-posinset', '1')
  })
})

test.describe('layouts', () => {
  test('the library panel is wider for albums and artists than for tracks', async ({ page }) => {
    const b = browse(page)
    await b.app.open()
    await load(b.app)
    const width = async () => (await b.app.sidebar.boundingBox())?.width ?? 0
    const narrow = await width()
    await b.app.showMode('Albums')
    await expect.poll(width).toBeGreaterThan(narrow + 100)
    await b.app.showMode('Folders')
    await expect.poll(width).toBe(narrow)
  })

  test.describe('phone', () => {
    test.use({ viewport: { width: 390, height: 844 } })

    test('shows two columns of albums, and an album page with its actions and tracks', async ({ page }) => {
      const b = browse(page)
      await b.app.open()
      await load(b.app)
      await b.app.showMode('Albums')
      await expect(b.cards()).toHaveCount(ALBUM_ORDER.length)
      const boxes = await b.cards().evaluateAll((els) => els.map((el) => el.getBoundingClientRect()).map((r) => ({ x: Math.round(r.left), y: Math.round(r.top), w: Math.round(r.width) })))
      expect(boxes[0]?.y).toBe(boxes[1]?.y)
      expect(boxes[2]?.y).toBeGreaterThan(boxes[0]?.y ?? 0)
      expect(boxes[0]?.x).toBeLessThan(boxes[1]?.x ?? 0)
      expect(boxes[0]?.w).toBeGreaterThan(120)
      expect((boxes[1]?.x ?? 0) + (boxes[1]?.w ?? 0)).toBeLessThanOrEqual(390)

      await b.albumCard('Abbey Road').click()
      await expect(b.heading('Abbey Road')).toBeVisible()
      for (const name of ['Play Abbey Road', 'Shuffle Abbey Road', 'Add to playlist: Abbey Road']) await expect(b.app.sidebar.getByRole('button', { name })).toBeVisible()
      await expect(b.titles()).toHaveText(['Come Together', 'Something'])
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth)
      expect(overflow).toBe(false)
    })

    test('the phone\'s Back button closes a page instead of leaving the library', async ({ page }) => {
      const b = browse(page)
      await b.app.open()
      await load(b.app)
      await b.app.showMode('Albums')
      await b.albumCard('Help').click()
      await expect(b.heading('Help')).toBeVisible()
      await page.goBack()
      await expect(b.grid()).toBeVisible()
      await expect(b.heading('Help')).toHaveCount(0)
    })

    test('the queue sheet stays a list of tracks', async ({ page }) => {
      const b = browse(page)
      await b.app.open()
      await load(b.app)
      await b.app.showMode('Albums')
      await page.locator('#player-mini').getByRole('button', { name: 'Open now playing' }).click()
      await page.getByRole('button', { name: 'Open queue' }).click()
      const sheet = page.getByRole('dialog', { name: 'Queue' })
      await expect(sheet).toBeVisible()
      await expect(sheet.getByRole('tab')).toHaveText(['Tracks', 'Folders'])
    })
  })

  test.describe('tablet', () => {
    test.use({ viewport: { width: 820, height: 1180 } })

    test('fits roomy columns of albums beside the stage', async ({ page }) => {
      const b = browse(page)
      await b.app.open()
      await load(b.app)
      await b.app.showMode('Albums')
      await expect(b.cards()).toHaveCount(ALBUM_ORDER.length)
      const layout = async () => {
        const rects = await b.cards().evaluateAll((els) => els.map((el) => el.getBoundingClientRect()).map((r) => ({ left: r.left, right: r.right, top: Math.round(r.top) })))
        return { columns: rects.filter((r) => r.top === rects[0]?.top).length, rects }
      }
      await expect.poll(async () => (await layout()).columns).toBeGreaterThanOrEqual(2)
      const panel = await b.app.sidebar.boundingBox()
      expect(panel?.width).toBeGreaterThan(380)
      for (const r of (await layout()).rects) {
        expect(r.left).toBeGreaterThanOrEqual((panel?.x ?? 0) - 1)
        expect(r.right).toBeLessThanOrEqual((panel?.x ?? 0) + (panel?.width ?? 0) + 1)
      }
      await expect(b.app.stage).toBeVisible()
      expect((await b.app.stage.boundingBox())?.width).toBeGreaterThan(300)
    })
  })

  test.describe('TV', () => {
    test('moves one card per press with the remote, and opens a page with OK and closes it with Back', async ({ page }) => {
      await page.addInitScript(() => localStorage.setItem('wl-tv', '1'))
      const b = browse(page)
      await b.app.open()
      await load(b.app)
      await b.app.showMode('Albums')
      await expect(page.locator('html')).toHaveClass(/tv/)
      await expect(b.cards()).toHaveCount(ALBUM_ORDER.length)
      await b.cards().first().focus()
      await page.keyboard.press('ArrowRight')
      await expect(b.cards().nth(1)).toBeFocused() // one step, not two: the grid and the D-pad navigator do not both move it
      await page.keyboard.press('ArrowLeft')
      await expect(b.cards().first()).toBeFocused()
      await page.keyboard.press('Enter')
      await expect(b.heading('Arrival')).toBeFocused()
      await page.keyboard.press('Escape')
      await expect(b.grid()).toBeVisible()
      await expect(b.albumCard('Arrival')).toBeFocused()
    })

    test('scales the cards and rows with the larger text, so nothing is cut off', async ({ page }) => {
      await page.addInitScript(() => localStorage.setItem('wl-tv', '1'))
      const b = browse(page)
      await b.app.open()
      await load(b.app)
      await b.app.showMode('Albums')
      await expect(b.cards()).toHaveCount(ALBUM_ORDER.length)
      const clipped = await b.grid().locator('li').evaluateAll((els) => els.filter((li) => li.scrollHeight > li.clientHeight + 1).length)
      expect(clipped).toBe(0)
      await b.app.showMode('Artists')
      await expect(b.artistList().locator('[data-main]')).toHaveCount(6)
      const rowsClipped = await b.artistList().locator('li').evaluateAll((els) => els.filter((li) => li.scrollHeight > li.clientHeight + 1).length)
      expect(rowsClipped).toBe(0)
    })
  })
})

test.describe('accessibility of browsing (axe-core)', () => {
  let b: ReturnType<typeof browse>

  test.beforeEach(async ({ page }) => {
    b = browse(page)
    await b.app.open()
    await load(b.app)
  })

  const expectClean = async (page: Page, state: string): Promise<void> => {
    const { violations } = await new AxeBuilder({ page }).include('aside').withTags(['wcag2a', 'wcag2aa', 'wcag21aa', 'wcag22aa', 'best-practice']).analyze()
    expect(violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(' ')).join(', ')}`), state).toEqual([])
  }

  test('the track list with the sort menu and the search tips open', async ({ page }) => {
    await expectClean(page, 'tracks')
    await b.sortTracks().click()
    await expectClean(page, 'sort menu')
    await page.keyboard.press('Escape')
    await b.app.sidebar.getByRole('button', { name: 'Search tips' }).click()
    await expectClean(page, 'search tips')
  })

  test('the album grid, its sort menu, an album page and an artist page', async ({ page }) => {
    await b.app.showMode('Albums')
    await expect(b.cards()).toHaveCount(ALBUM_ORDER.length)
    await expectClean(page, 'albums')
    await b.sortAlbums().click()
    await expectClean(page, 'album sort menu')
    await page.keyboard.press('Escape')
    await b.albumCard('The White Album').click()
    await expect(b.heading('The White Album')).toBeVisible()
    await expectClean(page, 'multi-disc album page')
    await b.app.sidebar.getByRole('button', { name: 'Add to playlist: The White Album' }).click()
    await expectClean(page, 'album page with the playlist menu')
    await page.keyboard.press('Escape')
    await b.app.sidebar.getByRole('button', { name: 'The Beatles', exact: true }).click()
    await expect(b.heading('The Beatles')).toBeVisible()
    await expectClean(page, 'artist page')
  })

  test('the artist list', async ({ page }) => {
    await b.app.showMode('Artists')
    await expect(b.artistList().locator('[data-main]')).toHaveCount(6)
    await expectClean(page, 'artists')
  })

  test('with a track playing and searching, on a phone too', async ({ page }) => {
    await b.app.showMode('Albums')
    await b.albumCard('Arrival').hover()
    await b.app.sidebar.getByRole('button', { name: 'Play Arrival' }).click()
    await b.app.expectPlaying()
    await b.app.sidebar.getByLabel('Search albums').fill('abba')
    await expect(b.cards()).toHaveCount(1)
    await expectClean(page, 'albums while playing and filtered')
    await page.setViewportSize({ width: 390, height: 844 })
    await expectClean(page, 'albums on a phone')
  })

  test('tabs: arrow keys move and choose, and the panel is named after the tab', async ({ page }) => {
    await b.app.tab('Tracks').focus()
    await page.keyboard.press('ArrowRight')
    await expect(b.app.tab('Albums')).toBeFocused()
    await expect(b.app.tab('Albums')).toHaveAttribute('aria-selected', 'true')
    await expect(b.app.sidebar.getByRole('tabpanel', { name: 'Albums' })).toBeVisible()
    await page.keyboard.press('End')
    await expect(b.app.tab('Folders')).toHaveAttribute('aria-selected', 'true')
    await expect(b.app.sidebar.getByRole('tabpanel', { name: 'Folders' })).toBeVisible()
  })
})
