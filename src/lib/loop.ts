/**
 * The A-B loop: a part of the playing track that repeats. A media element reports its position about every 250 ms, which is too
 * coarse to end a loop on the beat, so the player looks at the loop each time it hears the position and this says what to do:
 * nothing, wait a little and jump, or jump now. Pure, so the timing is tested without a browser.
 */

/** The part of a track that repeats, in seconds from the start of the file. */
export interface LoopRange {
  a: number
  b: number
}

/** `range` if it is a loop (two times in order, neither of them infinite), otherwise null. The player only ever holds a loop of this kind. */
export function asLoop(range: LoopRange | null): LoopRange | null {
  return range && Number.isFinite(range.a) && Number.isFinite(range.b) && range.b > range.a ? range : null
}

export type LoopStep = { kind: 'none' } | { kind: 'wait'; seconds: number } | { kind: 'jump' }

/** The end has to be this close (in seconds of waiting) before the jump is scheduled: a little over the gap between two position reports. */
export const LOOK_AHEAD = 0.4
/** The jump is scheduled this much before the end, so that it lands on it rather than after it. */
export const EARLY = 0.01
/** A playhead further past the end than this was not carried there by playing: the person moved it, and the loop lets it be. */
export const LEFT_BEHIND = 0.5

const NONE: LoopStep = { kind: 'none' }
const JUMP: LoopStep = { kind: 'jump' }

/** What to do about `loop` when the file is at `time` (seconds) and plays at `rate` times its speed. */
export function loopStep(loop: LoopRange, time: number, rate: number): LoopStep {
  if (Number.isNaN(time)) return NONE
  const over = time - loop.b
  if (over > LEFT_BEHIND) return NONE
  if (over >= 0) return JUMP
  const left = -over / (Number.isFinite(rate) && rate > 0 ? rate : 1)
  return left > LOOK_AHEAD ? NONE : { kind: 'wait', seconds: Math.max(0, left - EARLY) }
}
