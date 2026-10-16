/**
 * What counts as "a play". Counting every click would make a skipped track look as loved as a favourite, so a play
 * only counts once the listener has actually heard a meaningful part of the track:
 *   - half of it, or 30 seconds, whichever comes first (the same rule most scrobblers use),
 *   - measured as time really listened: pauses do not count and neither do seeks, so dragging the bar to the end
 *     cannot manufacture a play.
 * One tally follows one track at a time and reports each play exactly once.
 */

/** A long track counts after this many seconds of listening. */
export const COUNT_AFTER_SECONDS = 30
/** A short track counts after this fraction of its length. */
export const COUNT_AFTER_FRACTION = 0.5
/** Position samples further apart than this (forward) are seeks, not listening. Covers 2x speed with sparse updates. */
export const MAX_STEP_SECONDS = 2.5

/** Seconds of listening after which a track of `duration` seconds counts as played. */
export function countThreshold(duration: number): number {
  if (!Number.isFinite(duration) || duration <= 0) return COUNT_AFTER_SECONDS
  return Math.min(COUNT_AFTER_SECONDS, duration * COUNT_AFTER_FRACTION)
}

export class PlayTally {
  private id: string | null = null
  private listened = 0
  private last: number | null = null
  private counted = false

  /** Start following `id` from scratch (a new track was loaded, or the same one restarted). */
  begin(id: string | null): void {
    this.id = id
    this.listened = 0
    this.last = null
    this.counted = false
  }

  /** Seconds of the current track heard so far. */
  get listenedSeconds(): number {
    return this.listened
  }

  get hasCounted(): boolean {
    return this.counted
  }

  /**
   * Feed one position sample of the current track (`timeupdate`). Returns true exactly once: on the sample that makes
   * the play count.
   */
  observe(id: string, position: number, duration: number, playing: boolean): boolean {
    if (id !== this.id) this.begin(id)
    if (!playing || !Number.isFinite(position)) {
      this.last = null
      return false
    }
    if (this.last !== null) {
      const step = position - this.last
      if (step > 0 && step <= MAX_STEP_SECONDS) this.listened += step
    }
    this.last = position
    if (this.counted || this.listened < countThreshold(duration)) return false
    this.counted = true
    return true
  }

  /** A seek or a stall: the next sample must not be measured against the one before it. */
  jumped(): void {
    this.last = null
  }

  /**
   * The track played to its end. Counts it if the threshold was not crossed by a sample (a very short track) but at
   * least half of it was heard. Returns true if this made it count.
   */
  finish(duration: number): boolean {
    if (this.counted || !(duration > 0) || this.listened < duration * COUNT_AFTER_FRACTION) return false
    this.counted = true
    return true
  }
}
