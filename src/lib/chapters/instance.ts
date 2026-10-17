import { idbKeyValue } from '../rawdb'
import { readChapters } from './index'
import { ChaptersService } from './service'
import { pruneChapters } from './store'

/**
 * The page's one chapters service. The seek bar is mounted twice (footer and phone sheet) and both read this, so a file's tags
 * are read once. Only lazy code imports it (it reaches the database, which the start-up code must not drag along).
 */
export const chaptersService = new ChaptersService({
  kv: idbKeyValue,
  read: (target) => readChapters(target.file, target.format ?? null, target.duration),
})

let pruned = false
/** Once per page, when the browser is idle: forget the chapters of tracks that are no longer in the library. */
export function pruneOnce(known: ReadonlySet<string>): void {
  if (pruned) return
  pruned = true
  const run = () => void pruneChapters(idbKeyValue, known).catch(() => {})
  if (typeof requestIdleCallback === 'function') requestIdleCallback(run, { timeout: 10_000 })
  else setTimeout(run, 5000)
}
