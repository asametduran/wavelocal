import type { KeyValue } from '../rawdb'
import type { NoPeaks, PeaksRecord } from './types'

/**
 * The waveform cache: one small record per track in the app's `meta` store, under `peaks:<track id>`. It is derived data
 * (the audio can always be measured again), so nothing here may ever get in the way of playback: a failed read is a miss
 * and a failed write is dropped.
 */

export const PEAKS_PREFIX = 'peaks:'
const MAX_LENGTH = 4096
const NO_PEAKS: readonly string[] = ['unsupported', 'too-long'] satisfies readonly NoPeaks[]

/**
 * A stored value if it is exactly what this version writes, copied field by field. Anything else (an older layout, a damaged
 * record, plain arrays that a JSON round trip would leave behind) is null, which means "measure it again".
 */
export function readPeaksRecord(value: unknown): PeaksRecord | null {
  if (typeof value !== 'object' || value === null) return null
  const record = value as Record<string, unknown>
  if (record.v !== 1) return null
  if ('none' in record) return typeof record.none === 'string' && NO_PEAKS.includes(record.none) ? { v: 1, none: record.none as NoPeaks } : null
  const { duration, length, peak, rms } = record
  if (typeof duration !== 'number' || !Number.isFinite(duration) || duration < 0) return null
  if (typeof length !== 'number' || !Number.isInteger(length) || length < 1 || length > MAX_LENGTH) return null
  if (!(peak instanceof Uint8Array) || !(rms instanceof Uint8Array) || peak.length !== length || rms.length !== length) return null
  return { v: 1, duration, length, peak, rms }
}

export async function loadPeaks(kv: KeyValue, trackId: string): Promise<PeaksRecord | null> {
  try {
    return readPeaksRecord(await kv.get(PEAKS_PREFIX + trackId))
  } catch {
    return null
  }
}

export async function savePeaks(kv: KeyValue, trackId: string, record: PeaksRecord): Promise<void> {
  try {
    await kv.set(PEAKS_PREFIX + trackId, record)
  } catch {
    // the disk is full or blocked: the waveform is measured again next time
  }
}

/** Forget the waveforms of tracks that are no longer in the library. Resolves with how many were deleted. */
export async function prunePeaks(kv: KeyValue, known: ReadonlySet<string>): Promise<number> {
  let removed = 0
  for (const key of await kv.keys(PEAKS_PREFIX)) {
    if (known.has(key.slice(PEAKS_PREFIX.length))) continue
    await kv.delete(key)
    removed++
  }
  return removed
}
