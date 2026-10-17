import { describe, expect, it } from 'vitest'
import { BACKUP_FORMAT, MAX_BACKUP_BYTES, MAX_PLAYLISTS, MAX_TRACKS, parseBackup, planRestore } from './backup'
import type { Backup } from './backup'
import { FUZZ_TIMEOUT, eachSeed, int, mutateText, pick, timed } from '../test-utils/fuzz'
import type { Random } from '../test-utils/fuzz'

const eqBands = [{ id: 'g0', type: 'peaking', frequency: 60, q: 1, gain: 3 }]
const track = (i: number) => ({
  key: `song${i}.mp3|${1000 + i}|1700000000000`,
  name: `song${i}.mp3`,
  path: 'Music/Rock',
  title: `Song ${i}`,
  artist: 'An Artist',
  album: 'An Album',
  duration: 200.5,
  lyrics: { synced: true, lines: [{ t: 1, text: 'a line' }, { t: 2.5, text: 'another' }] },
  gainDb: -3.2,
  addedAt: 1_700_000_000_000,
  plays: 3,
  lastPlayedAt: 1_700_000_100_000,
  albumArtist: 'The Band',
  genre: 'Rock',
  trackNo: 3,
  trackTotal: 12,
  discNo: 1,
  year: 1999,
  compilation: true,
  eq: eqBands,
})
const valid = (tracks = 5) => ({
  format: BACKUP_FORMAT,
  version: 1,
  exportedAt: '2026-10-17T00:00:00.000Z',
  tracks: Array.from({ length: tracks }, (_, i) => track(i)),
  playlists: [{ id: 'pl1', name: 'Mix', keys: [track(0).key, track(1).key] }, { id: 'pl2', name: 'Other', keys: [track(2).key] }],
})
const VALID = JSON.stringify(valid())

