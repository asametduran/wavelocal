import { describe, expect, it } from 'vitest'
import { ALBUM_SORTS, describeAlbumSort, filterGroups, getGroups, groupAlbums, groupArtists, groupOf, parseAlbumSort, sortAlbums } from './groups'
import type { Groupable } from './groups'
import { parseQuery } from './search'
import type { Searchable } from './search'

let n = 0
const t = (over: Partial<Groupable> & { title: string }): Groupable => ({
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
  ...over,
})
const titles = (items: readonly Groupable[]): string[] => items.map((x) => x.title)
const art = new Blob(['art'])

describe('groupAlbums', () => {
  it('groups tracks by album, keeping each album in disc and track order', () => {
    const albums = groupAlbums([
      t({ title: 'B2', album: 'Help', artist: 'Beatles', trackNo: 2 }),
      t({ title: 'A1', album: 'Arrival', artist: 'Abba', trackNo: 1 }),
      t({ title: 'B1', album: 'Help', artist: 'Beatles', trackNo: 1 }),
      t({ title: 'D2', album: 'Double', artist: 'Beatles', discNo: 2, trackNo: 1 }),
      t({ title: 'D1', album: 'Double', artist: 'Beatles', discNo: 1, trackNo: 9 }),
    ])
    expect(albums.map((a) => [a.title, a.artist, titles(a.tracks)])).toEqual([
      ['Arrival', 'Abba', ['A1']],
      ['Double', 'Beatles', ['D1', 'D2']],
      ['Help', 'Beatles', ['B1', 'B2']],
    ])
  })

  it('adds up lengths, takes the usual year, the newest added time and the first artwork', () => {
    const [album] = groupAlbums([
      t({ title: '1', album: 'LP', artist: 'X', trackNo: 1, duration: 100, year: 1999, addedAt: 5 }),
      t({ title: '2', album: 'LP', artist: 'X', trackNo: 2, duration: 200.5, year: 2005, addedAt: 9, coverBlob: art }),
      t({ title: '3', album: 'LP', artist: 'X', trackNo: 3, duration: 50, year: 1999, addedAt: 7 }),
    ])
    expect(album).toMatchObject({ title: 'LP', duration: 350.5, year: 1999, addedAt: 9 })
    expect(album?.cover?.title).toBe('2')
    expect(album?.tracks).toHaveLength(3)
  })

  it('takes the earlier year when two years are equally common', () => {
    const [album] = groupAlbums([
      t({ title: '1', album: 'LP', artist: 'X', year: 2005 }),
      t({ title: '2', album: 'LP', artist: 'X', year: 1999 }),
      t({ title: '3', album: 'LP', artist: 'X', year: 2005 }),
      t({ title: '4', album: 'LP', artist: 'X', year: 1999 }),
    ])
    expect(album?.year).toBe(1999)
  })

  it('keeps two albums of the same name apart when different artists made them', () => {
    const albums = groupAlbums([
      t({ title: 'x1', album: 'Greatest Hits', artist: 'X' }),
      t({ title: 'x2', album: 'Greatest Hits', artist: 'X' }),
      t({ title: 'y1', album: 'Greatest Hits', artist: 'Y' }),
      t({ title: 'y2', album: 'Greatest Hits', artist: 'Y' }),
    ])
    expect(albums.map((a) => [a.artist, titles(a.tracks)])).toEqual([
      ['X', ['x1', 'x2']],
      ['Y', ['y1', 'y2']],
    ])
  })

  it('treats names the way search does: case, accents and Turkish dots do not split an album', () => {
    const albums = groupAlbums([t({ title: '1', album: 'İstanbul', artist: 'Şebnem' }), t({ title: '2', album: 'ISTANBUL', artist: 'Sebnem' })])
    expect(albums).toHaveLength(1)
    expect(albums[0]?.title).toBe('İstanbul') // the first spelling seen is the one shown
    expect(albums[0]?.artist).toBe('Şebnem')
  })

  describe('compilations', () => {
    it('the album artist keeps a compilation together although the track artists differ', () => {
      const albums = groupAlbums([
        t({ title: 'c1', album: 'Mix', artist: 'Amy', albumArtist: 'Various Artists', trackNo: 1 }),
        t({ title: 'c2', album: 'Mix', artist: 'Zed', albumArtist: 'Various Artists', trackNo: 2 }),
      ])
      expect(albums).toHaveLength(1)
      expect(albums[0]).toMatchObject({ title: 'Mix', artist: 'Various Artists' })
    })

    it('a compilation flag does it too', () => {
      const albums = groupAlbums([t({ title: 'a', album: 'Mix', artist: 'Amy', compilation: true }), t({ title: 'b', album: 'Mix', artist: 'Zed', compilation: true })])
      expect(albums).toHaveLength(1)
      expect(albums[0]).toMatchObject({ artist: 'Various Artists', compilation: true })
    })

    it('with no tags at all, many different artists on one album title count as a compilation', () => {
      const albums = groupAlbums(['A', 'B', 'C', 'D', 'E'].map((artist, i) => t({ title: `s${i}`, album: 'Summer Hits', artist, trackNo: i + 1 })))
      expect(albums).toHaveLength(1)
      expect(albums[0]?.artist).toBe('Various Artists')
    })

    it('does not guess a compilation from a short album: three tracks by three artists is too little to go on', () => {
      const albums = groupAlbums(['A', 'B', 'C'].map((artist, i) => t({ title: `s${i}`, album: 'Split', artist, trackNo: i + 1 })))
      expect(albums.map((a) => a.artist)).toEqual(['A', 'B', 'C'])
    })

    it('but one artist with most of the tracks, or only two artists, is not one', () => {
      const dominant = ['A', 'A', 'A', 'A', 'B', 'C'].map((artist, i) => t({ title: `d${i}`, album: 'Best Of', artist }))
      expect(groupAlbums(dominant).map((a) => a.artist)).toEqual(['A', 'B', 'C'])
      const two = ['A', 'A', 'B', 'B'].map((artist, i) => t({ title: `w${i}`, album: 'Live', artist }))
      expect(groupAlbums(two).map((a) => a.artist)).toEqual(['A', 'B'])
    })
  })

  describe('tracks with no album', () => {
    const loose = [t({ title: 'x1', artist: 'X' }), t({ title: 'x2', artist: 'X' }), t({ title: 'y1', artist: 'Y' })]

    it('gather under an "Unknown album" for each artist', () => {
      const albums = groupAlbums(loose)
      expect(albums.map((a) => [a.title, a.artist, a.unknown, titles(a.tracks)])).toEqual([
        ['Unknown album', 'X', true, ['x1', 'x2']],
        ['Unknown album', 'Y', true, ['y1']],
      ])
    })

    it('or all under one card when asked', () => {
      const albums = groupAlbums(loose, { mergeUnknown: true })
      expect(albums).toHaveLength(1)
      expect(albums[0]).toMatchObject({ title: 'Unknown album', artist: '', unknown: true })
      expect(albums[0]?.tracks).toHaveLength(3)
    })

    it('are ordered by title, as there is no track order to follow', () => {
      const [album] = groupAlbums([t({ title: 'z', artist: 'X' }), t({ title: 'a', artist: 'X' })])
      expect(titles(album?.tracks ?? [])).toEqual(['a', 'z'])
    })
  })

  it('lists albums by artist, then year, then title', () => {
    const albums = groupAlbums([
      t({ title: '1', album: 'Zed', artist: 'B', year: 1990 }),
      t({ title: '2', album: 'Alpha', artist: 'B', year: 2000 }),
      t({ title: '3', album: 'Beta', artist: 'B', year: 1990 }),
      t({ title: '4', album: 'Omega', artist: 'A', year: 2010 }),
    ])
    expect(albums.map((a) => a.title)).toEqual(['Omega', 'Beta', 'Zed', 'Alpha'])
  })

  it('gives every album a distinct id', () => {
    const albums = groupAlbums([t({ title: '1', album: 'A', artist: 'X' }), t({ title: '2', album: 'A', artist: 'Y' }), t({ title: '3', album: 'B', artist: 'X' }), t({ title: '4', artist: 'X' })])
    expect(new Set(albums.map((a) => a.id)).size).toBe(albums.length)
  })

  it('handles nothing', () => {
    expect(groupAlbums([])).toEqual([])
  })
})

