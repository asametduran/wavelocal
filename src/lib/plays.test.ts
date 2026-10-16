import { describe, expect, it } from 'vitest'
import { COUNT_AFTER_SECONDS, MAX_STEP_SECONDS, PlayTally, countThreshold } from './plays'

/** Listen to `id` from `from` to `to` seconds in quarter-second timeupdate steps; returns how many plays were reported. */
function listen(t: PlayTally, id: string, from: number, to: number, duration: number, playing = true): number {
  let counted = 0
  for (let p = from; p <= to + 1e-9; p += 0.25) if (t.observe(id, p, duration, playing)) counted++
  return counted
}

describe('countThreshold', () => {
  it('is half of a short track and 30 seconds for a long one', () => {
    expect(countThreshold(10)).toBe(5)
    expect(countThreshold(60)).toBe(30)
    expect(countThreshold(600)).toBe(COUNT_AFTER_SECONDS)
    expect(countThreshold(0.4)).toBeCloseTo(0.2)
  })
  it('falls back to 30 seconds while the duration is unknown', () => {
    for (const d of [0, -1, NaN, Infinity]) expect(countThreshold(d)).toBe(COUNT_AFTER_SECONDS)
  })
})

describe('PlayTally', () => {
  it('counts a long track once, after 30 seconds of listening', () => {
    const t = new PlayTally()
    expect(listen(t, 'a', 0, 29, 200)).toBe(0)
    expect(listen(t, 'a', 29.25, 31, 200)).toBe(1)
    expect(listen(t, 'a', 31.25, 120, 200)).toBe(0)
    expect(t.hasCounted).toBe(true)
  })

  it('counts a short track at half of its length', () => {
    const t = new PlayTally()
    expect(listen(t, 'a', 0, 4.5, 10)).toBe(0)
    expect(listen(t, 'a', 4.75, 6, 10)).toBe(1)
  })

  it('does not count a skipped track', () => {
    const t = new PlayTally()
    expect(listen(t, 'a', 0, 8, 200)).toBe(0)
    expect(listen(t, 'b', 0, 3, 200)).toBe(0)
    expect(t.listenedSeconds).toBeCloseTo(3, 0)
  })

  it('does not count time spent paused', () => {
    const t = new PlayTally()
    listen(t, 'a', 0, 20, 200)
    // paused for a long time: the position stays put and nothing is heard
    for (let i = 0; i < 1000; i++) t.observe('a', 20, 200, false)
    expect(t.listenedSeconds).toBeCloseTo(20, 0)
    expect(listen(t, 'a', 20.25, 31, 200)).toBe(1)
  })

  it('does not count seeking forward as listening', () => {
    const t = new PlayTally()
    listen(t, 'a', 0, 5, 200)
    expect(t.observe('a', 150, 200, true)).toBe(false) // dragged the bar
    expect(t.observe('a', 190, 200, true)).toBe(false)
    expect(t.listenedSeconds).toBeLessThan(6)
  })

  it('does not count seeking backward, but keeps counting what is heard afterwards', () => {
    const t = new PlayTally()
    listen(t, 'a', 10, 20, 200)
    const heard = t.listenedSeconds
    t.observe('a', 2, 200, true)
    expect(t.listenedSeconds).toBe(heard)
    listen(t, 'a', 2.25, 4, 200)
    expect(t.listenedSeconds).toBeGreaterThan(heard)
  })

  it('treats a sample after a reported jump as a fresh start', () => {
    const t = new PlayTally()
    t.observe('a', 0, 200, true)
    t.jumped()
    t.observe('a', 2, 200, true)
    expect(t.listenedSeconds).toBe(0)
  })

  it('follows 2x playback, where each update moves further', () => {
    const t = new PlayTally()
    let counted = 0
    for (let p = 0; p <= 40; p += 0.5) if (t.observe('a', p, 300, true)) counted++
    expect(counted).toBe(1)
    expect(0.5).toBeLessThanOrEqual(MAX_STEP_SECONDS)
  })

  it('starts over when a different track begins, and when the same one is restarted', () => {
    const t = new PlayTally()
    expect(listen(t, 'a', 0, 31, 200)).toBe(1)
    expect(listen(t, 'b', 0, 31, 200)).toBe(1)
    t.begin('b')
    expect(t.hasCounted).toBe(false)
    expect(listen(t, 'b', 0, 31, 200)).toBe(1)
  })

  it('counts a finished track that was too short to cross the threshold in samples', () => {
    const t = new PlayTally()
    t.observe('a', 0, 0.4, true)
    t.observe('a', 0.25, 0.4, true) // 0.25 s heard of 0.4 s: already past half, so observe counted it
    const u = new PlayTally()
    u.observe('a', 0, 1, true)
    u.observe('a', 0.5, 1, true) // exactly half
    expect(u.finish(1)).toBe(false) // already counted by observe
    const v = new PlayTally()
    v.observe('a', 0, 0, true) // duration unknown while it played
    v.observe('a', 1, 0, true)
    v.observe('a', 2, 0, true)
    expect(v.finish(3)).toBe(true)
    expect(v.finish(3)).toBe(false)
  })

  it('does not count a finish after only a small part was heard', () => {
    const t = new PlayTally()
    t.observe('a', 0, 0, true)
    t.observe('a', 1, 0, true)
    expect(t.finish(100)).toBe(false)
    expect(t.finish(0)).toBe(false)
  })

  it('ignores non-finite positions', () => {
    const t = new PlayTally()
    expect(t.observe('a', NaN, 100, true)).toBe(false)
    expect(t.listenedSeconds).toBe(0)
  })
})