const hasControl = (text: string) => /[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/.test(text)

/** What a parsed backup has to be, whatever the file said. */
function sane(backup: Backup): void {
  expect(backup.format).toBe(BACKUP_FORMAT)
  expect(backup.tracks.length).toBeLessThanOrEqual(MAX_TRACKS)
  expect(backup.playlists.length).toBeLessThanOrEqual(MAX_PLAYLISTS)
  const keys = new Set<string>()
  for (const t of backup.tracks) {
    expect(t.key.length).toBeGreaterThan(0)
    expect(t.key.length).toBeLessThanOrEqual(600)
    expect(keys.has(t.key)).toBe(false)
    keys.add(t.key)
    for (const text of [t.name, t.path, t.title, t.artist, t.album]) expect(hasControl(text)).toBe(false)
    expect(t.title.length).toBeLessThanOrEqual(500)
    expect(t.duration).toBeGreaterThanOrEqual(0)
    expect(t.duration).toBeLessThanOrEqual(86_400)
    expect(t.plays).toBeGreaterThanOrEqual(0)
    expect(t.plays).toBeLessThanOrEqual(10_000_000)
    expect(Number.isFinite(t.addedAt)).toBe(true)
    if (t.gainDb !== null) expect(Math.abs(t.gainDb)).toBeLessThanOrEqual(12)
    if (t.lyrics) {
      expect(t.lyrics.lines.length).toBeLessThanOrEqual(5000)
      if (t.lyrics.synced) expect(t.lyrics.lines.every((l) => l.t !== null)).toBe(true)
    }
    if (t.year !== undefined) expect(t.year).toBeGreaterThanOrEqual(1000)
  }
  const ids = new Set<string>()
  for (const p of backup.playlists) {
    expect(ids.has(p.id)).toBe(false)
    ids.add(p.id)
    expect(p.name.length).toBeGreaterThan(0)
    expect(p.name.length).toBeLessThanOrEqual(100)
    expect(new Set(p.keys).size).toBe(p.keys.length)
  }
}

/** Parse, check, and restore into an empty library: the result of parsing is what the rest of the app is fed. */
function digest(text: string): void {
  const parsed = parseBackup(text)
  if (!parsed.ok) {
    expect(parsed.error.length).toBeGreaterThan(0)
    return
  }
  sane(parsed.backup)
  let n = 0
  const plan = planRestore(parsed.backup, [], [], {}, null, () => `new${++n}`)
  expect(plan.summary.tracksInBackup).toBe(parsed.backup.tracks.length)
}

const JUNK: unknown[] = [null, true, false, 0, -1, 1e308, -1e308, 2 ** 53, 1.5, '', 'x'.repeat(5000), '\u0000‮', [], {}, [[]], { a: {} }, '__proto__', 'constructor', [null], { t: 'x', text: 5 }]

/** A copy of a JSON value with one random part replaced by something of the wrong kind. */
function corrupt(random: Random, value: unknown): unknown {
  if (Array.isArray(value)) {
    if (!value.length || random() < 0.15) return pick(random, JUNK)
    const at = int(random, value.length)
    return value.map((item, i) => (i === at ? corrupt(random, item) : item))
  }
  if (typeof value === 'object' && value !== null) {
    const entries = Object.entries(value)
    if (!entries.length || random() < 0.15) return pick(random, JUNK)
    const at = int(random, entries.length)
    return Object.fromEntries(entries.map(([key, item], i) => (i === at ? [key, corrupt(random, item)] : [key, item])))
  }
  return pick(random, JUNK)
}

describe('parseBackup under fuzzing', { timeout: FUZZ_TIMEOUT }, () => {
  it('survives a backup with a random value replaced by a value of the wrong kind', async () => {
    await eachSeed(500, (random) => digest(JSON.stringify(corrupt(random, corrupt(random, valid())))))
  })

  it('survives damaged text', async () => {
    await eachSeed(500, (random) => digest(mutateText(random, VALID)))
  })

  it('survives text that is not JSON at all', async () => {
    await eachSeed(200, (random) => digest(mutateText(random, mutateText(random, 'wavelocal-backup'))))
  })

  it('cannot pollute the prototype chain through __proto__, constructor or prototype keys', () => {
    const attacks = [
      '{"__proto__":{"polluted":"yes"},"format":"wavelocal-backup","version":1,"tracks":[],"playlists":[]}',
      '{"format":"wavelocal-backup","version":1,"tracks":[{"key":"a","__proto__":{"polluted":"yes"},"eq":{"__proto__":{"polluted":"yes"}}}],"playlists":[]}',
      '{"format":"wavelocal-backup","version":1,"tracks":[{"key":"__proto__","eq":[{"id":"__proto__","type":"peaking","frequency":100,"q":1,"gain":1}]}],"playlists":[{"id":"__proto__","name":"x","keys":["__proto__"]}]}',
      '{"format":"wavelocal-backup","version":1,"tracks":[{"key":"constructor"}],"playlists":[{"id":"constructor","name":"prototype","keys":["constructor","prototype"]}]}',
      '{"format":"wavelocal-backup","version":1,"tracks":[{"key":"a","lyrics":{"__proto__":{"polluted":"yes"},"lines":[{"t":1,"text":"x","__proto__":{"polluted":"yes"}}]}}],"playlists":[]}',
    ]
    for (const attack of attacks) digest(attack)
    expect(({} as Record<string, unknown>).polluted).toBeUndefined()
    expect(Object.keys(Object.prototype)).toEqual([])
    expect(Object.getPrototypeOf({})).toBe(Object.prototype)
  })

  it('makes a whole backup of valid data out of a valid backup, and nothing else', () => {
    const parsed = parseBackup(VALID)
    expect(parsed.ok).toBe(true)
    if (parsed.ok) {
      expect(parsed.skipped).toBe(0)
      expect(parsed.backup.tracks).toHaveLength(5)
      expect(parsed.backup.playlists.map((p) => p.keys.length)).toEqual([2, 1])
    }
  })

  it('refuses a file that is too large before reading it', () => {
    const { result, ms } = timed(() => parseBackup('x'.repeat(MAX_BACKUP_BYTES + 1)))
    expect(result.ok).toBe(false)
    expect(ms).toBeLessThan(500)
  })

  it('refuses more tracks than it will restore, and takes exactly that many', () => {
    const many = (n: number) => `{"format":"wavelocal-backup","version":1,"tracks":[${Array.from({ length: n }, (_, i) => `{"key":"k${i}"}`).join(',')}],"playlists":[]}`
    const ok = timed(() => parseBackup(many(MAX_TRACKS)))
    expect(ok.result.ok && ok.result.backup.tracks.length).toBe(MAX_TRACKS)
    expect(ok.ms).toBeLessThan(5000)
    expect(parseBackup(many(MAX_TRACKS + 1)).ok).toBe(false)
  })

  it('handles thousands of playlists in a moment', () => {
    const playlists = Array.from({ length: MAX_PLAYLISTS }, (_, i) => ({ id: `p${i % 50}`, name: `List ${i}`, keys: Array.from({ length: 20 }, (_, k) => `key${(i * 20 + k) % 400}`) }))
    const text = JSON.stringify({ ...valid(400), playlists })
    const { result, ms } = timed(() => digestResult(text))
    expect(result).toBe(true)
    // about 1.5 s of CPU on a fast machine: the budget tells that from the minutes a quadratic merge of playlists would take
    expect(ms).toBeLessThan(10_000)
  })

  it('gives up on nesting that is too deep for the parser instead of crashing', () => {
    for (const text of ['['.repeat(300_000), '{"a":'.repeat(150_000), `{"format":"wavelocal-backup","version":1,"tracks":${'['.repeat(100_000)}`]) {
      const { result, ms } = timed(() => parseBackup(text))
      expect(result.ok).toBe(false)
      expect(ms).toBeLessThan(2000)
    }
  })

  it('takes strange lyrics and equalizer data in its stride', () => {
    const lines = Array.from({ length: 20_000 }, (_, i) => ({ t: i, text: 'line' }))
    const text = JSON.stringify({ ...valid(1), tracks: [{ ...track(0), lyrics: { synced: true, lines }, eq: Array.from({ length: 5000 }, () => eqBands[0]) }] })
    const parsed = parseBackup(text)
    expect(parsed.ok && parsed.backup.tracks[0]?.lyrics?.lines.length).toBe(5000)
  })
})

function digestResult(text: string): boolean {
  digest(text)
  return true
}
