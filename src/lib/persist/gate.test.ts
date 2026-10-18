// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest'
import { LOCK_NAME, NotSavingError, WriteGate, claimWindow, claimWriter } from './gate'
import type { GateMode, MemoryReason } from './gate'

const gateWith = (): { gate: WriteGate; explained: [GateMode, MemoryReason | null][] } => {
  const explained: [GateMode, MemoryReason | null][] = []
  return { gate: new WriteGate({ explain: (mode, reason) => void explained.push([mode, reason]) }), explained }
}

describe('WriteGate', () => {
  it('starts by reading the library: nothing may be written yet, and the first answer is awaited', async () => {
    const { gate } = gateWith()
    expect(gate.snapshot()).toEqual({ mode: 'loading', reason: null, dropped: 0, failing: [], error: null })
    expect(gate.canWrite).toBe(false)
    let settled = false
    void gate.settled.then(() => {
      settled = true
    })
    await Promise.resolve()
    expect(settled).toBe(false)
  })

  it('opens when the library was read, and lets the writes through', async () => {
    const { gate } = gateWith()
    gate.open()
    expect(gate.snapshot().mode).toBe('open')
    expect(gate.canWrite).toBe(true)
    await expect(gate.settled).resolves.toBeUndefined()
  })

  it('stays out of the way of the library when it could not be read, and says why', async () => {
    const { gate } = gateWith()
    gate.memory('unreadable')
    expect(gate.snapshot()).toMatchObject({ mode: 'memory', reason: 'unreadable' })
    expect(gate.canWrite).toBe(false)
    await expect(gate.settled).resolves.toBeUndefined()
    const other = gateWith().gate
    other.memory('unavailable')
    expect(other.snapshot().reason).toBe('unavailable')
  })

  it('is taken over when another window takes the lock, and stops writing', () => {
    const { gate } = gateWith()
    gate.open()
    gate.take()
    expect(gate.snapshot().mode).toBe('taken')
    expect(gate.canWrite).toBe(false)
  })

  it('is taken over even when that happens while the library is still being read', () => {
    const { gate } = gateWith()
    gate.take()
    expect(gate.snapshot().mode).toBe('loading')
    gate.open()
    expect(gate.snapshot().mode).toBe('taken')
    expect(gate.canWrite).toBe(false)
  })

  it('only ever moves on: a window that could not read stays that way, a taken one is not opened again', () => {
    const unread = gateWith().gate
    unread.memory('unreadable')
    unread.open()
    unread.take()
    expect(unread.snapshot().mode).toBe('memory')

    const taken = gateWith().gate
    taken.open()
    taken.take()
    taken.open()
    taken.memory('unreadable')
    expect(taken.snapshot().mode).toBe('taken')

    const open = gateWith().gate
    open.open()
    open.memory('unreadable')
    expect(open.snapshot().mode).toBe('open')
  })

  it('explains at once that it could not read the library (an empty window needs words), and never again for the writes it refuses', () => {
    const { gate, explained } = gateWith()
    gate.memory('unreadable')
    expect(explained).toEqual([['memory', 'unreadable']])
    gate.refuse(false)
    gate.refuse(false)
    expect(gate.snapshot().dropped).toBe(2)
    expect(explained).toEqual([['memory', 'unreadable']])

    const { gate: browser, explained: browserExplained } = gateWith()
    browser.memory('unavailable')
    expect(browserExplained).toEqual([['memory', 'unavailable']])
  })

  it('waits for a change of the person\'s own to be refused before it explains that another window took over, and then does it once', () => {
    const { gate: other, explained: otherExplained } = gateWith()
    other.open()
    other.take()
    other.refuse(false)
    other.refuse(false)
    expect(otherExplained).toEqual([['taken', null]])
  })

  it('counts the writes that are automatic (the place being played, a play count) without ever explaining them', () => {
    const { gate, explained } = gateWith()
    gate.open()
    gate.take()
    gate.refuse(true)
    gate.refuse(true)
    expect(gate.snapshot().dropped).toBe(2)
    expect(explained).toEqual([])
    gate.refuse(false)
    expect(explained).toEqual([['taken', null]])
  })

  it('does not count a write that waits for the library to be read as a refusal', () => {
    const { gate, explained } = gateWith()
    gate.refuse(false)
    expect(gate.snapshot().dropped).toBe(0)
    expect(explained).toEqual([])
  })

  it('hands the same snapshot to everyone until something changes, and tells the listeners when it does', () => {
    const { gate } = gateWith()
    const first = gate.snapshot()
    expect(gate.snapshot()).toBe(first)
    const seen: GateMode[] = []
    const stop = gate.subscribe(() => seen.push(gate.snapshot().mode))
    gate.open()
    gate.take()
    expect(seen).toEqual(['open', 'taken'])
    stop()
    gate.refuse(true)
    expect(seen).toEqual(['open', 'taken'])
    expect(gate.snapshot()).not.toBe(first)
  })

  it('does not notify for a change that changes nothing', () => {
    const { gate } = gateWith()
    gate.open()
    const listener = vi.fn()
    gate.subscribe(listener)
    gate.open()
    gate.memory('unreadable')
    expect(listener).not.toHaveBeenCalled()
  })
})

