/**
 * Library backup and restore. A backup is one JSON file that holds everything about the library except the audio and
 * artwork: each track's tags, lyrics, play counts and dates, its remembered equalizer curve, and every playlist (as
 * lists of track keys). Tracks are identified by their library key (`name|size|modified`), the same key the importer
 * uses to skip duplicates, so a backup also works on a different device holding the same files.
 *
 * Restoring is a merge, never a wipe, and it never needs the audio to be present: whatever matches a track in the
 * library is applied now, and the rest is kept as a *pending restore* that completes by itself as soon as the missing
 * files are added. That makes "back up, lose everything, add the music folder again" a full recovery.
 *
 * Everything here is pure (no I/O) and treats the file as untrusted input.
 */
import type { EqBand, Lyrics, Playlist, Track, TrackRecord } from '../types'
import { normalizeTrackEq } from './eq'

export const BACKUP_FORMAT = 'wavelocal-backup'
export const BACKUP_VERSION = 1

/** Refuse files larger than this before even reading them (a 100,000-track backup is about 40 MB). */
export const MAX_BACKUP_BYTES = 64 * 1024 * 1024
export const MAX_TRACKS = 100_000
export const MAX_PLAYLISTS = 5_000
const MAX_LYRIC_LINES = 5_000

export interface BackupTrack {
  key: string
  /** File name, so a missing track can be named in the restore summary. */
  name: string
  path: string
  title: string
  artist: string
  album: string
  duration: number
  lyrics: Lyrics | null
  gainDb: number | null
  addedAt: number
  plays: number
  lastPlayedAt: number | null
  /** The track's own equalizer curve, if it has one. */
  eq?: EqBand[]
}

export interface BackupPlaylist {
  id: string
  name: string
  /** Library keys in playlist order. */
  keys: string[]
}

export interface Backup {
  format: typeof BACKUP_FORMAT
  version: typeof BACKUP_VERSION
  /** ISO timestamp. */
  exportedAt: string
  tracks: BackupTrack[]
  playlists: BackupPlaylist[]
}

/** A playlist slot waiting for a track that is not in the library yet. */
export interface PendingLink {
  playlistId: string
  key: string
  /** Position in the original playlist, so late arrivals land roughly where they belong. */
  at: number
}

/** The part of a restored backup that could not be applied yet because its files are not in the library. */
export interface PendingRestore {
  tracks: BackupTrack[]
  links: PendingLink[]
}

// ---- export ---------------------------------------------------------------------------------------------------

/** Snapshot the library's metadata. Audio and cover art are deliberately left out. */
export function buildBackup(tracks: readonly Track[], playlists: readonly Playlist[], trackEq: Readonly<Record<string, EqBand[]>>, now: Date): Backup {
  const keyById = new Map(tracks.map((t) => [t.id, t.key]))
  return {
    format: BACKUP_FORMAT,
    version: BACKUP_VERSION,
    exportedAt: now.toISOString(),
    tracks: tracks.map((t) => {
      const eq = trackEq[t.id]
      const entry: BackupTrack = {
        key: t.key,
        name: t.file.name,
        path: t.path,
        title: t.title,
        artist: t.artist,
        album: t.album,
        duration: t.duration,
        lyrics: t.lyrics,
        gainDb: t.gainDb,
        addedAt: t.addedAt,
        plays: t.plays,
        lastPlayedAt: t.lastPlayedAt,
      }
      if (eq) entry.eq = eq
      return entry
    }),
    playlists: playlists.map((p) => ({ id: p.id, name: p.name, keys: p.trackIds.flatMap((id) => keyById.get(id) ?? []) })),
  }
}

export const serializeBackup = (backup: Backup): string => JSON.stringify(backup, null, 1)

/** `wavelocal-backup-2026-10-16.json` */
export const backupFileName = (now: Date): string => `wavelocal-backup-${now.toISOString().slice(0, 10)}.json`

// ---- import: parsing ------------------------------------------------------------------------------------------

export type ParseResult = { ok: true; backup: Backup; skipped: number } | { ok: false; error: string }

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)

/** Strip control and bidi-override characters and cap the length. */
function text(v: unknown, max: number): string {
  if (typeof v !== 'string') return ''
  return v
    .replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f‪-‮⁦-⁩]/g, '')
    .trim()
    .slice(0, max)
}

