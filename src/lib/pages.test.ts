import { describe, expect, it } from 'vitest'
import { groupAlbums, groupArtists } from './groups'
import type { Groupable } from './groups'
import { albumMeta, albumRows, artistLine, artistMeta, artistRows, cardSubtitle } from './pages'
import type { PageRow } from './pages'
import { parseQuery } from './search'
import type { Searchable } from './search'

type Item = Groupable & Searchable

let n = 0
const t = (over: Partial<Item> & { title: string }): Item => ({
  id: `t${n++}`,
  artist: 'Artist',
  album: '',
  albumArtist: '',
  trackNo: 0,
  discNo: 0,
  year: 0,
  duration: 100,
  addedAt: 0,
  plays: 0,
  lastPlayedAt: null,
  compilation: false,
  coverBlob: null,
  genre: '',
  path: '',
  file: { name: `${over.title}.mp3` },
  ...over,
})

/** Rows as short text: "# Disc 2" for a heading, the title for a track. */
const shape = (rows: readonly PageRow<Item>[]): string[] => rows.map((row) => (row.kind === 'heading' ? `# ${row.label}` : row.t.title))
const art = new Blob(['art'])

describe('albumRows', () => {
  it('is just the tracks, in album order, for an album on one disc', () => {
    const [album] = groupAlbums([t({ title: 'two', album: 'LP', trackNo: 2 }), t({ title: 'one', album: 'LP', trackNo: 1 }), t({ title: 'three', album: 'LP', trackNo: 3 })])
    const rows = albumRows(album!)
    expect(shape(rows)).toEqual(['one', 'two', 'three'])
    expect(rows.map((r) => (r.kind === 'track' ? r.index : -1))).toEqual([0, 1, 2])
  })

  it('puts a heading before each disc of a multi-disc album', () => {
    const [album] = groupAlbums([
      t({ title: 'b1', album: 'Double', discNo: 2, trackNo: 1 }),
      t({ title: 'a2', album: 'Double', discNo: 1, trackNo: 2 }),
      t({ title: 'a1', album: 'Double', discNo: 1, trackNo: 1 }),
      t({ title: 'b2', album: 'Double', discNo: 2, trackNo: 2 }),
    ])
    expect(shape(albumRows(album!))).toEqual(['# Disc 1', 'a1', 'a2', '# Disc 2', 'b1', 'b2'])
  })

  it('gives every heading its own key, so rows can be told apart', () => {
    const [album] = groupAlbums([t({ title: 'a', album: 'Box', discNo: 1 }), t({ title: 'b', album: 'Box', discNo: 2 }), t({ title: 'c', album: 'Box', discNo: 3 })])
    const keys = albumRows(album!).flatMap((r) => (r.kind === 'heading' ? [r.key] : []))
    expect(keys).toHaveLength(3)
    expect(new Set(keys).size).toBe(3)
  })

  it('counts a track with no disc number as disc 1', () => {
    const [album] = groupAlbums([t({ title: 'x', album: 'Mixed', trackNo: 9 }), t({ title: 'y', album: 'Mixed', discNo: 2, trackNo: 1 })])
    expect(shape(albumRows(album!))).toEqual(['# Disc 1', 'x', '# Disc 2', 'y'])
  })

  it('shows no heading when no track names a second disc', () => {
    const [album] = groupAlbums([t({ title: 'x', album: 'One', discNo: 1, trackNo: 1 }), t({ title: 'y', album: 'One', trackNo: 2 })])
    expect(shape(albumRows(album!))).toEqual(['x', 'y'])
  })

  describe('with a search', () => {
    const [album] = groupAlbums([
      t({ title: 'Help!', album: 'Double', discNo: 1, trackNo: 1 }),
      t({ title: 'Yesterday', album: 'Double', discNo: 1, trackNo: 2 }),
      t({ title: 'Yellow Submarine', album: 'Double', discNo: 2, trackNo: 1 }),
    ])

    it('keeps only the tracks that match', () => {
      expect(shape(albumRows(album!, parseQuery('yesterday')))).toEqual(['# Disc 1', 'Yesterday'])
    })

    it('drops the heading of a disc with nothing left on it', () => {
      expect(shape(albumRows(album!, parseQuery('submarine')))).toEqual(['# Disc 2', 'Yellow Submarine'])
      expect(shape(albumRows(album!, parseQuery('nothing like it')))).toEqual([])
    })

    it('treats an empty search as no search at all', () => {
      expect(shape(albumRows(album!, parseQuery('  ')))).toEqual(shape(albumRows(album!)))
    })
  })
})

