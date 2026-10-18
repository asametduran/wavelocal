// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ChaptersService } from './service'
import type { ChaptersDeps, ChaptersState, ChaptersTarget } from './service'
import type { Chapter } from './types'
import { memoryKv } from '../../test-utils/memorykv'

// what the service hands to the error log when a file's chapters cannot be read
const mocks = vi.hoisted(() => ({ note: vi.fn() }))
vi.mock('../diagnostics/capture', () => ({ note: (kind: string) => (error: unknown) => mocks.note(kind, error) }))
beforeEach(() => mocks.note.mockReset())

const book: Chapter[] = [
  { start: 0, end: 10, title: 'A' },
  { start: 10, end: 30, title: 'B' },
]
const target = (id: string): ChaptersTarget => ({ id, file: new Blob(['x']), duration: 30 })

function rig(overrides: Partial<ChaptersDeps> = {}) {
  const kv = memoryKv()
  const read = vi.fn(async () => book)
  const service = new ChaptersService({ kv, read, ...overrides })
  return { service, kv, read }
}

const status = (service: ChaptersService, id: string): ChaptersState['status'] => service.getState(id).status
const settled = (service: ChaptersService, id: string) => vi.waitFor(() => expect(['ready', 'error']).toContain(status(service, id)))

describe('ChaptersService', () => {
  it('shows the chapters from the cache and never reads the file', async () => {
    const { service, kv, read } = rig()
    kv.data.set('chapters:t1', { v: 1, chapters: book })
    service.want(target('t1'))
    await settled(service, 't1')
    expect(service.getState('t1')).toEqual({ status: 'ready', chapters: book })
    expect(read).not.toHaveBeenCalled()
  })

  it('reads the file for a track not seen before, and keeps what it found', async () => {
    const { service, kv, read } = rig()
    service.want(target('t1'))
    expect(status(service, 't1')).toBe('loading')
    await settled(service, 't1')
    expect(read).toHaveBeenCalledTimes(1)
    expect(service.getState('t1')).toEqual({ status: 'ready', chapters: book })
    expect(kv.data.get('chapters:t1')).toEqual({ v: 1, chapters: book })
  })

  it('keeps "there are none" as an answer: a book without chapters is read once, ever', async () => {
    const empty = rig({ read: vi.fn(async () => []) })
    empty.service.want(target('t1'))
    await settled(empty.service, 't1')
    expect(empty.service.getState('t1')).toEqual({ status: 'ready', chapters: [] })
    const later = new ChaptersService({ kv: empty.kv, read: vi.fn(async () => book) })
    later.want(target('t1'))
    await settled(later, 't1')
    expect(later.getState('t1')).toEqual({ status: 'ready', chapters: [] })
  })

  it('reads a damaged record again instead of trusting it', async () => {
    const { service, kv, read } = rig()
    kv.data.set('chapters:t1', { v: 1, chapters: [{ start: 5, end: 1, title: 'backwards' }] })
    service.want(target('t1'))
    await settled(service, 't1')
    expect(read).toHaveBeenCalledTimes(1)
  })

  it('shows the chapters even if keeping them fails, and reads the file if the cache cannot be read', async () => {
    const { service, kv, read } = rig()
    kv.fail.set = true
    kv.fail.get = true
    service.want(target('t1'))
    await settled(service, 't1')
    expect(service.getState('t1')).toEqual({ status: 'ready', chapters: book })
    expect(read).toHaveBeenCalledTimes(1)
  })

  it('reads a track once, however many times it is asked for, while it is being read and after', async () => {
    let finish: (chapters: Chapter[]) => void = () => {}
    const read = vi.fn(() => new Promise<Chapter[]>((resolve) => (finish = resolve)))
    const { service } = rig({ read })
    service.want(target('t1'))
    service.want(target('t1'))
    await vi.waitFor(() => expect(read).toHaveBeenCalledTimes(1))
    service.want(target('t1'))
    finish(book)
    await settled(service, 't1')
    service.want(target('t1'))
    expect(read).toHaveBeenCalledTimes(1)
  })

  it('keeps going for the track that was left behind, so coming back to it finds the chapters', async () => {
    let finishA: (chapters: Chapter[]) => void = () => {}
    const read = vi.fn((t: ChaptersTarget) => (t.id === 'a' ? new Promise<Chapter[]>((resolve) => (finishA = resolve)) : Promise.resolve(book)))
    const { service } = rig({ read })
    service.want(target('a'))
    service.want(target('b'))
    await settled(service, 'b')
    finishA([{ start: 0, end: 5, title: 'Only A' }])
    await settled(service, 'a')
    expect(service.getState('a')).toEqual({ status: 'ready', chapters: [{ start: 0, end: 5, title: 'Only A' }] })
  })

  it('says "error" when the file cannot be read, keeps nothing, and does not try again this session', async () => {
    const read = vi.fn().mockRejectedValue(new Error('gone'))
    const { service, kv } = rig({ read })
    service.want(target('t1'))
    await settled(service, 't1')
    expect(status(service, 't1')).toBe('error')
    expect(kv.data.has('chapters:t1')).toBe(false)
    service.want(target('t1'))
    await new Promise((resolve) => setTimeout(resolve, 5))
    expect(read).toHaveBeenCalledTimes(1)
    expect(mocks.note.mock.calls).toEqual([['decode', new Error('gone')]]) // reported once, with the other attempt that never happened
  })

  it('reports nothing for a book that is read, and nothing for one without chapters', async () => {
    const { service } = rig({ read: vi.fn(async () => []) })
    service.want(target('t1'))
    await settled(service, 't1')
    expect(status(service, 't1')).toBe('ready')
    expect(mocks.note).not.toHaveBeenCalled()
  })

  it('tells those who listen when a state changes, and nobody who stopped, and hands out one object until it does', async () => {
    const { service } = rig()
    const heard = vi.fn()
    const stopped = vi.fn()
    service.subscribe(heard)
    service.subscribe(stopped)()
    service.want(target('t1'))
    await settled(service, 't1')
    expect(heard.mock.calls.length).toBeGreaterThanOrEqual(2)
    expect(stopped).not.toHaveBeenCalled()
    expect(service.getState('t1')).toBe(service.getState('t1'))
    expect(service.getState('x')).toBe(service.getState('y'))
  })

  it('has nothing to do when nothing is playing', () => {
    const { service, read } = rig()
    expect(() => service.want(null)).not.toThrow()
    expect(read).not.toHaveBeenCalled()
  })

  it('keeps the chapters of the latest few tracks in memory; the older ones come back from the cache', async () => {
    const { service, kv } = rig({ keep: 3 })
    for (let i = 0; i < 6; i++) kv.data.set(`chapters:t${i}`, { v: 1, chapters: book })
    for (let i = 0; i < 6; i++) {
      service.want(target(`t${i}`))
      await settled(service, `t${i}`)
    }
    expect(status(service, 't0')).toBe('idle')
    expect(status(service, 't5')).toBe('ready')
  })
})
