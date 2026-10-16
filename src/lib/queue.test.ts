import { describe, expect, it } from 'vitest'
import { moveItem, nextRepeat, pickTrack, resolveQueue } from './queue'
import type { PickInput } from './queue'
import type { Playlist, Track } from '../types'
import { EMPTY_META } from './trackmeta'

const track = (id: string): Track => ({
  id,
  key: id,
  file: new File([], `${id}.mp3`),
  path: '',
  coverBlob: null,
  title: id,
  artist: '',
  album: '',
  duration: 0,
  lyrics: null,
  gainDb: null, addedAt: 0, plays: 0, lastPlayedAt: null,
  ...EMPTY_META,
  url: `blob:${id}`,
  cover: null,
})

const abc = ['a', 'b', 'c'].map(track)

const pick = (over: Partial<PickInput>) =>
  pickTrack({ queue: abc, currentId: 'a', repeat: 'off', shuffle: false, history: [], dir: 1, auto: false, ...over })

/** A random source that replays the given values, then repeats the last one. */
const sequence = (...values: number[]) => {
  let i = 0
  return () => values[Math.min(i++, values.length - 1)] ?? 0
}

describe('pickTrack: sequential', () => {
  it('returns null for an empty queue and leaves history alone', () => {
    const history = ['x']
    expect(pick({ queue: [], history })).toEqual({ track: null, history })
  })

  it('moves forward and backward', () => {
    expect(pick({ currentId: 'a' }).track?.id).toBe('b')
    expect(pick({ currentId: 'b' }).track?.id).toBe('c')
    expect(pick({ currentId: 'c', dir: -1 }).track?.id).toBe('b')
  })

  it('wraps around on a manual skip', () => {
    expect(pick({ currentId: 'c', auto: false }).track?.id).toBe('a')
    expect(pick({ currentId: 'a', dir: -1 }).track?.id).toBe('c')
  })

  it('stops at the end of the queue when a track ends with repeat off', () => {
    expect(pick({ currentId: 'c', auto: true, repeat: 'off' }).track).toBeNull()
  })

  it('wraps when a track ends with repeat all', () => {
    expect(pick({ currentId: 'c', auto: true, repeat: 'all' }).track?.id).toBe('a')
  })

  it('starts from the first track when nothing is current', () => {
    expect(pick({ currentId: null }).track?.id).toBe('a')
  })

  it('does not touch history when not shuffling', () => {
    const history = ['x', 'y']
    expect(pick({ currentId: 'b', dir: -1, history }).history).toBe(history)
  })

  it('handles a single-track queue', () => {
    const one = [track('solo')]
    expect(pick({ queue: one, currentId: 'solo', auto: true }).track).toBeNull()
    expect(pick({ queue: one, currentId: 'solo', auto: true, repeat: 'all' }).track?.id).toBe('solo')
    expect(pick({ queue: one, currentId: 'solo', auto: false }).track?.id).toBe('solo')
  })
})

