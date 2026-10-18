// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { PeaksService } from './service'
import type { PeaksDeps, PeaksState, PeaksTarget } from './service'
import type { Peaks, PeaksRecord } from './types'
import { AudioDecodeError } from '../audio/pcm'
import { memoryKv } from '../../test-utils/memorykv'

// what the service hands to the error log: a failure that is the file's or the browser's, not a cancellation or a stored reason
const mocks = vi.hoisted(() => ({ note: vi.fn() }))
vi.mock('../diagnostics/capture', () => ({ note: (kind: string) => (error: unknown) => mocks.note(kind, error) }))
beforeEach(() => mocks.note.mockReset())

const peaks = (seed = 1): Peaks => ({ v: 1, duration: 10, length: 3, peak: Uint8Array.of(seed, 2, 3), rms: Uint8Array.of(1, 1, 1) })
const target = (id: string): PeaksTarget => ({ id, file: new Blob(['x']), duration: 10 })

/** A promise the test settles by hand, to hold a measurement half way. */
function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

function rig(overrides: Partial<PeaksDeps> = {}) {
  const kv = memoryKv()
  const measured: { id: string; signal: AbortSignal }[] = []
  const waits: number[] = []
  const deps: PeaksDeps = {
    kv,
    measure: async (t, signal) => {
      measured.push({ id: t.id, signal })
      return peaks()
    },
    wait: async (ms) => {
      waits.push(ms)
    },
    ...overrides,
  }
  return { service: new PeaksService(deps), kv, measured, waits }
}

const status = (service: PeaksService, id: string): PeaksState['status'] => service.getState(id).status
const settled = (service: PeaksService, id: string) => vi.waitFor(() => expect(['ready', 'none', 'error']).toContain(status(service, id)))

describe('a track with a stored waveform', () => {
  it('is shown from the cache and never measured', async () => {
    const { service, kv, measured, waits } = rig()
    kv.data.set('peaks:t1', peaks(9))
    service.want(target('t1'))
    await settled(service, 't1')
    expect(service.getState('t1')).toEqual({ status: 'ready', peaks: peaks(9) })
    expect(measured).toEqual([])
    expect(waits).toEqual([])
  })

  it('is not the answer of a record this version does not understand: it is measured again', async () => {
    const { service, kv, measured } = rig()
    kv.data.set('peaks:t1', { ...peaks(), v: 2 })
    service.want(target('t1'))
    await settled(service, 't1')
    expect(measured).toHaveLength(1)
  })
})

describe('a track without one', () => {
  it('is measured after a pause, so start-up and the first seconds of playback are left alone, and the result is kept', async () => {
    const { service, kv, measured, waits } = rig()
    service.want(target('t1'))
    expect(status(service, 't1')).toBe('loading')
    await settled(service, 't1')
    expect(waits).toEqual([1000])
    expect(measured.map((m) => m.id)).toEqual(['t1'])
    expect(service.getState('t1')).toMatchObject({ status: 'ready' })
    expect(kv.data.get('peaks:t1')).toEqual(peaks())
  })

  it('is shown even if keeping the result fails (the disk is full): a waveform is only a cache', async () => {
    const { service, kv } = rig()
    kv.fail.set = true
    service.want(target('t1'))
    await settled(service, 't1')
    expect(status(service, 't1')).toBe('ready')
  })

  it('is measured when the cache cannot be read', async () => {
    const { service, kv, measured } = rig()
    kv.fail.get = true
    service.want(target('t1'))
    await settled(service, 't1')
    expect(measured).toHaveLength(1)
    expect(status(service, 't1')).toBe('ready')
  })

  it('is measured once, however many times it is asked for', async () => {
    const hold = deferred<PeaksRecord>()
    const measured: { id: string; signal: AbortSignal }[] = []
    const { service } = rig({ measure: async (t, signal) => (measured.push({ id: t.id, signal }), hold.promise) })
    service.want(target('t1'))
    service.want(target('t1'))
    await vi.waitFor(() => expect(measured).toHaveLength(1))
    service.want(target('t1'))
    hold.resolve(peaks())
    await settled(service, 't1')
    service.want(target('t1'))
    expect(measured).toHaveLength(1)
  })

  it('tells everyone who listens when it changes, and nobody who stopped', async () => {
    const { service } = rig()
    const heard = vi.fn()
    const stopped = vi.fn()
    service.subscribe(heard)
    service.subscribe(stopped)()
    service.want(target('t1'))
    await settled(service, 't1')
    expect(heard.mock.calls.length).toBeGreaterThanOrEqual(2) // loading, then ready
    expect(stopped).not.toHaveBeenCalled()
  })

  it('hands out the same state object until something changes, as a store read by React must', async () => {
    const { service } = rig()
    service.want(target('t1'))
    await settled(service, 't1')
    expect(service.getState('t1')).toBe(service.getState('t1'))
    expect(service.getState('never-asked')).toBe(service.getState('also-never'))
  })
})

