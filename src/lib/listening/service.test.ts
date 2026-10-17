// @vitest-environment node
import { describe, expect, it, vi } from 'vitest'
import { MAX_BOOKMARKS } from './bookmarks'
import { ListeningService } from './service'
import type { BookmarksState, ListeningDeps } from './service'
import type { Bookmark } from './types'
import { memoryKv } from '../../test-utils/memorykv'
import type { MemoryKv } from '../../test-utils/memorykv'

const A = 'one.mp3|100|1'
const B = 'two.mp3|200|2'
const mark = (t: number, label = `at ${t}`, id = `id${t}`, at = 1000): Bookmark => ({ id, t, label, at })

function rig(overrides: Partial<ListeningDeps> = {}, kv: MemoryKv = memoryKv()) {
  let n = 0
  const onSaveError = vi.fn()
  const service = new ListeningService({ kv, now: () => 5000, newId: () => `new${++n}`, onSaveError, ...overrides })
  return { service, kv, onSaveError }
}

const bookmarksOf = (service: ListeningService, key: string): readonly Bookmark[] => {
  const state = service.getState(key)
  return state.status === 'ready' ? state.bookmarks : []
}
const ready = (service: ListeningService, key: string) => {
  service.want({ key })
  return vi.waitFor(() => expect(service.getState(key).status).toBe('ready'))
}
const stored = (kv: MemoryKv, key: string): unknown => kv.data.get(`listen:${key}`)

describe('ListeningService: reading', () => {
  it('has nothing to say about a track nobody asked for', () => {
    const { service } = rig()
    expect(service.getState(A)).toEqual({ status: 'idle' })
    service.want(null) // nothing is playing
    expect(service.getState(A)).toEqual({ status: 'idle' })
  })

  it('loads the bookmarks kept for the track: loading first, then ready', async () => {
    const { service, kv } = rig()
    kv.data.set(`listen:${A}`, { v: 1, at: 1, bookmarks: [mark(10), mark(20)] })
    service.want({ key: A })
    expect(service.getState(A).status).toBe('loading')
    await ready(service, A)
    expect(service.getState(A)).toEqual({ status: 'ready', bookmarks: [mark(10), mark(20)] })
  })

  it('is ready with an empty list for a track that has none', async () => {
    const { service } = rig()
    await ready(service, A)
    expect(service.getState(A)).toEqual({ status: 'ready', bookmarks: [] })
  })

  it('reads a track once, however often it is asked for, while it loads and after', async () => {
    const kv = memoryKv()
    const get = vi.spyOn(kv, 'get')
    const { service } = rig({}, kv)
    service.want({ key: A })
    service.want({ key: A })
    await ready(service, A)
    service.want({ key: A })
    expect(get).toHaveBeenCalledTimes(1)
  })

  it('does not drop a stored bookmark because it lies beyond the length the library has for the file: that length can be a guess, the bookmark is the person’s', async () => {
    const { service, kv } = rig()
    kv.data.set(`listen:${A}`, { v: 1, at: 1, bookmarks: [mark(10), mark(900)] })
    await ready(service, A)
    expect(bookmarksOf(service, A).map((b) => b.t)).toEqual([10, 900])
    expect(service.add(A, 20, 60)).toMatchObject({ ok: true }) // a change made with a shorter length in hand leaves the others as they are
    expect(bookmarksOf(service, A).map((b) => b.t)).toEqual([10, 20, 900])
  })

  it('says error when the record cannot be read, refuses changes meanwhile, and tries again the next time the track is asked for', async () => {
    const { service, kv } = rig()
    kv.data.set(`listen:${A}`, { v: 1, at: 1, bookmarks: [mark(10)] })
    kv.fail.get = true
    service.want({ key: A })
    await vi.waitFor(() => expect(service.getState(A).status).toBe('error'))
    expect(service.add(A, 30, 600)).toEqual({ ok: false, reason: 'unavailable' })
    expect(stored(kv, A)).toEqual({ v: 1, at: 1, bookmarks: [mark(10)] }) // what was there is untouched

    kv.fail.get = false
    await ready(service, A)
    expect(bookmarksOf(service, A)).toEqual([mark(10)])
  })

  it('keeps the lists of the last few tracks in memory, and reads an older one again when it comes back', async () => {
    const kv = memoryKv()
    const get = vi.spyOn(kv, 'get')
    const { service } = rig({ keep: 2 }, kv)
    for (const key of ['a', 'b', 'c']) await ready(service, key)
    expect(service.getState('a')).toEqual({ status: 'idle' }) // pushed out
    expect(service.getState('c').status).toBe('ready')
    get.mockClear()
    await ready(service, 'a')
    expect(get).toHaveBeenCalledTimes(1)
  })

  it('tells the listeners when a state changes, until they stop listening', async () => {
    const { service } = rig()
    const heard = vi.fn()
    const stop = service.subscribe(heard)
    await ready(service, A)
    expect(heard).toHaveBeenCalledTimes(2) // loading, ready
    stop()
    service.add(A, 10, 600)
    expect(heard).toHaveBeenCalledTimes(2)
  })

  it('hands out the same state object until something changes, as useSyncExternalStore needs', async () => {
    const { service } = rig()
    await ready(service, A)
    const first: BookmarksState = service.getState(A)
    expect(service.getState(A)).toBe(first)
    service.want({ key: A })
    expect(service.getState(A)).toBe(first)
    service.add(A, 10, 600)
    expect(service.getState(A)).not.toBe(first)
  })
})

