import { describe, expect, it } from 'vitest'
import { runPool } from './pool'

const tick = (ms = 0) => new Promise<void>((resolve) => setTimeout(resolve, ms))

describe('runPool', () => {
  it('returns results in input order whatever order the work finishes in', async () => {
    const delays = [30, 5, 20, 1, 10]
    const out = await runPool(delays, 3, async (ms, i) => {
      await tick(ms)
      return `${i}:${ms}`
    })
    expect(out.results).toEqual(['0:30', '1:5', '2:20', '3:1', '4:10'])
    expect(out.completed).toBe(5)
    expect(out.aborted).toBe(false)
  })

  it('never runs more than `limit` workers at once', async () => {
    let running = 0
    let peak = 0
    await runPool(Array.from({ length: 40 }, (_, i) => i), 4, async () => {
      running++
      peak = Math.max(peak, running)
      await tick(2)
      running--
    })
    expect(peak).toBe(4)
  })

  it('treats a limit below 1 as 1 and a huge limit as "all at once"', async () => {
    let peak = 0
    let running = 0
    const work = async () => {
      running++
      peak = Math.max(peak, running)
      await tick(1)
      running--
    }
    await runPool([1, 2, 3], 0, work)
    expect(peak).toBe(1)
    peak = 0
    await runPool([1, 2, 3], 1000, work)
    expect(peak).toBe(3)
  })

  it('handles an empty list', async () => {
    const out = await runPool([], 4, async () => 1)
    expect(out).toEqual({ results: [], completed: 0, aborted: false })
  })

  it('isolates failures: a throwing worker yields the fallback and the rest still run', async () => {
    const seen: number[] = []
    const out = await runPool(
      [1, 2, 3, 4],
      2,
      async (n) => {
        if (n === 2) throw new Error('boom')
        seen.push(n)
        return n * 10
      },
      { onError: (_error, item) => -item },
    )
    expect(out.results).toEqual([10, -2, 30, 40])
    expect(seen.sort()).toEqual([1, 3, 4])
    expect(out.completed).toBe(4)
  })

  it('without an onError handler a failure leaves a hole (undefined) rather than rejecting the pool', async () => {
    const out = await runPool([1, 2], 2, async (n) => {
      if (n === 1) throw new Error('boom')
      return n
    })
    expect(out.results).toEqual([undefined, 2])
  })

  it('reports progress after every finished item with a running count', async () => {
    const counts: number[] = []
    await runPool([5, 1, 3], 3, async (ms) => tick(ms), { onProgress: (done, total) => counts.push(done * 100 + total) })
    expect(counts).toEqual([103, 203, 303])
  })

  it('stops starting new work once aborted and says so', async () => {
    const controller = new AbortController()
    const started: number[] = []
    const out = await runPool(
      Array.from({ length: 20 }, (_, i) => i),
      2,
      async (n) => {
        started.push(n)
        await tick(3)
        if (n === 3) controller.abort()
        return n
      },
      { signal: controller.signal },
    )
    expect(out.aborted).toBe(true)
    expect(started.length).toBeLessThan(20)
    expect(out.completed).toBe(started.length) // everything that started was allowed to finish
    expect(out.results.slice(started.length).every((r) => r === undefined)).toBe(true)
  })

  it('does nothing at all when the signal is already aborted', async () => {
    const controller = new AbortController()
    controller.abort()
    let calls = 0
    const out = await runPool([1, 2, 3], 2, async () => void calls++, { signal: controller.signal })
    expect(calls).toBe(0)
    expect(out.aborted).toBe(true)
    expect(out.completed).toBe(0)
  })

  it('passes the item index to the worker', async () => {
    const out = await runPool(['a', 'b', 'c'], 2, async (item, index) => `${item}${index}`)
    expect(out.results).toEqual(['a0', 'b1', 'c2'])
  })
})
