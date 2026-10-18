// @vitest-environment node
import { describe, expect, it, vi } from 'vitest'
import { MAX_FRAME, MAX_FRAMES, MAX_MESSAGE } from './redact'
import { DiagnosticsLog, MAX_COUNT, MAX_ENTRIES, MAX_STORED, STORAGE_KEY, append, readEntries, serialize } from './log'
import type { LogStorage } from './log'
import type { LogEntry } from './types'

class MemoryStorage implements LogStorage {
  readonly items = new Map<string, string>()
  failReads = false
  failWrites = false

  getItem(key: string): string | null {
    if (this.failReads) throw new DOMException('denied', 'SecurityError')
    return this.items.get(key) ?? null
  }

  setItem(key: string, value: string): void {
    if (this.failWrites) throw new DOMException('full', 'QuotaExceededError')
    this.items.set(key, value)
  }

  removeItem(key: string): void {
    this.items.delete(key)
  }
}

const entry = (over: Partial<LogEntry> = {}): LogEntry => ({ at: 1000, kind: 'error', name: 'TypeError', message: 'boom', frames: ['f (a.js:1:2)'], count: 1, ...over })

/** An error with no stack, so that two of them are one failure when their words are the same (a real one has the test runner's frames). */
const failure = (message: string, name = 'Error'): Error => Object.assign(new Error(message), { name, stack: '' })

/** A log whose clock reads 2000, 3000... on its calls. */
function clocked(storage: LogStorage | null = new MemoryStorage()): DiagnosticsLog {
  let now = 1000
  return new DiagnosticsLog(storage, () => (now += 1000))
}

const stored = (storage: MemoryStorage): { v: number; entries: LogEntry[] } => JSON.parse(storage.items.get(STORAGE_KEY) ?? 'null') as { v: number; entries: LogEntry[] }

describe('DiagnosticsLog: recording', () => {
  it('starts empty', () => {
    expect(clocked().snapshot()).toEqual([])
  })

  it('keeps a failure with its kind, its cleaned message and where it happened', () => {
    const log = clocked()
    const error = new TypeError("Cannot read 'title' of C:\\Music\\a b.mp3")
    error.stack = 'TypeError: x\n    at render (https://e.com/assets/index-abc.js:5:6)'
    log.record('save', error)
    expect(log.snapshot()).toEqual([{ at: 2000, kind: 'save', name: 'TypeError', message: 'Cannot read <text> of <path>', frames: ['render (index-abc.js:5:6)'], count: 1 }])
  })

  it('keeps things that were not errors', () => {
    const log = clocked()
    log.record('rejection', 'plain "words"')
    log.record('rejection', undefined)
    expect(log.snapshot().map((e) => [e.name, e.message])).toEqual([
      ['Error', 'plain <text>'],
      ['Error', 'undefined'],
    ])
  })

  it('counts the same failure in a row once, with the time of the latest', () => {
    const log = clocked()
    for (let i = 0; i < 3; i++) log.record('save', failure('disk full'))
    expect(log.snapshot()).toEqual([{ at: 4000, kind: 'save', name: 'Error', message: 'disk full', frames: [], count: 3 }])
  })

  it.each([
    ['kind', () => [['save', failure('x')] as const, ['decode', failure('x')] as const]],
    ['name', () => [['save', failure('x', 'TypeError')] as const, ['save', failure('x', 'RangeError')] as const]],
    ['message', () => [['save', failure('x')] as const, ['save', failure('y')] as const]],
  ])('is another entry when the %s differs', (_what, make) => {
    const log = clocked()
    for (const [kind, error] of make()) log.record(kind, error)
    expect(log.snapshot()).toHaveLength(2)
  })

  it('is another entry when it happened in another place', () => {
    const log = clocked()
    const at = (place: string): Error => Object.assign(new Error('same'), { stack: `Error: same\n    at ${place} (https://e.com/assets/a.js:1:1)` })
    log.record('error', at('one'))
    log.record('error', at('two'))
    expect(log.snapshot()).toHaveLength(2)
  })

  it('is another entry when something else came in between', () => {
    const log = clocked()
    log.record('save', failure('x'))
    log.record('save', failure('y'))
    log.record('save', failure('x'))
    expect(log.snapshot().map((e) => [e.message, e.count])).toEqual([
      ['x', 1],
      ['y', 1],
      ['x', 1],
    ])
  })

  it('never throws, whatever is wrong with the clock, the error or the store', () => {
    const storage = new MemoryStorage()
    storage.failReads = true
    storage.failWrites = true
    const broken = new DiagnosticsLog(storage, () => {
      throw new Error('clock')
    })
    expect(() => broken.record('error', failure('x'))).not.toThrow()
    expect(broken.snapshot()).toEqual([])
    const log = new DiagnosticsLog(storage)
    expect(() => log.record('error', { get message(): string { throw new Error('no') } })).not.toThrow()
  })
})

