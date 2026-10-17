import { downloadBlob } from './download'
import { countLabel } from './format'
import { noticeDialog, toast } from './overlays'
import { MAX_PLAYLIST_BYTES, decodePlaylist, entryPath, matchEntries, parsePlaylist, playlistFileName, serializeM3u, serializePls } from './playlistfiles'
import type { PlaylistEntry } from './playlistfiles'
import { uniqueName } from './playlists'
import type { PlayerApi, Playlist, Track } from '../types'

/**
 * Reading playlist files into playlists and writing playlists out as files: the part that touches files, dialogs and
 * toasts, around the pure parsing and matching in `playlistfiles.ts`. Loaded only when a playlist is imported or exported.
 */

type ImportTarget = Pick<PlayerApi, 'tracks' | 'playlists' | 'createPlaylist' | 'setViewId'>

/** How many of the tracks that could not be found a dialog lists. */
const LISTED = 50

const entries = (n: number): string => (n === 1 ? '1 entry' : `${n} entries`)

/** What to call an entry the library has no track for: what the playlist says it is, else its file name. */
function entryName(entry: PlaylistEntry): string {
  if (entry.title) return entry.artist ? `${entry.artist} - ${entry.title}` : entry.title
  return entry.path.split(/[\\/]/).filter(Boolean).at(-1) ?? entry.path
}

function listed(missing: readonly PlaylistEntry[]): string[] {
  const lines = missing.slice(0, LISTED).map(entryName)
  return missing.length > LISTED ? [...lines, `…and ${missing.length - LISTED} more`] : lines
}

/**
 * Make a playlist of each file from the library's tracks that it names, and open the last one. Never throws: whatever
 * goes wrong is said in a toast or a dialog, and the other files are still read.
 */
export async function importPlaylistFiles(p: ImportTarget, files: readonly File[]): Promise<void> {
  const names = p.playlists.map((pl) => pl.name)
  for (const file of files) {
    try {
      await importOne(p, file, names)
    } catch {
      toast(`Could not read ${file.name}`)
    }
  }
}

async function importOne(p: ImportTarget, file: File, names: string[]): Promise<void> {
  if (file.size > MAX_PLAYLIST_BYTES) {
    toast(`${file.name} is too big to be a playlist`)
    return
  }
  const parsed = parsePlaylist(decodePlaylist(new Uint8Array(await file.arrayBuffer())), file.name)
  if (!parsed.entries.length) {
    toast(`${file.name} has no tracks in it`)
    return
  }
  const { ids, missing } = matchEntries(parsed.entries, p.tracks)
  const total = parsed.entries.length
  const skipped = parsed.skipped ? ` ${entries(parsed.skipped)} (such as internet radio streams) ${parsed.skipped === 1 ? 'was' : 'were'} skipped.` : ''

  if (!ids.length) {
    await noticeDialog({
      title: `Nothing to import from “${parsed.name}”`,
      message: `None of its ${countLabel(total, 'track')} are in your library yet. Add the music first, then import the playlist again.${skipped}`,
      details: listed(missing),
    })
    return
  }

  const name = uniqueName(names, parsed.name)
  names.push(name)
  p.setViewId(p.createPlaylist(name, ids))
  if (!missing.length && !skipped) {
    toast(`Imported “${name}”: ${countLabel(ids.length, 'track')}`)
    return
  }
  await noticeDialog({
    title: `Imported “${name}”`,
    message: `${ids.length} of ${countLabel(total, 'track')} ${ids.length === 1 && total === 1 ? 'was' : 'were'} found in your library${missing.length ? '; the others are not in it yet' : ''}.${skipped}`,
    details: listed(missing),
  })
}

/** Download a playlist as an M3U8 or PLS file, with the tracks the library still has. */
export function exportPlaylist(playlist: Playlist, tracks: readonly Track[], format: 'm3u8' | 'pls'): void {
  const byId = new Map(tracks.map((t) => [t.id, t]))
  const items = playlist.trackIds.flatMap((id) => {
    const t = byId.get(id)
    return t ? [{ path: entryPath(t.path, t.file.name), title: t.title, artist: t.artist, duration: t.duration }] : []
  })
  if (!items.length) {
    toast(`“${playlist.name}” is empty: there is nothing to export`)
    return
  }
  const fileName = playlistFileName(playlist.name, format)
  const text = format === 'pls' ? serializePls(items) : serializeM3u(playlist.name, items)
  downloadBlob(new Blob([text], { type: format === 'pls' ? 'audio/x-scpls' : 'audio/x-mpegurl' }), fileName)
  toast(`Exported ${countLabel(items.length, 'track')} as ${fileName}`)
}