describe('sortAlbums', () => {
  const albums = groupAlbums([
    t({ title: '1', album: 'Zed', artist: 'B', year: 1990, addedAt: 5 }),
    t({ title: '2', album: 'Alpha', artist: 'C', year: 2000, addedAt: 9 }),
    t({ title: '3', album: 'Beta', artist: 'A', year: 0, addedAt: 7 }),
  ])
  const order = (key: Parameters<typeof sortAlbums>[1], dir: 'asc' | 'desc' = 'asc') => sortAlbums(albums, key, dir).map((a) => a.title)

  it('by title, artist, year or when added', () => {
    expect(order('title')).toEqual(['Alpha', 'Beta', 'Zed'])
    expect(order('title', 'desc')).toEqual(['Zed', 'Beta', 'Alpha'])
    expect(order('artist')).toEqual(['Beta', 'Zed', 'Alpha'])
    expect(order('year')).toEqual(['Zed', 'Alpha', 'Beta']) // no year: last
    expect(order('year', 'desc')).toEqual(['Alpha', 'Zed', 'Beta'])
    expect(order('added', 'desc')).toEqual(['Alpha', 'Beta', 'Zed'])
    expect(order('added')).toEqual(['Zed', 'Beta', 'Alpha'])
  })

  it('puts an album with no title tag last, whatever the key and the direction', () => {
    const mixed = groupAlbums([t({ title: 'u', artist: 'A' }), t({ title: 'z', album: 'Zed', artist: 'Z', year: 2000, addedAt: 3 }), t({ title: 'b', album: 'Beta', artist: 'B', year: 1990, addedAt: 2 })])
    for (const key of ['artist', 'title', 'year', 'added'] as const) {
      for (const dir of ['asc', 'desc'] as const) expect(sortAlbums(mixed, key, dir).at(-1)?.unknown, `${key} ${dir}`).toBe(true)
    }
  })

  it('does not change the list it is given', () => {
    const before = albums.map((a) => a.title)
    sortAlbums(albums, 'title', 'desc')
    expect(albums.map((a) => a.title)).toEqual(before)
  })
})