describe('DiagnosticsLog: keeping it', () => {
  it('stores the entries, and the next page finds them', () => {
    const storage = new MemoryStorage()
    const first = clocked(storage)
    first.record('save', failure('disk full'))
    expect(stored(storage)).toEqual({ v: 1, entries: first.snapshot() })
    expect(new DiagnosticsLog(storage).snapshot()).toEqual(first.snapshot())
  })

  it('keeps no more than the newest entries', () => {
    const log = clocked()
    for (let i = 0; i < MAX_ENTRIES + 25; i++) log.record('error', failure(`failure number ${i}`))
    const entries = log.snapshot()
    expect(entries).toHaveLength(MAX_ENTRIES)
    expect(entries[0]?.message).toBe('failure number 25')
    expect(entries[entries.length - 1]?.message).toBe(`failure number ${MAX_ENTRIES + 24}`)
  })

  it('keeps what it stores within its size, dropping the oldest', () => {
    const storage = new MemoryStorage()
    const log = clocked(storage)
    const stack = Array.from({ length: MAX_FRAMES }, (_, i) => `    at f${i} (https://e.com/assets/${'x'.repeat(150)}.js:${i}:1)`).join('\n')
    for (let i = 0; i < 60; i++) log.record('save', Object.assign(new Error(`${i} ${'long '.repeat(80)}`), { stack }))
    const text = storage.items.get(STORAGE_KEY) ?? ''
    expect(text.length).toBeLessThanOrEqual(MAX_STORED)
    expect(stored(storage).entries.length).toBeGreaterThan(1)
    expect(stored(storage).entries[stored(storage).entries.length - 1]?.message.startsWith('59 ')).toBe(true) // the newest is the one kept
  })

  it('bounds what one entry holds', () => {
    const log = clocked()
    const stack = Array.from({ length: 30 }, (_, i) => `    at f${i} (https://e.com/assets/${'y'.repeat(400)}.js:${i}:1)`).join('\n')
    log.record('error', Object.assign(new Error('word '.repeat(500)), { stack }))
    const [only] = log.snapshot()
    expect(Array.from(only?.message ?? '').length).toBeLessThanOrEqual(MAX_MESSAGE)
    expect(only?.frames).toHaveLength(MAX_FRAMES)
    for (const frame of only?.frames ?? []) expect(Array.from(frame).length).toBeLessThanOrEqual(MAX_FRAME)
  })

  it('works in memory when nothing can be stored', () => {
    const log = clocked(null)
    log.record('error', failure('a'))
    log.record('error', failure('b'))
    expect(log.snapshot().map((e) => e.message)).toEqual(['a', 'b'])
    expect(log.clear()).toHaveLength(2)
    expect(log.snapshot()).toEqual([])
  })

  it('works in memory when the store refuses to be read', () => {
    const storage = new MemoryStorage()
    storage.failReads = true
    const log = clocked(storage)
    log.record('error', failure('a'))
    log.record('error', failure('b'))
    expect(log.snapshot().map((e) => e.message)).toEqual(['a', 'b'])
  })

  it('keeps what a full store could not take, and writes it with the next failure once the store takes it', () => {
    const storage = new MemoryStorage()
    storage.failWrites = true
    const log = clocked(storage)
    expect(() => log.record('error', failure('a'))).not.toThrow()
    log.record('error', failure('b'))
    expect(log.snapshot().map((e) => e.message)).toEqual(['a', 'b'])
    expect(storage.items.size).toBe(0)
    storage.failWrites = false
    log.record('error', failure('c'))
    expect(stored(storage).entries.map((e) => e.message)).toEqual(['a', 'b', 'c'])
    expect(new DiagnosticsLog(storage).snapshot().map((e) => e.message)).toEqual(['a', 'b', 'c'])
  })

  it('adds what a full store could not take after what another window wrote meanwhile', () => {
    const storage = new MemoryStorage()
    const one = clocked(storage)
    const two = clocked(storage)
    storage.failWrites = true
    one.record('error', failure('lost for now'))
    storage.failWrites = false
    two.record('error', failure('from two'))
    one.record('error', failure('again'))
    expect(stored(storage).entries.map((e) => e.message)).toEqual(['from two', 'lost for now', 'again'])
  })

  it('keeps what could not be written when it looks at the store again', () => {
    const storage = new MemoryStorage()
    const log = clocked(storage)
    storage.failWrites = true
    log.record('error', failure('unwritten'))
    log.refresh()
    expect(log.snapshot().map((e) => e.message)).toEqual(['unwritten'])
  })

  it('reads a store that has none of the usual shape as an empty log, and writes over it', () => {
    for (const text of ['', '{{{', 'null', '5', '"text"', '[]', '{}', '{"v":1}', '{"v":1,"entries":5}', '{"v":1,"entries":{"a":1}}']) {
      const storage = new MemoryStorage()
      storage.items.set(STORAGE_KEY, text)
      const log = clocked(storage)
      expect(log.snapshot()).toEqual([])
      log.record('error', failure('after'))
      expect(stored(storage).entries.map((e) => e.message)).toEqual(['after'])
    }
  })

  it('shares the store with other windows: a failure is added to what is stored now, not to what this window saw', () => {
    const storage = new MemoryStorage()
    const one = clocked(storage)
    const two = clocked(storage)
    one.record('error', failure('from one'))
    two.record('error', failure('from two'))
    one.record('error', failure('again from one'))
    expect(stored(storage).entries.map((e) => e.message)).toEqual(['from one', 'from two', 'again from one'])
    two.refresh()
    expect(two.snapshot().map((e) => e.message)).toEqual(['from one', 'from two', 'again from one'])
  })
})

