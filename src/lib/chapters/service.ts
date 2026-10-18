import type { AudioFormat } from '../audio/probe/types'
import { note } from '../diagnostics/capture'
import type { KeyValue } from '../rawdb'
import { loadChapters, saveChapters } from './store'
import type { Chapter } from './types'

/**
 * Who gets chapters and when: the current track's, read from the cache or, the first time, from the file, and kept. Like the
 * waveform's service this is one shared store, because the seek bar is mounted twice (footer and phone sheet). Reading a
 * file's tags is quick, so there is no pause before it and nothing to cancel: a track that was left while it was being read
 * simply finishes, and has its chapters ready if the listener comes back.
 */

export type ChaptersState = { status: 'idle' } | { status: 'loading' } | { status: 'ready'; chapters: Chapter[] } | { status: 'error' }

export interface ChaptersTarget {
  id: string
  file: Blob
  /** Seconds according to the track's record (0: not known). */
  duration: number
  format?: AudioFormat | null
}

export interface ChaptersDeps {
  kv: KeyValue
  /** Read the chapters from the file itself. */
  read(target: ChaptersTarget): Promise<Chapter[]>
  /** How many tracks' states are kept in memory (the older ones come back from the cache). */
  keep?: number
}

const IDLE: ChaptersState = { status: 'idle' }
const LOADING: ChaptersState = { status: 'loading' }
const FAILED: ChaptersState = { status: 'error' }

export class ChaptersService {
  private readonly states = new Map<string, ChaptersState>()
  private readonly listeners = new Set<() => void>()

  constructor(private readonly deps: ChaptersDeps) {}

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  /** The same object until the track's state changes, as `useSyncExternalStore` requires. */
  getState = (id: string): ChaptersState => this.states.get(id) ?? IDLE

  /** Make sure the chapters of the current track are on their way (or already here); `null` when nothing is playing. */
  want(target: ChaptersTarget | null): void {
    if (!target) return
    const known = this.states.get(target.id)
    if (known) {
      if (known !== LOADING) this.set(target.id, known) // seen lately: keep it in memory
      return
    }
    this.set(target.id, LOADING)
    void this.load(target)
  }

  private async load(target: ChaptersTarget): Promise<void> {
    const { kv, read } = this.deps
    try {
      let chapters = await loadChapters(kv, target.id)
      if (!chapters) {
        chapters = await read(target)
        await saveChapters(kv, target.id, chapters)
      }
      this.set(target.id, { status: 'ready', chapters })
    } catch (error) {
      note('decode')(error) // the chapters of this file could not be read
      this.set(target.id, FAILED)
    }
  }

  private set(id: string, state: ChaptersState): void {
    this.states.delete(id)
    this.states.set(id, state)
    const keep = this.deps.keep ?? 8
    for (const old of this.states.keys()) {
      if (this.states.size <= keep) break
      if (old !== id && this.states.get(old) !== LOADING) this.states.delete(old)
    }
    for (const listener of [...this.listeners]) listener()
  }
}
