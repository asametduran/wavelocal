// @vitest-environment node
import { describe, expect, it, vi } from 'vitest'
import type { MetaValues, TrackRecord } from '../../types'
import { NotSavingError, WriteGate } from './gate'
import { createWriter } from './write'
import type { WriteStore } from './write'

/** A store that remembers what it was asked to write, in order, and can be made to fail. */
function fakeStore(failWith: unknown = null): WriteStore & { calls: string[]; failWith: unknown } {
  const calls: string[] = []
  const store = { failWith }
  const done = async (): Promise<void> => {
    if (store.failWith) throw store.failWith
  }
  return Object.assign(store, {
    calls,
    setMeta: async <K extends keyof MetaValues>(key: K, value: MetaValues[K]) => {
      calls.push(`meta ${key} ${JSON.stringify(value)}`)
      await done()
    },
    putTracks: async (records: TrackRecord[]) => {
      calls.push(`put ${records.map((r) => r.id).join(',')}`)
      await done()
    },
    patchTracks: async (patches: ReadonlyMap<string, Partial<TrackRecord>>) => {
      calls.push(`patch ${[...patches.keys()].join(',')}`)
      await done()
    },
    deleteTrack: async (id: string) => {
      calls.push(`delete ${id}`)
      await done()
    },
    clearTracks: async () => {
      calls.push('clear')
      await done()
    },
  })
}

const record = (id: string): TrackRecord => ({ id }) as TrackRecord
const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0))

/** A retry port that waits for the test: `fire` runs what was handed over for a key, as the timer would. */
function handRetry() {
  const waiting = new Map<string, () => void>()
  const done: string[] = []
  return {
    waiting,
    done,
    later: (key: string, run: () => void) => void waiting.set(key, run),
    done_: (key: string) => void done.push(key),
    fire: (key: string) => {
      const run = waiting.get(key)
      waiting.delete(key)
      run?.()
    },
  }
}

function rig(failWith: unknown = null) {
  const explained = vi.fn()
  const gate = new WriteGate({ explain: explained })
  const store = fakeStore(failWith)
  const hand = handRetry()
  const retry = { later: hand.later, done: hand.done_ }
  return { gate, store, explained, hand, writer: createWriter({ gate, store, retry }) }
}

describe('guarded writes', () => {
  it('wait for the saved library to be read, then write in the order they were asked', async () => {
    const { gate, store, writer } = rig()
    writer.saveMeta('order', ['a'])
    writer.saveMeta('order', ['a', 'b'])
    writer.removeTrack('x')
    await flush()
    expect(store.calls).toEqual([])
    gate.open()
    await flush()
    expect(store.calls).toEqual(['meta order ["a"]', 'meta order ["a","b"]', 'delete x'])
  })

  it('write straight away once the library is open', async () => {
    const { gate, store, writer } = rig()
    gate.open()
    writer.saveMeta('playlists', [{ id: 'p', name: 'One', trackIds: [] }])
    writer.clearTracks()
    await writer.saveTracks([record('a'), record('b')])
    await writer.patchTracks(new Map([['a', { duration: 3 }]]))
    await flush()
    expect(store.calls).toEqual(['meta playlists [{"id":"p","name":"One","trackIds":[]}]', 'clear', 'put a,b', 'patch a'])
  })

  it('write nothing in a window that could not read the library, count what it refused, and explain once (when it found out)', async () => {
    const { gate, store, explained, writer } = rig()
    gate.memory('unreadable')
    writer.saveMeta('order', [])
    writer.saveMeta('playlists', [])
    writer.removeTrack('a')
    writer.clearTracks()
    await flush()
    expect(store.calls).toEqual([])
    expect(gate.snapshot().dropped).toBe(4)
    expect(explained).toHaveBeenCalledTimes(1)
    expect(explained).toHaveBeenCalledWith('memory', 'unreadable')
  })

  it('write nothing in a window another window took over', async () => {
    const { gate, store, explained, writer } = rig()
    gate.open()
    gate.take()
    writer.saveMeta('upNext', ['a'])
    await flush()
    expect(store.calls).toEqual([])
    expect(explained).toHaveBeenCalledWith('taken', null)
  })

  it('refuse the automatic ones (the place being played) without a word', async () => {
    const { gate, store, explained, writer } = rig()
    gate.open()
    gate.take()
    writer.saveMeta('resume', { id: 'a', time: 4 }, { quiet: true })
    await expect(writer.saveTracks([record('a')], { quiet: true })).rejects.toBeInstanceOf(NotSavingError)
    await flush()
    expect(store.calls).toEqual([])
    expect(gate.snapshot().dropped).toBe(2)
    expect(explained).not.toHaveBeenCalled()
  })

  it('make a track write fail with an error that says the window is not saving, never pretending it worked', async () => {
    const { gate, store, writer } = rig()
    gate.memory('unavailable')
    await expect(writer.saveTracks([record('a')])).rejects.toMatchObject({ name: 'NotSavingError', mode: 'memory' })
    await expect(writer.patchTracks(new Map([['a', {}]]))).rejects.toBeInstanceOf(NotSavingError)
    expect(store.calls).toEqual([])
    const taken = rig()
    taken.gate.open()
    taken.gate.take()
    await expect(taken.writer.saveTracks([record('a')])).rejects.toMatchObject({ mode: 'taken' })
  })

  it('refuse a track write that was waiting for the library when the library turns out unreadable', async () => {
    const { gate, store, writer } = rig()
    const pending = writer.saveTracks([record('a')])
    const outcome = pending.then(
      () => 'written',
      (error: unknown) => (error instanceof NotSavingError ? 'refused' : 'failed'),
    )
    await flush()
    gate.memory('unreadable')
    expect(await outcome).toBe('refused')
    expect(store.calls).toEqual([])
  })

  it('pass the database error of a track write on to whoever asked, who has a message for it', async () => {
    const quota = new DOMException('The quota has been exceeded.', 'QuotaExceededError')
    const { gate, writer } = rig(quota)
    gate.open()
    await expect(writer.saveTracks([record('a')])).rejects.toBe(quota)
    await expect(writer.patchTracks(new Map([['a', {}]]))).rejects.toBe(quota)
  })

  it('swallow the error of a write nobody waits for (a rejection nobody handles would fail this whole run), and keep it as a failing save', async () => {
    const { gate, store, writer } = rig(new Error('disk'))
    gate.open()
    writer.saveMeta('order', ['a'])
    writer.removeTrack('a')
    writer.clearTracks()
    await flush()
    await flush()
    expect(store.calls).toEqual(['meta order ["a"]', 'delete a', 'clear'])
    expect(gate.snapshot().failing).toEqual(['meta:order', 'delete:a', 'clear'])
  })
})

