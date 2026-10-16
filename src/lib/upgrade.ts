import type { TrackRecord, UpgradeProgress } from '../types'
import type { Analysis } from './analyze'
import { analyzeOnDemand } from './analyzeOnDemand'
import { runPool } from './pool'
import { INDEX_VERSION } from './trackmeta'

/**
 * Upgrading a library that was stored before the app read durations, track numbers, years, genres and the audio
 * format: every record is analysed again from the audio copy it already holds (nothing is re-imported, no file is
 * rewritten), a few at a time in the background, with the progress kept in the records themselves (`indexed`) so a
 * restart simply carries on. Only what is still unknown is filled in, and nothing a person can edit is touched.
 */

/** The fields of a record that an analysis may fill in. */
export type UpgradeFields = Pick<TrackRecord, 'duration' | 'gainDb' | 'audio' | 'albumArtist' | 'trackNo' | 'trackTotal' | 'discNo' | 'discTotal' | 'year' | 'genre' | 'compilation'>

export type UpgradePatch = Partial<UpgradeFields> & { indexed: number }

/** True for a record that was never analysed, or was analysed by an older version. (A newer version's stamp is left alone.) */
export const needsUpgrade = (t: Pick<TrackRecord, 'indexed'>): boolean => !(typeof t.indexed === 'number' && t.indexed >= INDEX_VERSION)

/**
 * What an analysis adds to a record: only fields that are still unknown (0, empty, null), so a loudness that was
 * measured, a duration learned while playing or a value somebody set stays, plus the analysis version. A file that
 * could not be analysed (`null`) is stamped too, so it is not tried again on every start.
 */
export function upgradePatch(t: UpgradeFields, a: Analysis | null): UpgradePatch {
  const patch: UpgradePatch = { indexed: INDEX_VERSION }
  if (!a) return patch
  const m = a.meta
  if (!t.duration && a.duration > 0) patch.duration = a.duration
  if (!t.audio && m.audio) patch.audio = m.audio
  if (!t.albumArtist && m.albumArtist) patch.albumArtist = m.albumArtist
  if (!t.trackNo && m.trackNo) patch.trackNo = m.trackNo
  if (!t.trackTotal && m.trackTotal && m.trackTotal >= (t.trackNo || m.trackNo)) patch.trackTotal = m.trackTotal
  if (!t.discNo && m.discNo) patch.discNo = m.discNo
  if (!t.discTotal && m.discTotal && m.discTotal >= (t.discNo || m.discNo)) patch.discTotal = m.discTotal
  if (!t.year && m.year) patch.year = m.year
  if (!t.genre && m.genre) patch.genre = m.genre
  if (!t.compilation && m.compilation) patch.compilation = true
  if (t.gainDb === null && a.gainDb !== null) patch.gainDb = a.gainDb
  return patch
}

export interface UpgradeTarget {
  id: string
  file: Blob
}

export interface UpgradeOptions {
  /** Files analysed at the same time. Default 3: this runs behind the music, so it stays gentle. */
  concurrency?: number
  /** Results handed over at a time. Default 50. */
  batchSize?: number
  signal?: AbortSignal
  analyze?: (file: Blob) => Promise<Analysis>
  onProgress?: (progress: UpgradeProgress) => void
  /** Gets each batch of results by track id; `null` where a file could not be analysed. May be asynchronous. */
  onBatch: (results: Map<string, Analysis | null>) => void | Promise<void>
}

const yieldToUi = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0))

/** Analyse `targets` in the background. Resolves when done or cancelled; what was handed over before a cancel stays. */
export async function upgradeLibrary(targets: readonly UpgradeTarget[], options: UpgradeOptions): Promise<{ done: number; cancelled: boolean }> {
  const { concurrency = 3, batchSize = 50, signal, onProgress, onBatch } = options
  const analyze = options.analyze ?? ((file: Blob) => analyzeOnDemand(file))
  const total = targets.length
  let done = 0
  let cancelled = Boolean(signal?.aborted) && total > 0
  onProgress?.({ total, done: 0 })

  for (let at = 0; at < total && !cancelled; at += batchSize) {
    if (signal?.aborted) {
      cancelled = true
      break
    }
    const chunk = targets.slice(at, at + batchSize)
    const { results, aborted } = await runPool<UpgradeTarget, Analysis | null>(chunk, concurrency, (target) => analyze(target.file), {
      signal,
      onError: () => null,
      onProgress: (finished) => onProgress?.({ total, done: at + finished }),
    })
    const batch = new Map<string, Analysis | null>()
    chunk.forEach((target, i) => {
      const result = results[i]
      if (result !== undefined) batch.set(target.id, result)
    })
    if (batch.size) {
      await onBatch(batch)
      done += batch.size
    }
    onProgress?.({ total, done })
    if (aborted) cancelled = true
    else await yieldToUi()
  }
  return { done, cancelled }
}
