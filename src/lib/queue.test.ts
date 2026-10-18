import { describe, expect, it } from 'vitest'
import { contextQueue, mergeTrackIds, moveItem, nextAfterRemoval, nextRepeat, pickTrack, resolveQueue } from './queue'
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

  it('starts at either end when the current track is not in the queue (another album was opened)', () => {
    expect(pick({ currentId: 'elsewhere' }).track?.id).toBe('a')
    expect(pick({ currentId: 'elsewhere', dir: -1 }).track?.id).toBe('c')
    expect(pick({ currentId: null, dir: -1 }).track?.id).toBe('c')
  })

  it('goes back through what was played when the current track is not in the queue (it came from Up Next)', () => {
    const result = pick({ currentId: 'queued', dir: -1, history: ['x', 'c'] })
    expect(result.track?.id).toBe('c')
    expect(result.history).toEqual(['x'])
  })

  it('can go back to a track that is not in the queue either, when it can look one up in the library', () => {
    const outside = track('outside')
    const find = (id: string) => (id === 'outside' ? outside : undefined)
    const result = pick({ currentId: 'queued', dir: -1, history: ['outside'], find })
    expect(result.track).toBe(outside)
    expect(result.history).toEqual([])
  })

  it('keeps stepping through the queue when the current track is in it, whatever the history says', () => {
    expect(pick({ currentId: 'b', dir: -1, history: ['c'] }).track?.id).toBe('a')
  })

  it('goes back through what was played, though the current track is in the queue, when told it came from Up Next', () => {
    // c was queued by hand while a played: Previous returns to a, not to b, the track before c in the list
    const result = pick({ currentId: 'c', dir: -1, history: ['a'], useHistory: true })
    expect(result.track?.id).toBe('a')
    expect(result.history).toEqual([])
  })

  it('steps through the queue when told it came from Up Next but nothing was played before', () => {
    expect(pick({ currentId: 'c', dir: -1, history: [], useHistory: true }).track?.id).toBe('b')
  })

  it('does not let that change which track comes next', () => {
    expect(pick({ currentId: 'a', dir: 1, history: ['c'], useHistory: true }).track?.id).toBe('b')
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

describe('pickTrack: tracks to skip (the ones that could not be played)', () => {
  const skipping = (...ids: string[]) => new Set(ids)

  it('changes nothing when there is nothing to skip', () => {
    for (const currentId of ['a', 'b', 'c', 'elsewhere', null]) {
      for (const dir of [1, -1] as const) {
        expect(pick({ currentId, dir, skip: skipping() })).toEqual(pick({ currentId, dir }))
      }
    }
  })

  it('goes past a track to skip, forward and back', () => {
    expect(pick({ currentId: 'a', skip: skipping('b') }).track?.id).toBe('c')
    expect(pick({ currentId: 'c', dir: -1, skip: skipping('b') }).track?.id).toBe('a')
  })

  it('goes past several in a row, and wraps like a manual skip does', () => {
    expect(pick({ currentId: 'a', skip: skipping('b', 'c') }).track?.id).toBe('a') // only a is left, and it is the current one
    expect(pick({ currentId: 'b', skip: skipping('c') }).track?.id).toBe('a')
    expect(pick({ currentId: 'a', dir: -1, skip: skipping('c') }).track?.id).toBe('b')
  })

  it('still stops at the end of the queue when a track ends with repeat off, even when the tracks at the end are skipped', () => {
    expect(pick({ currentId: 'b', auto: true, repeat: 'off', skip: skipping('c') }).track).toBeNull()
  })

  it('wraps past skipped tracks when a track ends with repeat all', () => {
    expect(pick({ currentId: 'b', auto: true, repeat: 'all', skip: skipping('c', 'a') }).track?.id).toBe('b')
    expect(pick({ currentId: 'b', auto: true, repeat: 'all', skip: skipping('c') }).track?.id).toBe('a')
  })

  it('has no track when every track is skipped, whatever repeat says: the chain of failures ends by itself', () => {
    const all = skipping('a', 'b', 'c')
    for (const repeat of ['off', 'all', 'one'] as const) {
      for (const auto of [true, false]) {
        expect(pick({ currentId: 'a', repeat, auto, skip: all }).track).toBeNull()
        expect(pick({ currentId: 'a', repeat, auto, shuffle: true, skip: all }).track).toBeNull()
        expect(pick({ currentId: 'a', repeat, auto, dir: -1, skip: all }).track).toBeNull()
      }
    }
  })

  it('has no track when only the current track is left and it is the one that failed', () => {
    expect(pick({ currentId: 'a', repeat: 'all', auto: true, skip: skipping('a', 'b', 'c') }).track).toBeNull()
  })

  it('starts from the first track that is not skipped when nothing is current', () => {
    expect(pick({ currentId: null, skip: skipping('a') }).track?.id).toBe('b')
    expect(pick({ currentId: null, dir: -1, skip: skipping('c') }).track?.id).toBe('b')
  })

  it('never shuffles into a skipped track, and reaches every other one', () => {
    const seen = new Set<string>()
    for (let i = 0; i < 300; i++) {
      const id = pick({ shuffle: true, currentId: 'a', skip: skipping('b') }).track?.id ?? ''
      seen.add(id)
    }
    expect(seen).toEqual(new Set(['c']))
    const many = ['a', 'b', 'c', 'd', 'e'].map(track)
    const reached = new Set<string>()
    for (let i = 0; i < 400; i++) reached.add(pick({ queue: many, shuffle: true, currentId: 'a', skip: skipping('c') }).track?.id ?? '')
    expect(reached).toEqual(new Set(['b', 'd', 'e']))
  })

  it('has no track to shuffle to when everything else is skipped', () => {
    expect(pick({ shuffle: true, currentId: 'a', skip: skipping('b', 'c') }).track).toBeNull()
  })

  it('goes back through what was played, past the tracks to skip, and takes them out of history', () => {
    const result = pick({ currentId: 'x', dir: -1, history: ['a', 'b', 'c'], skip: skipping('c', 'b') })
    expect(result.track?.id).toBe('a')
    expect(result.history).toEqual([])
    const kept = pick({ currentId: 'x', dir: -1, history: ['a', 'b', 'c'], skip: skipping('a') })
    expect(kept.track?.id).toBe('c')
    expect(kept.history).toEqual(['a', 'b'])
  })

  it('does not mutate its inputs', () => {
    const history = Object.freeze(['a', 'b'])
    const skip: ReadonlySet<string> = new Set(['a'])
    pick({ currentId: 'x', dir: -1, history, skip })
    expect(history).toEqual(['a', 'b'])
    expect([...skip]).toEqual(['a'])
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

describe('contextQueue', () => {
  const library = ['a', 'b', 'c', 'd'].map(track)
  const ids = (list: readonly Track[]) => list.map((t) => t.id)

  it('is the tracks of the given ids, in the order of the ids', () => {
    expect(ids(contextQueue(library, ['c', 'a', 'd']))).toEqual(['c', 'a', 'd'])
  })

  it('leaves out ids that are not in the library any more', () => {
    expect(ids(contextQueue(library, ['a', 'gone', 'b']))).toEqual(['a', 'b'])
    expect(contextQueue(library, ['gone'])).toEqual([])
    expect(contextQueue(library, [])).toEqual([])
  })

  it('lists a track once, however often it is named', () => {
    expect(ids(contextQueue(library, ['b', 'b', 'a', 'b']))).toEqual(['b', 'a'])
  })

  it('hands back the library\'s own track objects, not copies', () => {
    expect(contextQueue(library, ['b'])[0]).toBe(library[1])
  })
})

describe('mergeTrackIds', () => {
  it('appends the ids a list does not have yet, keeping their order', () => {
    expect(mergeTrackIds(['a', 'b'], ['c', 'a', 'd'])).toEqual({ ids: ['a', 'b', 'c', 'd'], added: 2 })
  })

  it('adds nothing, and hands back the very same list, when everything is there already', () => {
    const current = ['a', 'b']
    const merged = mergeTrackIds(current, ['b', 'a'])
    expect(merged.added).toBe(0)
    expect(merged.ids).toBe(current)
    expect(mergeTrackIds(current, []).ids).toBe(current)
  })

  it('names an id once however often it is given', () => {
    expect(mergeTrackIds([], ['x', 'x', 'y', 'x'])).toEqual({ ids: ['x', 'y'], added: 2 })
  })

  it('does not change the list it is given', () => {
    const current = Object.freeze(['a'])
    expect(mergeTrackIds(current, ['b']).ids).toEqual(['a', 'b'])
    expect(current).toEqual(['a'])
  })
})

describe('nextAfterRemoval', () => {
  const order = ['a', 'b', 'c'].map(track)

  it('is the track that followed the removed one, wrapping round at the end', () => {
    expect(nextAfterRemoval(order, 'a')?.id).toBe('b')
    expect(nextAfterRemoval(order, 'b')?.id).toBe('c')
    expect(nextAfterRemoval(order, 'c')?.id).toBe('a')
  })

  it('is nothing when the removed track was the only one, or is not in the order at all', () => {
    expect(nextAfterRemoval([track('a')], 'a')).toBeNull()
    expect(nextAfterRemoval(order, 'elsewhere')).toBeNull()
    expect(nextAfterRemoval([], 'a')).toBeNull()
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
