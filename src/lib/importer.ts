import type { ImportProgress, Lyrics, Track } from '../types'
import type { Analysis } from './analyze'
import { analyzeOnDemand } from './analyzeOnDemand'
import { folderOf } from './folders'
import { parseLrc } from './lrc'
import { buildTrack, fileKey, isAudioFile, isLrcFile, lrcFromFile, newId, norm, relativePathOf, stripExt } from './metadata'
import { runPool } from './pool'
import { INDEX_VERSION } from './trackmeta'

/**
 * The import pipeline. Files are read a few at a time (never all at once: a folder of 5,000 songs must not start 5,000
 * readers), finished tracks are handed over in batches so they appear, and are saved, while the rest is still being
 * read, progress is reported, and the whole thing can be cancelled with what is already done kept.
 */

/** An `.lrc` file that parsed but matched no imported audio file. */
export interface OrphanLrc {
  name: string
  lyrics: Lyrics
}

export interface ImportOptions {
  /** Library keys already present (`name|size|modified`); such files are skipped. */
  existingKeys?: ReadonlySet<string>
  /** Files read at the same time. Default 6. */
  concurrency?: number
  /** Tracks per batch. Default 100. */
  batchSize?: number
  signal?: AbortSignal
  /** Replaces the analysis of one file (to add a duration fallback, or in tests). */
  analyze?: (file: File) => Promise<Analysis>
  onProgress?: (progress: ImportProgress) => void
  /** Gets each batch of finished tracks, in library order, before the next batch is read. May be asynchronous. */
  onBatch?: (tracks: Track[]) => void | Promise<void>
}

export interface ImportResult {
  /** Everything that was imported, in library order. */
  tracks: Track[]
  orphanLrc: OrphanLrc[]
  /** Audio files skipped because the library already had them (or the selection held them twice). */
  duplicates: number
  /** Files whose analysis threw (they are not imported). */
  failed: number
  /** True when the import was stopped before every file was read. */
  cancelled: boolean
  /** Audio files that were to be read. */
  total: number
}

const DEFAULT_CONCURRENCY = 6
const DEFAULT_BATCH = 100
const natural = new Intl.Collator(undefined, { numeric: true })

/** Folder by folder, and by natural file name within a folder ("2" before "10"). */
function inLibraryOrder(files: readonly File[]): File[] {
  return files
    .map((file) => ({ file, folder: folderOf(relativePathOf(file)) }))
    .sort((a, b) => natural.compare(a.folder, b.folder) || natural.compare(a.file.name, b.file.name))
    .map((entry) => entry.file)
}

async function fileToTrack(file: File, lrcMap: ReadonlyMap<string, Lyrics>, analyze: (file: File) => Promise<Analysis>, addedAt: number): Promise<Track> {
  const a = await analyze(file)
  const title = a.title.trim() || stripExt(file.name)
  const artist = a.artist.trim() || 'Unknown Artist'
  const lyrics = lrcMap.get(norm(file.name)) || lrcMap.get(title.toLowerCase()) || lrcMap.get(`${artist} - ${title}`.toLowerCase()) || parseLrc(a.lyricsText) || null
  return buildTrack({
    id: newId(),
    key: fileKey(file),
    file,
    path: folderOf(relativePathOf(file)),
    coverBlob: a.cover,
    title,
    artist,
    album: a.album.trim(),
    duration: a.duration,
    lyrics,
    gainDb: a.gainDb,
    addedAt,
    plays: 0,
    lastPlayedAt: null,
    ...a.meta,
    indexed: INDEX_VERSION,
  })
}

/**
 * Turn picked or dropped files into tracks. `.lrc` files are paired by name (or title) with audio files; the ones that
 * match nothing come back so the caller can attach them to tracks that are already in the library.
 */
export async function importFiles(fileList: Iterable<File> | ArrayLike<File>, options: ImportOptions = {}): Promise<ImportResult> {
  const { existingKeys = new Set<string>(), concurrency = DEFAULT_CONCURRENCY, batchSize = DEFAULT_BATCH, signal, onProgress, onBatch } = options
  const analyze = options.analyze ?? ((file: File) => analyzeOnDemand(file, { fallbackDuration: false }))
  // one time for the whole import: files are read in parallel and finish in any order, while "recently added" must
  // follow the library order (equal times are ordered by position)
  const addedAt = Date.now()
  const all = Array.from(fileList)

  // a file the library has, or that the selection holds twice, is read once at most
  const seen = new Set(existingKeys)
  let duplicates = 0
  const fresh: File[] = []
  for (const file of all.filter(isAudioFile)) {
    const key = fileKey(file)
    if (seen.has(key)) {
      duplicates++
      continue
    }
    seen.add(key)
    fresh.push(file)
  }
  const audio = inLibraryOrder(fresh)

  // sidecar lyrics are small and any track may claim one, so they are read before the audio
  const lrcFiles: OrphanLrc[] = []
  for (const file of all.filter(isLrcFile)) {
    if (signal?.aborted) break
    const lyrics = await lrcFromFile(file)
    if (lyrics) lrcFiles.push({ name: file.name, lyrics })
  }
  const lrcMap = new Map<string, Lyrics>(lrcFiles.map((l) => [norm(l.name), l.lyrics]))

  const total = audio.length
  const tracks: Track[] = []
  let failed = 0
  let cancelled = Boolean(signal?.aborted) && total > 0
  onProgress?.({ total, done: 0, added: 0 })

  for (let at = 0; at < total && !cancelled; at += batchSize) {
    if (signal?.aborted) {
      cancelled = true
      break
    }
    const chunk = audio.slice(at, at + batchSize)
    const { results, completed, aborted } = await runPool(chunk, concurrency, (file) => fileToTrack(file, lrcMap, analyze, addedAt), {
      signal,
      onProgress: (done) => onProgress?.({ total, done: at + done, added: tracks.length }),
    })
    const made = results.filter((t): t is Track => t !== undefined)
    failed += completed - made.length
    if (made.length) {
      tracks.push(...made)
      await onBatch?.(made)
    }
    onProgress?.({ total, done: at + completed, added: tracks.length })
    if (aborted) cancelled = true
  }

  const used = new Set(tracks.flatMap((t) => (t.lyrics ? [t.lyrics] : [])))
  return { tracks, orphanLrc: lrcFiles.filter((l) => !used.has(l.lyrics)), duplicates, failed, cancelled, total }
}

/** Import everything in one go, without batches or progress: for callers that only want the result. */
export async function filesToTracks(fileList: Iterable<File> | ArrayLike<File>, existingKeys: ReadonlySet<string> = new Set()): Promise<{ tracks: Track[]; orphanLrc: OrphanLrc[] }> {
  const { tracks, orphanLrc } = await importFiles(fileList, { existingKeys })
  return { tracks, orphanLrc }
}