describe('artistRows', () => {
  const library = [
    t({ title: 'B2', artist: 'The Beatles', album: 'Help', trackNo: 2, year: 1965 }),
    t({ title: 'B1', artist: 'The Beatles', album: 'Help', trackNo: 1, year: 1965, coverBlob: art }),
    t({ title: 'R1', artist: 'The Beatles', album: 'Abbey Road', trackNo: 1, year: 1969 }),
    t({ title: 'M1', artist: 'Mixer', album: 'Summer', albumArtist: 'Various Artists', trackNo: 1 }),
    t({ title: 'M2', artist: 'The Beatles', album: 'Summer', albumArtist: 'Various Artists', trackNo: 2 }),
    t({ title: 'Loose', artist: 'The Beatles' }),
  ]
  const albums = groupAlbums(library)
  const artists = groupArtists(library, albums)
  const beatles = artists.find((a) => a.name === 'The Beatles')!

  it('lists the tracks album by album, under a heading for each, oldest album first', () => {
    expect(shape(artistRows(beatles))).toEqual(['# Help', 'B1', 'B2', '# Abbey Road', 'R1', '# Summer', 'M2', '# Unknown album', 'Loose'])
  })

  it('lists the same tracks, in the same order, that playing the artist walks through', () => {
    const tracks = artistRows(beatles).flatMap((r) => (r.kind === 'track' ? [r.t.id] : []))
    expect(tracks).toEqual(beatles.tracks.map((x) => x.id))
  })

  it('lets a heading open its album, play its own tracks and show its artwork', () => {
    const help = artistRows(beatles).find((r) => r.kind === 'heading' && r.label === 'Help')
    expect(help?.kind).toBe('heading')
    if (help?.kind !== 'heading') return
    expect(help.open).toBe(`album:${albums.find((a) => a.title === 'Help')?.id}`)
    expect(help.tracks.map((x) => x.title)).toEqual(['B1', 'B2'])
    expect(help.art?.title).toBe('B1')
    expect(help.detail).toBe('1965 · 2 tracks')
  })

  it('shows only the artist\'s own tracks of a compilation, though the heading opens the whole album', () => {
    const summer = artistRows(beatles).find((r) => r.kind === 'heading' && r.label === 'Summer')
    if (summer?.kind !== 'heading') throw new Error('no Summer heading')
    expect(summer.tracks.map((x) => x.title)).toEqual(['M2'])
    expect(summer.detail).toBe('1 track')
    expect(albums.find((a) => `album:${a.id}` === summer.open)?.tracks).toHaveLength(2)
  })

  it('numbers the tracks through the whole page', () => {
    const index = artistRows(beatles).flatMap((r) => (r.kind === 'track' ? [r.index] : []))
    expect(index).toEqual([0, 1, 2, 3, 4])
  })

  describe('with a search', () => {
    it('keeps the matching tracks and only the headings that still have one', () => {
      expect(shape(artistRows(beatles, parseQuery('abbey')))).toEqual(['# Abbey Road', 'R1'])
      expect(shape(artistRows(beatles, parseQuery('b2')))).toEqual(['# Help', 'B2'])
      expect(shape(artistRows(beatles, parseQuery('zzz')))).toEqual([])
    })

    it('finds a track by its album, the way the library search does', () => {
      expect(shape(artistRows(beatles, parseQuery('album:summer')))).toEqual(['# Summer', 'M2'])
    })
  })
})

describe('labels', () => {
  const [album] = groupAlbums([
    t({ title: 'one', album: 'Help', artist: 'The Beatles', year: 1965, trackNo: 1, duration: 120 }),
    t({ title: 'two', album: 'Help', artist: 'The Beatles', year: 1965, trackNo: 2, duration: 180 }),
  ])

  it('albumMeta: year, number of tracks and how long they play', () => {
    expect(albumMeta(album!)).toBe('1965 · 2 tracks · 5 min')
  })

  it('albumMeta: leaves out a year that is not known and marks lengths that are not', () => {
    const [bare] = groupAlbums([t({ title: 'a', album: 'Bare', duration: 0 }), t({ title: 'b', album: 'Bare', duration: 60 })])
    expect(albumMeta(bare!)).toBe('2 tracks · 1 min+')
  })

  it('cardSubtitle: who made it and when', () => {
    expect(cardSubtitle(album!)).toBe('The Beatles · 1965')
    const [noYear] = groupAlbums([t({ title: 'a', album: 'Plain', artist: 'Someone' })])
    expect(cardSubtitle(noYear!)).toBe('Someone')
  })

  it('cardSubtitle: says how many tracks are on the merged "Unknown album"', () => {
    const merged = groupAlbums([t({ title: 'a', artist: 'X' }), t({ title: 'b', artist: 'Y' })], { mergeUnknown: true })[0]
    expect(cardSubtitle(merged!)).toBe('2 tracks')
  })

  it('artistMeta: albums, tracks and time, counting real albums only', () => {
    const library = [
      t({ title: 'a', artist: 'X', album: 'One', duration: 3600 }),
      t({ title: 'b', artist: 'X', album: 'Two', duration: 3600 }),
      t({ title: 'c', artist: 'X', duration: 60 }),
    ]
    const x = groupArtists(library).find((a) => a.name === 'X')!
    expect(artistMeta(x)).toBe('2 albums · 3 tracks · 2 h 1 min')
  })

  it('artistMeta: has no album count for an artist whose tracks carry no album', () => {
    const solo = groupArtists([t({ title: 'a', artist: 'Solo' })]).find((a) => a.name === 'Solo')!
    expect(artistMeta(solo)).toBe('1 track · 1 min')
  })

  it('artistLine: the short form for a list of artists, without adding up lengths', () => {
    const library = [t({ title: 'a', artist: 'X', album: 'One' }), t({ title: 'b', artist: 'X', album: 'One' }), t({ title: 'c', artist: 'X', album: 'Two' }), t({ title: 'd', artist: 'X' })]
    const x = groupArtists(library).find((a) => a.name === 'X')!
    expect(artistLine(x)).toBe('2 albums · 4 tracks')
    const solo = groupArtists([t({ title: 'a', artist: 'Solo' })]).find((a) => a.name === 'Solo')!
    expect(artistLine(solo)).toBe('1 track')
    const one = groupArtists([t({ title: 'a', artist: 'Duo', album: 'Only' })]).find((a) => a.name === 'Duo')!
    expect(artistLine(one)).toBe('1 album · 1 track')
  })
})