const count = (v: unknown, max: number): number => (typeof v === 'number' && Number.isFinite(v) ? Math.min(max, Math.max(0, Math.round(v))) : 0)
const stamp = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) && v > 0 && v < 8.64e15 ? Math.round(v) : 0)

function parseLyrics(v: unknown): Lyrics | null {
  if (!isObj(v) || !Array.isArray(v.lines) || !v.lines.length) return null
  const lines = []
  for (const line of v.lines.slice(0, MAX_LYRIC_LINES)) {
    if (!isObj(line) || typeof line.text !== 'string') continue
    const t = typeof line.t === 'number' && Number.isFinite(line.t) && line.t >= 0 ? line.t : null
    lines.push({ t, text: line.text.replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g, '').slice(0, 1000) })
  }
  if (!lines.length) return null
  // synced lyrics need a time on every line, otherwise they are plain text
  return { synced: v.synced === true && lines.every((l) => l.t !== null), lines }
}

function parseTrack(v: unknown): BackupTrack | null {
  if (!isObj(v) || typeof v.key !== 'string' || !v.key || v.key.length > 600) return null
  const gain = typeof v.gainDb === 'number' && Number.isFinite(v.gainDb) ? Math.round(Math.max(-12, Math.min(12, v.gainDb)) * 10) / 10 : null
  const last = stamp(v.lastPlayedAt)
  const track: BackupTrack = {
    key: v.key,
    name: text(v.name, 255) || v.key.split('|')[0] || v.key,
    path: text(v.path, 1000),
    title: text(v.title, 500),
    artist: text(v.artist, 500),
    album: text(v.album, 500),
    duration: typeof v.duration === 'number' && Number.isFinite(v.duration) ? Math.min(86_400, Math.max(0, v.duration)) : 0,
    lyrics: parseLyrics(v.lyrics),
    gainDb: gain,
    addedAt: stamp(v.addedAt),
    plays: count(v.plays, 10_000_000),
    lastPlayedAt: last || null,
  }
  const eq = normalizeTrackEq({ [v.key]: v.eq })[v.key]
  if (eq) track.eq = eq
  return track
}

/** Read and validate a backup file's text. Never throws; problems come back as a message a person can act on. */
export function parseBackup(raw: string): ParseResult {
  if (raw.length > MAX_BACKUP_BYTES) return { ok: false, error: 'That file is too large to be a Wavelocal backup.' }
  let data: unknown
  try {
    data = JSON.parse(raw)
  } catch {
    return { ok: false, error: 'That is not a Wavelocal backup (the file is not valid JSON).' }
  }
  if (!isObj(data) || data.format !== BACKUP_FORMAT) return { ok: false, error: 'That is not a Wavelocal backup.' }
  if (typeof data.version !== 'number' || data.version > BACKUP_VERSION) {
    return { ok: false, error: 'This backup was made by a newer version of Wavelocal. Update the app and try again.' }
  }
  if (!Array.isArray(data.tracks) || !Array.isArray(data.playlists)) return { ok: false, error: 'The backup is incomplete (no track or playlist list).' }
  if (data.tracks.length > MAX_TRACKS || data.playlists.length > MAX_PLAYLISTS) return { ok: false, error: 'The backup is larger than Wavelocal can restore.' }

  let skipped = 0
  const seen = new Set<string>()
  const tracks: BackupTrack[] = []
  for (const item of data.tracks) {
    const track = parseTrack(item)
    if (!track || seen.has(track.key)) {
      skipped++
      continue
    }
    seen.add(track.key)
    tracks.push(track)
  }

  const playlists: BackupPlaylist[] = []
  const ids = new Set<string>()
  for (const item of data.playlists) {
    if (!isObj(item) || !Array.isArray(item.keys)) {
      skipped++
      continue
    }
    const name = text(item.name, 100) || 'Restored playlist'
    let id = text(item.id, 100)
    if (!id || ids.has(id)) id = `${id || 'pl'}-${ids.size + 1}`
    ids.add(id)
    const keys = item.keys.filter((k): k is string => typeof k === 'string' && k.length > 0 && k.length <= 600).slice(0, MAX_TRACKS)
    playlists.push({ id, name, keys: [...new Set(keys)] })
  }

  const exportedAt = typeof data.exportedAt === 'string' && !Number.isNaN(Date.parse(data.exportedAt)) ? new Date(data.exportedAt).toISOString() : ''
  return { ok: true, backup: { format: BACKUP_FORMAT, version: BACKUP_VERSION, exportedAt, tracks, playlists }, skipped }
}

