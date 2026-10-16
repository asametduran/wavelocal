import { describe, expect, it } from 'vitest'
import type { EqBand, Playlist, Track } from '../types'
import { graphicBands } from './eq'
import {
  BACKUP_FORMAT,
  BACKUP_VERSION,
  MAX_PLAYLISTS,
  backupFileName,
  buildBackup,
  diffTrack,
  normalizePending,
  parseBackup,
  planRestore,
  resolvePending,
  serializeBackup,
} from './backup'
import type { Backup, BackupTrack, PendingRestore } from './backup'

function track(id: string, over: Partial<Track> = {}): Track {
  return {
    id,
    key: `${id}.mp3|10|1`,
    file: new File(['x'], `${id}.mp3`),
    path: '',
    coverBlob: null,
    title: id,
    artist: 'Unknown Artist',
    album: '',
    duration: 100,
    lyrics: null,
    gainDb: null,
    addedAt: 0,
    plays: 0,
    lastPlayedAt: null,
    url: '',
    cover: null,
    ...over,
  }
}

const NOW = new Date('2026-10-16T12:00:00Z')
let counter = 0
const newId = () => `new${++counter}`
const pl = (id: string, name: string, trackIds: string[]): Playlist => ({ id, name, trackIds })

function bt(id: string, over: Partial<BackupTrack> = {}): BackupTrack {
  return { key: `${id}.mp3|10|1`, name: `${id}.mp3`, path: '', title: id, artist: 'Unknown Artist', album: '', duration: 100, lyrics: null, gainDb: null, addedAt: 0, plays: 0, lastPlayedAt: null, ...over }
}

describe('buildBackup', () => {
  it('captures tags, counters, eq and playlists by key, and leaves audio and covers out', () => {
    const eq: EqBand[] = graphicBands()
    const a = track('a', { title: 'Alpha', plays: 3, lastPlayedAt: 500, addedAt: 400, lyrics: { synced: false, lines: [{ t: null, text: 'la' }] }, gainDb: -2 })
    const b = track('b')
    const backup = buildBackup([a, b], [pl('p1', 'Road', ['b', 'a', 'ghost'])], { a: eq }, NOW)
    expect(backup).toMatchObject({ format: BACKUP_FORMAT, version: BACKUP_VERSION, exportedAt: '2026-10-16T12:00:00.000Z' })
    expect(backup.tracks[0]).toMatchObject({ key: a.key, name: 'a.mp3', title: 'Alpha', plays: 3, lastPlayedAt: 500, addedAt: 400, gainDb: -2 })
    expect(backup.tracks[0]?.eq).toEqual(eq)
    expect(backup.tracks[1]).not.toHaveProperty('eq')
    expect(backup.playlists).toEqual([{ id: 'p1', name: 'Road', keys: [b.key, a.key] }]) // the unknown id is dropped
    const json = serializeBackup(backup)
    expect(json).not.toContain('coverBlob')
    expect(json).not.toContain('"file"')
  })

  it('names the file after the date', () => {
    expect(backupFileName(NOW)).toBe('wavelocal-backup-2026-10-16.json')
  })
})

