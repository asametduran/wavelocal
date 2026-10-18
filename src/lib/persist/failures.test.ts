// @vitest-environment node
import { describe, expect, it, vi } from 'vitest'
import { DELAYS, Retrier } from './failures'

/** Timers by hand: nothing happens until the test fires it. */
function handTimers() {
  let next = 1
  const waiting = new Map<number, { run: () => void; ms: number }>()
  return {
    set: (run: () => void, ms: number) => {
      const id = next++
      waiting.set(id, { run, ms })
      return id
    },
    clear: (id: unknown) => void waiting.delete(id as number),
    waiting,
    /** The waits asked for and not fired yet, in order. */
    pending: (): number[] => [...waiting.values()].map((t) => t.ms),
    fireAll: () => {
      for (const [id, t] of [...waiting]) {
        waiting.delete(id)
        t.run()
      }
    },
  }
}

describe('Retrier', () => {
  it('waits a second after the first failure and longer after each one in a row, up to half a minute', () => {
    const timers = handTimers()
    const retrier = new Retrier(timers)
    const waited: number[] = []
    for (let i = 0; i < 9; i++) {
      retrier.later('meta:order', () => {})
      waited.push(...timers.pending())
      timers.fireAll()
    }
    expect(waited).toEqual([1000, 2000, 4000, 8000, 16000, 30000, 30000, 30000, 30000])
    expect(DELAYS.at(-1)).toBe(30000)
  })

  it('runs the retry once when its time comes', () => {
    const timers = handTimers()
    const retrier = new Retrier(timers)
    const run = vi.fn()
    retrier.later('meta:order', run)
    expect(run).not.toHaveBeenCalled()
    timers.fireAll()
    expect(run).toHaveBeenCalledTimes(1)
  })

  it('lets a newer try for the same write replace the one that is waiting, and carries on counting', () => {
    const timers = handTimers()
    const retrier = new Retrier(timers)
    const older = vi.fn()
    const newer = vi.fn()
    retrier.later('meta:playlists', older)
    retrier.later('meta:playlists', newer)
    expect(timers.pending()).toEqual([2000]) // one timer, and it is the second failure's wait
    timers.fireAll()
    expect(older).not.toHaveBeenCalled()
    expect(newer).toHaveBeenCalledTimes(1)
  })

  it('starts again at a second once a write has gone through', () => {
    const timers = handTimers()
    const retrier = new Retrier(timers)
    retrier.later('meta:order', () => {})
    timers.fireAll()
    retrier.later('meta:order', () => {})
    timers.fireAll()
    retrier.done('meta:order')
    retrier.later('meta:order', () => {})
    expect(timers.pending()).toEqual([1000])
  })

  it('keeps one write\'s waits apart from another\'s', () => {
    const timers = handTimers()
    const retrier = new Retrier(timers)
    retrier.later('meta:order', () => {})
    timers.fireAll()
    retrier.later('meta:order', () => {})
    retrier.later('meta:upNext', () => {})
    expect(timers.pending().sort((a, b) => a - b)).toEqual([1000, 2000])
  })

  it('forgets a write that went through while its retry was waiting', () => {
    const timers = handTimers()
    const retrier = new Retrier(timers)
    const run = vi.fn()
    retrier.later('meta:order', run)
    retrier.done('meta:order')
    timers.fireAll()
    expect(run).not.toHaveBeenCalled()
    expect(timers.waiting.size).toBe(0)
  })

  it('tries everything that is waiting at once when asked, and leaves nothing waiting', () => {
    const timers = handTimers()
    const retrier = new Retrier(timers)
    const a = vi.fn()
    const b = vi.fn()
    retrier.later('meta:order', a)
    retrier.later('meta:playlists', b)
    retrier.now()
    expect(a).toHaveBeenCalledTimes(1)
    expect(b).toHaveBeenCalledTimes(1)
    expect(timers.waiting.size).toBe(0)
    timers.fireAll()
    expect(a).toHaveBeenCalledTimes(1)
  })

  it('does not start a write again that is already under way when asked to try again', () => {
    const timers = handTimers()
    const retrier = new Retrier(timers)
    const run = vi.fn()
    retrier.later('meta:order', run)
    timers.fireAll() // its time came: the retry is being written
    expect(run).toHaveBeenCalledTimes(1)
    retrier.now() // "Try again" is pressed meanwhile
    expect(run).toHaveBeenCalledTimes(1)
  })

  it('does nothing when asked to try again and nothing is waiting', () => {
    const retrier = new Retrier(handTimers())
    expect(() => retrier.now()).not.toThrow()
  })
})
