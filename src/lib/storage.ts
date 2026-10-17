/**
 * Storage the app uses on this device: how much, how much is left, whether the browser may take it back, which tracks
 * cost the most, and what to say when it runs short. The audio of the library is copied into the browser's own database
 * (IndexedDB), so the library costs its size again on top of the files it came from. Loaded on demand, not at start-up.
 */

/** The browser's own split of the usage, where it gives one (Chromium does). */
export interface StorageDetails {
  indexedDB: number
  caches: number
  serviceWorker: number
}

export interface StorageEstimate {
  /** Bytes this site stores on the device. */
  usage: number
  /** Bytes it may store (an estimate: browsers round it and some change it over time). */
  quota: number
  details: StorageDetails | null
}

export type StorageLevel = 'unknown' | 'ok' | 'warn' | 'critical'

export interface StorageAssessment {
  level: StorageLevel
  /** usage / quota, from 0 to 1 (0 when the browser does not say). */
  fraction: number
  /** Bytes still free for the site. */
  free: number
}

export const WARN_FRACTION = 0.8
export const CRITICAL_FRACTION = 0.95
const WARN_FREE_BYTES = 250e6
const CRITICAL_FREE_BYTES = 50e6

const finite = (value: unknown): number | null => (typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null)

/** The part of `navigator.storage` the app uses; everything is optional because older browsers lack parts of it. */
export interface StorageApi {
  estimate?: () => Promise<{ usage?: number; quota?: number; usageDetails?: Record<string, unknown> }>
  persisted?: () => Promise<boolean>
  persist?: () => Promise<boolean>
}

const browserStorage = (): StorageApi | undefined => (typeof navigator === 'undefined' ? undefined : (navigator.storage as StorageApi | undefined))

/** What the browser says about this site's storage, or null where it says nothing usable. Never rejects. */
export async function readEstimate(api: StorageApi | undefined = browserStorage()): Promise<StorageEstimate | null> {
  if (!api?.estimate) return null
  try {
    const raw = await api.estimate()
    const usage = finite(raw.usage)
    const quota = finite(raw.quota)
    if (usage === null || quota === null || quota <= 0) return null
    const d = raw.usageDetails
    const parts = d ? { indexedDB: finite(d.indexedDB), caches: finite(d.caches), serviceWorker: finite(d.serviceWorkerRegistrations) } : null
    const details = parts && parts.indexedDB !== null && parts.caches !== null ? { indexedDB: parts.indexedDB, caches: parts.caches, serviceWorker: parts.serviceWorker ?? 0 } : null
    return { usage, quota, details }
  } catch {
    return null
  }
}

/** Whether the browser promises not to delete this site's data when the device runs low on space; null where it cannot tell. */
export async function readPersisted(api: StorageApi | undefined = browserStorage()): Promise<boolean | null> {
  if (!api?.persisted) return null
  try {
    return await api.persisted()
  } catch {
    return null
  }
}

/** Ask the browser to keep this site's data. Resolves with whether it agreed, or null where the browser cannot be asked. */
export async function requestPersistence(api: StorageApi | undefined = browserStorage()): Promise<boolean | null> {
  if (!api?.persist) return null
  try {
    return await api.persist()
  } catch {
    return null
  }
}

/** How full storage is. Little room left counts even when the quota is huge, since an import then fails halfway. */
export function assessStorage(estimate: StorageEstimate | null): StorageAssessment {
  if (!estimate) return { level: 'unknown', fraction: 0, free: Number.POSITIVE_INFINITY }
  const fraction = Math.min(1, estimate.usage / estimate.quota)
  const free = Math.max(0, estimate.quota - estimate.usage)
  const level: StorageLevel = fraction >= CRITICAL_FRACTION || free < CRITICAL_FREE_BYTES ? 'critical' : fraction >= WARN_FRACTION || free < WARN_FREE_BYTES ? 'warn' : 'ok'
  return { level, fraction, free }
}

const UNITS = ['B', 'kB', 'MB', 'GB', 'TB'] as const

/** Sizes the way phones and file managers show them (powers of 1000): `312 MB`, `1.43 GB`. */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return '0 B'
  let unit = 0
  let value = bytes
  while (value >= 1000 && unit < UNITS.length - 1) {
    value /= 1000
    unit++
  }
  const digits = unit === 0 || value >= 100 ? 0 : value >= 10 ? 1 : 2
  return `${value.toFixed(digits)} ${UNITS[unit]}`
}