describe('groupArtists', () => {
  const library = [
    t({ title: 'B2', artist: 'The Beatles', album: 'Help', trackNo: 2, year: 1965, duration: 120, coverBlob: art }),
    t({ title: 'B1', artist: 'The Beatles', album: 'Help', trackNo: 1, year: 1965, duration: 100 }),
    t({ title: 'R1', artist: 'The Beatles', album: 'Abbey Road', trackNo: 1, year: 1969, duration: 80 }),
    t({ title: 'M1', artist: 'Mixer', album: 'Summer', albumArtist: 'Various Artists', trackNo: 1 }),
    t({ title: 'M2', artist: 'The Beatles', album: 'Summer', albumArtist: 'Various Artists', trackNo: 2, duration: 60 }),
    t({ title: 'Single', artist: 'Şebnem' }),
    t({ title: 'single', artist: 'SEBNEM' }),
  ]
  const artists = groupArtists(library)

  it('lists artists alphabetically, merging spellings that differ only in case or accents', () => {
    expect(artists.map((a) => a.name)).toEqual(['Mixer', 'Şebnem', 'The Beatles'])
    expect(artists.find((a) => a.name === 'Şebnem')?.tracks).toHaveLength(2)
  })

  it('keeps an artist\'s tracks together by album in the order of the albums, adds up their length and finds artwork', () => {
    const beatles = artists.find((a) => a.name === 'The Beatles')
    // Help (1965), Abbey Road (1969), then Summer (no year): the same order as the list of albums below
    expect(titles(beatles?.tracks ?? [])).toEqual(['B1', 'B2', 'R1', 'M2'])
    expect(beatles?.duration).toBe(80 + 100 + 120 + 60)
    expect(beatles?.cover?.title).toBe('B2')
  })

  it('plays an artist through their albums in exactly the order the albums are listed', () => {
    for (const artist of artists) {
      const own = new Set(artist.tracks.map((x) => x.id))
      const walked = artist.albums.flatMap((album) => album.tracks.filter((x) => own.has(x.id)).map((x) => x.id))
      expect(artist.tracks.map((x) => x.id), artist.name).toEqual(walked)
    }
  })

  it('lists the albums an artist appears on, compilations included, oldest first', () => {
    const beatles = artists.find((a) => a.name === 'The Beatles')
    expect(beatles?.albums.map((a) => a.title)).toEqual(['Help', 'Abbey Road', 'Summer']) // 1965, 1969, and no year last
    expect(beatles?.albums.find((a) => a.title === 'Summer')?.tracks).toHaveLength(2) // the whole album, not just their track
  })

  it('gives every artist a distinct id and handles nothing', () => {
    expect(new Set(artists.map((a) => a.id)).size).toBe(artists.length)
    expect(groupArtists([])).toEqual([])
  })
})

