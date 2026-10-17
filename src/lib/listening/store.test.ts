// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { MAX_BOOKMARKS } from './bookmarks'
import { LISTEN_PREFIX, listenKey, loadBookmarks, readListenRecord, saveBookmarks } from './store'
import type { Bookmark } from './types'
import { memoryKv } from '../../test-utils/memorykv'

const KEY = 'Lecture 1.mp3|48211|1760000000000'
const mark = (t: number, label = `at ${t}`, id = `id${t}`, at = 1000): Bookmark => ({ id, t, label, at })
const ids = () => {
  let n = 0
  return () => `gen${++n}`
}

describe('listenKey', () => {
  it('puts the key of a track under the listen: prefix, whatever characters the key holds', () => {
    expect(LISTEN_PREFIX).toBe('listen:')
    expect(listenKey(KEY)).toBe(`listen:${KEY}`)
    expect(listenKey('名前|1|2')).toBe('listen:名前|1|2')
  })
})

describe('saveBookmarks and loadBookmarks', () => {
  it('keep the list under the track key, with the date of the change, and give the same list back', async () => {
    const kv = memoryKv()
    const list = [mark(10), mark(95.5, 'Second part')]
    expect(await saveBookmarks(kv, KEY, list, 5000)).toBe(true)
    expect(kv.data.get(`listen:${KEY}`)).toEqual({ v: 1, at: 5000, bookmarks: list })
    expect(await loadBookmarks(kv, KEY, ids())).toEqual(list)
  })

  it('know nothing about a track that has no record: that is an empty list, not a failure', async () => {
    expect(await loadBookmarks(memoryKv(), KEY, ids())).toEqual([])
  })

  it('keep one list for each track, and leave the other records of the database alone', async () => {
    const kv = memoryKv({ 'chapters:t1': { v: 1, chapters: [] }, order: ['t1'] })
    await saveBookmarks(kv, 'a|1|1', [mark(1)], 1)
    await saveBookmarks(kv, 'b|2|2', [mark(2), mark(3)], 1)
    expect(await loadBookmarks(kv, 'a|1|1', ids())).toEqual([mark(1)])
    expect(await loadBookmarks(kv, 'b|2|2', ids())).toEqual([mark(2), mark(3)])
    expect([...kv.data.keys()].sort()).toEqual(['chapters:t1', 'listen:a|1|1', 'listen:b|2|2', 'order'])
  })

  it('keep nothing for an empty list: the record is deleted, so a track without bookmarks takes no room', async () => {
    const kv = memoryKv({ [`listen:${KEY}`]: { v: 1, at: 1, bookmarks: [mark(1)] } })
    expect(await saveBookmarks(kv, KEY, [], 9)).toBe(true)
    expect(kv.data.has(`listen:${KEY}`)).toBe(false)
    expect(await saveBookmarks(kv, KEY, [], 10)).toBe(true) // nothing there to delete is no problem
  })

  it('say that a change could not be kept when the disk does not take it, and do not throw', async () => {
    const kv = memoryKv()
    kv.fail.set = true
    expect(await saveBookmarks(kv, KEY, [mark(1)], 1)).toBe(false)
    expect(kv.data.size).toBe(0)
  })

  it('say that nothing is known (null, not an empty list) when the record cannot be read, so nobody writes over it', async () => {
    const kv = memoryKv({ [`listen:${KEY}`]: { v: 1, at: 1, bookmarks: [mark(1)] } })
    kv.fail.get = true
    expect(await loadBookmarks(kv, KEY, ids())).toBeNull()
  })

  it('do not hand out the object that is stored: changing the list read back does not change the database', async () => {
    const kv = memoryKv()
    const list = [mark(1)]
    await saveBookmarks(kv, KEY, list, 1)
    list.push(mark(2)) // the caller goes on using its own list
    const read = await loadBookmarks(kv, KEY, ids())
    read?.push(mark(3))
    expect(await loadBookmarks(kv, KEY, ids())).toEqual([mark(1)])
  })
})

describe('readListenRecord', () => {
  it('reads the bookmarks of a record this version wrote', () => {
    expect(readListenRecord({ v: 1, at: 7, bookmarks: [mark(3), mark(1)] }, ids())).toEqual([mark(1), mark(3)])
  })

  it('reads anything that is not such a record as no bookmarks: it is mended by the next change, never trusted', () => {
    const damaged: unknown[] = [undefined, null, 'nonsense', 5, [], { v: 1 }, { v: 1, bookmarks: 'x' }, { v: 1, bookmarks: {} }, { v: 2, at: 1, bookmarks: [mark(1)] }, { bookmarks: [mark(1)] }]
    for (const value of damaged) expect(readListenRecord(value, ids()), JSON.stringify(value)).toEqual([])
  })

  it('keeps the bookmarks of a record that is damaged in places, and skips what is not a bookmark', () => {
    const record = { v: 1, at: 'yesterday', bookmarks: [null, 4, { t: 'x' }, { t: -1, label: 'before' }, mark(20), { t: 30, label: 'no id or date' }] }
    expect(readListenRecord(record, ids())).toEqual([mark(20), { id: 'gen1', t: 30, label: 'no id or date', at: 0 }])
  })

  it('holds a hostile record to the rules of a list: ordered, no two at one place, no repeated id, at most what a track can hold, only known fields', () => {
    const many = Array.from({ length: MAX_BOOKMARKS + 30 }, (_, i) => mark(1000 - i * 2, `m${i}`, `m${i}`))
    const read = readListenRecord({ v: 1, at: 1, bookmarks: [...many, mark(1000.1, 'twin'), { ...mark(5, 'x', 'y'), polluted: true }] }, ids())
    expect(read).toHaveLength(MAX_BOOKMARKS)
    expect(read.map((b) => b.t)).toEqual([...read.map((b) => b.t)].sort((a, b) => a - b))
    expect(new Set(read.map((b) => b.id)).size).toBe(read.length)
    expect(read.every((b) => Object.keys(b).sort().join() === 'at,id,label,t')).toBe(true)
  })
})
