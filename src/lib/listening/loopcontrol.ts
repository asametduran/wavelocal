import { toast } from '../overlays'
import type { PlayerApi } from '../../types'
import type { LoopChange, LoopState } from './loopdraft'
import { Value } from './value'

/**
 * Where setting an A-B loop meets the player: the key and the buttons ask for one of the actions of `loopdraft.ts` at the
 * playhead, and this hands the loop it makes to the player, keeps the start that is still waiting for its end, and says what
 * happened (a toast, which a screen reader hears too).
 */

/** The start of a loop that has no end yet. The page forgets it when another track starts. */
export const loopStart = new Value<number | null>(null)

export type LoopPlayer = Pick<PlayerApi, 'loop' | 'setLoop' | 'position' | 'duration'>

/** Do `act` (the L key, the A button, ...) from where the playhead is now. */
export function changeLoop(p: LoopPlayer, act: (state: LoopState, time: number, duration: number) => LoopChange): void {
  const change = act({ loop: p.loop, start: loopStart.get() }, p.position(), p.duration)
  p.setLoop(change.state.loop)
  loopStart.set(change.state.start)
  toast(change.say)
}
