import { describe, expect, it } from 'vitest'
import { CPU_CLOCK, FUZZ_SCALE, SLOWDOWN, clock, eachSeed, mutateBytes, mutateText, randomBytes, randomText, rng, seeds, since, timed } from './fuzz'

describe('seeds', () => {
  it('are the same every run, and as many as asked for (times the scale factor)', () => {
    expect(seeds(5)).toEqual(Array.from({ length: 5 * FUZZ_SCALE }, (_, i) => i + (seeds(1)[0] ?? 1)))
    expect(seeds(3)).toEqual(seeds(3))
  })

  it('always gives at least one', () => {
    expect(seeds(0).length).toBeGreaterThanOrEqual(1)
  })
})

describe('mutations', () => {
  const sample = Uint8Array.from({ length: 200 }, (_, i) => i)

  it('are reproducible from their seed', () => {
    expect(mutateBytes(rng(7), sample)).toEqual(mutateBytes(rng(7), sample))
    expect(mutateText(rng(7), 'hello [00:01.00] world')).toBe(mutateText(rng(7), 'hello [00:01.00] world'))
  })

  it('damage the input: a copy that differs from it for almost every seed, and never the input itself', () => {
    let different = 0
    for (let seed = 1; seed <= 300; seed++) {
      const out = mutateBytes(rng(seed), sample)
      expect(out).not.toBe(sample)
      if (out.length !== sample.length || out.some((byte, i) => byte !== sample[i])) different++
    }
    expect(different).toBeGreaterThan(280)
  })

  it('leave the input untouched', () => {
    const before = Uint8Array.from(sample)
    for (let seed = 1; seed <= 50; seed++) mutateBytes(rng(seed), sample)
    expect(sample).toEqual(before)
  })

  it('cope with empty input and tiny input', () => {
    for (let seed = 1; seed <= 100; seed++) {
      expect(() => mutateBytes(rng(seed), new Uint8Array(0))).not.toThrow()
      expect(() => mutateBytes(rng(seed), Uint8Array.of(1))).not.toThrow()
      expect(() => mutateText(rng(seed), '')).not.toThrow()
    }
  })

  it('produce a spread of lengths and of values', () => {
    const lengths = new Set<number>()
    const values = new Set<number>()
    for (let seed = 1; seed <= 300; seed++) {
      const out = mutateBytes(rng(seed), sample)
      lengths.add(out.length)
      out.forEach((byte) => values.add(byte))
    }
    expect(lengths.size).toBeGreaterThan(20)
    expect(values.size).toBe(256)
  })
})

describe('random data', () => {
  it('has the requested length, is reproducible, and uses boundary values often', () => {
    const a = randomBytes(rng(3), 1000)
    expect(a.length).toBe(1000)
    expect(randomBytes(rng(3), 1000)).toEqual(a)
    expect(a.filter((byte) => byte === 0 || byte === 0xff).length).toBeGreaterThan(30)
  })

  it('makes text of the requested length from an alphabet or from odd characters', () => {
    expect(randomText(rng(1), 50, 'ab')).toMatch(/^[ab]{50}$/)
    expect(randomText(rng(1), 500).length).toBeGreaterThanOrEqual(500)
  })
})

describe('eachSeed and timed', () => {
  it('names the failing seed so the case can be replayed', async () => {
    await expect(
      eachSeed(10, (_random, seed) => {
        if (seed === 4) throw new Error('boom')
      }),
    ).rejects.toThrow(/fuzz seed 4: boom/)
  })

  it('waits for asynchronous checks', async () => {
    let done = 0
    await eachSeed(3, async () => {
      await new Promise((resolve) => setTimeout(resolve, 1))
      done++
    })
    expect(done).toBe(3 * FUZZ_SCALE)
  })

  it('measures how long work takes', () => {
    const { result, ms } = timed(() => 21 * 2)
    expect(result).toBe(42)
    expect(ms).toBeGreaterThanOrEqual(0)
  })
})

describe('the clock of time budgets', () => {
  it('does not count time spent waiting, only work (so a busy machine cannot fail a budget)', async () => {
    const start = clock()
    await new Promise((resolve) => setTimeout(resolve, 150))
    // 150 ms went by on the wall; a process that sat idle through them used next to no CPU
    expect(clock() - start).toBeLessThan(CPU_CLOCK ? 100 : Number.POSITIVE_INFINITY)
  })

  it('moves forward while code runs', () => {
    const start = clock()
    const giveUp = performance.now() + 5000
    while (clock() === start && performance.now() < giveUp) {
      // spin until it ticks (the CPU clock is coarse: about 16 ms on Windows)
    }
    expect(clock()).toBeGreaterThan(start)
  })

  it('reports in the milliseconds of an uninstrumented run: coverage makes code slower, so the reading is divided', () => {
    const elapsed = since(clock() - 400) * SLOWDOWN
    expect(elapsed).toBeGreaterThanOrEqual(400)
    expect(elapsed).toBeLessThan(440)
  })

  it('is what timed() measures, in the same unit', () => {
    const { result, ms } = timed(() => {
      const until = clock() + 30
      while (clock() < until) {
        // work until 30 ms of the clock have passed
      }
      return 'done'
    })
    expect(result).toBe('done')
    expect(ms).toBeGreaterThanOrEqual(30 / SLOWDOWN)
  })
})
