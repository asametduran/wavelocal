// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { EARLY, LEFT_BEHIND, LOOK_AHEAD, asLoop, loopStep } from './loop'
import type { LoopRange } from './loop'

const loop: LoopRange = { a: 10, b: 20 }

describe('asLoop', () => {
  it('is the loop itself when it is two times in order', () => {
    expect(asLoop(loop)).toBe(loop)
    expect(asLoop({ a: 0, b: 0.5 })).toEqual({ a: 0, b: 0.5 })
  })

  it('is nothing for no loop', () => {
    expect(asLoop(null)).toBeNull()
  })

  it('is nothing when the ends are not in order, or the same: there is no part to repeat', () => {
    for (const range of [{ a: 20, b: 10 }, { a: 5, b: 5 }]) expect(asLoop(range), JSON.stringify(range)).toBeNull()
  })

  it('is nothing when an end is not a time: jumping to it would throw, or never come', () => {
    const bad = [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]
    for (const value of bad) {
      expect(asLoop({ a: value, b: 10 }), `a ${value}`).toBeNull()
      expect(asLoop({ a: 1, b: value }), `b ${value}`).toBeNull()
    }
  })
})

describe('loopStep', () => {
  it('has nothing to do while the end is far off', () => {
    for (const time of [0, 9.9, 10, 15, 19, 19.5, 19.59]) expect(loopStep(loop, time, 1), `at ${time}`).toEqual({ kind: 'none' })
  })

  it('schedules the jump for just before the end once it is close: the time left, less a hair', () => {
    const step = loopStep(loop, 19.7, 1)
    expect(step.kind).toBe('wait')
    expect(step.kind === 'wait' ? step.seconds : -1).toBeCloseTo(0.3 - EARLY, 6)
    const nearly = loopStep(loop, 20 - LOOK_AHEAD + 0.001, 1)
    expect(nearly.kind).toBe('wait') // the first moment it is close enough
    expect(loopStep(loop, 20 - LOOK_AHEAD - 0.001, 1)).toEqual({ kind: 'none' }) // and the last one it is not
  })

  it('counts the time left at the speed the file is played: twice as fast, half the wait', () => {
    const fast = loopStep(loop, 19.6, 2) // 0.4 s of file at double speed is 0.2 s of waiting
    expect(fast.kind === 'wait' ? fast.seconds : -1).toBeCloseTo(0.2 - EARLY, 6)
    expect(loopStep(loop, 19.21, 2).kind).toBe('wait') // 0.79 s of file is 0.395 s of waiting: close enough
    expect(loopStep(loop, 19.1, 2).kind).toBe('none') // 0.9 s of file is 0.45 s of waiting: not yet
    const slow = loopStep(loop, 19.9, 0.5) // 0.1 s of file at half speed is 0.2 s of waiting
    expect(slow.kind === 'wait' ? slow.seconds : -1).toBeCloseTo(0.2 - EARLY, 6)
  })

  it('jumps at once when the end has been reached or only just passed (a timer that ran late, an event that came late)', () => {
    for (const time of [20, 20.01, 20.2, 20 + LEFT_BEHIND]) expect(loopStep(loop, time, 1), `at ${time}`).toEqual({ kind: 'jump' })
  })

  it('leaves a playhead that is well past the end alone: the person went somewhere else on purpose', () => {
    for (const time of [20 + LEFT_BEHIND + 0.01, 21, 100, Number.POSITIVE_INFINITY]) expect(loopStep(loop, time, 1), `at ${time}`).toEqual({ kind: 'none' })
  })

  it('has nothing to do before the loop begins, however far before', () => {
    for (const time of [0, 5, 9.99, -3, Number.NEGATIVE_INFINITY]) expect(loopStep(loop, time, 1), `at ${time}`).toEqual({ kind: 'none' })
  })

  it('reads a rate that is not a speed as normal speed', () => {
    for (const rate of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) expect(loopStep(loop, 19.7, rate), `rate ${rate}`).toEqual(loopStep(loop, 19.7, 1))
  })

  it('does nothing for a position that is not a time', () => {
    expect(loopStep(loop, Number.NaN, 1)).toEqual({ kind: 'none' })
  })

  it('never asks to wait a negative time, and never longer than the look-ahead', () => {
    for (let time = 15; time < 22; time += 0.013) {
      for (const rate of [0.25, 0.5, 1, 1.5, 2, 4]) {
        const step = loopStep(loop, time, rate)
        if (step.kind !== 'wait') continue
        expect(step.seconds).toBeGreaterThanOrEqual(0)
        expect(step.seconds).toBeLessThanOrEqual(LOOK_AHEAD)
      }
    }
  })

  it('has one decision for every point of the file: none, then wait, then jump, then none again, in that order of time', () => {
    const order = { none: 0, wait: 1, jump: 2 }
    let rank = 0
    let leftTheRegion = false
    for (let time = 15; time < 25; time += 0.01) {
      const kind = loopStep(loop, time, 1).kind
      if (kind === 'none' && rank === order.jump) leftTheRegion = true
      if (!leftTheRegion) {
        expect(order[kind], `at ${time.toFixed(2)}`).toBeGreaterThanOrEqual(rank)
        rank = order[kind]
      } else expect(kind).toBe('none')
    }
    expect(leftTheRegion).toBe(true)
  })
})
