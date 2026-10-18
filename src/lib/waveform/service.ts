import { AudioDecodeError } from '../audio/pcm'
import type { AudioFormat } from '../audio/probe/types'
import { note } from '../diagnostics/capture'
import type { KeyValue } from '../rawdb'
import { loadPeaks, savePeaks } from './store'
import type { NoPeaks, Peaks, PeaksRecord } from './types'

/**
 * Who gets a waveform and when. One job at a time, for the track that is playing: a stored waveform is simply read; a new one
 * is measured after a pause (so start-up and the first seconds of playback are left alone), kept for next time, and dropped
 * the moment another track becomes current. The seek bar is mounted twice (footer and phone sheet), so this is one shared
 * store read by both, not state of a component.
 */

export type PeaksState =
  | { status: 'idle' }
  | { status: 'loading' }
  | { status: 'ready'; peaks: Peaks }
  | { status: 'none'; why: NoPeaks }
  | { status: 'error' }

/** What the service needs to know about a track. */
export interface PeaksTarget {
  id: string
  file: Blob
  /** Seconds according to the track's record (0: not known). */
  duration: number
  /** What the container probe found at import, when it did. */
  format?: AudioFormat | null
}

export interface PeaksDeps {
  kv: KeyValue
  /** Measure the track. Rejects with an `AudioDecodeError`: `aborted` when cancelled, `unsupported` for a file nothing can decode. */
  measure(target: PeaksTarget, signal: AbortSignal): Promise<PeaksRecord>
  /** Resolves after `ms`; rejects with an `aborted` error as soon as `signal` fires. */
  wait(ms: number, signal: AbortSignal): Promise<void>
  /** The pause before a new measurement starts. */
  delayMs?: number
  /** How many tracks' states are kept in memory (the older ones come back from the cache). */
  keep?: number
}

const IDLE: PeaksState = { status: 'idle' }
const LOADING: PeaksState = { status: 'loading' }
const FAILED: PeaksState = { status: 'error' }

const stateOf = (record: PeaksRecord): PeaksState => ('none' in record ? { status: 'none', why: record.none } : { status: 'ready', peaks: record })
const isCancelled = (error: unknown): boolean => error instanceof AudioDecodeError && error.code === 'aborted'

/** `setTimeout` that gives up the moment `signal` fires. */
export function delay(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const cancelled = () => new AudioDecodeError('Waiting for the waveform was cancelled', 'aborted')
    if (signal.aborted) return reject(cancelled())
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    const onAbort = () => {
      clearTimeout(timer)
      reject(cancelled())
    }
    signal.addEventListener('abort', onAbort, { once: true })
  })
}

export class PeaksService {
  private readonly states = new Map<string, PeaksState>()
  private readonly listeners = new Set<() => void>()
  private job: { id: string; controller: AbortController } | null = null

  constructor(private readonly deps: PeaksDeps) {}

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  /** The same object until the track's state changes, as `useSyncExternalStore` requires. */
  getState = (id: string): PeaksState => this.states.get(id) ?? IDLE

  /** Make sure the waveform of the current track is on its way (or already here); `null` when nothing is playing. */
  want(target: PeaksTarget | null): void {
    const running = this.job
    if (target && running?.id === target.id) return
    if (running) {
      running.controller.abort()
      this.job = null
      this.drop(running.id)
    }
    if (!target) return
    const known = this.states.get(target.id)
    if (known && known !== LOADING) {
      this.touch(target.id, known)
      return
    }
    const controller = new AbortController()
    this.job = { id: target.id, controller }
    this.set(target.id, LOADING)
    void this.run(target, controller)
  }

  private async run(target: PeaksTarget, controller: AbortController): Promise<void> {
    const { signal } = controller
    const { kv, measure, wait, delayMs = 1000 } = this.deps
    try {
      let record = await loadPeaks(kv, target.id)
      if (signal.aborted) return
      if (!record) {
        await wait(delayMs, signal)
        try {
          record = await measure(target, signal)
        } catch (error) {
          if (signal.aborted || !(error instanceof AudioDecodeError) || error.code !== 'unsupported') throw error
          record = { v: 1, none: 'unsupported' } // a file nothing can decode stays that way: remember it
        }
        if (signal.aborted) return
        await savePeaks(kv, target.id, record)
      }
      if (!signal.aborted) this.set(target.id, stateOf(record))
    } catch (error) {
      if (signal.aborted || isCancelled(error)) {
        this.drop(target.id)
      } else {
        note('worker')(error) // the measuring (a worker or the browser's decoder) failed: the bar stays plain
        this.set(target.id, FAILED)
      }
    } finally {
      if (this.job?.controller === controller) this.job = null
    }
  }

  private emit(): void {
    for (const listener of [...this.listeners]) listener()
  }

  /** Forget a track that was still being measured, so it is asked for again next time. */
  private drop(id: string): void {
    if (this.states.get(id) !== LOADING) return
    this.states.delete(id)
    this.emit()
  }

  private touch(id: string, state: PeaksState): void {
    this.states.delete(id)
    this.states.set(id, state)
  }

  private set(id: string, state: PeaksState): void {
    this.touch(id, state)
    const keep = this.deps.keep ?? 8
    for (const old of this.states.keys()) {
      if (this.states.size <= keep) break
      if (old !== this.job?.id && old !== id) this.states.delete(old)
    }
    this.emit()
  }
}