describe('when another track becomes current', () => {
  it('drops the measurement of the one before, and what it finds later is neither shown nor kept', async () => {
    const holdA = deferred<PeaksRecord>()
    const seen: { id: string; signal: AbortSignal }[] = []
    const { service, kv } = rig({
      measure: async (t, signal) => {
        seen.push({ id: t.id, signal })
        return t.id === 'a' ? holdA.promise : peaks(7)
      },
    })
    service.want(target('a'))
    await vi.waitFor(() => expect(seen).toHaveLength(1))
    service.want(target('b'))
    expect(seen[0]?.signal.aborted).toBe(true)
    expect(status(service, 'a')).toBe('idle')
    await settled(service, 'b')
    holdA.resolve(peaks(5)) // too late
    await new Promise((resolve) => setTimeout(resolve, 5))
    expect(status(service, 'a')).toBe('idle')
    expect(kv.data.has('peaks:a')).toBe(false)
    expect(kv.data.has('peaks:b')).toBe(true)
  })

  it('does not wait out the pause for a track that has already gone', async () => {
    // the pause never ends by itself: it only ends because the job was cancelled
    const { service, measured } = rig({ wait: (_ms, signal) => new Promise<void>((_, reject) => signal.addEventListener('abort', () => reject(new AudioDecodeError('stopped', 'aborted')))) })
    service.want(target('a'))
    service.want(target('b'))
    await new Promise((resolve) => setTimeout(resolve, 5))
    expect(measured).toEqual([])
    expect(status(service, 'a')).toBe('idle')
  })

  it('stops measuring when nothing is playing any more', async () => {
    const hold = deferred<PeaksRecord>()
    const seen: AbortSignal[] = []
    const { service } = rig({ measure: async (_t, signal) => (seen.push(signal), hold.promise) })
    service.want(target('a'))
    await vi.waitFor(() => expect(seen).toHaveLength(1))
    service.want(null)
    expect(seen[0]?.aborted).toBe(true)
  })

  it('measures it again if the listener comes back to it', async () => {
    const hold = deferred<PeaksRecord>()
    const measured: { id: string; signal: AbortSignal }[] = []
    const { service } = rig({
      measure: async (t, signal) => {
        measured.push({ id: t.id, signal })
        return t.id === 'a' && measured.length === 1 ? hold.promise : peaks()
      },
    })
    service.want(target('a'))
    await vi.waitFor(() => expect(measured).toHaveLength(1))
    service.want(target('b'))
    await settled(service, 'b')
    service.want(target('a'))
    await settled(service, 'a')
    expect(measured.filter((m) => m.id === 'a')).toHaveLength(2)
  })
})

describe('when a track cannot be measured', () => {
  it('keeps the reason for a file the browser cannot decode, so it is not tried on every play', async () => {
    const first = rig({ measure: async () => Promise.reject(new AudioDecodeError('no', 'unsupported')) })
    first.service.want(target('t1'))
    await settled(first.service, 't1')
    expect(first.service.getState('t1')).toEqual({ status: 'none', why: 'unsupported' })
    expect(first.kv.data.get('peaks:t1')).toEqual({ v: 1, none: 'unsupported' })
    expect(mocks.note).not.toHaveBeenCalled() // a format the browser does not decode is an answer, not a failure

    // a later visit finds the stored reason and does not measure
    const measure = vi.fn()
    const later = new PeaksService({ kv: first.kv, measure, wait: async () => {} })
    later.want(target('t1'))
    await settled(later, 't1')
    expect(later.getState('t1')).toEqual({ status: 'none', why: 'unsupported' })
    expect(measure).not.toHaveBeenCalled()
  })

  it('keeps the planner’s verdict that a file is too long', async () => {
    const { service, kv } = rig({ measure: async () => ({ v: 1, none: 'too-long' }) })
    service.want(target('t1'))
    await settled(service, 't1')
    expect(service.getState('t1')).toEqual({ status: 'none', why: 'too-long' })
    expect(kv.data.get('peaks:t1')).toEqual({ v: 1, none: 'too-long' })
  })

  it('shows an error and keeps nothing for a failure that may pass, and does not try again this session', async () => {
    const measure = vi.fn().mockRejectedValue(new Error('out of memory'))
    const { service, kv } = rig({ measure })
    service.want(target('t1'))
    await settled(service, 't1')
    expect(status(service, 't1')).toBe('error')
    expect(kv.data.has('peaks:t1')).toBe(false)
    service.want(target('t1'))
    await new Promise((resolve) => setTimeout(resolve, 5))
    expect(measure).toHaveBeenCalledTimes(1)
  })

  it('hands a failure that may pass to the error log, once, as the worker failing', async () => {
    const failure = new Error('out of memory')
    const { service } = rig({ measure: vi.fn().mockRejectedValue(failure) })
    service.want(target('t1'))
    await settled(service, 't1')
    service.want(target('t1')) // not tried again, so not reported again
    await new Promise((resolve) => setTimeout(resolve, 5))
    expect(mocks.note.mock.calls).toEqual([['worker', failure]])
  })

  it('is not an error when the measurement itself was cancelled: the track is simply not measured yet', async () => {
    const { service } = rig({ measure: async () => Promise.reject(new AudioDecodeError('cancelled', 'aborted')) })
    service.want(target('t1'))
    await new Promise((resolve) => setTimeout(resolve, 10))
    expect(status(service, 't1')).toBe('idle')
    expect(mocks.note).not.toHaveBeenCalled() // and not a failure for the log either
  })
})

describe('memory', () => {
  it('keeps the waveforms of the latest few tracks and lets the older ones go (they come back from the cache)', async () => {
    const { service, kv } = rig({ keep: 3 })
    for (let i = 0; i < 6; i++) kv.data.set(`peaks:t${i}`, peaks(i + 1))
    for (let i = 0; i < 6; i++) {
      service.want(target(`t${i}`))
      await settled(service, `t${i}`)
    }
    expect(status(service, 't0')).toBe('idle')
    expect(status(service, 't2')).toBe('idle')
    expect(status(service, 't3')).toBe('ready')
    expect(status(service, 't5')).toBe('ready')
  })
})
