import { describe, expect, it } from 'vitest'
import { filterByQuery, fold, matches, parseQuery, searchEntry } from './search'
import type { Searchable } from './search'
import { timed } from '../test-utils/fuzz'

const track = (over: Partial<Searchable> = {}): Searchable => ({ title: 'Song', artist: 'Artist', album: 'Album', albumArtist: '', genre: '', year: 0, path: '', file: { name: 'song.mp3' }, ...over })
const find = (items: Searchable[], query: string): string[] => filterByQuery(items, parseQuery(query)).map((t) => t.title)

describe('fold', () => {
  it.each([
    ['İstanbul', 'istanbul'],
    ['ISTANBUL', 'istanbul'],
    ['Istanbul', 'istanbul'],
    ['ıspanak', 'ispanak'],
    ['Gece Yarısı', 'gece yarisi'],
    ['Çöl Şarkısı', 'col sarkisi'],
    ['Şebnem Ferah Ğ', 'sebnem ferah g'],
    ['Beyoncé', 'beyonce'],
    ['Sigur Rós', 'sigur ros'],
    ['Mötley Crüe', 'motley crue'],
    ['Björk', 'bjork'],
    ['Æsop', 'aesop'],
    ['Straße', 'strasse'],
    ['Łódź', 'lodz'],
    ['Ørsted', 'orsted'],
    ['Σίσυφος', 'σισυφοσ'],
    ['ﬁnal ＡＢＣ', 'final abc'],
    ['', ''],
  ])('folds %j to %j', (input, expected) => {
    expect(fold(input)).toBe(expected)
  })

  it('is idempotent', () => {
    for (const text of ['İstanbul', 'Mötley Crüe', 'Straße', 'Çöl Şarkısı', 'Σίσυφος']) expect(fold(fold(text))).toBe(fold(text))
  })
})

describe('parseQuery', () => {
  it('is empty for nothing', () => {
    expect(parseQuery('')).toEqual({ terms: [], empty: true })
    expect(parseQuery('   \t ')).toEqual({ terms: [], empty: true })
  })

  it('splits words into terms that must all match, folded', () => {
    expect(parseQuery('Beatles  Help!').terms).toEqual([
      { field: null, text: 'beatles', negate: false, range: null },
      { field: null, text: 'help!', negate: false, range: null },
    ])
  })

  it('reads field filters, quoted phrases and negation', () => {
    expect(parseQuery('artist:ŞEBNEM album:"white album" -live -genre:rock').terms).toEqual([
      { field: 'artist', text: 'sebnem', negate: false, range: null },
      { field: 'album', text: 'white album', negate: false, range: null },
      { field: null, text: 'live', negate: true, range: null },
      { field: 'genre', text: 'rock', negate: true, range: null },
    ])
    expect(parseQuery('"neon rain"').terms).toEqual([{ field: null, text: 'neon rain', negate: false, range: null }])
    expect(parseQuery('-"live at"').terms).toEqual([{ field: null, text: 'live at', negate: true, range: null }])
  })

  it('treats an unterminated quote as running to the end', () => {
    expect(parseQuery('title:"neon ra').terms).toEqual([{ field: 'title', text: 'neon ra', negate: false, range: null }])
  })

  it.each([
    ['by:x', 'artist'],
    ['song:x', 'title'],
    ['name:x', 'title'],
    ['folder:x', 'path'],
    ['dir:x', 'path'],
    ['date:2000', 'year'],
    ['file:x', 'file'],
  ])('knows the alias %s as %s', (query, field) => {
    expect(parseQuery(query).terms[0]?.field).toBe(field)
  })

  it('ignores a field with nothing after it yet (the user is still typing) and a lone dash or quote', () => {
    expect(parseQuery('artist:').empty).toBe(true)
    expect(parseQuery('-').empty).toBe(true)
    expect(parseQuery('"').empty).toBe(true)
    expect(parseQuery('artist: beatles').terms.map((t) => t.text)).toEqual(['beatles'])
  })

  it('keeps an unknown "field" as plain text, so searching for AC/DC: Back works', () => {
    expect(parseQuery('foo:bar').terms).toEqual([{ field: null, text: 'foo:bar', negate: false, range: null }])
  })

  it.each([
    ['year:2019', [2019, 2019]],
    ['year:1990..1999', [1990, 1999]],
    ['year:1990-1999', [1990, 1999]],
    ['year:1999..1990', [1990, 1999]],
    ['year:>=2000', [2000, Infinity]],
    ['year:>2000', [2001, Infinity]],
    ['year:<=1999', [-Infinity, 1999]],
    ['year:<1999', [-Infinity, 1998]],
    ['year:..1999', [-Infinity, 1999]],
    ['year:2000..', [2000, Infinity]],
    ['year:1990s', [1990, 1999]],
  ])('reads %s as the range %j', (query, range) => {
    expect(parseQuery(query).terms).toEqual([{ field: 'year', text: '', negate: false, range }])
  })

  it('keeps a year it cannot read as plain text', () => {
    expect(parseQuery('year:abc').terms).toEqual([{ field: null, text: 'year:abc', negate: false, range: null }])
  })

  it('caps how much it will parse', () => {
    expect(parseQuery(Array.from({ length: 100 }, (_, i) => `w${i}`).join(' ')).terms).toHaveLength(20)
    expect(parseQuery('x'.repeat(5000)).terms[0]?.text).toHaveLength(200)
  })
})

