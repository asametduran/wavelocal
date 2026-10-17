// @vitest-environment node
import { describe, expect, it } from 'vitest'
import type { Progress } from './progress'
import { HEARD_PREFIX, deleteProgress, heardKey, loadAllProgress, saveProgress } from './progressstore'
import { memoryKv } from '../../test-utils/memorykv'

const KEY = 'The Book.mp3|48211|1760000000000'
const record = (over: Partial<Progress> = {}): Progress => ({ v: 1, at: 5000, t: 1234.5, speed: 1.5, mode: 'auto', ...over })

describe('heardKey', () => {
  it('puts the key of a track under the heard: prefix', () => {
    expect(HEARD_PREFIX).toBe('heard:')
    expect(heardKey(KEY)).toBe(`heard:${KEY}`)
  })
})

describe('saveProgress and loadAllProgress', () => {
  it('keep a record under the track key and give it back', async () => {
    const kv = memoryKv()
    expect(await saveProgress(kv, KEY, record())).toBe(true)
    expect(kv.data.get(`heard:${KEY}`)).toEqual(record())
    const all = await loadAllProgress(kv)
    expect(all?.get(KEY)).toEqual(record())
  })

  it('keep nothing for a record with nothing to remember: the record is deleted', async () => {
    const kv = memoryKv({ [`heard:${KEY}`]: record() })
    expect(await saveProgress(kv, KEY, record({ t: null, speed: null, mode: 'auto' }))).toBe(true)
    expect(kv.data.has(`heard:${KEY}`)).toBe(false)
  })

  it('keep a record that holds only a choice, or only a speed, or only a place', async () => {
    const kv = memoryKv()
    await saveProgress(kv, 'a|1|1', record({ t: null, speed: null, mode: 'never' }))
    await saveProgress(kv, 'b|1|1', record({ t: null, speed: 1.25, mode: 'auto' }))
    await saveProgress(kv, 'c|1|1', record({ t: 99, speed: null, mode: 'auto' }))
    expect([...(await loadAllProgress(kv))?.keys() ?? []].sort()).toEqual(['a|1|1', 'b|1|1', 'c|1|1'])
  })

  it('say that a record could not be kept when the disk does not take it, and do not throw', async () => {
    const kv = memoryKv()
    kv.fail.set = true
    expect(await saveProgress(kv, KEY, record())).toBe(false)
  })

  it('load every record at once, and nothing else in the database', async () => {
    const kv = memoryKv({ 'listen:x|1|1': { v: 1, at: 1, bookmarks: [] }, 'chapters:t1': { v: 1, chapters: [] }, order: [] })
    await saveProgress(kv, 'a|1|1', record())
    await saveProgress(kv, 'b|2|2', record({ t: 7 }))
    const all = await loadAllProgress(kv)
    expect([...(all?.keys() ?? [])].sort()).toEqual(['a|1|1', 'b|2|2'])
  })

  it('load an empty database as no records, not as a failure', async () => {
    const all = await loadAllProgress(memoryKv())
    expect(all).not.toBeNull()
    expect(all?.size).toBe(0)
  })

  it('skip a record that is not what this version writes, and mend one that is damaged in places', async () => {
    const kv = memoryKv({ 'heard:junk|1|1': 'nonsense', 'heard:old|1|1': { v: 2, t: 5 }, 'heard:half|1|1': { v: 1, at: 'x', t: 40, speed: 7, mode: 'odd' } })
    const all = await loadAllProgress(kv)
    expect([...(all?.keys() ?? [])]).toEqual(['half|1|1'])
    expect(all?.get('half|1|1')).toEqual({ v: 1, at: 0, t: 40, speed: null, mode: 'auto' })
  })

  it('say that nothing is known (null) when a record cannot be read, so nobody writes over what could not be seen', async () => {
    const kv = memoryKv({ [`heard:${KEY}`]: record() })
    kv.fail.get = true
    expect(await loadAllProgress(kv)).toBeNull()
  })
})

describe('deleteProgress', () => {
  it('forgets a record, and has no complaint about one that is not there', async () => {
    const kv = memoryKv({ [`heard:${KEY}`]: record() })
    expect(await deleteProgress(kv, KEY)).toBe(true)
    expect(kv.data.has(`heard:${KEY}`)).toBe(false)
    expect(await deleteProgress(kv, KEY)).toBe(true)
  })
})