// ---- import: merging ------------------------------------------------------------------------------------------

export type TrackPatch = Partial<Pick<TrackRecord, 'title' | 'artist' | 'album' | 'lyrics' | 'gainDb' | 'addedAt' | 'plays' | 'lastPlayedAt'>>

const sameLyrics = (a: Lyrics | null, b: Lyrics | null): boolean =>
  a === b || (a !== null && b !== null && a.synced === b.synced && a.lines.length === b.lines.length && a.lines.every((l, i) => l.t === b.lines[i]?.t && l.text === b.lines[i]?.text))

/**
 * What changes when `from` is applied to `local`: tags and lyrics from the backup win (that is what restoring means),
 * counters only ever grow (play counts take the larger value, "added" takes the earlier date), and measured loudness
 * only fills a gap. Applying the same backup twice changes nothing the second time.
 */
export function diffTrack(local: Pick<TrackRecord, 'title' | 'artist' | 'album' | 'lyrics' | 'gainDb' | 'addedAt' | 'plays' | 'lastPlayedAt'>, from: BackupTrack): TrackPatch {
  const patch: TrackPatch = {}
  if (from.title && from.title !== local.title) patch.title = from.title
  if (from.artist && from.artist !== local.artist) patch.artist = from.artist
  if (from.album && from.album !== local.album) patch.album = from.album
  if (from.lyrics && !sameLyrics(local.lyrics, from.lyrics)) patch.lyrics = from.lyrics
  if (from.gainDb !== null && local.gainDb === null) patch.gainDb = from.gainDb
  if (from.addedAt > 0 && (!local.addedAt || from.addedAt < local.addedAt)) patch.addedAt = from.addedAt
  if (from.plays > (local.plays || 0)) patch.plays = from.plays
  if (from.lastPlayedAt !== null && from.lastPlayedAt > (local.lastPlayedAt ?? 0)) patch.lastPlayedAt = from.lastPlayedAt
  return patch
}

export interface ResolveResult {
  /** Track id -> only the fields that change. */
  patches: Map<string, TrackPatch>
  /** The full per-track equalizer map after the merge. */
  trackEq: Record<string, EqBand[]>
  /** The full playlist list after the merge. */
  playlists: Playlist[]
  /** What is still waiting for its files, or null when nothing is. */
  pending: PendingRestore | null
  /** Tracks that were matched and carried a change. */
  tracksMatched: number
  membersAdded: number
}

/**
 * Apply as much of `pending` as the library allows. Called right after a backup is restored and again every time
 * tracks are added, so a restore completes by itself as the music comes back.
 */
export function resolvePending(pending: PendingRestore, library: readonly Track[], playlists: readonly Playlist[], trackEq: Readonly<Record<string, EqBand[]>>): ResolveResult {
  const byKey = new Map(library.map((t) => [t.key, t]))
  const patches = new Map<string, TrackPatch>()
  const eq: Record<string, EqBand[]> = { ...trackEq }
  const remainingTracks: BackupTrack[] = []
  let tracksMatched = 0

  for (const bt of pending.tracks) {
    const local = byKey.get(bt.key)
    if (!local) {
      remainingTracks.push(bt)
      continue
    }
    tracksMatched++
    const patch = diffTrack(local, bt)
    if (Object.keys(patch).length) patches.set(local.id, patch)
    if (bt.eq && !eq[local.id]) eq[local.id] = bt.eq
  }

  const lists = playlists.map((p) => ({ ...p, trackIds: [...p.trackIds] }))
  const byId = new Map(lists.map((p) => [p.id, p]))
  const members = new Map(lists.map((p) => [p.id, new Set(p.trackIds)])) // O(1) "already in the playlist" checks
  const remainingLinks: PendingLink[] = []
  let membersAdded = 0
  // earlier playlist positions first, so tracks that arrive together keep their original order
  for (const link of [...pending.links].sort((a, b) => a.at - b.at)) {
    const list = byId.get(link.playlistId)
    if (!list) continue // the playlist was deleted since: nothing to complete
    const local = byKey.get(link.key)
    if (!local) {
      remainingLinks.push(link)
      continue
    }
    const present = members.get(list.id)
    if (present && !present.has(local.id)) {
      present.add(local.id)
      list.trackIds.splice(Math.min(link.at, list.trackIds.length), 0, local.id)
      membersAdded++
    }
  }

  const rest = remainingTracks.length || remainingLinks.length ? { tracks: remainingTracks, links: remainingLinks } : null
  return { patches, trackEq: eq, playlists: lists, pending: rest, tracksMatched, membersAdded }
}

