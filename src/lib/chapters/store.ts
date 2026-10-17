import { pruneByPrefix } from '../rawdb'
import type { KeyValue } from '../rawdb'
import { MAX_CHAPTERS, MAX_TITLE } from './normalize'
import type { Chapter } from './types'

/**
 * The chapter cache: one small record per track in the app's `meta` store, under `chapters:<track id>`. Reading a file's tags
 * costs a few reads, but the answer never changes, so it is kept. It is derived data and must never get in the way of
 * playback: a failed read is a miss, a failed write is dropped, and a record that is not exactly what this version writes is
 * a miss too. An empty list is a real answer ("looked, there are none").
 */

export const CHAPTERS_PREFIX = 'chapters:'

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value)

/** The chapters of a stored value, or null if it is not exactly what `saveChapters` writes (copied field by field). */
export function readChaptersRecord(value: unknown): Chapter[] | null {
  if (!isRecord(value) || value.v !== 1 || !Array.isArray(value.chapters) || value.chapters.length > MAX_CHAPTERS) return null
  const chapters: Chapter[] = []
  for (const entry of value.chapters as unknown[]) {
    if (!isRecord(entry)) return null
    const { start, end, title } = entry
    if (typeof start !== 'number' || typeof end !== 'number' || typeof title !== 'string') return null
    if (!Number.isFinite(start) || !Number.isFinite(end) || start < 0 || end < start || [...title].length > MAX_TITLE) return null
    if (chapters.length > 0 && start <= (chapters.at(-1)?.start ?? 0)) return null // starts go strictly forward
    chapters.push({ start, end, title })
  }
  return chapters
}

export async function loadChapters(kv: KeyValue, trackId: string): Promise<Chapter[] | null> {
  try {
    return readChaptersRecord(await kv.get(CHAPTERS_PREFIX + trackId))
  } catch {
    return null
  }
}

export async function saveChapters(kv: KeyValue, trackId: string, chapters: readonly Chapter[]): Promise<void> {
  try {
    await kv.set(CHAPTERS_PREFIX + trackId, { v: 1, chapters })
  } catch {
    // the disk is full or blocked: the file is read again next time
  }
}

/** Forget the chapters of tracks that are no longer in the library. Resolves with how many were deleted. */
export const pruneChapters = (kv: KeyValue, known: ReadonlySet<string>): Promise<number> => pruneByPrefix(kv, CHAPTERS_PREFIX, known)