describe('matching', () => {
  const library = [
    track({ title: 'İstanbul', artist: 'Şebnem Ferah', album: 'Aşk', year: 2019, genre: 'Pop', path: 'Music/Pop' }),
    track({ title: 'Gece Yarısı', artist: 'Tarkan', album: 'Karma', year: 1994, genre: 'Pop', path: 'Music/Pop' }),
    track({ title: 'Help!', artist: 'The Beatles', album: 'Help!', albumArtist: 'The Beatles', year: 1965, genre: 'Rock', path: 'Music/Rock' }),
    track({ title: 'Live at Shea', artist: 'The Beatles', album: 'Live', year: 1966, genre: 'Hard Rock', path: 'Music/Rock/Bootlegs' }),
    track({ title: 'Beyoncé Medley', artist: 'Various', album: 'Hits', year: 0, genre: '', path: '' }),
  ]

  it('finds a Turkish title typed on an English keyboard, in either case', () => {
    expect(find(library, 'istanbul')).toEqual(['İstanbul'])
    expect(find(library, 'ISTANBUL')).toEqual(['İstanbul'])
    expect(find(library, 'İSTANBUL')).toEqual(['İstanbul'])
    expect(find(library, 'yarisi')).toEqual(['Gece Yarısı'])
    expect(find(library, 'sebnem')).toEqual(['İstanbul'])
    expect(find(library, 'ask')).toEqual(['İstanbul'])
  })

  it('ignores accents in both directions', () => {
    expect(find(library, 'beyonce')).toEqual(['Beyoncé Medley'])
    expect(find(library, 'beyoncé')).toEqual(['Beyoncé Medley'])
  })

  it('matches every word, in any order, across title, artist and album', () => {
    expect(find(library, 'beatles help')).toEqual(['Help!'])
    expect(find(library, 'help beatles')).toEqual(['Help!'])
    expect(find(library, 'beatles zzz')).toEqual([])
  })

  it('looks at the genre, the folder and the year too', () => {
    expect(find(library, 'pop')).toEqual(['İstanbul', 'Gece Yarısı'])
    expect(find(library, 'bootlegs')).toEqual(['Live at Shea'])
    expect(find(library, '1965')).toEqual(['Help!'])
  })

  it('narrows to a field when asked', () => {
    expect(find(library, 'artist:beatles')).toEqual(['Help!', 'Live at Shea'])
    expect(find(library, 'title:live')).toEqual(['Live at Shea'])
    expect(find(library, 'album:live')).toEqual(['Live at Shea'])
    expect(find(library, 'genre:rock')).toEqual(['Help!', 'Live at Shea'])
    expect(find(library, 'path:rock')).toEqual(['Help!', 'Live at Shea'])
    expect(find(library, 'folder:music/pop')).toEqual(['İstanbul', 'Gece Yarısı'])
  })

  it('finds an artist by the album artist as well', () => {
    const compilation = [track({ title: 'One', artist: 'Guest', albumArtist: 'Various Artists' }), track({ title: 'Two', artist: 'Someone' })]
    expect(find(compilation, 'artist:various')).toEqual(['One'])
  })

  it('treats a phrase as one contiguous piece of text', () => {
    expect(find(library, '"live at"')).toEqual(['Live at Shea'])
    expect(find(library, '"at live"')).toEqual([])
  })

  it('excludes what is negated', () => {
    expect(find(library, 'beatles -live')).toEqual(['Help!'])
    expect(find(library, 'pop -artist:tarkan')).toEqual(['İstanbul'])
    expect(find(library, '-pop -rock')).toEqual(['Beyoncé Medley'])
  })

  it('filters by year, range and decade, and never matches a track whose year is unknown', () => {
    expect(find(library, 'year:1965')).toEqual(['Help!'])
    expect(find(library, 'year:1960..1969')).toEqual(['Help!', 'Live at Shea'])
    expect(find(library, 'year:1990s')).toEqual(['Gece Yarısı'])
    expect(find(library, 'year:>=2000')).toEqual(['İstanbul'])
    expect(find(library, 'year:<1990')).toEqual(['Help!', 'Live at Shea']) // not the track with no year
    expect(find(library, 'pop year:>=2000')).toEqual(['İstanbul'])
  })

  it('combines filters with plain words', () => {
    expect(find(library, 'artist:beatles year:1966 shea')).toEqual(['Live at Shea'])
  })

  it('returns everything for an empty query, and the very same array', () => {
    const all = filterByQuery(library, parseQuery(''))
    expect(all).toBe(library)
    expect(find(library, '   ')).toHaveLength(5)
  })

  it('matches against the file name when the title is only the file name', () => {
    const bare = [track({ title: 'x', file: { name: 'Neon Rain.mp3' } })]
    expect(find(bare, 'file:neon')).toEqual(['x'])
    expect(find(bare, 'neon rain')).toEqual(['x'])
  })

  it('works on a Turkish library with the dotted and the dotless i', () => {
    const turkish = [track({ title: 'Işık' }), track({ title: 'İşte' }), track({ title: 'Kırmızı' }), track({ title: 'Kirmizi Gül' })]
    expect(find(turkish, 'isik')).toEqual(['Işık'])
    expect(find(turkish, 'iste')).toEqual(['İşte'])
    expect(find(turkish, 'kirmizi')).toEqual(['Kırmızı', 'Kirmizi Gül'])
  })
})

describe('searchEntry', () => {
  it('is computed once per track object and recomputed for a changed copy', () => {
    const t = track({ title: 'Original' })
    const first = searchEntry(t)
    expect(searchEntry(t)).toBe(first)
    const copy = { ...t, title: 'Changed' }
    expect(searchEntry(copy)).not.toBe(first)
    expect(searchEntry(copy).title).toBe('changed')
  })

  it('searches 20,000 tracks in well under a second', () => {
    const items = Array.from({ length: 20_000 }, (_, i) => track({ title: `Track ${i}`, artist: i % 7 === 0 ? 'Şebnem Ferah' : `Artist ${i % 500}`, album: `Album ${i % 900}`, year: 1950 + (i % 75), path: `Music/${i % 40}` }))
    find(items, 'warm up') // the entries are built on first use
    const { result: hits, ms } = timed(() => find(items, 'sebnem year:>=2000 -album:1'))
    expect(ms).toBeLessThan(500)
    expect(hits.length).toBeGreaterThan(0)
  })
})
