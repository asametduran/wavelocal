// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { toRecord } from '../db'
import { MAX_LINES } from '../lrc'
import { buildTrack } from '../metadata'
import { EMPTY_META, normalizeMeta } from '../trackmeta'
import { FUZZ_TIMEOUT, eachSeed, int, pick, randomText, timed } from '../../test-utils/fuzz'
import type { Random } from '../../test-utils/fuzz'
import type { TrackRecord } from '../../types'
import { hydrateLibrary as hydrateWith, normalizeLyrics, normalizePlaylists, normalizeResume, normalizeRow as normalizeRowWith } from './hydrate'
import type { Hydrated, RawLibrary } from './hydrate'

// the analysis fields are repaired by a function the caller hands in (see `hydrate.ts` for why), here the one the app uses
const hydrateLibrary = (raw: RawLibrary) => hydrateWith(raw, normalizeMeta)
const normalizeRow = (raw: unknown) => normalizeRowWith(raw, normalizeMeta)

// The database hands over whatever is in it. Whatever that is, reading must not throw, must not change what it was given, and must
// give back values the rest of the app can use without checking them again: that is what keeps one damaged value from blanking the
// page on every start.

const NUMBERS = [0, 1, 5, 12.5, -1, -0, 1e9, 2 ** 53, Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, 5e-324]
const TEXTS = ['', ' ', 'a', 'A song', '\u0000', 'x'.repeat(5000), '__proto__', 'constructor', '\ud800', 'İstanbul', '../..', 'a|b|c']

/** A JSON-like value of any kind, nested a little. */
function wild(random: Random, depth = 0): unknown {
  switch (int(random, depth > 2 ? 8 : 11)) {
    case 0:
      return null
    case 1:
      return undefined
    case 2:
      return pick(random, NUMBERS)
    case 3:
      return pick(random, TEXTS)
    case 4:
      return random() < 0.5
    case 5:
      return randomText(random, int(random, 12))
    case 6:
      return new Blob([randomText(random, 4)])
    case 7:
      return pick(random, NUMBERS)
    case 8:
      return Array.from({ length: int(random, 5) }, () => wild(random, depth + 1))
    case 9:
      return Object.fromEntries(Array.from({ length: int(random, 5) }, () => [pick(random, ['id', 'name', 'trackIds', 'time', 'synced', 'lines', 't', 'text', 'file', 'key', '__proto__', randomText(random, 3)]), wild(random, depth + 1)]))
    default:
      return Array.from({ length: int(random, 4) }, () => pick(random, TEXTS))
  }
}

const file = (name: string): File => new File([randomText(() => 0.5, 4)], name, { lastModified: 7 })

function healthyRow(random: Random, id: string): TrackRecord {
  const lines = Array.from({ length: int(random, 4) }, (_, i) => ({ t: i * 2.5, text: randomText(random, 6) }))
  return {
    id,
    key: `${id}.mp3|4|7`,
    file: file(`${id}.mp3`),
    path: pick(random, ['', 'Music', 'Music/Rock']),
    coverBlob: random() < 0.3 ? new Blob(['png']) : null,
    title: `T${randomText(random, int(random, 12))}`, // the importer never stores a blank title: it falls back to the file name
    artist: randomText(random, int(random, 8)),
    album: randomText(random, int(random, 8)),
    duration: random() * 600,
    lyrics: lines.length && random() < 0.5 ? { synced: true, lines } : null,
    gainDb: random() < 0.5 ? null : random() * 12 - 6,
    addedAt: int(random, 1e12),
    plays: int(random, 100),
    lastPlayedAt: random() < 0.5 ? null : int(random, 1e12),
    ...EMPTY_META,
    year: pick(random, [0, 1999, 2024]),
    genre: pick(random, ['', 'Rock', 'Jazz']),
    trackNo: int(random, 20),
  }
}

/** A row that is healthy except for some fields set to anything, or missing. */
function damagedRow(random: Random, id: string): unknown {
  const row: Record<string, unknown> = { ...healthyRow(random, id) }
  const fields = Object.keys(row)
  for (let i = int(random, 4); i > 0; i--) {
    const field = pick(random, fields)
    if (random() < 0.3) delete row[field]
    else row[field] = wild(random)
  }
  return row
}

