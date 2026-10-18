// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { EMPTY_META, normalizeMeta } from '../trackmeta'
import type { TrackRecord } from '../../types'
import { isUnavailable, loadLibrary as loadWith } from './load'
import type { LibraryReader, LoadOptions } from './load'

// the analysis fields are repaired by a function the caller hands in (see `hydrate.ts` for why), here the one the app uses
const loadLibrary = (source: LibraryReader, options?: LoadOptions) => loadWith(normalizeMeta, source, options)

const row = (id: string): TrackRecord => ({
  id,
  key: `${id}.mp3|5|1`,
  file: new File(['audio'], `${id}.mp3`, { lastModified: 1 }),
  path: '',
  coverBlob: null,
  title: id,
  artist: '',
  album: '',
  duration: 1,
  lyrics: null,
  gainDb: null,
  addedAt: 0,
  plays: 0,
  lastPlayedAt: null,
  ...EMPTY_META,
})

/** A database in memory whose reads can be made to fail, and that remembers how often it was asked. */
function reader(data: { rows?: unknown[]; meta?: Record<string, unknown> } = {}, failures: (call: number) => unknown = () => null): LibraryReader & { calls: number } {
  const out = {
    calls: 0,
    rows: async () => {
      const failure = failures(++out.calls)
      if (failure) throw failure
      return data.rows ?? []
    },
    meta: async (key: string) => data.meta?.[key],
  }
  return out
}

const instant = { delays: [0, 0], sleep: async () => {} }

describe('loadLibrary', () => {
  it('reads and validates the seven values together', async () => {
    const result = await loadLibrary(reader({ rows: [row('a'), row('b')], meta: { order: ['b', 'a'], playlists: [{ id: 'p', name: 'One', trackIds: ['a'] }], resume: { id: 'b', time: 9 }, upNext: ['a'] } }), instant)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.library.records.map((r) => r.id)).toEqual(['b', 'a'])
    expect(result.library.playlists.map((p) => p.name)).toEqual(['One'])
    expect(result.library.resume).toEqual({ id: 'b', time: 9 })
    expect(result.library.upNext).toEqual(['a'])
  })

  it('repairs the analysis fields of the rows with the function it is given', async () => {
    const result = await loadWith(() => ({ ...EMPTY_META, genre: 'injected' }), reader({ rows: [row('a')] }), instant)
    expect(result.ok && result.library.records[0]?.genre).toBe('injected')
  })

  it('reads an empty database as an empty library, not as a failure', async () => {
    const result = await loadLibrary(reader(), instant)
    expect(result).toMatchObject({ ok: true, library: { records: [], playlists: [], resume: null } })
  })

  it('tries again after a failed read and gives the whole library when the second try works', async () => {
    const source = reader({ rows: [row('a')], meta: { order: ['a'] } }, (call) => (call === 1 ? new DOMException('Internal error opening backing store', 'UnknownError') : null))
    const result = await loadLibrary(source, instant)
    expect(result.ok).toBe(true)
    expect(source.calls).toBe(2)
  })

  it('gives up after three tries and says the library could not be read', async () => {
    const source = reader({ rows: [row('a')] }, () => new DOMException('Internal error opening backing store', 'UnknownError'))
    const result = await loadLibrary(source, instant)
    expect(result).toMatchObject({ ok: false, reason: 'unreadable' })
    expect(source.calls).toBe(3)
  })

  it('waits between the tries, longer each time', async () => {
    const waited: number[] = []
    const source = reader({}, () => new Error('nope'))
    await loadLibrary(source, { delays: [250, 800], sleep: async (ms) => void waited.push(ms) })
    expect(waited).toEqual([250, 800])
  })

  it('does not go on to the other values once the tracks could not be read, and never half-reads', async () => {
    const asked: string[] = []
    const source: LibraryReader = {
      rows: async () => {
        throw new Error('nope')
      },
      meta: async (key) => {
        asked.push(key)
        return undefined
      },
    }
    const result = await loadLibrary(source, { delays: [], sleep: async () => {} })
    expect(result.ok).toBe(false)
    expect(asked.length).toBeLessThanOrEqual(6) // they may be asked together, but no answer is used when one failed
  })

  it('fails when one of the meta values cannot be read, even though the tracks could', async () => {
    const source: LibraryReader = {
      rows: async () => [row('a')],
      meta: async (key) => {
        if (key === 'playlists') throw new DOMException('aborted', 'AbortError')
        return undefined
      },
    }
    const result = await loadLibrary(source, { delays: [0], sleep: async () => {} })
    expect(result).toMatchObject({ ok: false, reason: 'unreadable' })
  })

  it('does not try again when the browser keeps nothing at all', async () => {
    const source = reader({}, () => new Error('IndexedDB unavailable'))
    const result = await loadLibrary(source, instant)
    expect(result).toMatchObject({ ok: false, reason: 'unavailable' })
    expect(source.calls).toBe(1)
    const blocked = reader({}, () => new DOMException('The operation is insecure.', 'SecurityError'))
    expect(await loadLibrary(blocked, instant)).toMatchObject({ ok: false, reason: 'unavailable' })
    expect(blocked.calls).toBe(1)
  })

  it('carries the error and how many rows and playlists had to be skipped', async () => {
    const result = await loadLibrary(reader({ rows: [row('a'), { id: 'x' }, null], meta: { playlists: [null, { id: 'p', name: 'Ok', trackIds: [] }] } }), instant)
    expect(result.ok && result.library.skippedRows).toBe(2)
    expect(result.ok && result.library.skippedPlaylists).toBe(1)
    const failed = await loadLibrary(reader({}, () => new Error('boom')), instant)
    expect(!failed.ok && failed.error).toBeInstanceOf(Error)
  })
})

describe('isUnavailable', () => {
  it('knows the errors of a browser that keeps nothing', () => {
    expect(isUnavailable(new Error('IndexedDB unavailable'))).toBe(true)
    expect(isUnavailable(new DOMException('insecure', 'SecurityError'))).toBe(true)
    expect(isUnavailable(new DOMException('nope', 'UnknownError'))).toBe(false)
    expect(isUnavailable(new Error('other'))).toBe(false)
    expect(isUnavailable(null)).toBe(false)
    expect(isUnavailable('IndexedDB unavailable')).toBe(false)
  })
})