describe('WriteGate: saves that fail', () => {
  const episodes = () => {
    const events: [string, unknown][] = []
    const gate = new WriteGate({ episode: (event, error) => void events.push([event, error]) })
    gate.open()
    return { gate, events }
  }

  it('lists the writes whose latest save failed, with the newest error, and says once that failing began', () => {
    const { gate, events } = episodes()
    const first = new DOMException('The quota has been exceeded.', 'QuotaExceededError')
    const second = new Error('disk')
    gate.failed('meta:order', first)
    expect(gate.snapshot()).toMatchObject({ failing: ['meta:order'], error: first })
    gate.failed('meta:playlists', second)
    gate.failed('meta:playlists', second)
    expect(gate.snapshot()).toMatchObject({ failing: ['meta:order', 'meta:playlists'], error: second })
    expect(events).toEqual([['failing', first]])
  })

  it('says once that saving works again when the last failing write is saved', () => {
    const { gate, events } = episodes()
    gate.failed('meta:order', new Error('disk'))
    gate.failed('meta:playlists', new Error('disk'))
    gate.saved('meta:order')
    expect(gate.snapshot().failing).toEqual(['meta:playlists'])
    expect(events).toHaveLength(1)
    gate.saved('meta:playlists')
    expect(gate.snapshot()).toMatchObject({ failing: [], error: null })
    expect(events.map(([event]) => event)).toEqual(['failing', 'recovered'])
  })

  it('starts a new episode, and says so, when saving fails again after it recovered', () => {
    const { gate, events } = episodes()
    gate.failed('meta:order', new Error('one'))
    gate.saved('meta:order')
    gate.failed('meta:order', new Error('two'))
    expect(events.map(([event]) => event)).toEqual(['failing', 'recovered', 'failing'])
  })

  it('does not notice a save of something that was not failing', () => {
    const { gate, events } = episodes()
    const listener = vi.fn()
    gate.subscribe(listener)
    gate.saved('meta:order')
    expect(listener).not.toHaveBeenCalled()
    expect(events).toEqual([])
  })

  it('tells the listeners when the list of failing writes changes', () => {
    const { gate } = episodes()
    const listener = vi.fn()
    gate.subscribe(listener)
    gate.failed('meta:order', new Error('disk'))
    gate.saved('meta:order')
    expect(listener).toHaveBeenCalledTimes(2)
  })
})

describe('NotSavingError', () => {
  it('is an error that names why the window is not saving', () => {
    const error = new NotSavingError('taken')
    expect(error).toBeInstanceOf(Error)
    expect(error.name).toBe('NotSavingError')
    expect(error.mode).toBe('taken')
  })
})

/** Web Locks in miniature: one holder per name, and a request with `steal` throws the holder out with an AbortError. */
class FakeLocks {
  holder: { reject: (error: unknown) => void } | null = null
  requests: { name: string; options: unknown }[] = []
  request(name: string, options: { steal?: boolean }, callback: () => Promise<unknown>): Promise<unknown> {
    this.requests.push({ name, options })
    return new Promise((resolve, reject) => {
      this.holder?.reject(new DOMException('Lock broken by another request with the steal option.', 'AbortError'))
      this.holder = { reject }
      callback().then(resolve, reject)
    })
  }
}

describe('claimWriter', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it('goes on at once in a browser that has no Web Locks', async () => {
    const { gate } = gateWith()
    await expect(claimWriter(gate, undefined)).resolves.toBeUndefined()
    expect(gate.snapshot().mode).toBe('loading')
  })

  it('takes the lock by stealing it, under the name the library is known by', async () => {
    const locks = new FakeLocks()
    await claimWriter(gateWith().gate, locks)
    expect(locks.requests).toEqual([{ name: LOCK_NAME, options: { steal: true } }])
  })

  it('keeps the lock for as long as the page lives, and tells the window that lost it', async () => {
    const locks = new FakeLocks()
    const older = gateWith().gate
    older.open()
    await claimWriter(older, locks)
    expect(older.snapshot().mode).toBe('open')

    const newer = gateWith().gate
    newer.open()
    await claimWriter(newer, locks)
    await new Promise((resolve) => setTimeout(resolve, 0)) // the older request's rejection is delivered
    expect(older.snapshot().mode).toBe('taken')
    expect(newer.snapshot().mode).toBe('open')
  })

  it('does not take a refusal that came before the lock was ever given for a loss of it', async () => {
    const gate = gateWith().gate
    gate.open()
    const locks = { request: () => Promise.reject(new DOMException('The operation is insecure.', 'SecurityError')) }
    await expect(claimWriter(gate, locks)).resolves.toBeUndefined()
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(gate.snapshot().mode).toBe('open')
  })

  it('is made once for the page however often the window asks, because a second request would steal the lock from the first', () => {
    expect(claimWindow()).toBe(claimWindow())
  })

  it('goes on after two seconds without an answer, so a browser that never answers cannot keep the library from loading', async () => {
    vi.useFakeTimers()
    const locks = { request: () => new Promise<never>(() => {}) }
    let done = false
    void claimWriter(gateWith().gate, locks).then(() => {
      done = true
    })
    await vi.advanceTimersByTimeAsync(1900)
    expect(done).toBe(false)
    await vi.advanceTimersByTimeAsync(200)
    expect(done).toBe(true)
  })
})
