/** Pure decisions for listening together: when the host announces its state and how a guest follows it. */

export interface HostPlayback {
  /** Library key of the current track, or null when nothing is loaded. */
  key: string | null
  playing: boolean
  /** Seconds into the track. */
  position: number
  speed: number
}

export interface Announcement extends HostPlayback {
  /** Local time (ms) the announcement was made. */
  at: number
}

export type BroadcastReason = 'track' | 'playing' | 'speed' | 'seek' | 'heartbeat'

export const HEARTBEAT_MS = 3000
/** How far the position may differ from where the last announcement predicts before it counts as a seek. */
export const SEEK_JUMP_SECONDS = 1.2

/** Where the playhead should be now if playback simply carried on after `last` was announced. */
export function predictedPosition(last: Announcement, now: number): number {
  return last.position + (last.playing ? ((now - last.at) / 1000) * last.speed : 0)
}

/** Should the host send a fresh state message, and why. Null means everything is as the guests already expect. */
export function broadcastReason(last: Announcement | null, cur: HostPlayback, now: number): BroadcastReason | null {
  if (!last) return 'track'
  if (cur.key !== last.key) return 'track'
  if (cur.playing !== last.playing) return 'playing'
  if (cur.speed !== last.speed) return 'speed'
  if (Math.abs(cur.position - predictedPosition(last, now)) > SEEK_JUMP_SECONDS) return 'seek'
  if (now - last.at >= HEARTBEAT_MS) return 'heartbeat'
  return null
}

export interface HostState {
  playing: boolean
  position: number
  speed: number
  /** Host clock (ms) when the position was read. */
  at: number
}

/** The position a guest should be at right now, given the host's announcement and the clock offset (host - local, ms). */
export function targetPosition(state: HostState, offsetMs: number, localNow: number, duration: number): number {
  const hostNow = localNow + offsetMs
  const elapsed = state.playing ? Math.max(0, (hostNow - state.at) / 1000) * state.speed : 0
  const t = state.position + elapsed
  return duration > 0 ? Math.min(Math.max(0, t), duration) : Math.max(0, t)
}

/** A guest this far off is pulled back; smaller drift is left alone because every correction is a small audible jump. */
export const DRIFT_SEEK_SECONDS = 0.35
/** Minimum time between two corrections, so one slow seek is not mistaken for more drift. */
export const CORRECTION_COOLDOWN_MS = 2000
/** Minimum time between two play/pause toggles, because the player reports the new state a moment late. */
export const TOGGLE_COOLDOWN_MS = 800

export interface GuestView {
  /** The guest is on the host's track and it has loaded far enough to seek. */
  ready: boolean
  playing: boolean
  position: number
}

export type GuestAction = { kind: 'none' } | { kind: 'toggle' } | { kind: 'seek'; to: number }

export interface GuestTiming {
  now: number
  lastSeekAt: number
  lastToggleAt: number
}

/** What the guest should do now to match the host: start/stop, jump to the right place, or nothing. */
export function planGuest(state: HostState, offsetMs: number, view: GuestView, timing: GuestTiming, duration: number): GuestAction {
  if (!view.ready) return { kind: 'none' }
  if (view.playing !== state.playing) {
    return timing.now - timing.lastToggleAt >= TOGGLE_COOLDOWN_MS ? { kind: 'toggle' } : { kind: 'none' }
  }
  const want = targetPosition(state, offsetMs, timing.now, duration)
  const drift = view.position - want
  if (Math.abs(drift) > DRIFT_SEEK_SECONDS && timing.now - timing.lastSeekAt >= CORRECTION_COOLDOWN_MS) return { kind: 'seek', to: want }
  return { kind: 'none' }
}