describe('parseBackup', () => {
  const sample = () =>
    buildBackup([track('a', { plays: 2, lyrics: { synced: true, lines: [{ t: 1, text: 'hi' }, { t: 2, text: 'there' }] } }), track('b')], [pl('p1', 'Road', ['a', 'b'])], { a: graphicBands() }, NOW)

  it('round-trips what buildBackup wrote', () => {
    const original = sample()
    const parsed = parseBackup(serializeBackup(original))
    expect(parsed).toEqual({ ok: true, backup: original, skipped: 0 })
  })

  it.each([
    ['not json', '{nope', /not valid JSON/],
    ['wrong document', JSON.stringify({ hello: 1 }), /not a Wavelocal backup/],
    ['array', '[]', /not a Wavelocal backup/],
    ['newer version', JSON.stringify({ format: BACKUP_FORMAT, version: 99, tracks: [], playlists: [] }), /newer version/],
    ['missing lists', JSON.stringify({ format: BACKUP_FORMAT, version: 1 }), /incomplete/],
  ])('rejects %s with a readable message', (_name, raw, message) => {
    const r = parseBackup(raw)
    expect(r.ok).toBe(false)
    expect(r.ok === false && r.error).toMatch(message)
  })

  it('rejects absurdly many playlists', () => {
    const raw = JSON.stringify({ format: BACKUP_FORMAT, version: 1, tracks: [], playlists: Array.from({ length: MAX_PLAYLISTS + 1 }, () => ({})) })
    expect(parseBackup(raw).ok).toBe(false)
  })

  it('skips malformed and duplicate entries instead of failing the whole file', () => {
    const raw = JSON.stringify({
      format: BACKUP_FORMAT,
      version: 1,
      tracks: [{ key: 'a|1|1', title: 'A' }, { key: 'a|1|1', title: 'again' }, { title: 'no key' }, 7, null, { key: '' }],
      playlists: [{ id: 'p', name: 'ok', keys: ['a|1|1'] }, 'junk', { id: 'q' }],
    })
    const r = parseBackup(raw)
    expect(r.ok && r.skipped).toBe(7)
    expect(r.ok && r.backup.tracks.map((t) => t.title)).toEqual(['A'])
    expect(r.ok && r.backup.playlists).toHaveLength(1)
  })

  it('cleans and bounds every value it keeps', () => {
    const raw = JSON.stringify({
      format: BACKUP_FORMAT,
      version: 1,
      tracks: [
        {
          key: 'a|1|1',
          title: 'Ti\u0000tle‮',
          artist: 'x'.repeat(5000),
          plays: -5,
          addedAt: 'yesterday',
          lastPlayedAt: -1,
          gainDb: 99,
          duration: 1e9,
          eq: 'not bands',
          lyrics: { synced: true, lines: [{ t: 1, text: 'one' }, { t: null, text: 'two' }] },
        },
      ],
      playlists: [{ id: '', name: '  ', keys: ['a|1|1', 'a|1|1', 5, ''] }],
    })
    const r = parseBackup(raw)
    expect(r.ok).toBe(true)
    if (!r.ok) return
    const t = r.backup.tracks[0]!
    expect(t.title).toBe('Title')
    expect(t.artist).toHaveLength(500)
    expect(t).toMatchObject({ plays: 0, addedAt: 0, lastPlayedAt: null, gainDb: 12, duration: 86_400 })
    expect(t.eq).toBeUndefined()
    // a line without a time makes the whole lyric plain text
    expect(t.lyrics).toMatchObject({ synced: false })
    expect(r.backup.playlists[0]).toMatchObject({ name: 'Restored playlist', keys: ['a|1|1'] })
    expect(r.backup.playlists[0]?.id).toBeTruthy()
  })

  it('gives playlists with clashing ids distinct ids', () => {
    const raw = JSON.stringify({ format: BACKUP_FORMAT, version: 1, tracks: [], playlists: [{ id: 'p', name: 'A', keys: [] }, { id: 'p', name: 'B', keys: [] }] })
    const r = parseBackup(raw)
    expect(r.ok && new Set(r.backup.playlists.map((p) => p.id)).size).toBe(2)
  })

  it('refuses a file that is too large before parsing it', () => {
    expect(parseBackup(' '.repeat(65 * 1024 * 1024)).ok).toBe(false)
  })
})

describe('diffTrack', () => {
  const local = track('a', { plays: 5, addedAt: 100, lastPlayedAt: 900 })

  it('is empty when the backup says the same thing', () => {
    expect(diffTrack(local, bt('a', { plays: 5, addedAt: 100, lastPlayedAt: 900 }))).toEqual({})
  })
  it('lets tags and lyrics from the backup win', () => {
    const lyrics = { synced: false, lines: [{ t: null, text: 'la' }] }
    expect(diffTrack(local, bt('a', { title: 'New', artist: 'Them', album: 'LP', lyrics }))).toEqual({ title: 'New', artist: 'Them', album: 'LP', lyrics })
  })
  it('never lowers a counter and keeps the earlier added date', () => {
    expect(diffTrack(local, bt('a', { plays: 2, lastPlayedAt: 100, addedAt: 500 }))).toEqual({})
    expect(diffTrack(local, bt('a', { plays: 9, lastPlayedAt: 1000, addedAt: 50 }))).toEqual({ plays: 9, lastPlayedAt: 1000, addedAt: 50 })
    expect(diffTrack(track('x'), bt('x', { addedAt: 70 }))).toEqual({ addedAt: 70 })
  })
  it('fills in a missing loudness value but does not overwrite a measured one', () => {
    expect(diffTrack(track('a'), bt('a', { gainDb: -3 }))).toEqual({ gainDb: -3 })
    expect(diffTrack(track('a', { gainDb: 1 }), bt('a', { gainDb: -3 }))).toEqual({})
  })
  it('does not blank a tag the backup does not have', () => {
    expect(diffTrack(track('a', { title: 'Keep' }), bt('a', { title: '', artist: '' }))).toEqual({})
  })
})

