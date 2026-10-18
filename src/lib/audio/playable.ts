import { note } from '../diagnostics/capture'
import type { ConvertResult } from './convert'
import { AudioDecodeError } from './errors'
import { mightBeLossless } from './lossless'
import type { WorkerRequest, WorkerResponse } from './decode.worker'

/** Load the decoders on first use, so players that never meet an unplayable WAV/FLAC never download them. */
const convertOnThisThread: ConvertFn = async (file, options) => (await import('./convert')).convertToWav(file, options)

/** Looking inside a file (and the WAV parser it needs) is only fetched when a WAV or FLAC has to be told apart from a file the browser plays. */
const loadSniffing = () => import('./sniff')

/**
 * Decides, per track, what URL the `<audio>` element should be given. Most files are handed to the browser
 * untouched. WAV and FLAC files the browser cannot play are decoded in JavaScript (in a worker) into a plain
 * 16-bit WAV blob, once, and that blob URL is cached for as long as the track is in use.
 */

export type ConvertFn = (file: Blob, options: { onProgress?: (fraction: number) => void; signal?: AbortSignal }) => Promise<ConvertResult>

export interface PlayableTrack {
  id: string
  /** Object URL of the original file. */
  url: string
  file: Blob & { name?: string }
}

export interface ResolverOptions {
  convert?: ConvertFn
  /** Element used to ask `canPlayType`; `null` means "assume the browser can play it". */
  element?: Pick<HTMLMediaElement, 'canPlayType'> | null
  /** How many converted tracks to keep (older ones that are not retained are dropped). */
  cacheSize?: number
  createUrl?: (blob: Blob) => string
  revokeUrl?: (url: string) => void
}

type Verdict = 'native' | 'decode'

export type ProgressListener = (trackId: string, fraction: number | null) => void

interface Job {
  promise: Promise<string>
  controller: AbortController
  progress: number
}

export class PlayableResolver {
  private readonly convert: ConvertFn
  private readonly element: Pick<HTMLMediaElement, 'canPlayType'> | null | undefined
  private readonly cacheSize: number
  private readonly createUrl: (blob: Blob) => string
  private readonly revokeUrl: (url: string) => void
  private readonly verdicts = new Map<string, Verdict>()
  /** Converted tracks, oldest first (a Map keeps insertion order, which doubles as recency). */
  private readonly converted = new Map<string, { url: string; result: ConvertResult }>()
  private readonly jobs = new Map<string, Job>()
  private readonly deciding = new Map<string, Promise<string>>()
  private readonly listeners = new Set<ProgressListener>()
  private retained = new Set<string>()

  constructor(options: ResolverOptions = {}) {
    this.convert = options.convert ?? convertOnThisThread
    this.element = options.element
    this.cacheSize = options.cacheSize ?? 4
    this.createUrl = options.createUrl ?? ((blob) => URL.createObjectURL(blob))
    this.revokeUrl = options.revokeUrl ?? ((url) => URL.revokeObjectURL(url))
  }

  /**
   * The URL to give the media element right now, or `null` when an asynchronous step is needed first
   * (the file might be WAV/FLAC that needs decoding). Ordinary files always answer immediately.
   */
  urlFor(track: PlayableTrack): string | null {
    const converted = this.converted.get(track.id)
    if (converted) {
      this.converted.delete(track.id) // refresh recency
      this.converted.set(track.id, converted)
      return converted.url
    }
    if (!mightBeLossless(track.file)) return track.url
    return this.verdicts.get(track.id) === 'native' ? track.url : null
  }

  /** A playable URL for the track, sniffing and converting if necessary. Concurrent calls share one job. */
  resolve(track: PlayableTrack): Promise<string> {
    const now = this.urlFor(track)
    if (now) return Promise.resolve(now)
    const running = this.jobs.get(track.id)
    if (running) return running.promise
    const deciding = this.deciding.get(track.id)
    if (deciding) return deciding

    const promise = (async () => {
      const { needsDecoder, sniffBlob } = await loadSniffing()
      const { container, head } = await sniffBlob(track.file)
      if (!needsDecoder(container, head, this.element)) {
        this.verdicts.set(track.id, 'native')
        return track.url
      }
      this.verdicts.set(track.id, 'decode')
      return this.start(track)
    })().finally(() => this.deciding.delete(track.id))
    this.deciding.set(track.id, promise)
    return promise
  }

  /** The browser tried the original and failed: decode it ourselves whatever the detection said. */
  forceDecode(track: PlayableTrack): Promise<string> {
    const existing = this.converted.get(track.id)
    if (existing) return Promise.resolve(existing.url)
    this.verdicts.set(track.id, 'decode')
    return this.jobs.get(track.id)?.promise ?? this.start(track)
  }

  /** True if this file is, by its content, WAV or FLAC (so a playback error is worth retrying through the decoder). */
  async isDecodable(track: PlayableTrack): Promise<boolean> {
    const { sniffBlob } = await loadSniffing()
    const { container } = await sniffBlob(track.file)
    return container !== 'other'
  }