describe('pickTrack: shuffle', () => {
  it('uses the random source to choose', () => {
    expect(pick({ shuffle: true, currentId: 'a', random: sequence(0.5) }).track?.id).toBe('b')
    expect(pick({ shuffle: true, currentId: 'a', random: sequence(0.99) }).track?.id).toBe('c')
  })

  it('re-rolls instead of repeating the current track', () => {
    // 0.0 would pick "a" (the current one); the second roll picks "c"
    expect(pick({ shuffle: true, currentId: 'a', random: sequence(0, 0.99) }).track?.id).toBe('c')
  })

  it('never returns the current track', () => {
    for (let i = 0; i < 300; i++) {
      const currentId = ['a', 'b', 'c'][i % 3] ?? 'a'
      expect(pick({ shuffle: true, currentId }).track?.id).not.toBe(currentId)
    }
  })

  it('eventually reaches every other track', () => {
    const seen = new Set<string>()
    for (let i = 0; i < 200; i++) seen.add(pick({ shuffle: true, currentId: 'a' }).track?.id ?? '')
    expect(seen).toEqual(new Set(['b', 'c']))
  })

  it('falls back to sequential order for a single-track queue', () => {
    const one = [track('solo')]
    expect(pick({ queue: one, currentId: 'solo', shuffle: true, auto: true }).track).toBeNull()
    expect(pick({ queue: one, currentId: 'solo', shuffle: true, auto: false }).track?.id).toBe('solo')
  })

  it('goes back through history without mutating it', () => {
    const history = Object.freeze(['a', 'b'])
    const result = pick({ shuffle: true, currentId: 'c', dir: -1, history })
    expect(result.track?.id).toBe('b')
    expect(result.history).toEqual(['a'])
    expect(history).toEqual(['a', 'b'])
  })

  it('pops history one step per previous', () => {
    let history: readonly string[] = ['a', 'b', 'c']
    const visited: string[] = []
    for (let i = 0; i < 3; i++) {
      const r = pick({ shuffle: true, currentId: 'x', dir: -1, history })
      visited.push(r.track?.id ?? '')
      history = r.history
    }
    expect(visited).toEqual(['c', 'b', 'a'])
    expect(history).toEqual([])
  })

  it('falls back to the first track when the historical track was removed', () => {
    expect(pick({ shuffle: true, currentId: 'c', dir: -1, history: ['gone'] }).track?.id).toBe('a')
  })

  it('goes to the previous queue entry once history is empty', () => {
    expect(pick({ shuffle: true, currentId: 'c', dir: -1, history: [] }).track?.id).toBe('b')
  })

  it('ignores history when going forward', () => {
    const history = ['a']
    expect(pick({ shuffle: true, currentId: 'a', random: sequence(0.5), history }).history).toBe(history)
  })
})

describe('resolveQueue', () => {
  const playlists: Playlist[] = [
    { id: 'p1', name: 'Mix', trackIds: ['c', 'a', 'missing'] },
    { id: 'p2', name: 'Empty', trackIds: [] },
  ]

  it('returns the library for the "all" view', () => {
    expect(resolveQueue(abc, playlists, 'all')).toBe(abc)
  })

  it("returns a playlist's tracks in playlist order, dropping ids that no longer exist", () => {
    expect(resolveQueue(abc, playlists, 'p1').map((t) => t.id)).toEqual(['c', 'a'])
  })

  it('returns an empty queue for an empty playlist', () => {
    expect(resolveQueue(abc, playlists, 'p2')).toEqual([])
  })

  it('falls back to the library for an unknown view', () => {
    expect(resolveQueue(abc, playlists, 'nope')).toBe(abc)
  })
})

describe('moveItem', () => {
  it('moves an item forward', () => {
    expect(moveItem([1, 2, 3, 4], 0, 2)).toEqual([2, 3, 1, 4])
  })

  it('moves an item backward', () => {
    expect(moveItem([1, 2, 3, 4], 3, 1)).toEqual([1, 4, 2, 3])
  })

  it('does not mutate the input', () => {
    const input = Object.freeze([1, 2, 3]) as number[]
    expect(moveItem(input, 0, 2)).toEqual([2, 3, 1])
    expect(input).toEqual([1, 2, 3])
  })

  it.each([
    [1, 1],
    [-1, 0],
    [0, -1],
    [3, 0],
    [0, 3],
  ])('returns the same array for no-op or out-of-range move %s -> %s', (from, to) => {
    const input = [1, 2, 3]
    expect(moveItem(input, from, to)).toBe(input)
  })
})

describe('nextRepeat', () => {
  it('cycles off -> all -> one -> off', () => {
    expect(nextRepeat('off')).toBe('all')
    expect(nextRepeat('all')).toBe('one')
    expect(nextRepeat('one')).toBe('off')
  })
})
