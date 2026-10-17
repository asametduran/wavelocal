import { cleanName } from './playlists'
import { fold } from './search'

/**
 * Playlist files: reading M3U, M3U8 and PLS, writing M3U8 and PLS, and finding the library's tracks for what a file lists.
 * A playlist file is untrusted text from anywhere (another player, another computer, another operating system), so reading
 * is lenient about how it is written and strict about what comes out: bounded lengths, no control characters, no streams.
 */

/** A playlist file bigger than this is not a playlist. */
export const MAX_PLAYLIST_BYTES = 5 * 1024 * 1024
export const MAX_ENTRIES = 50_000
const MAX_PATH = 1000
const MAX_TITLE = 300
const FALLBACK_NAME = 'Imported playlist'

export interface PlaylistEntry {
  /** The path or file URL as the playlist wrote it, without quotes. */
  path: string
  /** What the playlist calls the track (from `#EXTINF` or `TitleN`); '' when it does not say. */
  title: string
  artist: string
  /** Seconds, or 0 when the playlist does not know. */
  duration: number
}

export interface ParsedPlaylist {
  name: string
  format: 'm3u' | 'pls'
  entries: PlaylistEntry[]
  /** Lines that were entries but could not be used: streams, entries with no file, and anything past the limit. */
  skipped: number
}

export { isPlaylistFile } from './metadata'

// ---- reading ---------------------------------------------------------------------------------------------------

/** Text from a file's bytes: UTF-8 (a byte order mark is dropped), UTF-16 with a mark, otherwise Windows-1252 as old files are. */
export function decodePlaylist(bytes: Uint8Array): string {
  if (bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xfe) return new TextDecoder('utf-16le').decode(bytes.subarray(2))
  if (bytes.length >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff) return new TextDecoder('utf-16be').decode(bytes.subarray(2))
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  } catch {
    return new TextDecoder('windows-1252').decode(bytes)
  }
}

const CONTROL = /[\u0000-\u001f\u007f]/g
const STREAM = /^(?:https?|rtsp|rtmp|mmsh?|ftp|icy):\/\//i

const clean = (text: string, max: number): string => text.replace(CONTROL, ' ').trim().slice(0, max).trim()

function unquote(text: string): string {
  const first = text[0]
  return text.length >= 2 && (first === '"' || first === "'") && text.endsWith(first) ? text.slice(1, -1) : text
}

/** "Artist - Title" as playlists write it; a name with no " - " is only a title. */
function splitDisplay(display: string): { artist: string; title: string } {
  const text = clean(display, MAX_TITLE * 2)
  const at = text.indexOf(' - ')
  if (at < 0) return { artist: '', title: text.slice(0, MAX_TITLE).trim() }
  return { artist: text.slice(0, at).trim().slice(0, MAX_TITLE), title: text.slice(at + 3).trim().slice(0, MAX_TITLE) }
}

const seconds = (text: string): number => {
  const n = Number.parseFloat(text)
  return Number.isFinite(n) && n > 0 ? n : 0
}

interface Info {
  artist: string
  title: string
  duration: number
}

/** The part of an `#EXTINF` line after the colon: `215,Artist - Title`, or `-1 tvg-id="x",Name`. */
function parseExtinf(rest: string): Info {
  let comma = -1
  let quoted = false
  for (let i = 0; i < rest.length; i++) {
    const ch = rest[i]
    if (ch === '"') quoted = !quoted
    else if (ch === ',' && !quoted) {
      comma = i
      break
    }
  }
  const head = comma < 0 ? rest : rest.slice(0, comma)
  const lead = /^\s*(-?\d+(?:\.\d+)?)/.exec(head)
  return { ...splitDisplay(comma < 0 ? '' : rest.slice(comma + 1)), duration: lead ? seconds(lead[1] ?? '') : 0 }
}

const stem = (fileName: string): string => fileName.replace(/^.*[\\/]/, '').replace(/\.[^.]*$/, '')

