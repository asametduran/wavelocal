import { describe, expect, it } from 'vitest'
import { sortDetail, viewTracks } from './view'
import type { Playlist, Track } from '../types'

let n = 0
const track = (over: Partial<Track> & { title: string }): Track =>
  ({
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
    ...over,
  }) as Track

const titles = (items: readonly Track[]): string[] => items.map((x) => x.title)
const byLibrary = { key: 'library', dir: 'asc' } as const

describe('viewTracks', () => {
  const library = [
    track({ title: 'c', artist: 'Zed', album: 'Z-side', trackNo: 1 }),
    track({ title: 'a', artist: 'Amy', album: 'Debut', trackNo: 2 }),
    track({ title: 'b', artist: 'Amy', album: 'Debut', trackNo: 1 }),
  ]
  const playlists: Playlist[] = [{ id: 'pl1', name: 'Mix', trackIds: [library[2]?.id ?? '', library[0]?.id ?? ''] }]

  it('is the library itself, untouched, in library order', () => {
    expect(viewTracks(library, playlists, 'all', byLibrary)).toBe(library)
  })

  it('sorts the library without changing it', () => {
    expect(titles(viewTracks(library, playlists, 'all', { key: 'title', dir: 'asc' }))).toEqual(['a', 'b', 'c'])
    expect(titles(viewTracks(library, playlists, 'all', { key: 'title', dir: 'desc' }))).toEqual(['c', 'b', 'a'])
    expect(titles(library)).toEqual(['c', 'a', 'b'])
  })

  it('is a playlist in its own order, or sorted when a sort is chosen', () => {
    expect(titles(viewTracks(library, playlists, 'pl1', byLibrary))).toEqual(['b', 'c'])
    expect(titles(viewTracks(library, playlists, 'pl1', { key: 'title', dir: 'desc' }))).toEqual(['c', 'b'])
  })

  it('shows the whole library for a playlist that no longer exists', () => {
    expect(viewTracks(library, playlists, 'pl-gone', byLibrary)).toBe(library)
    expect(titles(viewTracks(library, playlists, 'pl-gone', { key: 'title', dir: 'asc' }))).toEqual(['a', 'b', 'c'])
  })

  it('does not treat an album or artist page as a list: those are opened on top of a list, never in place of it', () => {
    expect(viewTracks(library, playlists, 'album:anything', byLibrary)).toBe(library)
    expect(viewTracks(library, playlists, 'artist:anything', byLibrary)).toBe(library)
  })
})

describe('sortDetail', () => {
  const now = Date.UTC(2026, 9, 16)
  const day = 86_400_000
  const t = { album: 'Debut', trackNo: 3, year: 1999, addedAt: now - 3 * day, plays: 12 }

  it('says why a row is where it is', () => {
    expect(sortDetail('album', t, now)).toBe('Debut')
    expect(sortDetail('track', t, now)).toBe('track 3')
    expect(sortDetail('year', t, now)).toBe('1999')
    expect(sortDetail('added', t, now)).toBe('added 3 days ago')
    expect(sortDetail('plays', t, now)).toBe('12 plays')
    expect(sortDetail('plays', { ...t, plays: 1 }, now)).toBe('1 play')
  })

  it('has nothing to add where the row already shows it', () => {
    for (const key of ['library', 'title', 'artist', 'duration'] as const) expect(sortDetail(key, t, now)).toBeNull()
  })

  it('stays silent for what is unknown', () => {
    const empty = { album: '', trackNo: 0, year: 0, addedAt: 0, plays: 0 }
    for (const key of ['album', 'track', 'year', 'added', 'plays'] as const) expect(sortDetail(key, empty, now)).toBeNull()
  })
})
