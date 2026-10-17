import { toast } from '../overlays'
import { idbKeyValue } from '../rawdb'
import { ProgressService } from './progressservice'
import { ListeningService } from './service'

/** An id for a new bookmark; it only has to be different from the others of the same track. */
const newBookmarkId = (): string => `b${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`

/**
 * The page's one listening service. The seek bar is mounted twice (footer and phone sheet) and both read this, with the list
 * dialog, the waveform and the keys. Only lazy code imports it (it reaches the database, which the start-up code must not drag
 * along).
 */
export const listeningService = new ListeningService({
  kv: idbKeyValue,
  now: Date.now,
  newId: newBookmarkId,
  onSaveError: () => toast('Your bookmarks could not be saved on this device (the storage is full or blocked). They stay until the app is closed.'),
})

/** The page's one record of where the person stopped in each long recording, and the speed it plays at (see `progressservice.ts`). */
export const progressService = new ProgressService({
  kv: idbKeyValue,
  now: Date.now,
  onSaveError: () => toast('Where you stopped could not be saved on this device (the storage is full or blocked).'),
})

let pruned = false
/** Once per page, when the browser is idle: forget the places nobody came back to for half a year (see `ProgressService.prune`). */
export function pruneProgressOnce(): void {
  if (pruned) return
  pruned = true
  const run = () => void progressService.prune().catch(() => {})
  if (typeof requestIdleCallback === 'function') requestIdleCallback(run, { timeout: 10_000 })
  else setTimeout(run, 5000)
}
