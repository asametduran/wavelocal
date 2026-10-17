import { toast } from './overlays'
import { clearedMessage, queuedMessage } from './queuemessages'
import type { PlayerApi, Track } from '../types'

/**
 * What choosing "Play next", "Add to queue" or "Clear" does for the listener: change the queue, say what happened, and
 * offer to take it back (the toast's Undo, or Ctrl+Z). Kept apart from the player so every place that queues says the same.
 */

/** Queue tracks to play right after the current one (`next`) or after everything already queued (`last`). */
export function queueTracks(p: Pick<PlayerApi, 'playNext' | 'addToQueue'>, kind: 'next' | 'last', tracks: readonly Track[]): void {
  const first = tracks[0]
  if (!first) return
  const ids = tracks.map((t) => t.id)
  const undo = kind === 'next' ? p.playNext(ids) : p.addToQueue(ids)
  toast(queuedMessage(kind, ids.length, first.title), { action: { label: 'Undo', run: undo } })
}

/** Empty the queue. */
export function clearQueue(p: Pick<PlayerApi, 'upNext' | 'clearUpNext'>): void {
  const count = p.upNext.length
  if (!count) return
  toast(clearedMessage(count), { action: { label: 'Undo', run: p.clearUpNext() } })
}
