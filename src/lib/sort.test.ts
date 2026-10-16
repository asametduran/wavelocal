import { describe, expect, it } from 'vitest'
import { SORT_KEYS, describeSort, directionWords, parseSortSpec, sortTracks } from './sort'
import type { SortKey, Sortable } from './sort'

let counter = 0
const t = (over: Partial<Sortable> & { title: string }): Sortable & { id: number } => ({
  id: counter++,
  artist: 'Artist',
  album: '',
  albumArtist: '',
  trackNo: 0,
  discNo: 0,
  year: 0,
  duration: 0,
  addedAt: 0,
  plays: 0,
  lastPlayedAt: null,
  ...over,
})
const titles = (items: readonly Sortable[]): string[] => items.map((x) => x.title)
const sorted = (items: Sortable[], key: SortKey, dir: 'asc' | 'desc' = 'asc'): string[] => titles(sortTracks(items, { key, dir }))

describe('sortTracks', () => {
  it('leaves the library order alone, and returns the very same array', () => {
    const items = [t({ title: 'b' }), t({ title: 'a' })]
    expect(sortTracks(items, { key: 'library', dir: 'desc' })).toBe(items)
  })

  it('never changes the array it is given', () => {
    const items = [t({ title: 'b' }), t({ title: 'a' }), t({ title: 'c' })]
    const before = titles(items)
    sortTracks(items, { key: 'title', dir: 'asc' })
    expect(titles(items)).toEqual(before)
  })

  describe('by title', () => {
    const items = [t({ title: 'track 10' }), t({ title: 'Track 2' }), t({ title: 'Çöl' }), t({ title: 'cöl' }), t({ title: 'Ábel' }), t({ title: 'abel' }), t({ title: 'Zeta' })]

    it('puts numbers in numeric order and ignores case and accents when comparing', () => {
      const out = sorted(items, 'title')
      expect(out.indexOf('Track 2')).toBeLessThan(out.indexOf('track 10'))
      expect(out.slice(0, 2).sort()).toEqual(['abel', 'Ábel'].sort())
      expect(out.at(-1)).toBe('Zeta')
    })

    it('reverses the order for descending', () => {
      expect(sorted([t({ title: 'a' }), t({ title: 'c' }), t({ title: 'b' })], 'title', 'desc')).toEqual(['c', 'b', 'a'])
      expect(sorted(items, 'title', 'desc')[0]).toBe('Zeta')
      expect(sorted(items, 'title', 'desc')).toHaveLength(items.length)
    })

    it('keeps equal titles in library order (stable), and breaks ties by artist', () => {
      const first = t({ title: 'Song', artist: 'B' })
      const second = t({ title: 'Song', artist: 'A' })
      const third = t({ title: 'Song', artist: 'A' })
      const out = sortTracks([first, second, third], { key: 'title', dir: 'asc' })
      expect(out[0]).toBe(second)
      expect(out[1]).toBe(third)
      expect(out[2]).toBe(first)
    })
  })

  describe('by artist and by album', () => {
    const items = [
      t({ title: 'B2', artist: 'Beatles', album: 'Help', trackNo: 2 }),
      t({ title: 'A1', artist: 'Abba', album: 'Arrival', trackNo: 1 }),
      t({ title: 'B1', artist: 'Beatles', album: 'Help', trackNo: 1 }),
      t({ title: 'R1', artist: 'Beatles', album: 'Abbey Road', trackNo: 1 }),
      t({ title: 'D2', artist: 'Beatles', album: 'Double', discNo: 2, trackNo: 1 }),
      t({ title: 'D1', artist: 'Beatles', album: 'Double', discNo: 1, trackNo: 5 }),
    ]

    it('artist order keeps each artist\'s albums together, in album, disc and track order', () => {
      expect(sorted(items, 'artist')).toEqual(['A1', 'R1', 'D1', 'D2', 'B1', 'B2'])
    })

    it('descending reverses the artists but not the order inside an artist', () => {
      expect(sorted(items, 'artist', 'desc')).toEqual(['R1', 'D1', 'D2', 'B1', 'B2', 'A1'])
    })

    it('album order walks an album by disc and track number', () => {
      expect(sorted(items, 'album')).toEqual(['R1', 'A1', 'D1', 'D2', 'B1', 'B2'])
    })

    it('separates two albums with the same name by who made them', () => {
      const hits = [t({ title: 'y1', artist: 'Y', album: 'Hits', trackNo: 1 }), t({ title: 'x2', artist: 'X', album: 'Hits', trackNo: 2 }), t({ title: 'x1', artist: 'X', album: 'Hits', trackNo: 1 })]
      expect(sorted(hits, 'album')).toEqual(['x1', 'x2', 'y1'])
    })

    it('uses the album artist rather than the track artist to keep a compilation together', () => {
      const comp = [t({ title: 'c2', artist: 'Zed', albumArtist: 'Various', album: 'Mix', trackNo: 2 }), t({ title: 'c1', artist: 'Amy', albumArtist: 'Various', album: 'Mix', trackNo: 1 })]
      expect(sorted(comp, 'album')).toEqual(['c1', 'c2'])
    })
  })

  describe('unknown values sort last, in both directions', () => {
    it('album', () => {
      const items = [t({ title: 'no album' }), t({ title: 'B', album: 'B' }), t({ title: 'A', album: 'A' })]
      expect(sorted(items, 'album')).toEqual(['A', 'B', 'no album'])
      expect(sorted(items, 'album', 'desc')).toEqual(['B', 'A', 'no album'])
    })

    it('year', () => {
      const items = [t({ title: 'none' }), t({ title: '1999', year: 1999 }), t({ title: '2010', year: 2010 })]
      expect(sorted(items, 'year')).toEqual(['1999', '2010', 'none'])
      expect(sorted(items, 'year', 'desc')).toEqual(['2010', '1999', 'none'])
    })

    it('duration and track number', () => {
      const items = [t({ title: 'x', duration: 0, trackNo: 0 }), t({ title: 'long', duration: 300, trackNo: 9 }), t({ title: 'short', duration: 60, trackNo: 2 })]
      expect(sorted(items, 'duration')).toEqual(['short', 'long', 'x'])
      expect(sorted(items, 'duration', 'desc')).toEqual(['long', 'short', 'x'])
      expect(sorted(items, 'track')).toEqual(['short', 'long', 'x'])
      expect(sorted(items, 'track', 'desc')).toEqual(['long', 'short', 'x'])
    })

    it('date added', () => {
      const items = [t({ title: 'undated' }), t({ title: 'old', addedAt: 1000 }), t({ title: 'new', addedAt: 2000 })]
      expect(sorted(items, 'added')).toEqual(['old', 'new', 'undated'])
      expect(sorted(items, 'added', 'desc')).toEqual(['new', 'old', 'undated'])
    })
  })

  describe('by date added', () => {
    it('breaks ties (one import shares one time) by library position, later ones first when newest first', () => {
      const items = [t({ title: 'a', addedAt: 5 }), t({ title: 'b', addedAt: 5 }), t({ title: 'c', addedAt: 5 })]
      expect(sorted(items, 'added', 'desc')).toEqual(['c', 'b', 'a'])
      expect(sorted(items, 'added', 'asc')).toEqual(['a', 'b', 'c'])
    })
  })

  describe('by play count', () => {
    const items = [
      t({ title: 'never', plays: 0 }),
      t({ title: 'twice-old', plays: 2, lastPlayedAt: 100 }),
      t({ title: 'twice-new', plays: 2, lastPlayedAt: 200 }),
      t({ title: 'often', plays: 9, lastPlayedAt: 50 }),
    ]

    it('puts the most played first by default, then the most recently played', () => {
      expect(sorted(items, 'plays', 'desc')).toEqual(['often', 'twice-new', 'twice-old', 'never'])
    })

    it('ascending starts with what was never played', () => {
      expect(sorted(items, 'plays', 'asc')).toEqual(['never', 'twice-old', 'twice-new', 'often'])
    })
  })

  describe('by year', () => {
    it('groups a year by album, disc and track', () => {
      const items = [t({ title: 'b2', year: 1999, album: 'B', trackNo: 2 }), t({ title: 'a1', year: 1999, album: 'A', trackNo: 1 }), t({ title: 'b1', year: 1999, album: 'B', trackNo: 1 }), t({ title: 'old', year: 1970, album: 'Z' })]
      expect(sorted(items, 'year')).toEqual(['old', 'a1', 'b1', 'b2'])
    })
  })

  it('sorts 50,000 tracks in well under a second', () => {
    const items = Array.from({ length: 50_000 }, (_, i) => t({ title: `Song ${(i * 7919) % 50_000}`, artist: `Artist ${i % 800}`, album: `Album ${i % 3000}`, trackNo: i % 20, year: 1960 + (i % 60) }))
    const started = performance.now()
    sortTracks(items, { key: 'artist', dir: 'asc' })
    expect(performance.now() - started).toBeLessThan(1500)
  })
})