describe('planRestore', () => {
  const library = [track('a'), track('b')]

  it('applies matches now and keeps the rest waiting for their files', () => {
    const backup: Backup = {
      format: BACKUP_FORMAT,
      version: 1,
      exportedAt: '',
      tracks: [bt('a', { plays: 4 }), bt('gone', { plays: 7 })],
      playlists: [{ id: 'p1', name: 'Mix', keys: [bt('gone').key, library[0]!.key, library[1]!.key] }],
    }
    const plan = planRestore(backup, library, [], {}, null, newId)
    expect(plan.summary).toEqual({ tracksInBackup: 2, matched: 1, updated: 1, waiting: 1, playlistsInBackup: 1, playlistsCreated: 1, playlistsMerged: 0, membersAdded: 2 })
    expect(plan.patches.get('a')).toEqual({ plays: 4 })
    expect(plan.playlists).toEqual([{ id: 'p1', name: 'Mix', trackIds: ['a', 'b'] }])
    expect(plan.pending?.tracks.map((t) => t.key)).toEqual([bt('gone').key])
    expect(plan.pending?.links).toEqual([{ playlistId: 'p1', key: bt('gone').key, at: 0 }])
  })

  it('completes by itself when the missing file is added, in the original playlist order', () => {
    const backup: Backup = { format: BACKUP_FORMAT, version: 1, exportedAt: '', tracks: [bt('gone', { plays: 7, title: 'Gone Song' })], playlists: [{ id: 'p1', name: 'Mix', keys: [bt('gone').key, library[0]!.key, library[1]!.key] }] }
    const first = planRestore(backup, library, [], {}, null, newId)
    const returned = [...library, track('gone', { title: 'gone' })]
    const done = resolvePending(first.pending as PendingRestore, returned, first.playlists, first.trackEq)
    expect(done.pending).toBeNull()
    expect(done.patches.get('gone')).toEqual({ title: 'Gone Song', plays: 7 })
    expect(done.playlists[0]?.trackIds).toEqual(['gone', 'a', 'b']) // back at position 0, where it was
    expect(done.membersAdded).toBe(1)
  })

  it('puts several late arrivals back in their original order', () => {
    const keys = ['c', 'd', 'e'].map((id) => bt(id).key)
    const backup: Backup = { format: BACKUP_FORMAT, version: 1, exportedAt: '', tracks: ['c', 'd', 'e'].map((id) => bt(id)), playlists: [{ id: 'p', name: 'L', keys }] }
    const first = planRestore(backup, [], [], {}, null, newId)
    const done = resolvePending(first.pending as PendingRestore, [track('e'), track('c'), track('d')], first.playlists, {})
    expect(done.playlists[0]?.trackIds).toEqual(['c', 'd', 'e'])
  })

  it('merges into an existing playlist with the same id or name, without duplicates', () => {
    const backup: Backup = {
      format: BACKUP_FORMAT,
      version: 1,
      exportedAt: '',
      tracks: [bt('a'), bt('b')],
      playlists: [
        { id: 'zzz', name: 'road trip', keys: [library[1]!.key, library[0]!.key] },
        { id: 'p2', name: 'Other', keys: [library[0]!.key] },
      ],
    }
    const plan = planRestore(backup, library, [pl('p1', 'Road Trip', ['a']), pl('p2', 'Different name', [])], {}, null, newId)
    expect(plan.playlists).toEqual([
      { id: 'p1', name: 'Road Trip', trackIds: ['b', 'a'] },
      { id: 'p2', name: 'Different name', trackIds: ['a'] },
    ])
    expect(plan.summary).toMatchObject({ playlistsCreated: 0, playlistsMerged: 2, membersAdded: 2 })
  })

  it('gives a new playlist a fresh id when the backup id is taken by a different playlist', () => {
    const backup: Backup = { format: BACKUP_FORMAT, version: 1, exportedAt: '', tracks: [], playlists: [] }
    expect(planRestore(backup, library, [pl('p1', 'X', [])], {}, null, newId).playlists).toHaveLength(1)
    const clash: Backup = { ...backup, playlists: [{ id: 'p1', name: 'Another', keys: [] }] }
    // same id => treated as the same playlist (merged), not duplicated
    expect(planRestore(clash, library, [pl('p1', 'X', [])], {}, null, newId).playlists).toHaveLength(1)
    const sameIdOtherUser: Backup = { ...backup, playlists: [{ id: 'q', name: 'Another', keys: [] }] }
    const plan = planRestore(sameIdOtherUser, library, [pl('p1', 'X', [])], {}, null, newId)
    expect(plan.playlists.map((p) => p.id)).toEqual(['p1', 'q'])
  })

  it('restores a remembered equalizer curve only where the track has none', () => {
    const curve = graphicBands()
    const own = graphicBands().map((b) => ({ ...b, gain: 3 }))
    const backup: Backup = { format: BACKUP_FORMAT, version: 1, exportedAt: '', tracks: [bt('a', { eq: curve }), bt('b', { eq: curve })], playlists: [] }
    const plan = planRestore(backup, library, [], { b: own }, null, newId)
    expect(plan.trackEq.a).toEqual(curve)
    expect(plan.trackEq.b).toEqual(own)
  })

  it('is idempotent: restoring the same backup again changes nothing', () => {
    const backup: Backup = { format: BACKUP_FORMAT, version: 1, exportedAt: '', tracks: [bt('a', { plays: 4, title: 'T' })], playlists: [{ id: 'p', name: 'L', keys: [library[0]!.key] }] }
    const once = planRestore(backup, library, [], {}, null, newId)
    const applied = library.map((t) => ({ ...t, ...(once.patches.get(t.id) ?? {}) }))
    const twice = planRestore(backup, applied, once.playlists, once.trackEq, once.pending, newId)
    expect(twice.patches.size).toBe(0)
    expect(twice.playlists).toEqual(once.playlists)
    expect(twice.summary).toMatchObject({ updated: 0, membersAdded: 0, playlistsCreated: 0, playlistsMerged: 1 })
  })

  it('drops pending slots of a playlist the user has since deleted', () => {
    const backup: Backup = { format: BACKUP_FORMAT, version: 1, exportedAt: '', tracks: [bt('gone')], playlists: [{ id: 'p', name: 'L', keys: [bt('gone').key] }] }
    const first = planRestore(backup, [], [], {}, null, newId)
    const done = resolvePending(first.pending as PendingRestore, [track('gone')], [], {})
    expect(done.playlists).toEqual([])
    expect(done.pending).toBeNull()
  })

  it('a newer backup replaces what an earlier one left waiting for the same track', () => {
    const one: Backup = { format: BACKUP_FORMAT, version: 1, exportedAt: '', tracks: [bt('gone', { plays: 1 })], playlists: [] }
    const two: Backup = { format: BACKUP_FORMAT, version: 1, exportedAt: '', tracks: [bt('gone', { plays: 5 })], playlists: [] }
    const first = planRestore(one, [], [], {}, null, newId)
    const second = planRestore(two, [], [], {}, first.pending, newId)
    expect(second.pending?.tracks).toHaveLength(1)
    expect(second.pending?.tracks[0]?.plays).toBe(5)
  })

  it('keeps pending entries from an earlier restore when a new backup does not mention them', () => {
    const one: Backup = { format: BACKUP_FORMAT, version: 1, exportedAt: '', tracks: [bt('x')], playlists: [] }
    const two: Backup = { format: BACKUP_FORMAT, version: 1, exportedAt: '', tracks: [bt('y')], playlists: [] }
    const first = planRestore(one, [], [], {}, null, newId)
    const second = planRestore(two, [], [], {}, first.pending, newId)
    expect(second.pending?.tracks.map((t) => t.key).sort()).toEqual([bt('x').key, bt('y').key])
  })

  it('does not touch tracks or playlists that the backup does not mention', () => {
    const backup: Backup = { format: BACKUP_FORMAT, version: 1, exportedAt: '', tracks: [], playlists: [] }
    const mine = [pl('mine', 'Mine', ['a'])]
    const plan = planRestore(backup, library, mine, {}, null, newId)
    expect(plan.playlists).toEqual(mine)
    expect(plan.patches.size).toBe(0)
    expect(plan.pending).toBeNull()
  })

  it('handles a large library quickly', () => {
    const many = Array.from({ length: 20_000 }, (_, i) => track(`t${i}`))
    const backup = buildBackup(many, [pl('p', 'All', many.map((t) => t.id))], {}, NOW)
    const started = performance.now()
    const plan = planRestore(backup, many, [], {}, null, newId)
    expect(plan.summary).toMatchObject({ matched: 20_000, waiting: 0 })
    expect(plan.playlists[0]?.trackIds).toHaveLength(20_000)
    expect(performance.now() - started).toBeLessThan(3000)
  })
})

describe('normalizePending', () => {
  it('accepts what planRestore produces', () => {
    const backup: Backup = { format: BACKUP_FORMAT, version: 1, exportedAt: '', tracks: [bt('gone', { plays: 2 })], playlists: [{ id: 'p', name: 'L', keys: [bt('gone').key] }] }
    const pending = planRestore(backup, [], [], {}, null, newId).pending
    expect(normalizePending(JSON.parse(JSON.stringify(pending)))).toEqual(pending)
  })
  it('rejects junk and empties', () => {
    expect(normalizePending(null)).toBeNull()
    expect(normalizePending({})).toBeNull()
    expect(normalizePending({ tracks: [], links: [] })).toBeNull()
    expect(normalizePending({ tracks: [{ nope: 1 }], links: [{ playlistId: 1 }] })).toBeNull()
  })
})