export const formatPercent = (fraction: number): string => {
  const percent = fraction * 100
  return `${percent < 10 && percent > 0 ? percent.toFixed(1) : Math.round(percent)}%`
}

/** True for the error a browser raises when it has no room left to save. */
export function isQuotaError(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false
  const { name, code, message } = error as { name?: unknown; code?: unknown; message?: unknown }
  return name === 'QuotaExceededError' || code === 22 || (typeof message === 'string' && /\bquota\b/i.test(message))
}

/** What to tell a listener whose save failed: out of space gets its own advice, anything else the `fallback` text. */
export function describeSaveFailure(error: unknown, fallback: string): string {
  return isQuotaError(error) ? 'This device is out of storage space. Remove tracks you no longer need (Sound & tools, Storage) or free up space, then try again.' : fallback
}

export interface StorageWarning {
  level: 'warn' | 'critical'
  text: string
}

/** The sentence for a storage level that needs attention, or null. */
export function warningFor(assessment: StorageAssessment, persisted: boolean | null): StorageWarning | null {
  if (assessment.level !== 'warn' && assessment.level !== 'critical') return null
  const left = formatBytes(assessment.free)
  const risk = persisted === false ? ' The browser may also delete your library when the device runs low on space.' : ''
  return assessment.level === 'critical'
    ? { level: 'critical', text: `Storage is almost full: ${left} left for Wavelocal. Remove tracks you no longer need before adding more.${risk}` }
    : { level: 'warn', text: `Storage is getting full: ${left} left for Wavelocal.${risk}` }
}

const RANK: Record<StorageLevel, number> = { unknown: 0, ok: 0, warn: 1, critical: 2 }
let warned = 0

/** True the first time storage reaches a level worse than any warned about this session, so a warning is not repeated. */
export function shouldWarn(level: StorageLevel): boolean {
  const rank = RANK[level]
  if (rank <= warned) {
    if (rank === 0) warned = 0
    return false
  }
  warned = rank
  return true
}

export const resetWarnings = (): void => {
  warned = 0
}

/** What an import of files with these sizes needs, and whether the device has that much room. */
export function importFit(sizes: readonly number[], estimate: StorageEstimate | null): { fits: boolean; needed: number; free: number } {
  const needed = sizes.reduce((sum, size) => sum + (Number.isFinite(size) && size > 0 ? size : 0), 0)
  if (!estimate) return { fits: true, needed, free: Number.POSITIVE_INFINITY }
  const free = Math.max(0, estimate.quota - estimate.usage)
  return { fits: needed <= free, needed, free }
}

interface Stored {
  id: string
  title: string
  artist: string
  file: { size: number }
  coverBlob: { size: number } | null
  plays: number
  lastPlayedAt: number | null
}

export interface LibraryUsage {
  tracks: number
  audioBytes: number
  coverBytes: number
  total: number
}

/** The bytes the library's own copies take: the audio files and their artwork. */
export function libraryUsage(tracks: readonly Pick<Stored, 'file' | 'coverBlob'>[]): LibraryUsage {
  let audioBytes = 0
  let coverBytes = 0
  for (const track of tracks) {
    audioBytes += track.file.size
    coverBytes += track.coverBlob?.size ?? 0
  }
  return { tracks: tracks.length, audioBytes, coverBytes, total: audioBytes + coverBytes }
}

export interface LargeTrack {
  id: string
  title: string
  artist: string
  /** Audio plus artwork. */
  bytes: number
  plays: number
  lastPlayedAt: number | null
}

/** The tracks that take the most room, biggest first (ties by title), for deciding what to remove. */
export function largestTracks(tracks: readonly Stored[], limit = 10): LargeTrack[] {
  return tracks
    .map((track) => ({ id: track.id, title: track.title, artist: track.artist, bytes: track.file.size + (track.coverBlob?.size ?? 0), plays: track.plays, lastPlayedAt: track.lastPlayedAt }))
    .sort((a, b) => b.bytes - a.bytes || a.title.localeCompare(b.title))
    .slice(0, Math.max(0, limit))
}

export interface Breakdown {
  music: number
  app: number
  other: number
}

/** Split the site's usage into the library, the app's own offline copy, and whatever else (settings, caches of other tools). */
export function breakdown(usage: number, music: number, app: number): Breakdown {
  const m = Math.min(music, usage)
  const a = Math.min(app, Math.max(0, usage - m))
  return { music: m, app: a, other: Math.max(0, usage - m - a) }
}
