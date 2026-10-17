// @vitest-environment node
import { describe, expect, it, vi } from 'vitest'
import type { Progress } from './progress'
import { ProgressService } from './progressservice'
import type { ProgressDeps } from './progressservice'
import { memoryKv } from '../../test-utils/memorykv'
import type { MemoryKv } from '../../test-utils/memorykv'

const A = 'one.mp3|100|1'
const B = 'two.mp3|200|2'
const DAY = 86_400_000
const NOW = 1_800_000_000_000
const rec = (over: Partial<Progress> = {}): Progress => ({ v: 1, at: NOW - DAY, t: 600, speed: null, mode: 'auto', ...over })

function rig(overrides: Partial<ProgressDeps> = {}, kv: MemoryKv = memoryKv()) {
  let clock = NOW
  const onSaveError = vi.fn()
  const service = new ProgressService({ kv, now: () => clock, onSaveError, ...overrides })
  return { service, kv, onSaveError, advance: (ms: number) => (clock += ms) }
}

const stored = (kv: MemoryKv, key: string): unknown => kv.data.get(`heard:${key}`)

describe('ProgressService: reading', () => {
  it('knows nothing until it has read the database, then everything that was kept', async () => {
    const { service, kv } = rig()
    kv.data.set(`heard:${A}`, rec({ t: 700 }))
    expect(service.get(A)).toBeNull()
    expect(await service.ready()).toBe(true)
    expect(service.get(A)).toEqual(rec({ t: 700 }))
    expect(service.get(B)).toBeNull()
  })

  it('reads the database once, however often it is asked', async () => {
    const kv = memoryKv()
    const keys = vi.spyOn(kv, 'keys')
    const { service } = rig({}, kv)
    await Promise.all([service.ready(), service.ready()])
    await service.ready()
    expect(keys).toHaveBeenCalledTimes(1)
  })

  it('says it is not ready (false) when the database cannot be read, and refuses to change anything', async () => {
    const { service, kv } = rig()
    kv.data.set(`heard:${A}`, rec())
    kv.fail.get = true
    expect(await service.ready()).toBe(false)
    expect(service.save(A, { t: 50 })).toBe(false)
    kv.fail.get = false
    expect(stored(kv, A)).toEqual(rec()) // what was there is untouched
  })

  it('hands out the same record until it changes, as useSyncExternalStore needs', async () => {
    const { service } = rig()
    await service.ready()
    service.save(A, { t: 600 })
    const first = service.get(A)
    expect(service.get(A)).toBe(first)
    service.save(A, { t: 700 })
    expect(service.get(A)).not.toBe(first)
  })
})

describe('ProgressService: changing', () => {
  it('keeps a place with the time of the change, and shows it at once', async () => {
    const { service, kv } = rig()
    await service.ready()
    expect(service.save(A, { t: 321.5 })).toBe(true)
    expect(service.get(A)).toEqual({ v: 1, at: NOW, t: 321.5, speed: null, mode: 'auto' })
    await vi.waitFor(() => expect(stored(kv, A)).toEqual({ v: 1, at: NOW, t: 321.5, speed: null, mode: 'auto' }))
  })

  it('changes only what it is told to: a place does not undo a speed or a choice', async () => {
    const { service } = rig()
    await service.ready()
    service.save(A, { speed: 1.5 })
    service.save(A, { mode: 'always' })
    service.save(A, { t: 900 })
    expect(service.get(A)).toMatchObject({ t: 900, speed: 1.5, mode: 'always' })
    service.save(A, { t: null })
    expect(service.get(A)).toMatchObject({ t: null, speed: 1.5, mode: 'always' })
  })

  it('writes nothing for a change that changes nothing', async () => {
    const kv = memoryKv()
    const set = vi.spyOn(kv, 'set')
    const { service } = rig({}, kv)
    await service.ready()
    service.save(A, { t: 100 })
    service.save(A, { t: 100 })
    service.save(A, { speed: null })
    await vi.waitFor(() => expect(set).toHaveBeenCalledTimes(1))
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(set).toHaveBeenCalledTimes(1)
  })

  it('tells the listeners about a change, and not about one that changed nothing', async () => {
    const { service } = rig()
    await service.ready()
    const heard = vi.fn()
    const stop = service.subscribe(heard)
    service.save(A, { t: 10 })
    service.save(A, { t: 10 })
    expect(heard).toHaveBeenCalledTimes(1)
    stop()
    service.save(A, { t: 20 })
    expect(heard).toHaveBeenCalledTimes(1)
  })

  it('forgets a record that has nothing left to remember, in the database as well', async () => {
    const { service, kv } = rig()
    await service.ready()
    service.save(A, { t: 100 })
    await vi.waitFor(() => expect(stored(kv, A)).toBeDefined())
    service.save(A, { t: null })
    expect(service.get(A)).toBeNull()
    await vi.waitFor(() => expect(stored(kv, A)).toBeUndefined())
  })

  it('forgets everything about a track on request', async () => {
    const { service, kv } = rig()
    await service.ready()
    service.save(A, { t: 100, speed: 1.5, mode: 'never' })
    service.forget(A)
    expect(service.get(A)).toBeNull()
    await vi.waitFor(() => expect(stored(kv, A)).toBeUndefined())
    service.forget(B) // a track it never heard of is no problem
  })

  it('refuses to change anything before the database has been read: a record it has not seen must not be written over', () => {
    const { service, kv } = rig()
    expect(service.save(A, { t: 5 })).toBe(false)
    expect(kv.data.size).toBe(0)
  })
})

