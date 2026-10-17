import type { KeyValue } from '../rawdb'
import { cleanSpeed, isEmpty, staleKeys } from './progress'
import type { Mode, Progress } from './progress'
import { deleteProgress, loadAllProgress, saveProgress } from './progressstore'

/**
 * Where the person stopped in each long recording, the speed it is played at and whether it is remembered, for every track at once:
 * there are few of them (the oldest are forgotten), the seek bar is mounted twice and several parts of the page read them, so all
 * are read into memory once and looked up without waiting. A change shows at once and is kept afterwards, one write after another
 * in the order the changes were made. A change that cannot be kept stays for this visit; the person is told once for a run of
 * failures (a place is kept every few seconds, and a full disk must not become a message every few seconds).
 */

export interface ProgressDeps {
  kv: KeyValue
  /** Milliseconds since the epoch. */
  now: () => number
  /** A change could not be kept (the disk is full or blocked). Called once for a run of failures. */
  onSaveError?: () => void
}

/** What to change in a record; what is left out stays as it is. */
export type ProgressPatch = Partial<Pick<Progress, 't' | 'speed' | 'mode'>>

export class ProgressService {
  private records = new Map<string, Progress>()
  private readonly listeners = new Set<() => void>()
  private loading: Promise<boolean> | null = null
  private usable = false
  private failing = false
  /** The last of the database operations still to come. It never rejects: `enqueue` hands the result to the caller. */
  private ops: Promise<unknown> = Promise.resolve()

  constructor(private readonly deps: ProgressDeps) {}

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  /** What is kept about a track, or null. The same object until it changes, as `useSyncExternalStore` requires. */
  get = (key: string): Progress | null => this.records.get(key) ?? null

  /** How many tracks something is kept about. */
  get size(): number {
    return this.records.size
  }

  /** Read the database (once; a failed read is tried again at the next call). False when it could not be read: nothing can be changed then. */
  ready(): Promise<boolean> {
    if (!this.loading) {
      this.loading = loadAllProgress(this.deps.kv).then((all) => {
        if (!all) {
          this.loading = null
          return false
        }
        this.records = all
        this.usable = true
        this.emit()
        return true
      })
    }
    return this.loading
  }

  /** Change what is kept about a track. False when the database has not been read (a record not seen must not be written over). */
  save(key: string, patch: ProgressPatch): boolean {
    if (!this.usable) return false
    const old = this.records.get(key)
    const t = patch.t === undefined ? (old?.t ?? null) : patch.t !== null && Number.isFinite(patch.t) && patch.t >= 0 ? patch.t : null
    const speed = patch.speed === undefined ? (old?.speed ?? null) : cleanSpeed(patch.speed)
    const mode: Mode = patch.mode ?? old?.mode ?? 'auto'
    if (t === (old?.t ?? null) && speed === (old?.speed ?? null) && mode === (old?.mode ?? 'auto')) return true
    const next: Progress = { v: 1, at: this.deps.now(), t, speed, mode }
    if (isEmpty(next)) this.records.delete(key)
    else this.records.set(key, next)
    this.emit()
    void this.enqueue(() => this.keep(key, next))
    return true
  }

  /** Forget everything about a track: its place, its speed and the choice made for it. */
  forget(key: string): void {
    if (!this.usable) return
    if (this.records.delete(key)) this.emit()
    void this.enqueue(() => deleteProgress(this.deps.kv, key))
  }

  /** Forget everything kept about every track (what the person asked for in the settings). Resolves with how many records went. */
  async clear(): Promise<number> {
    if (!(await this.ready())) return 0
    const keys = [...this.records.keys()]
    if (keys.length === 0) return 0
    this.records = new Map()
    this.emit()
    await this.enqueue(async () => {
      for (const key of keys) await deleteProgress(this.deps.kv, key)
    })
    return keys.length
  }

  /** Forget the places that are old (see `staleKeys`). Resolves with how many went. */
  async prune(): Promise<number> {
    if (!(await this.ready())) return 0
    const entries = [...this.records].map(([key, progress]) => ({ key, at: progress.at, mode: progress.mode }))
    const stale = staleKeys(entries, this.deps.now())
    if (stale.length === 0) return 0
    for (const key of stale) this.records.delete(key)
    this.emit()
    await this.enqueue(async () => {
      for (const key of stale) await deleteProgress(this.deps.kv, key)
    })
    return stale.length
  }

  /** Run `run` after everything asked for before it. */
  private enqueue<T>(run: () => Promise<T>): Promise<T> {
    const result = this.ops.then(run)
    this.ops = result.catch(() => undefined)
    return result
  }

  private async keep(key: string, progress: Progress): Promise<void> {
    const kept = await saveProgress(this.deps.kv, key, progress)
    if (!kept && !this.failing) this.deps.onSaveError?.()
    this.failing = !kept
  }

  private emit(): void {
    for (const listener of [...this.listeners]) listener()
  }
}
