import { describe, expect, it } from 'vitest'
import { BROWSE_MODES, MAX_TRAIL, closePage, openPage, parseMode, parseTrail, pruneTrail } from './browse'

describe('BROWSE_MODES', () => {
  it('offers tracks, albums, artists and folders once each, with what each one lists', () => {
    expect(BROWSE_MODES.map((m) => m.mode)).toEqual(['list', 'albums', 'artists', 'folders'])
    expect(BROWSE_MODES.map((m) => m.label)).toEqual(['Tracks', 'Albums', 'Artists', 'Folders'])
    expect(BROWSE_MODES.map((m) => m.noun)).toEqual(['track', 'album', 'artist', 'track'])
  })
})

describe('parseMode', () => {
  it('reads what was stored, including the two values older versions wrote', () => {
    expect(parseMode('list')).toBe('list')
    expect(parseMode('folders')).toBe('folders')
    expect(parseMode('albums')).toBe('albums')
    expect(parseMode('artists')).toBe('artists')
  })

  it.each([[null], [undefined], [''], ['grid'], [3], [{}], [['albums']]])('falls back to the track list for %j', (raw) => {
    expect(parseMode(raw)).toBe('list')
  })

  it('falls back to the track list for a mode this place does not offer', () => {
    expect(parseMode('albums', ['list', 'folders'])).toBe('list')
    expect(parseMode('folders', ['list', 'folders'])).toBe('folders')
  })
})

describe('the page trail', () => {
  it('starts empty and grows as pages are opened from one another', () => {
    expect(openPage([], 'album:a')).toEqual(['album:a'])
    expect(openPage(['album:a'], 'artist:x')).toEqual(['album:a', 'artist:x'])
  })

  it('goes back one page at a time, and stays empty at the start', () => {
    expect(closePage(['album:a', 'artist:x'])).toEqual(['album:a'])
    expect(closePage(['album:a'])).toEqual([])
    expect(closePage([])).toEqual([])
  })

  it('does not stack the page that is already open', () => {
    const trail = ['album:a']
    expect(openPage(trail, 'album:a')).toBe(trail)
  })

  it('returns to a page it already passed instead of growing in a circle (album, artist, same album)', () => {
    expect(openPage(['album:a', 'artist:x'], 'album:a')).toEqual(['album:a'])
    expect(openPage(['artist:x', 'album:a', 'artist:y'], 'album:a')).toEqual(['artist:x', 'album:a'])
  })

  it('never grows past a handful of pages, forgetting the oldest', () => {
    let trail: readonly string[] = []
    for (let i = 0; i < MAX_TRAIL + 5; i++) trail = openPage(trail, `album:${i}`)
    expect(trail).toHaveLength(MAX_TRAIL)
    expect(trail.at(-1)).toBe(`album:${MAX_TRAIL + 4}`)
  })

  it('only opens albums and artists', () => {
    const trail = ['album:a']
    expect(openPage(trail, 'all')).toBe(trail)
    expect(openPage(trail, 'smart:top')).toBe(trail)
    expect(openPage(trail, '')).toBe(trail)
    expect(openPage(trail, 'album:')).toBe(trail)
  })

  it('does not change the trail it is given', () => {
    const trail = Object.freeze(['album:a'])
    openPage(trail, 'artist:x')
    closePage(trail)
    expect(trail).toEqual(['album:a'])
  })
})

describe('parseTrail', () => {
  it('reads back a trail that was stored', () => {
    expect(parseTrail(['artist:x', 'album:a'])).toEqual(['artist:x', 'album:a'])
    expect(parseTrail([])).toEqual([])
  })

  it.each([[null], [undefined], ['album:a'], [7], [{}], [{ length: 1, 0: 'album:a' }]])('is empty for %j, which is not a list', (raw) => {
    expect(parseTrail(raw)).toEqual([])
  })

  it('drops anything in the list that is not an album or artist ref', () => {
    expect(parseTrail(['album:a', 3, null, 'smart:top', 'artist:', 'artist:x', { ref: 'album:b' }])).toEqual(['album:a', 'artist:x'])
  })

  it('keeps only the newest pages of a list that is too long', () => {
    const long = Array.from({ length: MAX_TRAIL + 4 }, (_, i) => `album:${i}`)
    const trail = parseTrail(long)
    expect(trail).toHaveLength(MAX_TRAIL)
    expect(trail.at(-1)).toBe(`album:${MAX_TRAIL + 3}`)
  })
})

describe('pruneTrail', () => {
  const exists = (known: string[]) => (ref: string) => known.includes(ref)

  it('keeps a trail whose pages all still exist, and returns the very same one', () => {
    const trail = ['artist:x', 'album:a']
    expect(pruneTrail(trail, exists(['artist:x', 'album:a']))).toBe(trail)
  })

  it('cuts the trail back to the pages before the first one that is gone', () => {
    expect(pruneTrail(['artist:x', 'album:a', 'album:b'], exists(['artist:x', 'album:b']))).toEqual(['artist:x'])
    expect(pruneTrail(['album:a'], exists([]))).toEqual([])
    expect(pruneTrail([], exists([]))).toEqual([])
  })
})
