import { describe, expect, it } from 'vitest'
import { MAX_PLAYLIST_NAME, cleanName, copyName, restorePlaylist, uniqueName } from './playlists'
import type { Playlist } from '../types'

describe('cleanName', () => {
  it('trims, collapses runs of whitespace and keeps ordinary text as typed', () => {
    expect(cleanName('  Road   Trip \n 2024 ')).toBe('Road Trip 2024')
    expect(cleanName('Şebnem & Friends: Greatest Hits (live)')).toBe('Şebnem & Friends: Greatest Hits (live)')
  })

  it('removes control characters', () => {
    expect(cleanName('a\u0000b\u0007c\u007fd')).toBe('a b c d')
  })

  it('is the default name when nothing is left', () => {
    expect(cleanName('')).toBe('New playlist')
    expect(cleanName('   \t\n ')).toBe('New playlist')
    expect(cleanName('\u0000\u0001')).toBe('New playlist')
    expect(cleanName('', 'Imported')).toBe('Imported')
  })

  it('never makes a name longer than the limit', () => {
    expect(cleanName('x'.repeat(MAX_PLAYLIST_NAME + 50))).toHaveLength(MAX_PLAYLIST_NAME)
  })
})

describe('uniqueName', () => {
  it('keeps a name that is free', () => {
    expect(uniqueName(['Mix'], 'Road Trip')).toBe('Road Trip')
    expect(uniqueName([], 'Mix')).toBe('Mix')
  })

  it('numbers a name that is taken, counting case and accents as the same name', () => {
    expect(uniqueName(['Mix'], 'Mix')).toBe('Mix 2')
    expect(uniqueName(['Mix'], 'MIX')).toBe('MIX 2')
    expect(uniqueName(['Şarkılar'], 'Sarkilar')).toBe('Sarkilar 2')
    expect(uniqueName(['Mix', 'Mix 2', 'mix 3'], 'Mix')).toBe('Mix 4')
  })
})

describe('copyName', () => {
  it('names a copy after what it was copied from', () => {
    expect(copyName(['Mix'], 'Mix')).toBe('Mix copy')
  })

  it('numbers further copies instead of piling up the word', () => {
    expect(copyName(['Mix', 'Mix copy'], 'Mix')).toBe('Mix copy 2')
    expect(copyName(['Mix', 'Mix copy', 'Mix copy 2'], 'Mix')).toBe('Mix copy 3')
  })

  it('copying a copy is a numbered copy of the original, not "copy copy"', () => {
    expect(copyName(['Mix', 'Mix copy'], 'Mix copy')).toBe('Mix copy 2')
    expect(copyName(['Mix', 'Mix copy', 'Mix copy 2'], 'Mix copy 2')).toBe('Mix copy 3')
  })
})

describe('restorePlaylist', () => {
  const pl = (id: string, ...trackIds: string[]): Playlist => ({ id, name: id.toUpperCase(), trackIds })
  const known = (id: string): boolean => id.startsWith('t')
  const ids = (list: readonly Playlist[]): string[] => list.map((p) => p.id)

  it('puts a playlist back where it was', () => {
    const list = [pl('a'), pl('c')]
    const restored = restorePlaylist(list, { playlist: pl('b', 't1'), index: 1 }, known)
    expect(ids(restored)).toEqual(['a', 'b', 'c'])
    expect(restored[1]?.trackIds).toEqual(['t1'])
  })

  it('puts it at the end when the list has become shorter than where it was', () => {
    expect(ids(restorePlaylist([pl('a')], { playlist: pl('z'), index: 9 }, known))).toEqual(['a', 'z'])
    expect(ids(restorePlaylist([pl('a')], { playlist: pl('z'), index: -3 }, known))).toEqual(['z', 'a'])
  })

  it('brings back only the tracks the library still has, in their order', () => {
    const restored = restorePlaylist([], { playlist: pl('a', 't1', 'gone', 't2'), index: 0 }, known)
    expect(restored[0]?.trackIds).toEqual(['t1', 't2'])
  })

  it('does nothing when a playlist with that id exists again, and hands back the very same list', () => {
    const list = [pl('a'), pl('b')]
    expect(restorePlaylist(list, { playlist: pl('b', 't1'), index: 0 }, known)).toBe(list)
  })

  it('does not change the list it is given', () => {
    const list = Object.freeze([pl('a')])
    restorePlaylist(list, { playlist: pl('b'), index: 0 }, known)
    expect(ids(list)).toEqual(['a'])
  })
})