describe('group ids and the shared index', () => {
  const library = [t({ title: 'a1', album: 'LP', artist: 'X', trackNo: 1 }), t({ title: 'a2', album: 'LP', artist: 'X', trackNo: 2 }), t({ title: 'b1', album: 'Other', artist: 'Y' })]

  it('finds the tracks of an album or an artist by their page ref, in order', () => {
    const groups = getGroups(library)
    const lp = groups.albums.find((a) => a.title === 'LP')
    const x = groups.artists.find((a) => a.name === 'X')
    const ref = (id: string) => groupOf(groups, id)
    expect(titles((ref(`album:${lp?.id}`) as { album: { tracks: Groupable[] } }).album.tracks)).toEqual(['a1', 'a2'])
    expect(titles((ref(`artist:${x?.id}`) as { artist: { tracks: Groupable[] } }).artist.tracks)).toEqual(['a1', 'a2'])
    expect(ref('album:nothing')).toBeNull()
    expect(ref('pl1')).toBeNull()
  })

  it('knows which album card and which artist each track belongs to, the merged "Unknown album" included', () => {
    const loose = [t({ title: 'l1', artist: 'X' }), t({ title: 'l2', artist: 'Y' })]
    const all = [...library, ...loose]
    const groups = getGroups(all)
    const idOf = (i: number): string => all[i]?.id ?? ''
    const lp = groups.albums.find((a) => a.title === 'LP')
    const unknown = groups.albums.find((a) => a.unknown)
    expect(groups.albumOfTrack.get(idOf(0))).toBe(lp?.id)
    expect(groups.albumOfTrack.get(idOf(1))).toBe(lp?.id)
    expect(groups.albumOfTrack.get(idOf(3))).toBe(unknown?.id) // the loose tracks of every artist share one card
    expect(groups.albumOfTrack.get(idOf(4))).toBe(unknown?.id)
    const x = groups.artists.find((a) => a.name === 'X')
    expect(groups.artistOfTrack.get(idOf(0))).toBe(x?.id)
    expect(groups.artistOfTrack.get(idOf(3))).toBe(x?.id)
    expect(groups.albumOfTrack.size).toBe(all.length)
    expect(groups.artistOfTrack.size).toBe(all.length)
    // the card an index names can be opened
    expect(groups.albumById.get(groups.albumOfTrack.get(idOf(4)) ?? '')?.tracks).toHaveLength(2)
  })

  it('is built once per library array, however often it is asked for', () => {
    expect(getGroups(library)).toBe(getGroups(library))
    expect(getGroups([...library])).not.toBe(getGroups(library))
  })

  it('groups 20,000 tracks in well under a second', () => {
    const big = Array.from({ length: 20_000 }, (_, i) => t({ title: `T${i}`, album: `Album ${i % 1500}`, artist: `Artist ${i % 600}`, trackNo: (i % 15) + 1, year: 1970 + (i % 50) }))
    const started = performance.now()
    const groups = getGroups(big)
    expect(performance.now() - started).toBeLessThan(1500)
    expect(groups.albums.length).toBeGreaterThan(1000)
  })
})

describe('groupOf', () => {
  const library = [t({ title: 'a1', album: 'LP', artist: 'X', trackNo: 1 }), t({ title: 'b1', album: 'Other', artist: 'Y' })]

  it('says whether a view id is an album or an artist, and which one', () => {
    const groups = getGroups(library)
    const lp = groups.albums.find((a) => a.title === 'LP')
    const y = groups.artists.find((a) => a.name === 'Y')
    expect(groupOf(groups, `album:${lp?.id}`)).toEqual({ kind: 'album', album: lp })
    expect(groupOf(groups, `artist:${y?.id}`)).toEqual({ kind: 'artist', artist: y })
    expect(groupOf(groups, 'album:nothing')).toBeNull()
    expect(groupOf(groups, 'artist:nothing')).toBeNull()
    expect(groupOf(groups, 'all')).toBeNull()
    expect(groupOf(groups, 'pl1')).toBeNull()
  })

  it('keeps the kind of track it was built from (a type-level check, run by the typechecker)', () => {
    const rich = library.map((x) => ({ ...x, extra: 7 }))
    const first = getGroups(rich).albums[0]?.tracks[0]
    expect(first?.extra).toBe(7)
    const ref = groupOf(getGroups(rich), `album:${getGroups(rich).albums[0]?.id}`)
    expect(ref?.kind === 'album' ? ref.album.tracks[0]?.extra : undefined).toBe(7)
  })
})