export interface RestoreSummary {
  tracksInBackup: number
  /** In the backup and already in the library. */
  matched: number
  /** Matched tracks whose tags, lyrics or counters actually change. */
  updated: number
  /** In the backup but not in the library yet: they complete when their files are added. */
  waiting: number
  playlistsInBackup: number
  playlistsCreated: number
  playlistsMerged: number
  membersAdded: number
}

export interface RestorePlan extends ResolveResult {
  summary: RestoreSummary
}

const sameName = (a: string, b: string): boolean => a.trim().toLowerCase() === b.trim().toLowerCase()

/**
 * Merge a parsed backup into the current library. Playlists are matched by id, then by name (so restoring into the
 * device that made the backup merges, and restoring somewhere else adds the playlists next to the existing ones).
 * Nothing in the library is removed.
 */
export function planRestore(
  backup: Backup,
  library: readonly Track[],
  playlists: readonly Playlist[],
  trackEq: Readonly<Record<string, EqBand[]>>,
  earlier: PendingRestore | null,
  newId: () => string,
): RestorePlan {
  const lists = playlists.map((p) => ({ ...p, trackIds: [...p.trackIds] }))
  const used = new Set(lists.map((p) => p.id))
  const links: PendingLink[] = []
  let created = 0
  let merged = 0

  for (const bp of backup.playlists) {
    let target = lists.find((p) => p.id === bp.id) ?? lists.find((p) => sameName(p.name, bp.name))
    if (target) merged++
    else {
      const id = used.has(bp.id) ? newId() : bp.id
      used.add(id)
      target = { id, name: bp.name, trackIds: [] }
      lists.push(target)
      created++
    }
    bp.keys.forEach((key, at) => links.push({ playlistId: target.id, key, at }))
  }

  // what an earlier restore left waiting stays waiting; a newer backup's entry for the same track replaces the old one
  const newKeys = new Set(backup.tracks.map((t) => t.key))
  const tracks = [...(earlier?.tracks ?? []).filter((t) => !newKeys.has(t.key)), ...backup.tracks]
  const seen = new Set<string>()
  const allLinks = [...(earlier?.links ?? []), ...links].filter((l) => {
    const id = `${l.playlistId}\u0000${l.key}`
    return seen.has(id) ? false : (seen.add(id), true)
  })

  const resolved = resolvePending({ tracks, links: allLinks }, library, lists, trackEq)
  const idByKey = new Map(library.map((t) => [t.key, t.id]))
  const matched = backup.tracks.filter((t) => idByKey.has(t.key)).length
  const updated = backup.tracks.filter((t) => resolved.patches.has(idByKey.get(t.key) ?? '')).length
  return {
    ...resolved,
    summary: {
      tracksInBackup: backup.tracks.length,
      matched,
      updated,
      waiting: backup.tracks.length - matched,
      playlistsInBackup: backup.playlists.length,
      playlistsCreated: created,
      playlistsMerged: merged,
      membersAdded: resolved.membersAdded,
    },
  }
}

/** Validate a stored pending restore (it lives in IndexedDB, so treat it like any other input). */
export function normalizePending(raw: unknown): PendingRestore | null {
  if (!isObj(raw) || !Array.isArray(raw.tracks) || !Array.isArray(raw.links)) return null
  const tracks = raw.tracks.flatMap((t) => parseTrack(t) ?? [])
  const links = raw.links.flatMap((l): PendingLink[] =>
    isObj(l) && typeof l.playlistId === 'string' && typeof l.key === 'string' && typeof l.at === 'number' && Number.isFinite(l.at) ? [{ playlistId: l.playlistId, key: l.key, at: Math.max(0, Math.round(l.at)) }] : [],
  )
  return tracks.length || links.length ? { tracks, links } : null
}
