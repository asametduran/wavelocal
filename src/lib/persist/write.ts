import * as db from '../db'
import type { MetaValues, TrackRecord } from '../../types'
import { NotSavingError, writeGate } from './gate'
import type { WriteGate } from './gate'

/**
 * Every write of the library goes through here, so none can happen from a window that may not write (see `gate.ts`). A write that
 * arrives while the saved library is still being read waits for the answer; one that arrives in a window that could not read it, or
 * that another window took over, is refused: counted, and (unless it is an automatic one) explained to the person once.
 *
 * Writes nobody waits for (`saveMeta`, `removeTrack`, `clearTracks`) cannot say they failed, so a failure is kept: the gate lists the
 * write as failing (which makes the person hear of it once, see `notices.ts`) and it is tried again later with the newest value of
 * its key and only that (`failures.ts`). Writes of tracks (`saveTracks`, `patchTracks`) return the promise, which rejects with a
 * `NotSavingError` when refused, or with the database's error when it fails, so the import and the tag editor can say so in their
 * own words.
 */

/** The database as the writer uses it, so that tests can put a fake in its place. */
export interface WriteStore {
  setMeta<K extends keyof MetaValues>(key: K, value: MetaValues[K]): Promise<void>
  putTracks(records: TrackRecord[]): Promise<void>
  patchTracks(patches: ReadonlyMap<string, Partial<TrackRecord>>): Promise<void>
  deleteTrack(id: string): Promise<void>
  clearTracks(): Promise<void>
}

export interface WriteOptions {
  /** An automatic write (the place being played, a play count): never worth a message when it is refused. */
  quiet?: boolean
}

export interface Writer {
  saveMeta<K extends keyof MetaValues>(key: K, value: MetaValues[K], options?: WriteOptions): void
  saveTracks(records: TrackRecord[], options?: WriteOptions): Promise<void>
  patchTracks(patches: ReadonlyMap<string, Partial<TrackRecord>>, options?: WriteOptions): Promise<void>
  removeTrack(id: string): void
  /** `stillWanted` is asked before a retry: a clearing that failed must not wipe what was added to the library since. */
  clearTracks(stillWanted?: () => boolean): void
}

/** Where a failed write waits to be tried again (`failures.ts`, a lazy chunk). */
export interface RetryPort {
  /** Run `run` again after a wait; a newer call for the same key replaces the one that is waiting. */
  later(key: string, run: () => void): void
  /** The write for `key` went through. */
  done(key: string): void
}

const noRetry: RetryPort = { later: () => {}, done: () => {} }

export function createWriter({ gate, store, retry = noRetry }: { gate: WriteGate; store: WriteStore; retry?: RetryPort }): Writer {
  /** The newest write of each key that is not known to have gone through: only that one may be reported or tried again. */
  const latest = new Map<string, () => Promise<void>>()

  /** Run the write if this window may write: wait until the library has been read, refuse if it is not this window's to write. */
  async function guard(quiet: boolean, op: () => Promise<void>): Promise<void> {
    await gate.settled
    if (!gate.canWrite) {
      gate.refuse(quiet)
      throw new NotSavingError(gate.snapshot().mode === 'taken' ? 'taken' : 'memory')
    }
    await op()
  }

  /**
   * A write nobody waits for. Its failure is kept, not lost: the gate lists it, and it is tried again with its value, unless a newer
   * write of the same key has replaced it (that one's outcome is what counts) or `stillWanted` says it is no longer wanted. An
   * automatic (`quiet`) write is dropped when it fails: it writes itself again in a few seconds, and is no reason to alarm anyone.
   */
  function background(key: string, quiet: boolean, op: () => Promise<void>, stillWanted: () => boolean = () => true): void {
    if (quiet) {
      void guard(true, op).catch(() => {})
      return
    }
    latest.set(key, op)
    const settle = (): void => {
      latest.delete(key)
      if (gate.snapshot().failing.includes(key)) {
        gate.saved(key)
        retry.done(key)
      }
    }
    guard(false, op).then(
      () => {
        if (latest.get(key) === op) settle()
      },
      (error: unknown) => {
        if (latest.get(key) !== op) return // a newer write of this key took over
        if (error instanceof NotSavingError) return void latest.delete(key) // the window is not saving: that is not the disk's fault
        gate.failed(key, error)
        retry.later(key, () => {
          if (latest.get(key) !== op) return
          if (stillWanted()) background(key, false, op, stillWanted)
          else settle()
        })
      },
    )
  }

  return {
    saveMeta: (key, value, { quiet = false } = {}) => background(`meta:${key}`, quiet, () => store.setMeta(key, value)),
    removeTrack: (id) => background(`delete:${id}`, false, () => store.deleteTrack(id)),
    clearTracks: (stillWanted) => background('clear', false, () => store.clearTracks(), stillWanted),
    saveTracks: (records, { quiet = false } = {}) => guard(quiet, () => store.putTracks(records)),
    patchTracks: (patches, { quiet = false } = {}) => guard(quiet, () => store.patchTracks(patches)),
  }
}

// the retrying is a chunk of its own, fetched when the first save fails
const lazyRetry: RetryPort = {
  later: (key, run) => void import('./failures').then((failures) => failures.retryLater(key, run)).catch(() => {}),
  done: (key) => void import('./failures').then((failures) => failures.retryDone(key)).catch(() => {}),
}

export const { saveMeta, saveTracks, patchTracks, removeTrack, clearTracks } = createWriter({ gate: writeGate, store: db, retry: lazyRetry })
