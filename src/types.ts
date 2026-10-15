/** Shared domain types for Wavelocal. Type-only: contains no runtime code. */
import type { Dispatch, SetStateAction } from 'react'
import type { AudioEngine } from './lib/engine'

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
  file: File
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

/**
 * 3D spatial audio. The pad is a top-down view with the listener at the centre facing up:
 * `x` is left (-1) to right (+1) and `y` is front (-1) to behind (+1), clamped to the unit disc.
 */
export interface SpatialSettings {
  enabled: boolean
  x: number
  y: number
  /** 0..1, mapped to 1..10 metres from the listener. */
  distance: number
  /** 0 = dry (original stereo) .. 1 = fully spatialized, equal-power crossfade. */
  mix: number
  /** "8D" mode: the source circles the listener continuously. */
  rotate: boolean
  /** Seconds per full orbit while rotating. */
  orbitSeconds: number
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
  spatial: SpatialSettings
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

/** Everything `usePlayer` exposes to the UI. */
export interface PlayerApi {
  engine: AudioEngine
  /** The whole library, in library order. */
  tracks: Track[]
  /** The tracks of the current view (library or playlist), in play order. */
  queue: Track[]
  playlists: Playlist[]
  /** `'all'` or a playlist id. */
  viewId: string
  setViewId: Dispatch<SetStateAction<string>>
  current: Track | null
  currentId: string | null
  playing: boolean
  time: number
  duration: number
  volume: number
  muted: boolean
  repeat: RepeatMode
  shuffle: boolean
  transition: TransitionMode
  setTransition: Dispatch<SetStateAction<TransitionMode>>
  speed: number
  setSpeed: (v: number) => void
  preservePitch: boolean
  setPreservePitch: Dispatch<SetStateAction<boolean>>
  normalize: boolean
  setNormalize: Dispatch<SetStateAction<boolean>>
  eq: EqGains
  eqOn: boolean
  setEqOn: Dispatch<SetStateAction<boolean>>
  setEqBand: (index: number, gainDb: number) => void
  applyPreset: (name: string) => void
  spatial: SpatialSettings
  /** Merge a change into the spatial settings (values are clamped/sanitized). */
  setSpatial: (patch: Partial<SpatialSettings>) => void
  /** Seconds left on the sleep timer, or null when it is off. */
  sleepLeft: number | null
  /** Start the sleep timer for `minutes`; 0 or null cancels it. */
  setSleep: (minutes: number | null) => void
  loading: boolean
  notice: string
  hydrated: boolean
  play: (id: string) => void
  toggle: () => void
  next: () => void
  prev: () => void
  seek: (seconds: number) => void
  seekBy: (delta: number) => void
  setVolume: (v: number) => void
  volumeBy: (delta: number) => void
  toggleMute: () => void
  cycleRepeat: () => void
  toggleShuffle: () => void
  /** Import files (audio plus optional `.lrc`); resolves with the number of tracks added. */
  addFiles: (files: Iterable<File> | ArrayLike<File>) => Promise<number>
  attachLrc: (file: Blob) => Promise<void>
  remove: (id: string) => void
  clear: () => void
  reorder: (from: number, to: number) => void
  createPlaylist: (name?: string, trackIds?: string[]) => string
  addToPlaylist: (playlistId: string, trackId: string) => void
  deletePlaylist: (id: string) => void
}

/** Keys and value shapes of the IndexedDB `meta` store. */
export interface MetaValues {
  order: string[]
  playlists: Playlist[]
  resume: ResumePoint | null
}