function parseM3u(text: string, fallbackName: string): ParsedPlaylist {
  const entries: PlaylistEntry[] = []
  let skipped = 0
  let name = ''
  let pending: Info | null = null
  for (const raw of text.split(/\r\n|\r|\n/)) {
    const line = raw.trim()
    if (!line) continue
    if (line.startsWith('#')) {
      if (/^#EXTINF:/i.test(line)) pending = parseExtinf(line.slice(8))
      else if (/^#PLAYLIST:/i.test(line) && !name) name = clean(line.slice(10), MAX_TITLE)
      continue
    }
    const info = pending
    pending = null
    const path = clean(unquote(line), MAX_PATH)
    if (!path || STREAM.test(path) || entries.length >= MAX_ENTRIES) {
      skipped++
      continue
    }
    entries.push({ path, title: info?.title ?? '', artist: info?.artist ?? '', duration: info?.duration ?? 0 })
  }
  return { name: cleanName(name || fallbackName, FALLBACK_NAME), format: 'm3u', entries, skipped }
}

function parsePls(text: string, fallbackName: string): ParsedPlaylist {
  const slots = new Map<number, { path: string; title: string; duration: number }>()
  for (const raw of text.split(/\r\n|\r|\n/)) {
    const m = /^\s*(file|title|length)(\d{1,7})\s*=(.*)$/i.exec(raw)
    if (!m) continue
    const n = Number(m[2])
    if (!slots.has(n) && slots.size >= MAX_ENTRIES + 1000) continue
    const slot = slots.get(n) ?? { path: '', title: '', duration: 0 }
    const key = (m[1] ?? '').toLowerCase()
    const value = m[3] ?? ''
    if (key === 'file') slot.path = clean(unquote(value.trim()), MAX_PATH)
    else if (key === 'title') slot.title = value
    else slot.duration = seconds(value)
    slots.set(n, slot)
  }
  const entries: PlaylistEntry[] = []
  let skipped = 0
  for (const [, slot] of [...slots].sort((a, b) => a[0] - b[0])) {
    if (!slot.path || STREAM.test(slot.path) || entries.length >= MAX_ENTRIES) {
      skipped++
      continue
    }
    entries.push({ path: slot.path, ...splitDisplay(slot.title), duration: slot.duration })
  }
  return { name: cleanName(fallbackName, FALLBACK_NAME), format: 'pls', entries, skipped }
}

/** The tracks a playlist file lists. `fileName` names the playlist when the file does not (and helps tell M3U from PLS). */
export function parsePlaylist(text: string, fileName = ''): ParsedPlaylist {
  const body = text.replace(/^﻿/, '')
  const fallback = stem(fileName)
  return /^\s*\[playlist\]\s*$/im.test(body) ? parsePls(body, fallback) : parseM3u(body, fallback)
}

// ---- finding the tracks ------------------------------------------------------------------------------------------

/**
 * A path as comparable parts: file URLs and percent-encoding undone, Windows drives and backslashes gone, `.` and `..`
 * resolved, each part folded like search folds (case, accents and the Turkish dotted/dotless i do not matter).
 */
export function pathSegments(path: string): string[] {
  let p = path.trim().replace(/^file:\/\/(?:localhost)?/i, '')
  try {
    p = decodeURIComponent(p)
  } catch {
    // not valid percent-encoding: it is part of the name
  }
  p = p.replace(/\\/g, '/').replace(/^\/*[A-Za-z]:(?=\/|$)/, '')
  const parts: string[] = []
  for (const part of p.split('/')) {
    if (!part || part === '.') continue
    if (part === '..') parts.pop()
    else parts.push(part)
  }
  return parts.map((part) => fold(part).trim()).filter(Boolean)
}

/** What matching needs of a library track. */
export interface MatchTrack {
  id: string
  title: string
  artist: string
  /** The folder it was imported from (`Music/Rock`), '' for a loose file. */
  path: string
  file: { name: string }
}

export interface MatchResult {
  /** Library track ids in the playlist's order, each once. */
  ids: string[]
  /** The entries no track was found for. */
  missing: PlaylistEntry[]
  /** Entries that named a track an earlier entry had already named. */
  duplicates: number
}

const extensionless = (name: string): string => {
  const dot = name.lastIndexOf('.')
  return dot > 0 ? name.slice(0, dot) : name
}

interface Item {
  id: string
  folders: string[]
  title: string
  artist: string
}

interface FolderNode {
  children: Map<string, FolderNode>
  /** Every item whose folders end with the chain that leads to this node, in library order. */
  items: Item[]
}

/**
 * The tracks that share one file name, arranged by their folders read from the file outwards (a tree whose first step is the
 * folder the file is in). Choosing between same-named files by how many folders they share with a playlist's path is then
 * one walk down the tree instead of a comparison with every one of them, which matters when thousands of files are called
 * `track.mp3` and a playlist of tens of thousands of lines names them.
 */
class SameName {
  private readonly root: FolderNode = { children: new Map(), items: [] }

  add(item: Item): void {
    let node = this.root
    node.items.push(item)
    for (let i = item.folders.length - 1; i >= 0; i--) {
      const name = item.folders[i] as string
      let child = node.children.get(name)
      if (!child) node.children.set(name, (child = { children: new Map(), items: [] }))
      node = child
      node.items.push(item)
    }
  }

  /** The items sharing the most folders (counting from the file outwards) with `folders`, in library order. */
  closest(folders: readonly string[]): readonly Item[] {
    let node = this.root
    for (let i = folders.length - 1; i >= 0; i--) {
      const child = node.children.get(folders[i] as string)
      if (!child) break
      node = child
    }
    return node.items
  }
}

/**
 * Find the library's track for each entry of a playlist, tolerantly: by path, by file name (the folders then choose
 * between files of the same name), by file name with another extension, and finally by the title and artist the
 * playlist gives, which is only trusted when exactly one track fits. A match is never guessed between titles.
 */
export function matchEntries(entries: readonly PlaylistEntry[], tracks: readonly MatchTrack[]): MatchResult {
  const byName = new Map<string, SameName>()
  const byStem = new Map<string, SameName>()
  const byTitle = new Map<string, Item[]>()
  const folderCache = new Map<string, string[]>()
  const group = (map: Map<string, SameName>, key: string): SameName => {
    let same = map.get(key)
    if (!same) map.set(key, (same = new SameName()))
    return same
  }
  for (const t of tracks) {
    let folders = folderCache.get(t.path)
    if (!folders) folderCache.set(t.path, (folders = pathSegments(t.path)))
    const name = fold(t.file.name).trim()
    const item: Item = { id: t.id, folders, title: fold(t.title).trim(), artist: fold(t.artist).trim() }
    group(byName, name).add(item)
    group(byStem, extensionless(name)).add(item)
    if (item.title) {
      const list = byTitle.get(item.title)
      if (list) list.push(item)
      else byTitle.set(item.title, [item])
    }
  }

  const ids: string[] = []
  const seen = new Set<string>()
  const missing: PlaylistEntry[] = []
  let duplicates = 0

  for (const entry of entries) {
    const segments = pathSegments(entry.path)
    const name = segments.at(-1) ?? ''
    const title = fold(entry.title).trim()
    const artist = fold(entry.artist).trim()
    const tagged = (item: Item): boolean => !!title && item.title === title && (!artist || item.artist === artist)

    let found: Item | undefined
    const same = name ? (byName.get(name) ?? byStem.get(extensionless(name))) : undefined
    if (same) {
      // the folders decide between files of the same name; the tags the playlist gives only break a tie between equally close ones
      const top = same.closest(segments.slice(0, -1))
      found = title ? (top.find(tagged) ?? top[0]) : top[0]
    } else if (title) {
      const fits = (byTitle.get(title) ?? []).filter((item) => !artist || item.artist === artist)
      if (fits.length === 1) found = fits[0]
    }

    if (!found) missing.push(entry)
    else if (seen.has(found.id)) duplicates++
    else {
      seen.add(found.id)
      ids.push(found.id)
    }
  }
  return { ids, missing, duplicates }
}

// ---- writing -----------------------------------------------------------------------------------------------------

/** What an exported playlist says about one track. */
export interface ExportItem {
  path: string
  title: string
  artist: string
  duration: number
}

const oneLine = (text: string): string => text.replace(/[\u0000-\u001f\u007f\u2028\u2029]/g, ' ').replace(/\s+/g, ' ').trim()

const displayName = (item: ExportItem): string => {
  const artist = item.artist && item.artist !== 'Unknown Artist' ? oneLine(item.artist) : ''
  const title = oneLine(item.title)
  return artist && title ? `${artist} - ${title}` : title || artist
}

const length = (duration: number): number => (Number.isFinite(duration) && duration > 0 ? Math.round(duration) : -1)

/** A track's path as an exported playlist writes it: the folder it was imported from and its file name, with forward slashes. */
export const entryPath = (folder: string, fileName: string): string => (folder ? `${folder}/${fileName}` : fileName)

/** An extended M3U (UTF-8): what other players and phones read. */
export function serializeM3u(name: string, items: readonly ExportItem[]): string {
  const lines = ['#EXTM3U', `#PLAYLIST:${oneLine(name)}`]
  for (const item of items) lines.push(`#EXTINF:${length(item.duration)},${displayName(item)}`, oneLine(item.path))
  return `${lines.join('\n')}\n`
}

export function serializePls(items: readonly ExportItem[]): string {
  const lines = ['[playlist]']
  items.forEach((item, i) => lines.push(`File${i + 1}=${oneLine(item.path)}`, `Title${i + 1}=${displayName(item)}`, `Length${i + 1}=${length(item.duration)}`))
  lines.push(`NumberOfEntries=${items.length}`, 'Version=2')
  return `${lines.join('\n')}\n`
}

/** A name made safe to save as a file, with the extension. */
export function playlistFileName(name: string, extension: 'm3u8' | 'pls'): string {
  const base = name
    .replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_')
    .trim()
    .slice(0, 100)
    .replace(/[. ]+$/, '')
  return `${base || 'playlist'}.${extension}`
}
