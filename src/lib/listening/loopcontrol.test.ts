// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest'
import { changeLoop, loopStart } from './loopcontrol'
import { clearLoop, pressLoopKey, setLoopEnd, setLoopStart } from './loopdraft'
import type { LoopRange } from '../loop'
import { overlays } from '../overlays'

/** The part of the player the loop controls use, with the playhead at `at` and a loop that `setLoop` replaces. */
function fakePlayer(at: number, loop: LoopRange | null = null, duration = 100) {
  const player = {
    loop,
    duration,
    position: () => at,
    setLoop: vi.fn((next: LoopRange | null) => {
      player.loop = next
    }),
  }
  return player
}

const saying = (): string[] => overlays.snapshot().toasts.map((t) => t.text)

afterEach(() => {
  loopStart.set(null)
  for (const toast of overlays.snapshot().toasts) overlays.dismissToast(toast.id)
})

describe('changeLoop', () => {
  it('starts a loop where the playhead is, and says so', () => {
    const p = fakePlayer(62)
    changeLoop(p, pressLoopKey)
    expect(loopStart.get()).toBe(62)
    expect(p.setLoop).toHaveBeenCalledWith(null)
    expect(saying()).toEqual([expect.stringMatching(/^Loop start 1:02/)])
  })

  it('completes it at the next press, and hands the loop to the player', () => {
    const p = fakePlayer(62)
    changeLoop(p, pressLoopKey)
    const q = fakePlayer(79)
    changeLoop(q, pressLoopKey)
    expect(q.setLoop).toHaveBeenCalledWith({ a: 62, b: 79 })
    expect(loopStart.get()).toBeNull() // the waiting start went into the loop
    expect(saying()).toContain('Looping 1:02 to 1:19')
  })

  it('clears a loop the player has, and the start that was waiting', () => {
    const p = fakePlayer(70, { a: 62, b: 79 })
    loopStart.set(5)
    changeLoop(p, clearLoop)
    expect(p.setLoop).toHaveBeenCalledWith(null)
    expect(loopStart.get()).toBeNull()
    expect(saying()).toEqual(['Loop cleared'])
  })

  it('keeps the loop the player has when an action is refused, and says why', () => {
    const p = fakePlayer(10.2, { a: 10, b: 20 })
    changeLoop(p, setLoopEnd)
    expect(p.loop).toEqual({ a: 10, b: 20 }) // the end 0.2 s after the start was refused, so the loop is as it was
    expect(saying()).toEqual([expect.stringMatching(/at least half a second/)])
  })

  it('reads the position when it acts, not before: the same call at another moment is another loop', () => {
    const p = fakePlayer(5)
    changeLoop(p, setLoopStart)
    expect(loopStart.get()).toBe(5)
    const later = fakePlayer(9)
    changeLoop(later, setLoopEnd)
    expect(later.setLoop).toHaveBeenLastCalledWith({ a: 5, b: 9 })
  })
})
