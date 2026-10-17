import { AudioDecodeError } from '../audio/pcm'
import type { WorkerRequest, WorkerResponse } from '../audio/decode.worker'
import type { Peaks } from './types'

/**
 * The page's end of the waveform worker: sends it a WAV or FLAC file, matches the answer to the job, forwards a
 * cancellation, and lets the worker (a thread and the memory of the file it was reading) go after a quiet spell. It is a
 * second instance of the decode worker on purpose, so measuring a waveform never queues behind a FLAC being converted for
 * playback.
 */

/** The part of `Worker` this uses, so the behaviour is tested with a stand-in. */
export interface WorkerLike {
  postMessage(message: WorkerRequest): void
  terminate(): void
  onmessage: ((event: { data: WorkerResponse }) => void) | null
  onerror: ((event: { message?: string }) => void) | null
}

export interface PeaksWorker {
  measure(file: Blob, signal: AbortSignal): Promise<Peaks>
}

interface Job {
  resolve: (peaks: Peaks) => void
  reject: (error: unknown) => void
}

const cancelled = (): AudioDecodeError => new AudioDecodeError('Measuring the waveform was cancelled', 'aborted')

export function createPeaksWorker(make: () => WorkerLike, idleMs = 30_000): PeaksWorker {
  let worker: WorkerLike | null = null
  let idle: ReturnType<typeof setTimeout> | undefined
  let next = 1
  const jobs = new Map<number, Job>()

  const stop = (): void => {
    worker?.terminate()
    worker = null
  }
  const failAll = (error: unknown): void => {
    for (const job of jobs.values()) job.reject(error)
    jobs.clear()
  }
  const rest = (): void => {
    clearTimeout(idle)
    if (jobs.size === 0) idle = setTimeout(stop, idleMs)
  }

  function start(): WorkerLike {
    if (worker) return worker
    const created = make()
    created.onmessage = ({ data }) => {
      if (data.type !== 'peaks-done' && data.type !== 'error') return
      const job = jobs.get(data.id)
      if (!job) return // cancelled while the answer was on its way
      jobs.delete(data.id)
      if (data.type === 'peaks-done') job.resolve(data.peaks)
      else job.reject(data.code === 'failed' ? new Error(data.message) : new AudioDecodeError(data.message, data.code))
      rest()
    }
    created.onerror = (event) => {
      failAll(new Error(event.message || 'The waveform worker stopped'))
      stop()
    }
    worker = created
    return created
  }

  return {
    measure(file, signal) {
      if (signal.aborted) return Promise.reject(cancelled())
      const target = start()
      clearTimeout(idle)
      const id = next++
      return new Promise<Peaks>((resolve, reject) => {
        jobs.set(id, { resolve, reject })
        signal.addEventListener(
          'abort',
          () => {
            if (!jobs.delete(id)) return
            target.postMessage({ type: 'cancel', id })
            reject(cancelled())
            rest()
          },
          { once: true },
        )
        target.postMessage({ type: 'peaks', id, file })
      })
    },
  }
}
