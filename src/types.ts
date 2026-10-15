/** Shared domain types for Wavelocal. Kept free of runtime code so it can be imported anywhere. */

/** One lyric line; `t` is the start time in seconds, or null for unsynced (plain) lyrics. */
export interface LyricLine {
  t: number | null
  text: string
}

export interface Lyrics {
  synced: boolean
  lines: LyricLine[]
}

/** Serializable track record as persisted in IndexedDB (`tracks` store). */
export interface TrackRecord {
  id: string
  /** Dedupe key: `name|size|lastModified`. */
  key: string
  file: File | Blob
  coverBlob: Blob | null
  title: string
  artist: string
  album: string
  duration: number
  lyrics: Lyrics | null
  /** ReplayGain / measured loudness correction in dB, or null when unknown. */
  gainDb: number | null
}

/** A track in memory: the record plus object URLs for the audio element and artwork. */
export interface Track extends TrackRecord {
  url: string
  cover: string | null
}

export interface Playlist {
  id: string
  name: string
  trackIds: string[]
}

export type RepeatMode = 'off' | 'all' | 'one'
export type TransitionMode = 'off' | 'gapless' | 'crossfade'

/** Ten graphic-EQ band gains in dB (low to high frequency). */
export type EqGains = number[]

/** Playback position saved in the `resume` meta key. */
export interface ResumePoint {
  id: string
  time: number
}

/** User preferences persisted in localStorage under `wl-settings`. */
export interface Settings {
  volume: number
  muted: boolean
  repeat: RepeatMode
  shuffle: boolean
  transition: TransitionMode
  eq: EqGains
  eqOn: boolean
  speed: number
  preservePitch: boolean
  normalize: boolean
}

/** Snapshot of live playback state exposed by the player. */
export interface PlayerState {
  currentId: string | null
  playing: boolean
  time: number
  duration: number
  volume: number
  muted: boolean
  repeat: RepeatMode
  shuffle: boolean
  transition: TransitionMode
  speed: number
  preservePitch: boolean
  normalize: boolean
  eq: EqGains
  eqOn: boolean
  /** Seconds until the sleep timer fires, or null when inactive. */
  sleepLeft: number | null
}

/** Keys and value shapes of the IndexedDB `meta` store. */
export interface MetaValues {
  order: string[]
  playlists: Playlist[]
  resume: ResumePoint | null
}