describe('guarded writes that fail', () => {
  it('are tried again with the same value, and are not failing any more once they go through', async () => {
    const { gate, store, hand, writer } = rig(new DOMException('The quota has been exceeded.', 'QuotaExceededError'))
    gate.open()
    writer.saveMeta('playlists', [{ id: 'p', name: 'One', trackIds: [] }])
    await flush()
    expect(gate.snapshot().failing).toEqual(['meta:playlists'])
    expect([...hand.waiting.keys()]).toEqual(['meta:playlists'])

    store.failWith = null // the person freed some room
    hand.fire('meta:playlists')
    await flush()
    expect(store.calls).toEqual(['meta playlists [{"id":"p","name":"One","trackIds":[]}]', 'meta playlists [{"id":"p","name":"One","trackIds":[]}]'])
    expect(gate.snapshot().failing).toEqual([])
    expect(hand.done).toEqual(['meta:playlists'])
  })

  it('keep failing, and keep being tried again, while the database keeps saying no', async () => {
    const { gate, hand, store, writer } = rig(new Error('disk'))
    gate.open()
    writer.saveMeta('order', ['a'])
    await flush()
    hand.fire('meta:order')
    await flush()
    hand.fire('meta:order')
    await flush()
    expect(store.calls).toHaveLength(3)
    expect(gate.snapshot().failing).toEqual(['meta:order'])
    expect(hand.waiting.has('meta:order')).toBe(true)
  })

  it('never write an old value over a newer one: a retry of a superseded write does nothing', async () => {
    const { gate, store, hand, writer } = rig(new Error('disk'))
    gate.open()
    writer.saveMeta('order', ['a'])
    await flush()
    store.failWith = null
    writer.saveMeta('order', ['a', 'b']) // the newer value goes through
    await flush()
    expect(gate.snapshot().failing).toEqual([])
    store.calls.length = 0
    hand.fire('meta:order') // the old retry's time comes
    await flush()
    expect(store.calls).toEqual([])
  })

  it('ignore the late failure of a write that a newer one already replaced', async () => {
    const { gate, store, hand, writer } = rig()
    gate.open()
    let failFirst: (error: unknown) => void = () => {}
    const original = store.setMeta
    let calls = 0
    store.setMeta = ((key: keyof MetaValues, value: MetaValues[keyof MetaValues]) => {
      calls++
      if (calls === 1) return new Promise<void>((_resolve, reject) => void (failFirst = reject))
      return original(key as 'order', value as string[])
    }) as WriteStore['setMeta']
    writer.saveMeta('order', ['a']) // slow, and about to fail
    writer.saveMeta('order', ['a', 'b']) // newer, goes through
    await flush()
    failFirst(new Error('late'))
    await flush()
    expect(gate.snapshot().failing).toEqual([])
    expect(hand.waiting.size).toBe(0)
  })

  it('ignore the late success of a write that a newer one already replaced: the newer one is still failing, and still tried again', async () => {
    const { gate, store, hand, writer } = rig()
    gate.open()
    let finishFirst: () => void = () => {}
    const original = store.setMeta
    let calls = 0
    store.setMeta = ((key: keyof MetaValues, value: MetaValues[keyof MetaValues]) => {
      calls++
      if (calls === 1) return new Promise<void>((resolve) => void (finishFirst = resolve))
      return original(key as 'order', value as string[])
    }) as WriteStore['setMeta']
    writer.saveMeta('order', ['a']) // slow, and about to go through
    await flush()
    store.failWith = new Error('disk')
    writer.saveMeta('order', ['a', 'b']) // newer, and the disk says no
    await flush()
    expect(gate.snapshot().failing).toEqual(['meta:order'])
    finishFirst()
    await flush()
    expect(gate.snapshot().failing).toEqual(['meta:order']) // the old value was saved, the newest was not
    expect(hand.done).toEqual([])
    expect(hand.waiting.has('meta:order')).toBe(true)
  })

  it('do not count a refusal as a failure: the window is not saving, the disk is fine', async () => {
    const { gate, hand, writer } = rig()
    gate.open()
    gate.take()
    writer.saveMeta('order', ['a'])
    await flush()
    expect(gate.snapshot().failing).toEqual([])
    expect(hand.waiting.size).toBe(0)
  })

  it('retry a clearing of the library only while it is still empty, so a late retry can never wipe what was added since', async () => {
    const { gate, store, hand, writer } = rig(new Error('disk'))
    gate.open()
    let empty = true
    writer.clearTracks(() => empty)
    await flush()
    expect(gate.snapshot().failing).toEqual(['clear'])
    store.failWith = null
    empty = false // tracks were added after the clear failed
    store.calls.length = 0
    hand.fire('clear')
    await flush()
    expect(store.calls).toEqual([])
    expect(gate.snapshot().failing).toEqual([])
  })

  it('clear the library on a retry when it is still empty', async () => {
    const { gate, store, hand, writer } = rig(new Error('disk'))
    gate.open()
    writer.clearTracks(() => true)
    await flush()
    store.failWith = null
    store.calls.length = 0
    hand.fire('clear')
    await flush()
    expect(store.calls).toEqual(['clear'])
    expect(gate.snapshot().failing).toEqual([])
  })

  it('drop the failure of an automatic write (the place being played) without a word: it writes itself again in a few seconds', async () => {
    const { gate, hand, writer } = rig(new Error('disk'))
    gate.open()
    writer.saveMeta('resume', { id: 'a', time: 3 }, { quiet: true })
    await flush()
    expect(gate.snapshot().failing).toEqual([])
    expect(hand.waiting.size).toBe(0)
  })

  it('leave the failure of a track write to whoever asked for it, who has words for it', async () => {
    const { gate, hand, writer } = rig(new Error('disk'))
    gate.open()
    await expect(writer.saveTracks([record('a')])).rejects.toThrow('disk')
    await expect(writer.patchTracks(new Map([['a', {}]]))).rejects.toThrow('disk')
    expect(gate.snapshot().failing).toEqual([])
    expect(hand.waiting.size).toBe(0)
  })
})

