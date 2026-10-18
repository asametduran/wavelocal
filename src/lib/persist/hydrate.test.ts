// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { toRecord } from '../db'
import { MAX_LINES } from '../lrc'
import { buildTrack } from '../metadata'
import { EMPTY_META, normalizeMeta } from '../trackmeta'
import type { TrackRecord } from '../../types'
import { hydrateLibrary as hydrateWith, normalizeLyrics, normalizePlaylists, normalizeResume, normalizeRow as normalizeRowWith } from './hydrate'
import type { RawLibrary } from './hydrate'

// the analysis fields are repaired by a function the caller hands in (see `hydrate.ts` for why), here the one the app uses
const hydrateLibrary = (raw: RawLibrary) => hydrateWith(raw, normalizeMeta)
const normalizeRow = (raw: unknown) => normalizeRowWith(raw, normalizeMeta)

const file =(name: string, lastModified = 1): File => new File(['audio'], name, { type: 'audio/mpeg', lastModified })

/** A row as the importer stores it. */
const row = (id: string, over: Record<string, unknown> = {}): TrackRecord => ({
  id,
  key: `${id}.mp3|5|1`,
  file: file(`${id}.mp3`),
  path: '',
  coverBlob: null,
  title: id.toUpperCase(),
  artist: 'Artist',
  album: 'Album',
  duration: 12.5,
  lyrics: null,
  gainDb: null,
  addedAt: 5,
  plays: 2,
  lastPlayedAt: 9,
  ...EMPTY_META,
  ...over,
})

const library = (over: Partial<RawLibrary> = {}): RawLibrary => ({ rows: [], order: undefined, playlists: undefined, resume: undefined, trackEq: undefined, upNext: undefined, pending: undefined, ...over })
const ids = (records: readonly { id: string }[]): string[] => records.map((r) => r.id)