describe('ListeningService: changing', () => {
  it('adds a bookmark at once on screen, named by number, and keeps it', async () => {
    const { service, kv } = rig()
    await ready(service, A)
    const result = service.add(A, 62.5, 600)
    expect(result).toMatchObject({ ok: true, bookmark: { id: 'new1', t: 62.5, label: 'Bookmark 1', at: 5000 } })
    expect(bookmarksOf(service, A)).toEqual([{ id: 'new1', t: 62.5, label: 'Bookmark 1', at: 5000 }])
    await vi.waitFor(() => expect(stored(kv, A)).toEqual({ v: 1, at: 5000, bookmarks: [{ id: 'new1', t: 62.5, label: 'Bookmark 1', at: 5000 }] }))
  })

  it('names a bookmark as it is asked to', async () => {
    const { service } = rig()
    await ready(service, A)
    expect(service.add(A, 5, 600, 'The plot thickens')).toMatchObject({ ok: true, bookmark: { label: 'The plot thickens' } })
  })

  it('refuses to add before the track’s bookmarks are known: a list that is still being read must not be written over', () => {
    const { service, kv } = rig()
    expect(service.add(A, 10, 600)).toEqual({ ok: false, reason: 'unavailable' }) // never asked for
    service.want({ key: A })
    expect(service.add(A, 10, 600)).toEqual({ ok: false, reason: 'unavailable' }) // still loading
    expect(kv.data.size).toBe(0)
  })

  it('says why a bookmark was not added, and changes nothing: one is there already, the time is not in the file, the track is full', async () => {
    const { service, kv } = rig()
    await ready(service, A)
    service.add(A, 100, 600)
    const there = service.add(A, 100.2, 600)
    expect(there).toMatchObject({ ok: false, reason: 'there', existing: { t: 100 } })
    expect(service.add(A, 601, 600)).toEqual({ ok: false, reason: 'bad' })
    expect(service.add(A, Number.NaN, 600)).toEqual({ ok: false, reason: 'bad' })
    expect(bookmarksOf(service, A)).toHaveLength(1)

    const full = rig()
    full.kv.data.set(`listen:${B}`, { v: 1, at: 1, bookmarks: Array.from({ length: MAX_BOOKMARKS }, (_, i) => mark(i * 2)) })
    await ready(full.service, B)
    expect(full.service.add(B, 399, 0)).toEqual({ ok: false, reason: 'full' })
    await vi.waitFor(() => expect(stored(kv, A)).toBeDefined())
  })

  it('removes a bookmark and gives it back, and restores it where it was (the Undo)', async () => {
    const { service, kv } = rig()
    kv.data.set(`listen:${A}`, { v: 1, at: 1, bookmarks: [mark(10), mark(20), mark(30)] })
    await ready(service, A)
    const removed = service.remove(A, 'id20')
    expect(removed).toEqual(mark(20))
    expect(bookmarksOf(service, A).map((b) => b.t)).toEqual([10, 30])
    expect(service.restore(A, mark(20))).toBe(true)
    expect(bookmarksOf(service, A).map((b) => b.t)).toEqual([10, 20, 30])
    await vi.waitFor(() => expect((stored(kv, A) as { bookmarks: Bookmark[] }).bookmarks.map((b) => b.t)).toEqual([10, 20, 30]))
  })

  it('has nothing to remove for an id that is not there', async () => {
    const { service } = rig()
    await ready(service, A)
    expect(service.remove(A, 'nope')).toBeNull()
    expect(service.remove('never-asked-for', 'nope')).toBeNull()
  })

  it('does not restore a bookmark whose place has been taken since, and says so', async () => {
    const { service, kv } = rig()
    kv.data.set(`listen:${A}`, { v: 1, at: 1, bookmarks: [mark(100)] })
    await ready(service, A)
    const removed = service.remove(A, 'id100')
    service.add(A, 100.3, 600)
    expect(service.restore(A, removed ?? mark(0))).toBe(false)
    expect(bookmarksOf(service, A)).toHaveLength(1)
  })

  it('renames a bookmark, and keeps the new name; a name that is nothing, or an id that is not there, changes nothing', async () => {
    const { service, kv } = rig()
    kv.data.set(`listen:${A}`, { v: 1, at: 1, bookmarks: [mark(10)] })
    await ready(service, A)
    expect(service.rename(A, 'id10', '  Chapter\u0001 one ')).toBe(true)
    expect(bookmarksOf(service, A)[0]?.label).toBe('Chapter one')
    expect(service.rename(A, 'id10', '   ')).toBe(false)
    expect(service.rename(A, 'nope', 'x')).toBe(false)
    expect(bookmarksOf(service, A)[0]?.label).toBe('Chapter one')
    await vi.waitFor(() => expect((stored(kv, A) as { bookmarks: Bookmark[] }).bookmarks[0]?.label).toBe('Chapter one'))
  })

  it('deletes the record when the last bookmark goes, so a track without bookmarks is kept as nothing', async () => {
    const { service, kv } = rig()
    kv.data.set(`listen:${A}`, { v: 1, at: 1, bookmarks: [mark(10)] })
    await ready(service, A)
    service.remove(A, 'id10')
    await vi.waitFor(() => expect(kv.data.has(`listen:${A}`)).toBe(false))
  })

  it('keeps each track’s list apart', async () => {
    const { service, kv } = rig()
    await ready(service, A)
    await ready(service, B)
    service.add(A, 10, 600)
    service.add(B, 20, 600)
    expect(bookmarksOf(service, A).map((b) => b.t)).toEqual([10])
    expect(bookmarksOf(service, B).map((b) => b.t)).toEqual([20])
    await vi.waitFor(() => expect(stored(kv, B)).toBeDefined())
    expect((stored(kv, A) as { bookmarks: Bookmark[] }).bookmarks.map((b) => b.t)).toEqual([10])
  })
})

