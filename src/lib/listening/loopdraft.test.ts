// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { END_MARGIN, MIN_LOOP, NO_LOOP, clearLoop, describeLoop, makeLoop, pressLoopKey, setLoopEnd, setLoopStart } from './loopdraft'
import type { LoopState } from './loopdraft'

const DURATION = 100
const looping: LoopState = { loop: { a: 10, b: 20 }, start: null }
const half: LoopState = { loop: null, start: 10 }

describe('makeLoop', () => {
  it('keeps a loop that fits inside the file', () => {
    expect(makeLoop(10, 20, DURATION)).toEqual({ a: 10, b: 20 })
    expect(makeLoop(0, DURATION - END_MARGIN, DURATION)).toEqual({ a: 0, b: DURATION - END_MARGIN })
  })

  it('puts the two ends in order', () => {
    expect(makeLoop(20, 10, DURATION)).toEqual({ a: 10, b: 20 })
  })

  it('does not start before the beginning of the file', () => {
    expect(makeLoop(-4, 6, DURATION)).toEqual({ a: 0, b: 6 })
  })

  it('has to be long enough to hear: half a second, and not a hair less', () => {
    expect(makeLoop(10, 10 + MIN_LOOP, DURATION)).toEqual({ a: 10, b: 10.5 })
    expect(makeLoop(10, 10 + MIN_LOOP - 0.01, DURATION)).toBeNull()
    expect(makeLoop(10, 10, DURATION)).toBeNull()
  })

  it('stops short of the end of the file, where a jump back would race the end of the track, and fails when that leaves too little', () => {
    expect(makeLoop(90, 200, DURATION)).toEqual({ a: 90, b: DURATION - END_MARGIN })
    expect(makeLoop(DURATION - 0.7, DURATION, DURATION)).toBeNull() // 0.2 s are left between the start and the margin
    expect(makeLoop(DURATION + 5, DURATION + 9, DURATION)).toBeNull()
  })

  it('does not cap the end when the length of the file is not known yet', () => {
    for (const duration of [0, Number.NaN, -1]) expect(makeLoop(10, 500, duration), `duration ${duration}`).toEqual({ a: 10, b: 500 })
  })

  it('refuses ends that are not times', () => {
    for (const bad of [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
      expect(makeLoop(bad, 10, DURATION)).toBeNull()
      expect(makeLoop(10, bad, DURATION)).toBeNull()
    }
  })
})

describe('describeLoop', () => {
  it('says where the loop runs, the way times are shown elsewhere', () => {
    expect(describeLoop({ a: 62, b: 79 })).toBe('1:02 to 1:19')
    expect(describeLoop({ a: 3599, b: 7322 })).toBe('59:59 to 2:02:02')
  })
})

describe('the L key', () => {
  it('sets the start, then the end, then clears the loop', () => {
    const first = pressLoopKey(NO_LOOP, 62, DURATION)
    expect(first.state).toEqual({ loop: null, start: 62 })
    expect(first.say).toMatch(/^Loop start 1:02/)

    const second = pressLoopKey(first.state, 79, DURATION)
    expect(second.state).toEqual({ loop: { a: 62, b: 79 }, start: null })
    expect(second.say).toBe('Looping 1:02 to 1:19')

    const third = pressLoopKey(second.state, 70, DURATION)
    expect(third.state).toEqual(NO_LOOP)
    expect(third.say).toBe('Loop cleared')
  })

  it('does not take an end that is too close to the start, or before it: the start stays and the person is told', () => {
    for (const time of [10.2, 10, 4]) {
      const change = pressLoopKey(half, time, DURATION)
      expect(change.state, `at ${time}`).toEqual(half)
      expect(change.say).toMatch(/end has to come at least half a second after the start/i)
    }
  })

  it('does not take an end that leaves nothing to loop inside the file', () => {
    const late: LoopState = { loop: null, start: 99.8 }
    const change = pressLoopKey(late, 99.9, DURATION)
    expect(change.state).toEqual(late)
    expect(change.say).toMatch(/at least half a second/i)
  })
})

describe('the A button', () => {
  it('starts a loop where the playhead is', () => {
    expect(setLoopStart(NO_LOOP, 30, DURATION).state).toEqual({ loop: null, start: 30 })
  })

  it('moves the start of a loop and keeps its end', () => {
    const change = setLoopStart(looping, 12, DURATION)
    expect(change.state).toEqual({ loop: { a: 12, b: 20 }, start: null })
    expect(change.say).toBe('Looping 0:12 to 0:20')
  })

  it('can no longer keep the end when the new start is at or after it: the loop becomes a start waiting for its end', () => {
    for (const time of [19.8, 20, 45]) {
      const change = setLoopStart(looping, time, DURATION)
      expect(change.state, `at ${time}`).toEqual({ loop: null, start: time })
      expect(change.say).toMatch(/^Loop start/)
    }
  })

  it('moves a start that is waiting for its end', () => {
    expect(setLoopStart(half, 15, DURATION).state).toEqual({ loop: null, start: 15 })
  })
})

describe('the B button', () => {
  it('needs a start first, and says so, without changing anything', () => {
    const change = setLoopEnd(NO_LOOP, 30, DURATION)
    expect(change.state).toEqual(NO_LOOP)
    expect(change.say).toMatch(/start of the loop first/i)
  })

  it('completes a start that is waiting for its end', () => {
    const change = setLoopEnd(half, 25, DURATION)
    expect(change.state).toEqual({ loop: { a: 10, b: 25 }, start: null })
    expect(change.say).toBe('Looping 0:10 to 0:25')
  })

  it('moves the end of a loop, and keeps the loop when the new end is too early', () => {
    expect(setLoopEnd(looping, 40, DURATION).state).toEqual({ loop: { a: 10, b: 40 }, start: null })
    const early = setLoopEnd(looping, 10.2, DURATION)
    expect(early.state).toEqual(looping)
    expect(early.say).toMatch(/at least half a second/i)
  })

  it('stops short of the end of the file', () => {
    expect(setLoopEnd(half, DURATION, DURATION).state).toEqual({ loop: { a: 10, b: DURATION - END_MARGIN }, start: null })
  })
})

describe('clearLoop', () => {
  it('forgets both the loop and a waiting start', () => {
    expect(clearLoop()).toEqual({ state: NO_LOOP, say: 'Loop cleared' })
  })
})

describe('state', () => {
  it('is never changed in place: every answer is a new state', () => {
    const frozen: LoopState = Object.freeze({ loop: Object.freeze({ a: 10, b: 20 }), start: null })
    expect(() => {
      pressLoopKey(frozen, 5, DURATION)
      setLoopStart(frozen, 5, DURATION)
      setLoopEnd(frozen, 50, DURATION)
      clearLoop()
    }).not.toThrow()
    expect(frozen).toEqual({ loop: { a: 10, b: 20 }, start: null })
    expect(Object.isFrozen(NO_LOOP)).toBe(true)
  })

  it('walks through every combination of presses without ending up in a state that makes no sense', () => {
    // whatever is pressed in whatever order, a loop is ordered and long enough, and it is never in force with a start waiting too
    let state: LoopState = NO_LOOP
    const presses = [pressLoopKey, setLoopStart, setLoopEnd]
    let seed = 7
    const random = () => (seed = (seed * 16807) % 2147483647) / 2147483647
    for (let i = 0; i < 2000; i++) {
      const time = random() < 0.1 ? -5 + random() * 120 : random() * DURATION
      const press = presses[Math.floor(random() * presses.length)] ?? pressLoopKey
      state = random() < 0.05 ? clearLoop().state : press(state, time, DURATION).state
      if (state.loop) {
        expect(state.start).toBeNull()
        expect(state.loop.b - state.loop.a).toBeGreaterThanOrEqual(MIN_LOOP - 1e-9)
        expect(state.loop.a).toBeGreaterThanOrEqual(0)
        expect(state.loop.b).toBeLessThanOrEqual(DURATION - END_MARGIN + 1e-9)
      }
    }
  })
})