describe('DiagnosticsLog: telling the page', () => {
  it('lets the page subscribe, and hands out the same list until something changes', () => {
    const log = clocked()
    const listener = vi.fn()
    const unsubscribe = log.subscribe(listener)
    const before = log.snapshot()
    expect(log.snapshot()).toBe(before)
    log.record('error', failure('x'))
    expect(listener).toHaveBeenCalledTimes(1)
    expect(log.snapshot()).not.toBe(before)
    unsubscribe()
    log.record('error', failure('y'))
    expect(listener).toHaveBeenCalledTimes(1)
  })

  it('says so when a refresh finds something new, and only then', () => {
    const storage = new MemoryStorage()
    const one = clocked(storage)
    const two = clocked(storage)
    const listener = vi.fn()
    two.subscribe(listener)
    two.refresh()
    expect(listener).not.toHaveBeenCalled()
    one.record('error', failure('x'))
    two.refresh()
    expect(listener).toHaveBeenCalledTimes(1)
    two.refresh()
    expect(listener).toHaveBeenCalledTimes(1)
  })

  it('keeps what it has when a refresh cannot read the store', () => {
    const storage = new MemoryStorage()
    const log = clocked(storage)
    log.record('error', failure('x'))
    storage.failReads = true
    log.refresh()
    expect(log.snapshot()).toHaveLength(1)
  })
})

describe('DiagnosticsLog: clearing and taking it back', () => {
  it('empties the log and the store, and hands back what it removed', () => {
    const storage = new MemoryStorage()
    const log = clocked(storage)
    log.record('error', failure('x'))
    log.record('save', failure('y'))
    const listener = vi.fn()
    log.subscribe(listener)
    const removed = log.clear()
    expect(removed.map((e) => e.message)).toEqual(['x', 'y'])
    expect(log.snapshot()).toEqual([])
    expect(storage.items.has(STORAGE_KEY)).toBe(false)
    expect(listener).toHaveBeenCalledTimes(1)
  })

  it('puts back what was removed, in front of whatever was recorded since', () => {
    const storage = new MemoryStorage()
    const log = clocked(storage)
    log.record('error', failure('x'))
    log.record('error', failure('y'))
    const removed = log.clear()
    log.record('error', failure('z'))
    log.restore(removed)
    expect(log.snapshot().map((e) => e.message)).toEqual(['x', 'y', 'z'])
    expect(stored(storage).entries.map((e) => e.message)).toEqual(['x', 'y', 'z'])
  })

  it('joins the failure that was just recorded to the same one that comes back', () => {
    const log = clocked()
    log.record('error', failure('x'))
    const removed = log.clear()
    log.record('error', failure('x'))
    log.restore(removed)
    expect(log.snapshot().map((e) => [e.message, e.count])).toEqual([['x', 2]])
  })

  it('does nothing to put back nothing', () => {
    const log = clocked()
    const listener = vi.fn()
    log.subscribe(listener)
    log.restore([])
    expect(listener).not.toHaveBeenCalled()
  })

  it('is bounded when it puts back', () => {
    const log = clocked()
    const many = Array.from({ length: MAX_ENTRIES }, (_, i) => entry({ at: 1000 + i, message: `old ${i}` }))
    for (let i = 0; i < 10; i++) log.record('error', failure(`new ${i}`))
    log.restore(many)
    expect(log.snapshot()).toHaveLength(MAX_ENTRIES)
    expect(log.snapshot()[MAX_ENTRIES - 1]?.message).toBe('new 9')
  })
})