  /** Conversion progress (0..1) while a job is running, otherwise `null`. */
  progressOf(trackId: string): number | null {
    return this.jobs.get(trackId)?.progress ?? null
  }

  /** Subscribe to progress: `fraction` is a number while converting and `null` when the job ends. Returns an unsubscribe function. */
  onProgress(listener: ProgressListener): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  /** Tracks whose converted audio must not be evicted (the ones loaded into a deck). */
  retain(ids: Iterable<string>): void {
    this.retained = new Set(ids)
  }

  /** Forget everything about a track: cancel its job and free its converted audio. */
  release(trackId: string): void {
    this.jobs.get(trackId)?.controller.abort()
    this.verdicts.delete(trackId)
    const converted = this.converted.get(trackId)
    if (converted) {
      this.revokeUrl(converted.url)
      this.converted.delete(trackId)
    }
  }

  releaseAll(): void {
    for (const id of [...this.jobs.keys(), ...this.converted.keys(), ...this.verdicts.keys()]) this.release(id)
  }

  private start(track: PlayableTrack): Promise<string> {
    const controller = new AbortController()
    let settle: { resolve: (url: string) => void; reject: (error: unknown) => void } = { resolve: () => {}, reject: () => {} }
    const promise = new Promise<string>((resolve, reject) => (settle = { resolve, reject }))
    const job: Job = { controller, progress: 0, promise }
    const emit = (fraction: number | null) => this.listeners.forEach((l) => l(track.id, fraction))

    // register the job and announce it before the converter can report anything, so listeners see 0 first
    this.jobs.set(track.id, job)
    emit(0)

    this.convert(track.file, {
      signal: controller.signal,
      onProgress: (fraction) => {
        job.progress = fraction
        emit(fraction)
      },
    })
      .then((result) => {
        if (controller.signal.aborted) throw new AudioDecodeError('Decoding was cancelled', 'aborted')
        const url = this.createUrl(result.blob)
        this.converted.set(track.id, { url, result })
        this.evict()
        return url
      })
      .then(settle.resolve, settle.reject)
      .finally(() => {
        this.jobs.delete(track.id)
        emit(null)
      })
    return promise
  }

  private evict(): void {
    while (this.converted.size > this.cacheSize) {
      const victim = [...this.converted.keys()].find((id) => !this.retained.has(id))
      if (victim === undefined) return // everything left is in use
      const entry = this.converted.get(victim)
      if (entry) this.revokeUrl(entry.url)
      this.converted.delete(victim)
    }
  }
}

// ---- running the converter in a worker ----

/** A converter that uses one shared Web Worker, falling back to the main thread when workers are unavailable or fail to start. */
export function createWorkerConvert(): ConvertFn {
  let worker: Worker | null = null
  let broken = false
  let nextId = 1
  const pending = new Map<number, { resolve: (r: ConvertResult) => void; reject: (e: Error) => void; onProgress?: (f: number) => void; heard: boolean }>()

  const failAll = (error: Error) => {
    for (const job of pending.values()) job.reject(error)
    pending.clear()
  }

  const start = (): Worker | null => {
    if (broken || typeof Worker === 'undefined') return null
    if (worker) return worker
    try {
      const w = new Worker(new URL('./decode.worker.ts', import.meta.url), { type: 'module' })
      w.onmessage = (event: MessageEvent<WorkerResponse>) => {
        const message = event.data
        const job = pending.get(message.id)
        if (!job) return
        job.heard = true
        if (message.type === 'progress') job.onProgress?.(message.fraction)
        else if (message.type === 'done') {
          pending.delete(message.id)
          job.resolve(message.result)
        } else if (message.type === 'error') {
          pending.delete(message.id)
          job.reject(new AudioDecodeError(message.message, message.code === 'failed' ? 'corrupt' : message.code))
        }
        // 'peaks-done' belongs to the waveform's own instance of this worker (waveform/client.ts), which this one never asks
      }
      w.onerror = (event) => {
        note('worker')(new Error(event.message || 'The decoding worker failed to run')) // the job is done on this thread instead
        broken = true
        worker?.terminate()
        worker = null
        failAll(new Error('worker-unavailable'))
      }
      worker = w
      return w
    } catch {
      broken = true
      return null
    }
  }

  return (file, { onProgress, signal }) => {
    const w = start()
    if (!w) return convertOnThisThread(file, { onProgress, signal })
    return new Promise<ConvertResult>((resolve, reject) => {
      const id = nextId++
      pending.set(id, { resolve, reject, onProgress, heard: false })
      signal?.addEventListener('abort', () => {
        if (!pending.delete(id)) return
        w.postMessage({ type: 'cancel', id } satisfies WorkerRequest)
        reject(new AudioDecodeError('Decoding was cancelled', 'aborted'))
      })
      w.postMessage({ type: 'convert', id, file } satisfies WorkerRequest)
    }).catch((error: unknown) => {
      // the worker itself could not run (blocked, bundler issue): do the job here instead
      if (error instanceof Error && error.message === 'worker-unavailable') return convertOnThisThread(file, { onProgress, signal })
      throw error
    })
  }
}