describe('normalizeRow', () => {
  it('leaves a healthy row exactly as the library would have built it from the row itself', () => {
    const healthy = [
      row('a'),
      row('b', { lyrics: { synced: true, lines: [{ t: 1, text: 'x' }, { t: 2.5, text: 'y' }] }, gainDb: -3.25, coverBlob: new Blob(['png'], { type: 'image/png' }), path: 'Music/Rock', year: 1999, genre: 'Rock', trackNo: 3, plays: 7, lastPlayedAt: 123 }),
      row('c', { duration: 0, addedAt: 0, plays: 0, lastPlayedAt: null }),
    ]
    for (const original of healthy) {
      const repaired = normalizeRow(original)
      expect(repaired).not.toBeNull()
      expect(toRecord(buildTrack(repaired as TrackRecord))).toEqual(toRecord(buildTrack(original)))
    }
  })

  it('has no row for something that is not a record with an id and an audio file', () => {
    expect(normalizeRow(null)).toBeNull()
    expect(normalizeRow('a')).toBeNull()
    expect(normalizeRow([])).toBeNull()
    expect(normalizeRow({ ...row('a'), id: '' })).toBeNull()
    expect(normalizeRow({ ...row('a'), id: 5 })).toBeNull()
    expect(normalizeRow({ ...row('a'), id: undefined })).toBeNull()
    expect(normalizeRow({ ...row('a'), file: undefined })).toBeNull()
    expect(normalizeRow({ ...row('a'), file: 'a.mp3' })).toBeNull()
    expect(normalizeRow({ ...row('a'), file: { name: 'a.mp3', size: 5 } })).toBeNull()
  })

  it('repairs text: a missing title becomes the file name without its extension, other missing text becomes empty', () => {
    const repaired = normalizeRow({ ...row('song'), title: undefined, artist: 5, album: null })
    expect(repaired).toMatchObject({ title: 'song', artist: '', album: '' })
    expect(normalizeRow({ ...row('x', {}), title: '   ', file: file('Intro Track.flac') })).toMatchObject({ title: 'Intro Track' })
    expect(normalizeRow({ ...row('x'), title: undefined, file: file('.mp3') })).toMatchObject({ title: 'Untitled' })
  })

  it('repairs numbers: only finite, non-negative ones are kept', () => {
    const repaired = normalizeRow({ ...row('a'), duration: Number.NaN, addedAt: -4, plays: '3', lastPlayedAt: Number.POSITIVE_INFINITY, gainDb: Number.NaN })
    expect(repaired).toMatchObject({ duration: 0, addedAt: 0, plays: 0, lastPlayedAt: null, gainDb: null })
    expect(normalizeRow({ ...row('a'), gainDb: -7.5, lastPlayedAt: 0 })).toMatchObject({ gainDb: -7.5, lastPlayedAt: 0 })
  })

  it('rebuilds a missing or empty key from the file, and turns a plain Blob into a File', () => {
    expect(normalizeRow({ ...row('a'), key: undefined, file: file('a.mp3', 42) })).toMatchObject({ key: 'a.mp3|5|42' })
    expect(normalizeRow({ ...row('a'), key: '' })).toMatchObject({ key: 'a.mp3|5|1' })
    const repaired = normalizeRow({ ...row('a'), key: 'kept|1|1', file: new Blob(['audio'], { type: 'audio/mpeg' }) })
    expect(repaired?.file).toBeInstanceOf(File)
    expect(repaired?.file.name).toBe('kept')
    expect(repaired?.key).toBe('kept|1|1')
  })

  it('keeps a cover that is a Blob and drops anything else', () => {
    const cover = new Blob(['png'], { type: 'image/png' })
    expect(normalizeRow(row('a', { coverBlob: cover }))?.coverBlob).toBe(cover)
    expect(normalizeRow(row('a', { coverBlob: 'cover.png' }))?.coverBlob).toBeNull()
    expect(normalizeRow(row('a', { coverBlob: {} }))?.coverBlob).toBeNull()
  })

  it('hands over exactly the fields a record has, whatever else the stored row carried', () => {
    const repaired = normalizeRow({ ...row('a'), url: 'blob:old', selected: true, __proto__: { polluted: true } })
    expect(Object.keys(repaired ?? {}).sort()).toEqual(
      ['addedAt', 'album', 'albumArtist', 'artist', 'audio', 'compilation', 'coverBlob', 'discNo', 'discTotal', 'duration', 'file', 'gainDb', 'genre', 'id', 'indexed', 'key', 'lastPlayedAt', 'lyrics', 'path', 'plays', 'title', 'trackNo', 'trackTotal', 'year'].sort(),
    )
  })

  it('repairs the analysis fields with the function it is given, which keeps this lazy module from importing the code that does it', () => {
    const injected = { ...EMPTY_META, genre: 'injected', year: 1984 }
    expect(normalizeRowWith(row('a'), () => injected)).toMatchObject({ genre: 'injected', year: 1984 })
    expect(hydrateWith(library({ rows: [row('a')] }), () => injected).records[0]).toMatchObject({ genre: 'injected' })
  })

  it('repairs the analysis fields the way the library always has', () => {
    expect(normalizeRow({ ...row('a'), year: -5, trackNo: 'x', compilation: 'yes', audio: { container: 'zip' } })).toMatchObject({ year: 0, trackNo: 0, compilation: false, audio: null })
  })
})

describe('normalizeLyrics', () => {
  it('keeps well formed synced and plain lyrics', () => {
    const synced = { synced: true, lines: [{ t: 1, text: 'a' }, { t: 2.5, text: 'b' }] }
    const plain = { synced: false, lines: [{ t: null, text: 'a' }, { t: null, text: 'b' }] }
    expect(normalizeLyrics(synced)).toEqual(synced)
    expect(normalizeLyrics(plain)).toEqual(plain)
  })

  it('has none for something that is not lyrics, or lyrics without a line', () => {
    for (const value of [null, undefined, 5, 'la la', [], {}, { synced: true }, { synced: true, lines: 'x' }, { synced: false, lines: [] }, { synced: true, lines: [null, 5, { t: 1 }] }]) expect(normalizeLyrics(value)).toBeNull()
  })

  it('drops lines that are not text and turns a time that is not a time into none', () => {
    const lyrics = normalizeLyrics({ synced: false, lines: [{ t: Number.NaN, text: 'a' }, { t: 3, text: 7 }, { t: -1, text: 'b' }, 'c'] })
    expect(lyrics).toEqual({ synced: false, lines: [{ t: null, text: 'a' }, { t: null, text: 'b' }] })
  })

  it('says lyrics are not synced when a line has no time to follow', () => {
    expect(normalizeLyrics({ synced: true, lines: [{ t: 1, text: 'a' }, { t: null, text: 'b' }] })).toEqual({ synced: false, lines: [{ t: 1, text: 'a' }, { t: null, text: 'b' }] })
  })

  it('reads no more lines than a lyrics file may have, and cuts a line that is absurdly long', () => {
    const lines = Array.from({ length: MAX_LINES + 50 }, (_, i) => ({ t: i, text: 'x' }))
    expect(normalizeLyrics({ synced: true, lines })?.lines).toHaveLength(MAX_LINES)
    const long = normalizeLyrics({ synced: false, lines: [{ t: null, text: 'y'.repeat(100_000) }] })
    expect(long?.lines[0]?.text.length).toBeLessThanOrEqual(2000)
  })
})