describe('ListeningService: keeping', () => {
  it('writes in the order the changes were made, even when the database answers the earlier ones late', async () => {
    const kv = memoryKv()
    const calls: string[] = []
    const set = kv.set
    let slow = true
    kv.set = async (key, value) => {
      calls.push(JSON.stringify((value as { bookmarks: Bookmark[] }).bookmarks.map((b) => b.t)))
      if (slow) await new Promise((resolve) => setTimeout(resolve, 30)) // the first write takes longest
      slow = false
      return set(key, value)
    }
    const { service } = rig({}, kv)
    await ready(service, A)
    service.add(A, 10, 600)
    service.add(A, 20, 600)
    service.add(A, 30, 600)
    await vi.waitFor(() => expect(calls).toHaveLength(3))
    expect(calls).toEqual(['[10]', '[10,20]', '[10,20,30]'])
    await vi.waitFor(() => expect((stored(kv, A) as { bookmarks: Bookmark[] }).bookmarks.map((b) => b.t)).toEqual([10, 20, 30]))
  })

  it('shows a change even when it cannot be kept, says so once, and keeps everything with the next change that can be', async () => {
    const { service, kv, onSaveError } = rig()
    await ready(service, A)
    kv.fail.set = true
    service.add(A, 10, 600)
    expect(bookmarksOf(service, A).map((b) => b.t)).toEqual([10]) // on screen all the same
    await vi.waitFor(() => expect(onSaveError).toHaveBeenCalledTimes(1))
    expect(stored(kv, A)).toBeUndefined()

    kv.fail.set = false
    service.add(A, 20, 600)
    await vi.waitFor(() => expect((stored(kv, A) as { bookmarks: Bookmark[] }).bookmarks.map((b) => b.t)).toEqual([10, 20])) // the first one is not lost
    expect(onSaveError).toHaveBeenCalledTimes(1)
  })

  it('does not get stuck after a failed write: later changes are still written', async () => {
    const { service, kv } = rig()
    await ready(service, A)
    kv.fail.set = true
    service.add(A, 10, 600)
    await vi.waitFor(() => expect(kv.fail.set).toBe(true))
    kv.fail.set = false
    service.add(A, 40, 600)
    await vi.waitFor(() => expect(stored(kv, A)).toBeDefined())
  })

  it('reads a track after the changes that were asked for before it: a track that comes back sees what was kept for it', async () => {
    const kv = memoryKv()
    const set = kv.set
    kv.set = async (key, value) => {
      await new Promise((resolve) => setTimeout(resolve, 200)) // the write is slow: still on its way when the track is asked for again
      return set(key, value)
    }
    const { service } = rig({ keep: 1 }, kv)
    await ready(service, A)
    service.add(A, 10, 600)
    await ready(service, B) // A is pushed out of memory while its write is still on its way
    expect(service.getState(A)).toEqual({ status: 'idle' })
    await ready(service, A)
    expect(bookmarksOf(service, A).map((b) => b.t)).toEqual([10])
  })
})

