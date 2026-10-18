/**
 * Which failures of playback count, and which tracks cannot be played. Pure and framework-free, so the rules are tested (and fuzzed)
 * without a browser; `usePlayer` feeds it what the audio elements report.
 *
 * Two decks, and an `error` event can reach the player late: after it has given the deck another track, twice for one source (the
 * browser's own and one a rejected `play()` produces), or from the deck that is not playing. Counting each of those as a new
 * failure made a queue of unplayable files restart its own chain of skips for ever, and ignoring the idle deck's let a gapless or
 * crossfade hand-over land on a deck that could not play. So every failure is tied to the source the deck was given: it counts
 * once, and only while the deck still has that source.
 */

export type DeckId = 0 | 1

export type Failure =
  /** Stale (the deck has another source now) or repeated: nothing to do. */
  | { readonly kind: 'ignore' }
  /** The source the deck was given failed, for the first time. */
  | { readonly kind: 'failed'; readonly trackId: string; readonly src: string }

interface Attempt {
  readonly trackId: string
  readonly src: string
  failed: boolean
}

export class PlaybackFaults {
  private readonly attempts: [Attempt | null, Attempt | null] = [null, null]
  private readonly bad = new Set<string>()
  private readonly noPreload = new Set<string>()
  private streak = 0

  /** The tracks given up on this session, as one live set: the queue reads it to go past them. */
  readonly unplayable: ReadonlySet<string> = this.bad

  /** A deck was given `src` to play for `trackId` (a new attempt, whatever it was given before, even the same source). */
  attach(deck: DeckId, trackId: string, src: string): void {
    this.attempts[deck] = { trackId, src, failed: false }
  }

  /** A deck was emptied. */
  detach(deck: DeckId): void {
    this.attempts[deck] = null
  }

  /** The deck reported an error while its `src` attribute was `currentSrc`. */
  fail(deck: DeckId, currentSrc: string | null): Failure {
    const attempt = this.attempts[deck]
    if (!attempt || !currentSrc || attempt.src !== currentSrc || attempt.failed) return { kind: 'ignore' }
    attempt.failed = true
    return { kind: 'failed', trackId: attempt.trackId, src: attempt.src }
  }

  /** Give up on a track until it is asked for again: the queue goes past it. */
  markBad(trackId: string): void {
    this.bad.add(trackId)
  }

  isUnplayable(trackId: string): boolean {
    return this.bad.has(trackId)
  }

  /**
   * Preloading the track on the idle deck failed. It is not lined up again, but it is not given up on either: a lossless file the
   * browser could not preload may still be decoded when its turn comes, and plays then like any track.
   */
  markNoPreload(trackId: string): void {
    this.noPreload.add(trackId)
  }

  /** Whether the track may be lined up on the idle deck for a gapless or crossfade hand-over. */
  canPreload(trackId: string): boolean {
    return !this.noPreload.has(trackId) && !this.bad.has(trackId)
  }

  /** The track is tried again (the person asked for it): a failure may have been a passing one. */
  forget(trackId: string): void {
    this.bad.delete(trackId)
    this.noPreload.delete(trackId)
  }

  /** Another track in a row failed without playing; how many have, counting this one. */
  noteFailure(): number {
    return ++this.streak
  }

  /** Something played. Ends the streak of failures and says how long it was. */
  progress(): number {
    const was = this.streak
    this.streak = 0
    return was
  }
}

/**
 * A media element's `error` as the error log keeps it. A `MediaError` has no name and no stack, so it is given the name `MediaError`;
 * the code is what the player can rely on (4 is "the source is not supported"), and what the browser said with it is added for
 * whoever reads the report (the log takes names and paths out of it, as it does from every message).
 */
export function mediaFault(error: { readonly code: number; readonly message?: string } | null): { name: string; message: string } {
  const code = error && Number.isInteger(error.code) ? error.code : 0
  const said = typeof error?.message === 'string' ? error.message.trim() : ''
  return { name: 'MediaError', message: said ? `Media error ${code}: ${said}` : `Media error ${code}` }
}
