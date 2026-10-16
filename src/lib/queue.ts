import type { Playlist, RepeatMode, Track } from '../types'

/** Pure queue logic (selection, resolution, reordering). No I/O, so it is fully unit-testable. */

export interface PickInput {
  /** The tracks in play order. */
  queue: readonly Track[]
  currentId: string | null
  repeat: RepeatMode
  shuffle: boolean
  /** Ids of previously played tracks, most recent last. */
  history: readonly string[]
  /** 1 = next, -1 = previous. */
  dir: 1 | -1
  /** True when advancing because a track ended (so repeat-off stops at the end of the queue). */
  auto: boolean
  /** Random source in [0, 1); injectable for deterministic tests. */
  random?: () => number
}

export interface PickResult {
  track: Track | null
  /** The history after the pick (going back while shuffling pops one entry). */
  history: readonly string[]
}

/** Choose the next or previous track. Never mutates its inputs. */
export function pickTrack({ queue, currentId, repeat, shuffle, history, dir, auto, random = Math.random }: PickInput): PickResult {
  if (!queue.length) return { track: null, history }
  const idx = queue.findIndex((t) => t.id === currentId)

  if (dir < 0) {
    if (history.length && shuffle) {
      const prevId = history[history.length - 1]
      return { track: queue.find((t) => t.id === prevId) ?? queue[0] ?? null, history: history.slice(0, -1) }
    }
    // a current track that is not in this view (another album was opened while it plays): previous starts from the end
    return { track: queue[idx < 0 ? queue.length - 1 : (idx - 1 + queue.length) % queue.length] ?? null, history }
  }

  if (shuffle && queue.length > 1) {
    let n = queue[Math.floor(random() * queue.length)]
    while (!n || n.id === currentId) n = queue[Math.floor(random() * queue.length)]
    return { track: n, history }
  }
  if (idx === queue.length - 1) return { track: auto && repeat !== 'all' ? null : (queue[0] ?? null), history }
  return { track: queue[idx + 1] ?? null, history }
}

/** The tracks shown/played for a view: the whole library for `'all'`, otherwise the playlist's tracks in its order. */
export function resolveQueue(tracks: Track[], playlists: readonly Playlist[], viewId: string): Track[] {
  if (viewId === 'all') return tracks
  const pl = playlists.find((p) => p.id === viewId)
  if (!pl) return tracks
  const byId = new Map(tracks.map((t) => [t.id, t]))
  return pl.trackIds.flatMap((id) => {
    const t = byId.get(id)
    return t ? [t] : []
  })
}

/** The tracks of `ids`, in that order and each once; ids that are no longer in the library are skipped. */
export function contextQueue(tracks: readonly Track[], ids: readonly string[]): Track[] {
  const byId = new Map(tracks.map((t) => [t.id, t]))
  const seen = new Set<string>()
  const out: Track[] = []
  for (const id of ids) {
    const t = byId.get(id)
    if (t && !seen.has(id)) {
      seen.add(id)
      out.push(t)
    }
  }
  return out
}

/** `current` with the ids it does not have yet appended (each once, in order), and how many that was. Unchanged: the same array. */
export function mergeTrackIds(current: readonly string[], additions: readonly string[]): { ids: readonly string[]; added: number } {
  const have = new Set(current)
  const fresh: string[] = []
  for (const id of additions) {
    if (!have.has(id)) {
      have.add(id)
      fresh.push(id)
    }
  }
  return fresh.length ? { ids: [...current, ...fresh], added: fresh.length } : { ids: current, added: 0 }
}

/** The track to move on to when the playing one is removed: the one after it in `order`, wrapping round; null if there is none. */
export function nextAfterRemoval(order: readonly Track[], id: string): Track | null {
  const at = order.findIndex((t) => t.id === id)
  if (at < 0 || order.length < 2) return null
  return order[(at + 1) % order.length] ?? null
}

/** Move one item to a new index, returning a new array (or the same array for no-op / out-of-range moves). */
export function moveItem<T>(arr: T[], from: number, to: number): T[] {
  if (from === to || from < 0 || to < 0 || from >= arr.length || to >= arr.length) return arr
  const copy = arr.slice()
  const [item] = copy.splice(from, 1)
  if (item === undefined) return arr
  copy.splice(to, 0, item)
  return copy
}

/** off -> all -> one -> off */
export function nextRepeat(mode: RepeatMode): RepeatMode {
  return mode === 'off' ? 'all' : mode === 'all' ? 'one' : 'off'
}