describe('ProgressService: keeping', () => {
  it('writes in the order the changes were made, even when the database answers earlier ones late', async () => {
    const kv = memoryKv()
    const calls: number[] = []
    const set = kv.set
    let slow = true
    kv.set = async (key, value) => {
      calls.push((value as Progress).t ?? -1)
      if (slow) await new Promise((resolve) => setTimeout(resolve, 40))
      slow = false
      return set(key, value)
    }
    const { service } = rig({}, kv)
    await service.ready()
    service.save(A, { t: 10 })
    service.save(A, { t: 20 })
    service.save(A, { t: 30 })
    await vi.waitFor(() => expect(calls).toHaveLength(3))
    expect(calls).toEqual([10, 20, 30])
    await vi.waitFor(() => expect((stored(kv, A) as Progress).t).toBe(30))
  })

  it('shows a change even when it cannot be kept, says so, and keeps it with the next change that can be', async () => {
    const { service, kv, onSaveError } = rig()
    await service.ready()
    kv.fail.set = true
    service.save(A, { t: 10 })
    expect(service.get(A)?.t).toBe(10)
    await vi.waitFor(() => expect(onSaveError).toHaveBeenCalledTimes(1))
    kv.fail.set = false
    service.save(A, { t: 20 })
    await vi.waitFor(() => expect((stored(kv, A) as Progress).t).toBe(20))
  })

  it('says so once for a run of failures, not at every save (a place is saved every five seconds), and again after a success in between', async () => {
    const { service, kv, onSaveError } = rig()
    await service.ready()
    kv.fail.set = true
    service.save(A, { t: 10 })
    service.save(A, { t: 20 })
    service.save(A, { t: 30 })
    await vi.waitFor(() => expect(onSaveError).toHaveBeenCalledTimes(1))
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(onSaveError).toHaveBeenCalledTimes(1)

    kv.fail.set = false
    service.save(A, { t: 40 })
    await vi.waitFor(() => expect((stored(kv, A) as Progress).t).toBe(40))
    kv.fail.set = true
    service.save(A, { t: 50 })
    await vi.waitFor(() => expect(onSaveError).toHaveBeenCalledTimes(2))
  })
})

describe('ProgressService: forgetting everything', () => {
  it('forgets every record in memory and in the database, tells the listeners once, and leaves the bookmarks alone', async () => {
    const { service, kv } = rig()
    kv.data.set(`heard:${A}`, rec())
    kv.data.set(`heard:${B}`, rec({ speed: 1.5, mode: 'always' }))
    kv.data.set('listen:one.mp3|100|1', { v: 1, at: 1, bookmarks: [{ id: 'a', t: 5, label: 'x', at: 1 }] })
    await service.ready()
    const heard = vi.fn()
    service.subscribe(heard)
    expect(service.size).toBe(2)
    expect(await service.clear()).toBe(2)
    expect(service.size).toBe(0)
    expect(service.get(A)).toBeNull()
    expect(service.get(B)).toBeNull()
    expect(heard).toHaveBeenCalledTimes(1)
    expect([...kv.data.keys()]).toEqual(['listen:one.mp3|100|1'])
  })

  it('also forgets a place that was still waiting to be written', async () => {
    const kv = memoryKv()
    const set = kv.set
    kv.set = async (key, value) => {
      await new Promise((resolve) => setTimeout(resolve, 30))
      return set(key, value)
    }
    const { service } = rig({}, kv)
    await service.ready()
    service.save(A, { t: 100 })
    expect(await service.clear()).toBe(1)
    expect(service.get(A)).toBeNull()
    expect(stored(kv, A)).toBeUndefined() // the delete came after the slow write, not before it
  })

  it('says nothing was forgotten, and touches nothing, when there was nothing or the database could not be read', async () => {
    const { service } = rig()
    await service.ready()
    const heard = vi.fn()
    service.subscribe(heard)
    expect(await service.clear()).toBe(0)
    expect(heard).not.toHaveBeenCalled()

    const broken = rig()
    broken.kv.data.set(`heard:${A}`, rec())
    broken.kv.fail.get = true
    expect(await broken.service.clear()).toBe(0)
    expect(stored(broken.kv, A)).toEqual(rec())
  })
})

describe('ProgressService: pruning', () => {
  it('forgets places nobody came back to for half a year, and keeps the choices people made', async () => {
    const { service, kv } = rig()
    kv.data.set(`heard:${A}`, rec({ at: NOW - 300 * DAY }))
    kv.data.set(`heard:${B}`, rec({ at: NOW - 300 * DAY, t: null, mode: 'never' }))
    kv.data.set('heard:recent|1|1', rec({ at: NOW - 1 * DAY }))
    await service.ready()
    const removed = await service.prune()
    expect(removed).toBe(1)
    expect(service.get(A)).toBeNull()
    expect(service.get(B)).not.toBeNull()
    expect(service.get('recent|1|1')).not.toBeNull()
    await vi.waitFor(() => expect(stored(kv, A)).toBeUndefined())
  })

  it('does nothing when the database could not be read', async () => {
    const { service, kv } = rig()
    kv.fail.get = true
    kv.data.set(`heard:${A}`, rec({ at: 0 }))
    await service.ready()
    expect(await service.prune()).toBe(0)
  })
})