describe('normalizePlaylists', () => {
  it('keeps healthy playlists as they are, in order, with the fields a newer version may have added', () => {
    const stored = [
      { id: 'p1', name: 'Road Trip', trackIds: ['a', 'b'] },
      { id: 'p2', name: 'Empty', trackIds: [], color: 'red' },
    ]
    const { playlists, skipped } = normalizePlaylists(stored)
    expect(playlists).toEqual(stored)
    expect(skipped).toBe(0)
  })

  it('has no playlists, and nothing skipped, for a library that never had any', () => {
    expect(normalizePlaylists(undefined)).toEqual({ playlists: [], skipped: 0 })
    expect(normalizePlaylists(null)).toEqual({ playlists: [], skipped: 0 })
    expect(normalizePlaylists('x')).toEqual({ playlists: [], skipped: 0 })
    expect(normalizePlaylists({})).toEqual({ playlists: [], skipped: 0 })
  })

  it('skips and counts entries that are not playlists, and a second one with an id already taken', () => {
    const { playlists, skipped } = normalizePlaylists([null, 'x', 5, [], { name: 'no id', trackIds: [] }, { id: '', name: 'blank id' }, { id: 7, name: 'number id' }, { id: 'ok', name: 'Fine', trackIds: ['a'] }, { id: 'ok', name: 'Same id again', trackIds: ['b'] }])
    expect(playlists).toEqual([{ id: 'ok', name: 'Fine', trackIds: ['a'] }])
    expect(skipped).toBe(8)
  })

  it('repairs the name and the track list of a playlist that has an id', () => {
    const { playlists, skipped } = normalizePlaylists([
      { id: 'a', name: 5, trackIds: 'nope' },
      { id: 'b', name: '  Two\u0000  spaces\n', trackIds: ['x', 5, null, 'y', '', 'x'] },
    ])
    expect(playlists).toEqual([
      { id: 'a', name: 'Playlist', trackIds: [] },
      { id: 'b', name: 'Two spaces', trackIds: ['x', 'y', 'x'] },
    ])
    expect(skipped).toBe(0)
  })
})

describe('normalizeResume', () => {
  it('keeps a place with a track and a time', () => {
    expect(normalizeResume({ id: 'a', time: 12.5 })).toEqual({ id: 'a', time: 12.5 })
    expect(normalizeResume({ id: 'a', time: 0 })).toEqual({ id: 'a', time: 0 })
  })

  it('has none for anything else', () => {
    for (const value of [null, undefined, 5, 'a', [], {}, { id: 'a' }, { time: 5 }, { id: '', time: 5 }, { id: 5, time: 5 }, { id: 'a', time: -1 }, { id: 'a', time: Number.NaN }, { id: 'a', time: Number.POSITIVE_INFINITY }, { id: 'a', time: '5' }]) expect(normalizeResume(value)).toBeNull()
  })

  it('hands over only the two fields', () => {
    expect(normalizeResume({ id: 'a', time: 3, extra: true })).toEqual({ id: 'a', time: 3 })
  })
})