describe('reporting what the database refuses', () => {
  function reporting(failWith: unknown = null) {
    const report = vi.fn()
    const gate = new WriteGate()
    const store = fakeStore(failWith)
    return { gate, store, report, writer: createWriter({ gate, store, report }) }
  }

  it('reports every write the database refused, whether nobody, the player or a person waits for the answer', async () => {
    const quota = new DOMException('The quota has been exceeded.', 'QuotaExceededError')
    const { gate, report, writer } = reporting(quota)
    gate.open()
    writer.saveMeta('order', ['a']) // nobody waits
    writer.saveMeta('resume', { id: 'a', time: 1 }, { quiet: true }) // an automatic write, dropped without a word
    writer.removeTrack('a')
    writer.clearTracks()
    await expect(writer.saveTracks([record('a')])).rejects.toBe(quota) // somebody waits
    await expect(writer.patchTracks(new Map([['a', {}]]), { quiet: true })).rejects.toBe(quota)
    await flush()
    expect(report).toHaveBeenCalledTimes(6)
    for (const call of report.mock.calls) expect(call[0]).toBe(quota)
  })

  it('does not report a write that went through', async () => {
    const { gate, report, writer } = reporting()
    gate.open()
    writer.saveMeta('order', ['a'])
    await writer.saveTracks([record('a')])
    await flush()
    expect(report).not.toHaveBeenCalled()
  })

  it('does not report a write that was refused because this window may not write: that is not the database failing', async () => {
    const { gate, store, report, writer } = reporting()
    gate.memory('unreadable')
    writer.saveMeta('order', ['a'])
    writer.saveMeta('resume', { id: 'a', time: 1 }, { quiet: true })
    await expect(writer.saveTracks([record('a')])).rejects.toBeInstanceOf(NotSavingError)
    await flush()
    expect(report).not.toHaveBeenCalled()
    expect(store.calls).toEqual([])
  })

  it('reports each try that fails again, so that a disk that stays full shows how often it was asked', async () => {
    const report = vi.fn()
    const gate = new WriteGate()
    const store = fakeStore(new Error('full'))
    const hand = handRetry()
    const writer = createWriter({ gate, store, report, retry: { later: hand.later, done: hand.done_ } })
    gate.open()
    writer.saveMeta('order', ['a'])
    await flush()
    hand.fire('meta:order')
    await flush()
    hand.fire('meta:order')
    await flush()
    expect(report).toHaveBeenCalledTimes(3)
  })
})
