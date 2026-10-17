import type { Chapter } from './types'

/**
 * Where a listener is among the chapters, and where "next" and "previous" go. A seek to a chapter's start rarely lands
 * exactly on it (a media element rounds), so a position within a tenth of a second before a start counts as being in that
 * chapter already; otherwise "next" right after a jump would just jump to the same place again.
 */

const NEAR = 0.1
/** "Previous" restarts the chapter when more than this many seconds into it, the way "previous" works for tracks. */
export const RESTART_GRACE = 3

const clock = (time: number): number => (Number.isFinite(time) ? time : 0)

/** The index of the chapter playing at `time`: the last one that has begun. -1 before the first chapter, and with none. */
export function chapterIndexAt(chapters: readonly Chapter[], time: number): number {
  const t = clock(time) + NEAR
  let low = 0
  let high = chapters.length - 1
  let found = -1
  while (low <= high) {
    const mid = (low + high) >> 1
    if ((chapters[mid]?.start ?? Number.POSITIVE_INFINITY) <= t) {
      found = mid
      low = mid + 1
    } else high = mid - 1
  }
  return found
}

/** The start of the chapter after the one playing at `time`, or null when it is the last. */
export function nextChapterStart(chapters: readonly Chapter[], time: number): number | null {
  const next = chapters[chapterIndexAt(chapters, time) + 1]
  return next ? next.start : null
}

/**
 * Where "previous chapter" goes: the start of the chapter playing, if more than `grace` seconds into it; otherwise the start of
 * the one before it; from just inside the first chapter, the start of the file (or null if already there).
 */
export function previousChapterStart(chapters: readonly Chapter[], time: number, grace: number = RESTART_GRACE): number | null {
  const t = clock(time)
  const index = chapterIndexAt(chapters, t)
  const current = chapters[index]
  if (!current) return chapters.length > 0 && t > NEAR ? 0 : null // before the first chapter
  if (t - current.start > grace) return current.start
  const before = chapters[index - 1]
  if (before) return before.start
  return current.start > NEAR ? 0 : null
}