describe('SORT_KEYS', () => {
  it('offers every key once, with a label and a sensible first direction', () => {
    const keys = SORT_KEYS.map((k) => k.key)
    expect(new Set(keys).size).toBe(keys.length)
    expect(keys).toEqual(['library', 'title', 'artist', 'album', 'track', 'duration', 'added', 'plays', 'year'])
    expect(new Set(SORT_KEYS.map((k) => k.label)).size).toBe(keys.length)
    expect(SORT_KEYS.find((k) => k.key === 'added')?.dir).toBe('desc')
    expect(SORT_KEYS.find((k) => k.key === 'plays')?.dir).toBe('desc')
    expect(SORT_KEYS.find((k) => k.key === 'title')?.dir).toBe('asc')
  })
})

describe('parseSortSpec', () => {
  it('reads what it wrote', () => {
    expect(parseSortSpec({ key: 'album', dir: 'desc' })).toEqual({ key: 'album', dir: 'desc' })
    expect(parseSortSpec(JSON.parse(JSON.stringify({ key: 'year', dir: 'asc' })))).toEqual({ key: 'year', dir: 'asc' })
  })

  it.each([[null], [undefined], ['title'], [42], [[]], [{}], [{ key: 'nope', dir: 'asc' }], [{ key: 7 }]])('falls back to the library order for %j', (raw) => {
    expect(parseSortSpec(raw)).toEqual({ key: 'library', dir: 'asc' })
  })

  it('fills in the usual direction when only the key is valid', () => {
    expect(parseSortSpec({ key: 'plays' })).toEqual({ key: 'plays', dir: 'desc' })
    expect(parseSortSpec({ key: 'title', dir: 'bad' })).toEqual({ key: 'title', dir: 'asc' })
  })
})

