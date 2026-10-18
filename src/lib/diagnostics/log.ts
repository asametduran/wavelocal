import { cleanName, clip, describeError, redact, MAX_FRAME, MAX_FRAMES } from './redact'
import { LOG_KINDS } from './types'
import type { LogEntry, LogKind } from './types'

/**
 * The error log: what went wrong on this device, kept on this device. A short, bounded list of entries in `localStorage`, so it is there
 * at the next start (a crash on every start is exactly when it is wanted) and before any database is open. Every entry is a kind from a
 * closed set, an error's name, a redacted message and the places in the app's own code; the same failure in a row is one entry with a
 * count. Nothing here sends anything anywhere, and nothing here can throw into the code that records a failure.
 */

export const MAX_ENTRIES = 50
/** Characters of JSON kept: a `localStorage` that is nearly full must not be eaten by the log. */
export const MAX_STORED = 24_000
export const MAX_COUNT = 9999
export const STORAGE_KEY = 'wl.diagnostics'

/** The part of `localStorage` the log uses, so that tests can hand it a fake (or a full or missing one). */
export interface LogStorage {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
  removeItem(key: string): void
}

const KINDS: ReadonlySet<string> = new Set(LOG_KINDS)

/** One stored entry, checked and repaired: null when it is not one. Text is cleaned again, whatever wrote it. */
function readEntry(raw: unknown): LogEntry | null {
  if (typeof raw !== 'object' || raw === null) return null
  const { at, kind, name, message, frames, count } = raw as Record<string, unknown>
  if (typeof at !== 'number' || !Number.isFinite(at) || at < 0 || at > 8.64e15) return null
  if (typeof kind !== 'string' || !KINDS.has(kind)) return null
  const lines = Array.isArray(frames) ? frames.filter((f): f is string => typeof f === 'string').slice(0, MAX_FRAMES) : []
  return {
    at,
    kind: kind as LogKind,
    name: cleanName(name),
    message: typeof message === 'string' ? redact(message) : '',
    frames: lines.map((line) => clip(line.replace(/\s+/g, ' ').trim(), MAX_FRAME)),
    count: typeof count === 'number' && Number.isInteger(count) && count >= 1 ? Math.min(count, MAX_COUNT) : 1,
  }
}

/** The entries in a stored value (oldest first): whatever is not an entry is left out, and a value that is not a list reads as none. */
export function readEntries(raw: unknown): LogEntry[] {
  if (!Array.isArray(raw)) return []
  const entries: LogEntry[] = []
  for (const item of raw) {
    const entry = readEntry(item)
    if (entry) entries.push(entry)
  }
  return entries.slice(-MAX_ENTRIES)
}

/** The stored text for a list: the newest entries that fit in `MAX_STORED`. */
export function serialize(entries: readonly LogEntry[]): string {
  let kept = entries.slice(-MAX_ENTRIES)
  let text = JSON.stringify({ v: 1, entries: kept })
  while (text.length > MAX_STORED && kept.length > 1) {
    kept = kept.slice(1)
    text = JSON.stringify({ v: 1, entries: kept })
  }
  return text
}

const sameFailure = (a: LogEntry, b: LogEntry): boolean => a.kind === b.kind && a.name === b.name && a.message === b.message && a.frames[0] === b.frames[0]

/** `entries` with `entry` after them: the same failure again is the last entry once more, counted. */
export function append(entries: readonly LogEntry[], entry: LogEntry): LogEntry[] {
  const last = entries[entries.length - 1]
  if (last && sameFailure(last, entry)) {
    return [...entries.slice(0, -1), { ...last, at: Math.max(last.at, entry.at), count: Math.min(last.count + entry.count, MAX_COUNT) }]
  }
  return [...entries, entry].slice(-MAX_ENTRIES)
}

function browserStorage(): LogStorage | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage
  } catch {
    return null // some embedded and private contexts refuse even to say that they have none
  }
}

export class DiagnosticsLog {
  private entries: readonly LogEntry[]
  /** What was recorded here and could not be written (a full store): kept in memory, and written with the next one that can be. */
  private unsaved: readonly LogEntry[] = []
  private readonly listeners = new Set<() => void>()

  constructor(
    private readonly storage: LogStorage | null = browserStorage(),
    private readonly now: () => number = Date.now,
  ) {
    this.entries = this.read() ?? []
  }

  /** The same list until something changes, as `useSyncExternalStore` requires. Oldest first. */
  snapshot = (): readonly LogEntry[] => this.entries

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  private publish(): void {
    this.listeners.forEach((listener) => listener())
  }

  /** What is stored now (another window may have added to it): a damaged value is an empty log, and null says there is nothing to read from. */
  private read(): LogEntry[] | null {
    let text: string | null
    try {
      if (!this.storage) return null
      text = this.storage.getItem(STORAGE_KEY)
    } catch {
      return null
    }
    if (!text) return []
    try {
      const value: unknown = JSON.parse(text)
      return readEntries(typeof value === 'object' && value !== null ? (value as { entries?: unknown }).entries : null)
    } catch {
      return []
    }
  }

  /** Whether the entries went into the store. A full or refusing one is no reason to lose them: the log lives in memory until the page closes. */
  private write(entries: readonly LogEntry[]): boolean {
    try {
      if (!this.storage) return false
      if (!entries.length) this.storage.removeItem(STORAGE_KEY)
      else this.storage.setItem(STORAGE_KEY, serialize(entries))
      return true
    } catch {
      return false
    }
  }

  /** What is stored, with what could not be written added after it. */
  private withUnsaved(stored: LogEntry[]): LogEntry[] {
    return this.unsaved.reduce<LogEntry[]>((all, entry) => append(all, entry), stored)
  }

  /** Look again at what is stored, for when another window has recorded something. */
  refresh(): void {
    const stored = this.read()
    if (!stored) return
    const entries = this.withUnsaved(stored)
    if (JSON.stringify(entries) === JSON.stringify(this.entries)) return
    this.entries = entries
    this.publish()
  }

  /** Keep a failure. It is cleaned first, joined to the same failure just before it, and stored. Never throws. */
  record(kind: LogKind, error: unknown): void {
    try {
      const described = describeError(error)
      const entry: LogEntry = { at: this.now(), kind, ...described, count: 1 }
      // other windows write to the same store: add to what is there now, not to what this window last saw (and when nothing can be
      // read, carry on from memory)
      const stored = this.read()
      const next = append(stored ? this.withUnsaved(stored) : this.entries, entry)
      this.unsaved = this.write(next) ? [] : [...this.unsaved, entry].slice(-MAX_ENTRIES)
      this.entries = next
      this.publish()
    } catch {
      // a log that fails while recording a failure must not make another one
    }
  }

  /** Empty the log. Returns what was in it, so that the person can take it back. */
  clear(): readonly LogEntry[] {
    const removed = this.entries
    this.entries = []
    this.unsaved = []
    this.write([])
    this.publish()
    return removed
  }

  /** Put back what `clear` took out, before whatever was recorded since. */
  restore(removed: readonly LogEntry[]): void {
    if (!removed.length) return
    const merged = this.entries.reduce<LogEntry[]>((all, entry) => append(all, entry), [...removed])
    this.entries = merged.slice(-MAX_ENTRIES)
    this.unsaved = this.write(this.entries) ? [] : this.entries
    this.publish()
  }
}

/** The page's log. */
export const diagnostics = new DiagnosticsLog()

/** Keep a failure in the page's log (what `capture.ts` hands over to). */
export const record = (kind: LogKind, error: unknown): void => diagnostics.record(kind, error)