function wildLibrary(random: Random): RawLibrary {
  const ids = Array.from({ length: int(random, 14) }, (_, i) => `t${i}`)
  return {
    rows: ids.map((id) => (random() < 0.15 ? wild(random) : random() < 0.5 ? healthyRow(random, id) : damagedRow(random, id))),
    order: random() < 0.2 ? wild(random) : [...ids, ...ids.slice(0, 3), 'ghost', 5, null].filter(() => random() < 0.8).sort(() => random() - 0.5),
    playlists: random() < 0.2 ? wild(random) : Array.from({ length: int(random, 5) }, (_, i) => (random() < 0.4 ? wild(random) : { id: random() < 0.2 ? 'p0' : `p${i}`, name: wild(random), trackIds: random() < 0.7 ? ids.filter(() => random() < 0.5) : wild(random) })),
    resume: random() < 0.4 ? wild(random) : { id: pick(random, ids.length ? ids : ['x']), time: pick(random, NUMBERS) },
    trackEq: random() < 0.5 ? wild(random) : Object.fromEntries(ids.map((id) => [id, wild(random)])),
    upNext: random() < 0.3 ? wild(random) : [...ids, 'ghost', 7].filter(() => random() < 0.5),
    pending: wild(random),
  }
}

/** Freezes a value and everything plain inside it, so that a write to the input throws. Blobs are left as they are. */
function deepFreeze<T>(value: T): T {
  if (typeof value === 'object' && value !== null && !(value instanceof Blob) && !Object.isFrozen(value)) {
    Object.freeze(value)
    for (const inner of Object.values(value)) deepFreeze(inner)
  }
  return value
}

const finiteNonNegative = (value: unknown): boolean => typeof value === 'number' && Number.isFinite(value) && value >= 0

/** What is wrong with a hydrated library, as sentences (nothing, when it is well formed). */
function problems(h: Hydrated): string[] {
  const found: string[] = []
  const seen = new Set<string>()
  for (const r of h.records) {
    if (typeof r.id !== 'string' || !r.id) found.push('a record has no id')
    if (seen.has(r.id)) found.push(`${r.id} twice`)
    seen.add(r.id)
    if (!(r.file instanceof File)) found.push(`${r.id}: file is not a File`)
    if (typeof r.key !== 'string' || !r.key) found.push(`${r.id}: no key`)
    for (const field of ['title', 'artist', 'album', 'path'] as const) if (typeof r[field] !== 'string') found.push(`${r.id}: ${field} is not text`)
    if (!r.title.trim()) found.push(`${r.id}: blank title`)
    for (const field of ['duration', 'addedAt', 'plays'] as const) if (!finiteNonNegative(r[field])) found.push(`${r.id}: ${field} is ${String(r[field])}`)
    if (r.lastPlayedAt !== null && !finiteNonNegative(r.lastPlayedAt)) found.push(`${r.id}: lastPlayedAt is ${String(r.lastPlayedAt)}`)
    if (r.gainDb !== null && !(typeof r.gainDb === 'number' && Number.isFinite(r.gainDb))) found.push(`${r.id}: gainDb is ${String(r.gainDb)}`)
    if (r.coverBlob !== null && !(r.coverBlob instanceof Blob)) found.push(`${r.id}: cover is not a Blob`)
    if (r.lyrics) {
      if (!r.lyrics.lines.length || r.lyrics.lines.length > MAX_LINES) found.push(`${r.id}: ${r.lyrics.lines.length} lyric lines`)
      for (const line of r.lyrics.lines) if (typeof line.text !== 'string' || !(line.t === null || finiteNonNegative(line.t)) || (r.lyrics.synced && line.t === null)) found.push(`${r.id}: a lyric line is ${JSON.stringify(line)}`)
    }
  }
  const lists = new Set<string>()
  for (const p of h.playlists) {
    if (typeof p.id !== 'string' || !p.id || lists.has(p.id)) found.push('a playlist id is missing or repeated')
    lists.add(p.id)
    if (typeof p.name !== 'string' || !p.name.trim()) found.push(`${p.id}: name`)
    if (!Array.isArray(p.trackIds) || p.trackIds.some((id) => typeof id !== 'string' || !id)) found.push(`${p.id}: trackIds`)
  }
  if (h.resume && !(typeof h.resume.id === 'string' && h.resume.id && finiteNonNegative(h.resume.time))) found.push('resume')
  for (const id of h.upNext) if (!seen.has(id)) found.push(`Up Next names ${id}, which is not a track`)
  for (const id of Object.keys(h.trackEq)) if (!seen.has(id)) found.push(`an equalizer for ${id}, which is not a track`)
  if (!Number.isInteger(h.skippedRows) || h.skippedRows < 0 || !Number.isInteger(h.skippedPlaylists) || h.skippedPlaylists < 0) found.push('counts')
  return found
}