describe('directionWords', () => {
  it('names the two directions of every key the way people say them', () => {
    expect(directionWords('title', 'asc')).toBe('A to Z')
    expect(directionWords('title', 'desc')).toBe('Z to A')
    expect(directionWords('artist', 'asc')).toBe('A to Z')
    expect(directionWords('album', 'desc')).toBe('Z to A')
    expect(directionWords('track', 'asc')).toBe('low to high')
    expect(directionWords('track', 'desc')).toBe('high to low')
    expect(directionWords('duration', 'asc')).toBe('shortest first')
    expect(directionWords('duration', 'desc')).toBe('longest first')
    expect(directionWords('added', 'asc')).toBe('oldest first')
    expect(directionWords('added', 'desc')).toBe('newest first')
    expect(directionWords('plays', 'desc')).toBe('most first')
    expect(directionWords('plays', 'asc')).toBe('fewest first')
    expect(directionWords('year', 'asc')).toBe('oldest first')
    expect(directionWords('year', 'desc')).toBe('newest first')
  })

  it('has nothing to say about the library order, which has no direction', () => {
    expect(directionWords('library', 'asc')).toBe('')
    expect(directionWords('library', 'desc')).toBe('')
  })

  it('has words for both directions of every key in the sort menu', () => {
    for (const { key } of SORT_KEYS) {
      if (key === 'library') continue
      expect(directionWords(key, 'asc'), key).not.toBe('')
      expect(directionWords(key, 'asc'), key).not.toBe(directionWords(key, 'desc'))
    }
  })
})

describe('describeSort', () => {
  it('says the sort in a few words: what it sorts by, and which way', () => {
    expect(describeSort({ key: 'title', dir: 'asc' })).toBe('Title, A to Z')
    expect(describeSort({ key: 'added', dir: 'desc' })).toBe('Date added, newest first')
    expect(describeSort({ key: 'plays', dir: 'desc' })).toBe('Play count, most first')
    expect(describeSort({ key: 'duration', dir: 'asc' })).toBe('Length, shortest first')
  })

  it('calls the stored order by the name of the list it belongs to', () => {
    expect(describeSort({ key: 'library', dir: 'asc' })).toBe('Library order')
    expect(describeSort({ key: 'library', dir: 'desc' }, 'Playlist order')).toBe('Playlist order')
  })
})