describe('hydrateLibrary', () => {
  /** What the player did before this module: the order list first, then the rows it does not mention. */
  function formerOrdering(rows: readonly { id: string }[], order: unknown): string[] {
    const list = Array.isArray(order) ? order : []
    const byId = new Map(rows.map((r) => [r.id, r]))
    const inOrder = new Set(list)
    return [...list.flatMap((i) => (byId.has(i) ? [byId.get(i) as { id: string }] : [])), ...rows.filter((r) => !inOrder.has(r.id))].map((r) => r.id)
  }

  it('lists the tracks in the saved order, then the ones it does not mention in the order the database gave them', () => {
    const rows = [row('a'), row('b'), row('c'), row('d')]
    expect(ids(hydrateLibrary(library({ rows, order: ['c', 'a'] })).records)).toEqual(['c', 'a', 'b', 'd'])
    expect(ids(hydrateLibrary(library({ rows })).records)).toEqual(['a', 'b', 'c', 'd'])
  })

  it('gives the order the old code gave for a healthy library, over many shapes of it', () => {
    let seed = 12345
    const random = (): number => {
      seed = (seed * 1664525 + 1013904223) % 4294967296
      return seed / 4294967296
    }
    for (let round = 0; round < 200; round++) {
      const rows = Array.from({ length: Math.floor(random() * 12) }, (_, i) => row(`t${i}`))
      const shuffled = [...rows].sort(() => random() - 0.5)
      const order = [...shuffled.filter(() => random() < 0.6).map((r) => r.id), ...(random() < 0.3 ? ['gone1', 'gone2'] : [])]
      // a healthy order lists nobody twice; the old code also listed a track as often as the order named it
      const unique = [...new Set(order)]
      expect(ids(hydrateLibrary(library({ rows, order: unique })).records)).toEqual(formerOrdering(rows, unique))
    }
  })

  it('lists a track once, however often the saved order names it, and ignores names it has no track for', () => {
    const rows = [row('a'), row('b')]
    expect(ids(hydrateLibrary(library({ rows, order: ['b', 'b', 'ghost', 'a', 'b'] })).records)).toEqual(['b', 'a'])
    expect(ids(hydrateLibrary(library({ rows, order: 'a,b' })).records)).toEqual(['a', 'b'])
    expect(ids(hydrateLibrary(library({ rows, order: ['a', 5, null, {}] })).records)).toEqual(['a', 'b'])
  })

  it('lists a track once even if the database handed over its row twice, keeps the first, and counts the second', () => {
    const result = hydrateLibrary(library({ rows: [row('a'), row('b'), row('a', { title: 'Again' })] }))
    expect(ids(result.records)).toEqual(['a', 'b'])
    expect(result.records[0]?.title).toBe('A')
    expect(result.skippedRows).toBe(1)
  })

  it('skips the rows it cannot use, counts them, and never lists them anywhere', () => {
    const rows: unknown[] = [row('a'), { ...row('b'), file: null }, null, row('c'), { title: 'no id' }]
    const band = { id: 'b0', type: 'peaking', frequency: 1000, q: 1, gain: 3 }
    const result = hydrateLibrary(library({ rows, order: ['b', 'c'], upNext: ['b', 'a'], trackEq: { b: [band] } }))
    expect(ids(result.records)).toEqual(['c', 'a'])
    expect(result.skippedRows).toBe(3)
    expect(result.upNext).toEqual(['a'])
    expect(result.trackEq).toEqual({})
  })

  it('checks Up Next and the per-track equalizer against the tracks that remain', () => {
    const band = { id: 'b0', type: 'peaking', frequency: 1000, q: 1, gain: 3 }
    const result = hydrateLibrary(library({ rows: [row('a'), row('b')], upNext: ['b', 'ghost', 5, 'a'], trackEq: { a: [band], ghost: [band], b: 'nope' } }))
    expect(result.upNext).toEqual(['b', 'a'])
    expect(Object.keys(result.trackEq)).toEqual(['a'])
  })

  it('reads playlists and the place to resume, and counts the playlist entries it dropped', () => {
    const result = hydrateLibrary(library({ rows: [row('a')], playlists: [{ id: 'p', name: 'One', trackIds: ['a'] }, 5], resume: { id: 'a', time: 30 } }))
    expect(result.playlists).toEqual([{ id: 'p', name: 'One', trackIds: ['a'] }])
    expect(result.skippedPlaylists).toBe(1)
    expect(result.resume).toEqual({ id: 'a', time: 30 })
  })

  it('hands the pending restore over untouched (its own validator lives with the backup code)', () => {
    const pending = { whatever: [1, 2, 3] }
    expect(hydrateLibrary(library({ pending })).pending).toBe(pending)
  })

  it('reads an empty database as an empty library', () => {
    expect(hydrateLibrary(library())).toEqual({ records: [], skippedRows: 0, playlists: [], skippedPlaylists: 0, resume: null, trackEq: {}, upNext: [], pending: undefined })
  })
})
