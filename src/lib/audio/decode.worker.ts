import { convertToWav } from './convert'
import type { ConvertResult } from './convert'
import { AudioDecodeError } from './pcm'
import { peaksFromLossless } from '../waveform/lossless'
import type { Peaks } from '../waveform/types'

/**
 * Runs `convertToWav` off the main thread so decoding a long FLAC never freezes the interface, and measures the waveform of
 * a WAV or FLAC file the same way (`waveform/client.ts` keeps a second instance of this worker for that, so a waveform never
 * queues behind a conversion that playback is waiting for).
 * Protocol: the page posts { type: 'convert', id, file }, { type: 'peaks', id, file } or { type: 'cancel', id }; the worker
 * answers with { type: 'progress', id, fraction } and then { type: 'done', id, result } (convert) or
 * { type: 'peaks-done', id, peaks }, or { type: 'error', id, code, message }.
 */

export type WorkerRequest =
  | { type: 'convert'; id: number; file: Blob; lenient?: boolean }
  | { type: 'peaks'; id: number; file: Blob }
  | { type: 'cancel'; id: number }

export type WorkerResponse =
  | { type: 'progress'; id: number; fraction: number }
  | { type: 'done'; id: number; result: ConvertResult }
  | { type: 'peaks-done'; id: number; peaks: Peaks }
  | { type: 'error'; id: number; code: AudioDecodeError['code'] | 'failed'; message: string }

const scope = self as unknown as {
  onmessage: ((event: MessageEvent<WorkerRequest>) => void) | null
  postMessage: (message: WorkerResponse) => void
}

const jobs = new Map<number, AbortController>()

scope.onmessage = (event) => {
  const request = event.data
  if (request.type === 'cancel') {
    jobs.get(request.id)?.abort()
    return
  }
  const controller = new AbortController()
  jobs.set(request.id, controller)
  const job: Promise<void> =
    request.type === 'peaks'
      ? // gives the event loop a turn every few milliseconds (the default), so a `cancel` message is heard while it works
        peaksFromLossless(request.file, { signal: controller.signal }).then((peaks) => scope.postMessage({ type: 'peaks-done', id: request.id, peaks }))
      : convertToWav(request.file, {
          signal: controller.signal,
          lenient: request.lenient,
          yieldEveryMs: 0, // a worker has no UI to keep responsive
          onProgress: (fraction) => scope.postMessage({ type: 'progress', id: request.id, fraction }),
        }).then((result) => scope.postMessage({ type: 'done', id: request.id, result }))
  job
    .catch((error: unknown) => {
      const code = error instanceof AudioDecodeError ? error.code : 'failed'
      scope.postMessage({ type: 'error', id: request.id, code, message: error instanceof Error ? error.message : String(error) })
    })
    .finally(() => jobs.delete(request.id))
}