describe('album sort choices', () => {
  it('offers artist, album, year and date added, once each, with the usual direction first', () => {
    expect(ALBUM_SORTS.map((s) => s.key)).toEqual(['artist', 'title', 'year', 'added'])
    expect(new Set(ALBUM_SORTS.map((s) => s.label)).size).toBe(ALBUM_SORTS.length)
    expect(ALBUM_SORTS.find((s) => s.key === 'added')?.dir).toBe('desc')
    expect(ALBUM_SORTS.find((s) => s.key === 'artist')?.dir).toBe('asc')
  })

  it('reads what it wrote and fills in a missing direction', () => {
    expect(parseAlbumSort({ key: 'year', dir: 'desc' })).toEqual({ key: 'year', dir: 'desc' })
    expect(parseAlbumSort({ key: 'added' })).toEqual({ key: 'added', dir: 'desc' })
    expect(parseAlbumSort({ key: 'title', dir: 'sideways' })).toEqual({ key: 'title', dir: 'asc' })
  })

  it.each([[null], [undefined], ['year'], [7], [[]], [{}], [{ key: 'plays', dir: 'asc' }], [{ key: 3 }]])('falls back to artist order for %j', (raw) => {
    expect(parseAlbumSort(raw)).toEqual({ key: 'artist', dir: 'asc' })
  })

  it('says the sort in a few words: what it sorts by, and which way', () => {
    expect(describeAlbumSort({ key: 'artist', dir: 'asc' })).toBe('Artist, A to Z')
    expect(describeAlbumSort({ key: 'title', dir: 'desc' })).toBe('Album, Z to A')
    expect(describeAlbumSort({ key: 'year', dir: 'asc' })).toBe('Year, oldest first')
    expect(describeAlbumSort({ key: 'added', dir: 'desc' })).toBe('Date added, newest first')
  })
})

describe('filterGroups', () => {
  let m = 0
  const s = (over: Partial<Searchable & Groupable> & { title: string }): Searchable & Groupable => ({ ...t(over), genre: '', path: '', file: { name: `${over.title}-${m++}.mp3` }, ...over })
  const library = [
    s({ title: 'Help!', album: 'Help', artist: 'The Beatles', year: 1965, trackNo: 1 }),
    s({ title: 'Yesterday', album: 'Help', artist: 'The Beatles', year: 1965, trackNo: 2 }),
    s({ title: 'Dancing Queen', album: 'Arrival', artist: 'ABBA', year: 1976, trackNo: 1 }),
    s({ title: 'İstanbul', album: 'Şehir', artist: 'Sila', year: 2010, trackNo: 1 }),
  ]
  const albums = groupAlbums(library)
  const artists = groupArtists(library, albums)
  const names = (items: readonly { title?: string; name?: string }[]) => items.map((x) => x.title ?? x.name)

  it('returns the very same list for an empty query', () => {
    expect(filterGroups(albums, parseQuery(''))).toBe(albums)
    expect(filterGroups(artists, parseQuery('   '))).toBe(artists)
  })

  it('keeps an album, whole, when any one of its tracks matches', () => {
    const found = filterGroups(albums, parseQuery('yesterday'))
    expect(names(found)).toEqual(['Help'])
    expect(found[0]?.tracks).toHaveLength(2)
  })

  it('finds words that live in different fields of one track, in any order', () => {
    expect(names(filterGroups(albums, parseQuery('beatles help')))).toEqual(['Help'])
    expect(names(filterGroups(albums, parseQuery('help beatles')))).toEqual(['Help'])
    expect(names(filterGroups(albums, parseQuery('abba help')))).toEqual([])
  })

  it('ignores accents and Turkish casing, like the song search', () => {
    expect(names(filterGroups(albums, parseQuery('istanbul')))).toEqual(['Şehir'])
    expect(names(filterGroups(artists, parseQuery('sehir')))).toEqual(['Sila'])
  })

  it('understands filters', () => {
    expect(names(filterGroups(albums, parseQuery('year:1960..1969')))).toEqual(['Help'])
    expect(names(filterGroups(artists, parseQuery('album:arrival')))).toEqual(['ABBA'])
    expect(names(filterGroups(artists, parseQuery('artist:beatles -yesterday')))).toEqual(['The Beatles']) // "Help!" still qualifies
  })
})
