/**
 * Up Next: the tracks the listener queued by hand ("Play next", "Add to queue"). They play before the list on screen
 * carries on, and they are kept as a plain list of track ids, so they survive a restart. Pure functions that never
 * change what they are given and hand back the very same list when nothing changed.
 */

/** Far more than any listening session needs, and the ceiling for what is read back from storage. */
export const MAX_UP_NEXT = 500

/** `ids` ahead of everything already queued, in the order given: the latest "play next" plays first. */
export function queueNext(queue: readonly string[], ids: readonly string[]): readonly string[] {
  if (!ids.length) return queue
  return [...ids, ...queue].slice(0, MAX_UP_NEXT)
}

/** `ids` after everything already queued, as many as fit. A track may be queued more than once. */
export function queueLast(queue: readonly string[], ids: readonly string[]): readonly string[] {
  const room = MAX_UP_NEXT - queue.length
  if (!ids.length || room <= 0) return queue
  return [...queue, ...ids.slice(0, room)]
}

/** The queue without the track at `index`. */
export function dequeueAt(queue: readonly string[], index: number): readonly string[] {
  if (!Number.isInteger(index) || index < 0 || index >= queue.length) return queue
  return [...queue.slice(0, index), ...queue.slice(index + 1)]
}

/** The queue with `id` put back at `index` (the end, if the queue has got shorter since): what undoing a removal does. A full queue stays as it is. */
export function requeueAt(queue: readonly string[], index: number, id: string): readonly string[] {
  if (queue.length >= MAX_UP_NEXT) return queue
  const at = Number.isInteger(index) ? Math.min(Math.max(index, 0), queue.length) : queue.length
  return [...queue.slice(0, at), id, ...queue.slice(at)]
}

/** The queue without one occurrence of each of `ids`, looked for from the front or the back: what undoing "play next" or "add to queue" takes out. */
export function unqueue(queue: readonly string[], ids: readonly string[], from: 'front' | 'back'): readonly string[] {
  let next = queue
  for (const id of ids) {
    const at = from === 'front' ? next.indexOf(id) : next.lastIndexOf(id)
    if (at >= 0) next = dequeueAt(next, at)
  }
  return next
}

/** The queue with the track at `from` moved to `to`. */
export function moveQueued(queue: readonly string[], from: number, to: number): readonly string[] {
  if (from === to || !Number.isInteger(from) || !Number.isInteger(to) || from < 0 || to < 0 || from >= queue.length || to >= queue.length) return queue
  const copy = [...queue]
  const [item] = copy.splice(from, 1)
  if (item === undefined) return queue
  copy.splice(to, 0, item)
  return copy
}

/** What was stored, repaired: the ids that are text and that `known` still has, at most `MAX_UP_NEXT` of them. */
export function keepKnown(raw: unknown, known: (id: string) => boolean): string[] {
  if (!Array.isArray(raw)) return []
  const out: string[] = []
  for (const id of raw) {
    if (typeof id === 'string' && known(id)) {
      out.push(id)
      if (out.length >= MAX_UP_NEXT) break
    }
  }
  return out
}

/**
 * Where the list carries on once the queue is used up. While a queued track plays, the list does not carry on after that
 * track (that would skip what lies between): it picks up after `anchor`, the track that was playing when the queue took over.
 */
export interface Resume {
  /** The queued track this holds for: it stops holding as soon as anything else plays. */
  forId: string
  anchor: string
}

/** The track the list carries on after: while a queued track plays, the one it interrupted; otherwise the track that plays. */
export function continueAfter(resume: Resume | null, currentId: string | null): string | null {
  return resume && resume.forId === currentId ? resume.anchor : currentId
}

/** What to remember as the queued track `queuedId` starts: the list will carry on after the track it interrupts. */
export function resumeAfterQueued(resume: Resume | null, currentId: string | null, queuedId: string): Resume | null {
  const anchor = continueAfter(resume, currentId)
  return anchor ? { forId: queuedId, anchor } : null
}

/** The first queued track the library still has, and the queue after it (tracks that are gone are dropped on the way). */
export function nextQueued<T extends { id: string }>(queue: readonly string[], find: (id: string) => T | undefined): { track: T; rest: readonly string[] } | null {
  for (let i = 0; i < queue.length; i++) {
    const track = find(queue[i] ?? '')
    if (track) return { track, rest: queue.slice(i + 1) }
  }
  return null
}

/** What taking the next queued track changes. */
export interface Taken<T> {
  track: T
  /** The queue once the track has left it. */
  queue: readonly string[]
  /** Where the list carries on when the queued track is over. */
  resume: Resume | null
}

/**
 * The queued track that plays next, with everything that taking it changes: the queue without it, and the point the list
 * carries on from. Looking is free; only a caller that really starts the track should keep the result, because a queued
 * track that was taken and then never played is lost.
 */
export function takeQueued<T extends { id: string }>(queue: readonly string[], resume: Resume | null, currentId: string | null, find: (id: string) => T | undefined): Taken<T> | null {
  const next = nextQueued(queue, find)
  return next ? { track: next.track, queue: next.rest, resume: resumeAfterQueued(resume, currentId, next.track.id) } : null
}
