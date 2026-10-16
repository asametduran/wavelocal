import { describe, expect, it } from 'vitest'
import { ClockSync, sampleFrom } from './clock'

/** Simulate one ping where the responder's clock runs `offset` ms ahead and the legs take `out` and `back` ms. */
function ping(offset: number, out: number, back: number, at = 10_000, hold = 1) {
  const t0 = at
  const t1 = at + out + offset
  const t2 = t1 + hold
  const t3 = at + out + hold + back
  return sampleFrom(t0, t1, t2, t3)
}

describe('sampleFrom', () => {
  it('recovers the offset exactly when both legs take the same time', () => {
    expect(ping(250, 20, 20)).toEqual({ offset: 250, rtt: 40 })
    expect(ping(-1234, 5, 5)).toEqual({ offset: -1234, rtt: 10 })
  })

  it('is off by at most half the asymmetry, never more than half the round trip', () => {
    const s = ping(250, 10, 30)
    expect(s).not.toBeNull()
    expect(Math.abs((s?.offset ?? 0) - 250)).toBeLessThanOrEqual((s?.rtt ?? 0) / 2)
  })

  it('rejects samples that cannot be real', () => {
    expect(sampleFrom(100, 200, 201, 90)).toBeNull()
    expect(sampleFrom(100, 200, 500, 150)).toBeNull()
    expect(sampleFrom(NaN, 1, 2, 3)).toBeNull()
    expect(sampleFrom(0, 1, 2, Infinity)).toBeNull()
  })
})

describe('ClockSync', () => {
  it('has no estimate before the first reply', () => {
    expect(new ClockSync().estimate()).toBeNull()
  })

  it('ignores null samples', () => {
    const c = new ClockSync()
    c.add(null)
    expect(c.estimate()).toBeNull()
  })

  it('trusts the lowest-latency samples over congested ones', () => {
    const c = new ClockSync()
    // congested, lopsided replies would each be badly wrong
    c.add(ping(500, 200, 20))
    c.add(ping(500, 15, 400))
    c.add(ping(500, 4, 4))
    c.add(ping(500, 5, 5))
    c.add(ping(500, 4, 5))
    const e = c.estimate()
    expect(e?.offset).toBeCloseTo(500, 0)
    expect(e?.rtt).toBe(8)
    expect(e?.samples).toBe(5)
  })

  it('keeps only the most recent samples', () => {
    const c = new ClockSync(3)
    c.add(ping(100, 5, 5))
    c.add(ping(100, 5, 5))
    c.add(ping(100, 5, 5))
    for (let i = 0; i < 3; i++) c.add(ping(900, 5, 5))
    expect(c.estimate()?.offset).toBeCloseTo(900, 0)
  })

  it('can be reset', () => {
    const c = new ClockSync()
    c.add(ping(1, 1, 1))
    c.reset()
    expect(c.estimate()).toBeNull()
  })
})