describe('reading the saved library under fuzzing', { timeout: FUZZ_TIMEOUT }, () => {
  it('never throws, leaves its input alone, and hands over only values the app can use', async () => {
    await eachSeed(1500, (random) => {
      const raw = deepFreeze(wildLibrary(random))
      const out = hydrateLibrary(raw)
      expect(problems(out)).toEqual([])
    })
  })

  it('has nothing more to mend in what it hands over: reading it again changes nothing', async () => {
    await eachSeed(600, (random) => {
      const once = hydrateLibrary(wildLibrary(random))
      const again = hydrateLibrary({ rows: once.records, order: once.records.map((r) => r.id), playlists: once.playlists, resume: once.resume, trackEq: once.trackEq, upNext: once.upNext, pending: once.pending })
      expect(again.records.map((r) => r.id)).toEqual(once.records.map((r) => r.id))
      expect(again.skippedRows + again.skippedPlaylists).toBe(0)
      expect(again.playlists).toEqual(once.playlists)
      expect(again.resume).toEqual(once.resume)
      expect(again.upNext).toEqual(once.upNext)
      expect(again.trackEq).toEqual(once.trackEq)
      for (const [i, record] of again.records.entries()) expect(toRecord(buildTrack(record)), `record ${i}`).toEqual(toRecord(buildTrack(once.records[i] as TrackRecord)))
    })
  })

  it('leaves a healthy row exactly as the library would have built it from the row itself', async () => {
    await eachSeed(500, (random) => {
      const original = healthyRow(random, `t${int(random, 100)}`)
      const repaired = normalizeRow(original)
      expect(repaired).not.toBeNull()
      expect(toRecord(buildTrack(repaired as TrackRecord))).toEqual(toRecord(buildTrack(original)))
    })
  })

  it('reads lyrics, playlists and places of any shape without throwing, and well formed', async () => {
    await eachSeed(2000, (random) => {
      const lyrics = normalizeLyrics(wild(random))
      if (lyrics) {
        expect(lyrics.lines.length).toBeGreaterThan(0)
        for (const line of lyrics.lines) expect(typeof line.text).toBe('string')
      }
      const { playlists } = normalizePlaylists(wild(random))
      expect(new Set(playlists.map((p) => p.id)).size).toBe(playlists.length)
      const resume = normalizeResume(wild(random))
      if (resume) expect(finiteNonNegative(resume.time)).toBe(true)
    })
  })

  it('does not let a key called __proto__ in a stored value reach the prototype of anything', () => {
    const hostile = JSON.parse('{"id":"p","name":"x","trackIds":["a"],"__proto__":{"polluted":true},"constructor":{"prototype":{"polluted":true}}}') as unknown
    const { playlists } = normalizePlaylists([hostile])
    expect(playlists).toHaveLength(1)
    expect(({} as { polluted?: boolean }).polluted).toBeUndefined()
    expect((playlists[0] as unknown as { polluted?: boolean }).polluted).toBeUndefined()
    expect(normalizeRow(JSON.parse('{"id":"a","__proto__":{"polluted":true}}'))).toBeNull()
    expect(({} as { polluted?: boolean }).polluted).toBeUndefined()
  })

  it('reads a large hostile library in a time budget (nothing quadratic)', () => {
    const rows = Array.from({ length: 10_000 }, (_, i) => (i % 7 === 0 ? { id: `t${i}`, file: 'nope' } : healthyRow(() => 0.3, `t${i}`)))
    const order = Array.from({ length: 60_000 }, (_, i) => `t${(i * 7) % 12_000}`)
    const playlists = Array.from({ length: 300 }, (_, i) => ({ id: `p${i % 250}`, name: `List ${i}`, trackIds: rows.slice(0, 300).map((r) => (r as { id: string }).id) }))
    const upNext = Array.from({ length: 5000 }, (_, i) => `t${i}`)
    const { result, ms } = timed(() => hydrateLibrary({ rows, order, playlists, resume: { id: 't1', time: 4 }, trackEq: {}, upNext, pending: undefined }))
    expect(result.records.length).toBeGreaterThan(8000)
    expect(result.skippedRows).toBe(Math.ceil(10_000 / 7))
    expect(ms).toBeLessThan(1500)
  })
})
