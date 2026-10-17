/**
 * Long-form listening as plain rules, apart from any screen or database: which tracks are long recordings (a podcast, a book, a
 * lecture), where a place is worth coming back to, how far back to start, which speed a recording is played at, and which of the
 * places kept on the device are old enough to forget. What is stored is untrusted like any record read back, so it goes through
 * `normalizeProgress`.
 */

/** Whether a track is remembered: by the length rule (`auto`), or because the person said so for this one. */
export type Mode = 'auto' | 'always' | 'never'
export const MODES: readonly Mode[] = ['auto', 'always', 'never']

/** What is kept about one recording, under `heard:<track key>`. */
export interface Progress {
  v: 1
  /** When it last changed (ms since the epoch), so the oldest places can be forgotten first. */
  at: number
  /** Where the person stopped, in seconds, or null when there is no place worth coming back to. */
  t: number | null
  /** The speed chosen for this recording, or null for the usual one. */
  speed: number | null
  mode: Mode
}

/** A place nearer the beginning than this (seconds) is the beginning. */
export const MIN_KEPT = 5
/** A place nearer the end than this (seconds) is the end: the recording is finished. */
export const FINISHED = 15
/** A recording is taken up this many seconds before the place where it was left, so that the last words are heard again. */
export const REWIND = 3
/** How often the place is kept while a long recording plays (ms). */
export const SAVE_EVERY_MS = 5_000
/** A place not come back to for this many days is forgotten. */
export const STALE_DAYS = 180
/** At most this many places are kept, the most recent ones. */
export const KEEP_RECENT = 400
export const MIN_SPEED = 0.5
export const MAX_SPEED = 2
/** How far the buttons of a long recording move the playhead back and forward (seconds): enough to hear again what was missed, and to skip an advert. */
export const SKIP_BACK = 15
export const SKIP_FORWARD = 30
const DAY_MS = 86_400_000

export type Place = 'start' | 'kept' | 'finished'

/** What `t` seconds is in a recording `duration` seconds long (0 when that is not known): null if it is not a time at all. */
export function classify(t: number, duration: number): Place | null {
  if (!Number.isFinite(t) || t < 0) return null
  if (t < MIN_KEPT) return 'start'
  return Number.isFinite(duration) && duration > 0 && t > duration - FINISHED ? 'finished' : 'kept'
}

/** Where to take a recording up when the person left it at `t`. */
export const resumeAt = (t: number): number => Math.max(0, t - REWIND)

// ---- which tracks are long recordings ----

export type ThresholdId = 'never' | '5' | '10' | '20' | '30' | '60' | 'all'
export const DEFAULT_THRESHOLD: ThresholdId = '20'
/** The lengths to choose from (in minutes), as the settings panel lists them. */
export const THRESHOLDS: readonly { id: ThresholdId; label: string }[] = [
  { id: 'never', label: 'Never' },
  { id: '5', label: 'Over 5 min' },
  { id: '10', label: 'Over 10 min' },
  { id: '20', label: 'Over 20 min' },
  { id: '30', label: 'Over 30 min' },
  { id: '60', label: 'Over an hour' },
  { id: 'all', label: 'Every file' },
]

export const parseThreshold = (raw: unknown): ThresholdId => THRESHOLDS.find((t) => t.id === raw)?.id ?? DEFAULT_THRESHOLD

export interface LongFormInput {
  /** Seconds; 0 when the length is not known. */
  duration: number
  threshold: ThresholdId
  mode: Mode
}

/** Whether a track is a long recording: the person's word for this track first, then the length rule. */
export function isLongForm({ duration, threshold, mode }: LongFormInput): boolean {
  if (mode !== 'auto') return mode === 'always'
  if (threshold === 'never') return false
  if (threshold === 'all') return true
  return Number.isFinite(duration) && duration >= Number(threshold) * 60
}

// ---- the record ----

/** A speed the player offers (0.5 to 2, in steps of 0.05), or null for anything else. */
export function cleanSpeed(value: unknown): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < MIN_SPEED || value > MAX_SPEED) return null
  return Math.round(value * 20) / 20
}

/** A stored record, copied field by field. Null when it is not a record of this version; a damaged field reads as absent. */
export function normalizeProgress(raw: unknown): Progress | null {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return null
  const r = raw as Record<string, unknown>
  if (r.v !== 1) return null
  return {
    v: 1,
    at: typeof r.at === 'number' && Number.isFinite(r.at) && r.at > 0 ? r.at : 0,
    t: typeof r.t === 'number' && Number.isFinite(r.t) && r.t >= 0 ? r.t : null,
    speed: cleanSpeed(r.speed),
    mode: MODES.find((mode) => mode === r.mode) ?? 'auto',
  }
}

/** A record with nothing to remember is not kept at all. */
export const isEmpty = (p: Pick<Progress, 't' | 'speed' | 'mode'>): boolean => p.t === null && p.speed === null && p.mode === 'auto'

// ---- the speed of a recording ----

/** The speed to play a track at: the one chosen for a long recording if there is one, otherwise the usual speed. */
export function planSpeed({ long, stored, usual }: { long: boolean; stored: number | null; usual: number }): number {
  return long && stored !== null ? stored : usual
}

/** What a change of speed teaches: on a long recording it belongs to that recording, anywhere else it is the new usual speed. */
export function rememberSpeed({ long, speed, usual }: { long: boolean; speed: number; usual: number }): { usual: number; stored: number | null } {
  return long ? { usual, stored: speed } : { usual: speed, stored: null }
}

// ---- forgetting ----

/**
 * The keys of the records to forget: places not come back to for `STALE_DAYS`, then the oldest beyond the `KEEP_RECENT` most
 * recent. A recording the person made a choice about (`always`, `never`) is never forgotten, nor counted: forgetting it would
 * undo the choice.
 */
export function staleKeys(entries: readonly { key: string; at: number; mode: Mode }[], now: number): string[] {
  const stale: string[] = []
  const recent: { key: string; at: number }[] = []
  for (const entry of entries) {
    if (entry.mode !== 'auto') continue
    if (now - entry.at > STALE_DAYS * DAY_MS) stale.push(entry.key)
    else recent.push(entry)
  }
  recent.sort((a, b) => b.at - a.at)
  for (const entry of recent.slice(KEEP_RECENT)) stale.push(entry.key)
  return stale
}
