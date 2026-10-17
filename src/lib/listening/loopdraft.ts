import { formatTime } from '../format'
import type { LoopRange } from '../loop'

/**
 * How a person sets an A-B loop, as plain data in and out: the `L` key (first press the start, second the end, third clears it)
 * and the A, B and clear buttons all work through these functions, so both ways agree and are tested without a browser. A state
 * is never changed in place; each answer is a new state with the words to say about it (for the page's live region).
 */

/** The shortest loop that is worth hearing. */
export const MIN_LOOP = 0.5
/** A loop ends this far before the end of the file: a jump right at the end would race the track's own end. */
export const END_MARGIN = 0.5

/** Where setting a loop has got to: nothing, a start with its end still to come (`start`), or a loop in force (never both). */
export interface LoopState {
  loop: LoopRange | null
  start: number | null
}

export const NO_LOOP: LoopState = Object.freeze({ loop: null, start: null })

export interface LoopChange {
  state: LoopState
  say: string
}

const TOO_SHORT = 'The end has to come at least half a second after the start.'

/**
 * A loop between `a` and `b` for a file `duration` seconds long (not known: 0), or null. The ends are put in order, the start
 * is not before the file, the end is kept `END_MARGIN` short of its end, and what is left has to be `MIN_LOOP` long.
 */
export function makeLoop(a: number, b: number, duration: number): LoopRange | null {
  if (!Number.isFinite(a) || !Number.isFinite(b)) return null
  const start = Math.max(0, Math.min(a, b))
  const end = Number.isFinite(duration) && duration > 0 ? Math.min(Math.max(a, b), duration - END_MARGIN) : Math.max(a, b)
  return end - start >= MIN_LOOP - 1e-9 ? { a: start, b: end } : null
}

/** "1:02 to 1:19". */
export const describeLoop = (loop: LoopRange): string => `${formatTime(loop.a)} to ${formatTime(loop.b)}`

const looping = (loop: LoopRange): LoopChange => ({ state: { loop, start: null }, say: `Looping ${describeLoop(loop)}` })
const starting = (time: number, how: string): LoopChange => ({ state: { loop: null, start: time }, say: `Loop start ${formatTime(time)}. ${how}` })
const refused = (state: LoopState, say: string): LoopChange => ({ state, say })

/** The end of a loop that starts at `start`, put at `time`; refused (the state stays) when it does not leave a loop. */
function end(state: LoopState, start: number, time: number, duration: number): LoopChange {
  const loop = time - start >= MIN_LOOP ? makeLoop(start, time, duration) : null
  return loop ? looping(loop) : refused(state, TOO_SHORT)
}

export const clearLoop = (): LoopChange => ({ state: NO_LOOP, say: 'Loop cleared' })

/** The L key: the start, then the end, then clear. */
export function pressLoopKey(state: LoopState, time: number, duration: number): LoopChange {
  if (state.loop) return clearLoop()
  if (state.start === null) return starting(time, 'Press L at the end of the passage.')
  return end(state, state.start, time, duration)
}

/** The A button: the start goes to `time`. A loop keeps its end if the new start leaves it room, and otherwise waits for a new one. */
export function setLoopStart(state: LoopState, time: number, duration: number): LoopChange {
  const kept = state.loop && time < state.loop.b ? makeLoop(time, state.loop.b, duration) : null
  return kept && kept.a === Math.max(0, time) ? looping(kept) : starting(time, 'Set the end with B.')
}

/** The B button: the end goes to `time`; there has to be a start. */
export function setLoopEnd(state: LoopState, time: number, duration: number): LoopChange {
  const start = state.loop?.a ?? state.start
  return start === null ? refused(state, 'Set the start of the loop first (A).') : end(state, start, time, duration)
}
