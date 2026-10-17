// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createPeaksWorker } from './client'
import type { WorkerLike } from './client'
import type { Peaks } from './types'
import type { WorkerRequest, WorkerResponse } from '../audio/decode.worker'

const PEAKS: Peaks = { v: 1, duration: 3, length: 2, peak: Uint8Array.of(10, 20), rms: Uint8Array.of(5, 6) }

/** A stand-in for the module worker that records what it is sent and answers when the test says so. */
class FakeWorker implements WorkerLike {
  static made: FakeWorker[] = []
  sent: WorkerRequest[] = []
  terminated = false
  onmessage: ((event: { data: WorkerResponse }) => void) | null = null
  onerror: ((event: { message?: string }) => void) | null = null
  constructor() {
    FakeWorker.made.push(this)
  }
  postMessage(message: WorkerRequest): void {
    this.sent.push(message)
  }
  terminate(): void {
    this.terminated = true
  }
  reply(message: WorkerResponse): void {
    this.onmessage?.({ data: message })
  }
}

const file = new Blob(['x'])
afterEach(() => {
  FakeWorker.made = []
  vi.useRealTimers()
})

describe('createPeaksWorker', () => {
  it('starts the worker on the first job, not before, and sends it the file', () => {
    const worker = createPeaksWorker(() => new FakeWorker())
    expect(FakeWorker.made).toHaveLength(0)
    void worker.measure(file, new AbortController().signal).catch(() => {})
    expect(FakeWorker.made).toHaveLength(1)
    expect(FakeWorker.made[0]?.sent).toEqual([{ type: 'peaks', id: 1, file }])
  })

  it('resolves with the peaks the worker finds, for the job they belong to', async () => {
    const worker = createPeaksWorker(() => new FakeWorker())
    const first = worker.measure(file, new AbortController().signal)
    const second = worker.measure(file, new AbortController().signal)
    const fake = FakeWorker.made[0]
    fake?.reply({ type: 'peaks-done', id: 2, peaks: { ...PEAKS, duration: 99 } })
    fake?.reply({ type: 'peaks-done', id: 1, peaks: PEAKS })
    expect((await first).duration).toBe(3)
    expect((await second).duration).toBe(99)
    expect(FakeWorker.made).toHaveLength(1) // one worker for both
  })

  it('rejects with the worker’s own reason when it cannot measure the file', async () => {
    const worker = createPeaksWorker(() => new FakeWorker())
    const job = worker.measure(file, new AbortController().signal)
    FakeWorker.made[0]?.reply({ type: 'error', id: 1, code: 'unsupported', message: 'Not a WAV or FLAC file' })
    await expect(job).rejects.toMatchObject({ name: 'AudioDecodeError', code: 'unsupported', message: 'Not a WAV or FLAC file' })
  })

  it('maps a failure it has no name for to a plain error, not to a reason the cache would keep for ever', async () => {
    const worker = createPeaksWorker(() => new FakeWorker())
    const job = worker.measure(file, new AbortController().signal)
    FakeWorker.made[0]?.reply({ type: 'error', id: 1, code: 'failed', message: 'boom' })
    await expect(job).rejects.not.toMatchObject({ code: 'unsupported' })
    await expect(job).rejects.toThrow('boom')
  })

  it('cancels the job in the worker and rejects with "aborted" when the signal fires', async () => {
    const worker = createPeaksWorker(() => new FakeWorker())
    const controller = new AbortController()
    const job = worker.measure(file, controller.signal)
    controller.abort()
    await expect(job).rejects.toMatchObject({ code: 'aborted' })
    expect(FakeWorker.made[0]?.sent.at(-1)).toEqual({ type: 'cancel', id: 1 })
  })

  it('does not even start the worker for a job that is already cancelled', async () => {
    const worker = createPeaksWorker(() => new FakeWorker())
    const controller = new AbortController()
    controller.abort()
    await expect(worker.measure(file, controller.signal)).rejects.toMatchObject({ code: 'aborted' })
    expect(FakeWorker.made).toHaveLength(0)
  })

  it('ignores a late answer for a job that was cancelled', async () => {
    const worker = createPeaksWorker(() => new FakeWorker())
    const controller = new AbortController()
    const job = worker.measure(file, controller.signal)
    controller.abort()
    await expect(job).rejects.toMatchObject({ code: 'aborted' })
    expect(() => FakeWorker.made[0]?.reply({ type: 'peaks-done', id: 1, peaks: PEAKS })).not.toThrow()
  })

  it('fails every job that is waiting when the worker itself breaks, and starts a new worker for the next one', async () => {
    const worker = createPeaksWorker(() => new FakeWorker())
    const job = worker.measure(file, new AbortController().signal)
    FakeWorker.made[0]?.onerror?.({ message: 'script error' })
    await expect(job).rejects.toThrow()
    expect(FakeWorker.made[0]?.terminated).toBe(true)
    void worker.measure(file, new AbortController().signal).catch(() => {})
    expect(FakeWorker.made).toHaveLength(2)
  })

  it('lets the worker go after a quiet spell, so an idle tab does not keep a thread and its memory', async () => {
    vi.useFakeTimers()
    const worker = createPeaksWorker(() => new FakeWorker(), 30_000)
    const job = worker.measure(file, new AbortController().signal)
    FakeWorker.made[0]?.reply({ type: 'peaks-done', id: 1, peaks: PEAKS })
    await job
    expect(FakeWorker.made[0]?.terminated).toBe(false)
    vi.advanceTimersByTime(29_999)
    expect(FakeWorker.made[0]?.terminated).toBe(false)
    vi.advanceTimersByTime(2)
    expect(FakeWorker.made[0]?.terminated).toBe(true)
  })

  it('keeps the worker while a job is still running, however long it takes', async () => {
    vi.useFakeTimers()
    const worker = createPeaksWorker(() => new FakeWorker(), 30_000)
    void worker.measure(file, new AbortController().signal).catch(() => {})
    vi.advanceTimersByTime(10 * 60_000)
    expect(FakeWorker.made[0]?.terminated).toBe(false)
  })
})