describe('ListeningService: backup', () => {
  it('collects the bookmarks of the tracks that have some, by library key, and leaves out the others', async () => {
    const { service, kv } = rig()
    kv.data.set(`listen:${A}`, { v: 1, at: 1, bookmarks: [mark(10), mark(20)] })
    kv.data.set('listen:not-in-the-library|1|1', { v: 1, at: 1, bookmarks: [mark(5)] })
    expect(await service.collect([A, B])).toEqual({ [A]: [mark(10), mark(20)] })
  })

  it('collects a change that has been made and not yet kept, so a backup made at once is whole', async () => {
    const { service, kv } = rig()
    await ready(service, A)
    kv.fail.set = true // the disk refuses: the bookmark exists only on screen
    service.add(A, 15, 600)
    const found = await service.collect([A])
    expect(found[A]?.map((b) => b.t)).toEqual([15])
  })

  it('fails, rather than hand over a backup with bookmarks missing, when the database cannot be read', async () => {
    const { service, kv } = rig()
    kv.data.set(`listen:${A}`, { v: 1, at: 1, bookmarks: [mark(10)] })
    kv.fail.get = true
    await expect(service.collect([A])).rejects.toThrow(/could not be read/)
  })

  it('merges bookmarks from a backup into tracks that are not on screen, and keeps them', async () => {
    const { service, kv } = rig()
    kv.data.set(`listen:${A}`, { v: 1, at: 1, bookmarks: [mark(10)] })
    const result = await service.merge([
      { key: A, bookmarks: [{ t: 10.2, label: 'same place' }, { t: 40, label: 'New' }] },
      { key: B, bookmarks: [{ t: 5, label: 'Other track' }] },
    ])
    expect(result).toEqual({ added: 2, unreadable: 0 })
    expect((stored(kv, A) as { bookmarks: Bookmark[] }).bookmarks.map((b) => [b.t, b.label])).toEqual([[10, 'at 10'], [40, 'New']])
    expect((stored(kv, B) as { bookmarks: Bookmark[] }).bookmarks.map((b) => b.label)).toEqual(['Other track'])
  })

  it('shows merged bookmarks at once on the track that is on screen, and a change made after that does not lose them', async () => {
    const { service, kv } = rig()
    await ready(service, A)
    await service.merge([{ key: A, bookmarks: [{ t: 30, label: 'Restored' }] }])
    expect(bookmarksOf(service, A).map((b) => b.label)).toEqual(['Restored'])
    service.add(A, 60, 600)
    await vi.waitFor(() => expect((stored(kv, A) as { bookmarks: Bookmark[] }).bookmarks.map((b) => b.t)).toEqual([30, 60]))
  })

  it('does not push the track on screen out of memory by merging into many others', async () => {
    const { service } = rig({ keep: 2 })
    await ready(service, A)
    await service.merge(['k1', 'k2', 'k3', 'k4'].map((key) => ({ key, bookmarks: [{ t: 1, label: 'x' }] })))
    expect(service.getState(A).status).toBe('ready')
  })

  it('adds nothing the second time the same backup is merged', async () => {
    const { service } = rig()
    const entries = [{ key: A, bookmarks: [{ t: 12, label: 'One' }, { t: 90, label: 'Two' }] }]
    expect(await service.merge(entries)).toEqual({ added: 2, unreadable: 0 })
    expect(await service.merge(entries)).toEqual({ added: 0, unreadable: 0 })
  })

  it('reads a track that is asked for after a merge only once the merge is done, so it sees what was restored', async () => {
    const { service } = rig()
    const merging = service.merge([{ key: A, bookmarks: [{ t: 12, label: 'Restored' }] }])
    service.want({ key: A })
    await merging
    await ready(service, A)
    expect(bookmarksOf(service, A).map((b) => b.label)).toEqual(['Restored'])
  })

  it('counts a track whose record could not be read, leaves that record alone, and goes on with the others', async () => {
    const { service, kv } = rig()
    kv.data.set(`listen:${A}`, { v: 1, at: 1, bookmarks: [mark(10)] })
    kv.fail.get = true
    expect(await service.merge([{ key: A, bookmarks: [{ t: 40, label: 'x' }] }])).toEqual({ added: 0, unreadable: 1 })
    kv.fail.get = false
    expect(stored(kv, A)).toEqual({ v: 1, at: 1, bookmarks: [mark(10)] })
    expect(await service.merge([{ key: B, bookmarks: [{ t: 1, label: 'fine' }] }])).toEqual({ added: 1, unreadable: 0 })
  })

  it('has nothing to do for a track the backup holds no bookmarks for, and does not read it', async () => {
    const kv = memoryKv()
    const get = vi.spyOn(kv, 'get')
    const { service } = rig({}, kv)
    expect(await service.merge([{ key: A, bookmarks: [] }])).toEqual({ added: 0, unreadable: 0 })
    expect(get).not.toHaveBeenCalled()
  })
})