describe('append', () => {
  it('adds an entry after the others, and counts a repeat of the last', () => {
    expect(append([], entry())).toEqual([entry()])
    expect(append([entry()], entry({ at: 5000 }))).toEqual([entry({ at: 5000, count: 2 })])
    expect(append([entry()], entry({ message: 'other' }))).toHaveLength(2)
  })

  it('keeps the later time, and never lets a count pass its ceiling', () => {
    expect(append([entry({ at: 9000 })], entry({ at: 5000 }))[0]?.at).toBe(9000)
    expect(append([entry({ count: MAX_COUNT })], entry())[0]?.count).toBe(MAX_COUNT)
  })

  it('keeps the newest entries when there are too many', () => {
    const full = Array.from({ length: MAX_ENTRIES }, (_, i) => entry({ message: `m${i}` }))
    const next = append(full, entry({ message: 'last' }))
    expect(next).toHaveLength(MAX_ENTRIES)
    expect(next[0]?.message).toBe('m1')
    expect(next[MAX_ENTRIES - 1]?.message).toBe('last')
  })

  it('does not change what it is given', () => {
    const list = Object.freeze([Object.freeze(entry())])
    expect(() => append(list, entry())).not.toThrow()
    expect(list[0]?.count).toBe(1)
  })
})

describe('serialize', () => {
  it('writes the entries as they are when they fit', () => {
    const list = [entry(), entry({ message: 'other' })]
    expect(JSON.parse(serialize(list))).toEqual({ v: 1, entries: list })
  })

  it('drops the oldest until it fits, and keeps at least one', () => {
    const big = Array.from({ length: 40 }, (_, i) => entry({ message: `${i} ${'x'.repeat(MAX_MESSAGE)}`, frames: Array.from({ length: MAX_FRAMES }, () => 'y'.repeat(MAX_FRAME)) }))
    const text = serialize(big)
    expect(text.length).toBeLessThanOrEqual(MAX_STORED)
    const kept = (JSON.parse(text) as { entries: LogEntry[] }).entries
    expect(kept.length).toBeGreaterThan(1)
    expect(kept[kept.length - 1]?.message.startsWith('39 ')).toBe(true)
    expect(JSON.parse(serialize(big.slice(0, 1).map((e) => ({ ...e, message: 'z'.repeat(MAX_STORED) })))).entries).toHaveLength(1)
  })
})

describe('readEntries', () => {
  it('reads entries that are fine as they are', () => {
    const list = [entry(), entry({ kind: 'decode', count: 7 })]
    expect(readEntries(JSON.parse(JSON.stringify(list)))).toEqual(list)
  })

  it.each([undefined, null, 5, 'text', {}, { entries: [] }])('reads %j as no entries', (raw) => {
    expect(readEntries(raw)).toEqual([])
  })

  it('leaves out what is not an entry', () => {
    const bad = [null, 5, 'x', [], {}, entry({ at: Number.NaN }), entry({ at: -1 }), entry({ at: 9e15 }), { ...entry(), at: '1000' }, { ...entry(), kind: 'nope' }, { ...entry(), kind: 5 }]
    expect(readEntries([...bad, entry({ message: 'good' })]).map((e) => e.message)).toEqual(['good'])
  })

  it('repairs what can be repaired', () => {
    const [repaired] = readEntries([{ at: 5, kind: 'save', name: 'not a name', message: 5, frames: 'nope', count: 0 }])
    expect(repaired).toEqual({ at: 5, kind: 'save', name: 'Error', message: '', frames: [], count: 1 })
    expect(readEntries([entry({ count: 1.5 })])[0]?.count).toBe(1)
    expect(readEntries([entry({ count: -3 })])[0]?.count).toBe(1)
    expect(readEntries([{ ...entry(), count: '3' }])[0]?.count).toBe(1)
    expect(readEntries([entry({ count: MAX_COUNT * 10 })])[0]?.count).toBe(MAX_COUNT)
  })

  it('cleans the text again, whatever wrote it', () => {
    const [one] = readEntries([entry({ message: 'Cannot read C:\\Users\\Jane Doe\\Music\\My Song.mp3', frames: ['  fine  (a.js:1:2)  '] })])
    expect(one?.message).toBe('Cannot read <path>')
    expect(one?.frames).toEqual(['fine (a.js:1:2)'])
  })

  it('bounds the frames and the list', () => {
    const [one] = readEntries([entry({ frames: Array.from({ length: 40 }, () => 'z'.repeat(500)) })])
    expect(one?.frames).toHaveLength(MAX_FRAMES)
    for (const frame of one?.frames ?? []) expect(Array.from(frame).length).toBeLessThanOrEqual(MAX_FRAME)
    const many = readEntries(Array.from({ length: MAX_ENTRIES * 2 }, (_, i) => entry({ message: `m${i}` })))
    expect(many).toHaveLength(MAX_ENTRIES)
    expect(many[0]?.message).toBe(`m${MAX_ENTRIES}`)
  })

  it('leaves out frames that are not text', () => {
    expect(readEntries([{ ...entry(), frames: ['a (b.js:1:1)', 5, null, { x: 1 }] }])[0]?.frames).toEqual(['a (b.js:1:1)'])
  })
})
