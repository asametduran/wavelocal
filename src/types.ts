/** Shared domain types for Wavelocal. Type-only: contains no runtime code. */
import type { Dispatch, SetStateAction } from 'react'
import type { AudioEngine } from './lib/engine'
import type { Backup, PendingRestore, RestoreSummary } from './lib/backup'
import type { TagEdit } from './lib/tags'
import type { AudioFormat } from './lib/audio/probe/types'
import type { TagMeta } from './lib/tagfields'

/** One lyric line; `t` is the start time in seconds, or null for unsynced (plain) lyrics. */
export interface LyricLine {
  t: number | null
  text: string
}

export interface Lyrics {
  synced: boolean
  lines: LyricLine[]
}

/**
 * What reading a file's tags and headers adds to its library record: the fields for sorting, grouping and searching
 * (see `lib/tagfields.ts`), the audio format, and the version of the analysis that produced them (`lib/trackmeta.ts`).
 */
export interface TrackMeta extends TagMeta {
  /** What the container headers say about the audio; null when the file could not be read or is not a known container. */
  audio: AudioFormat | null
  /** The `INDEX_VERSION` this record was last analysed with: 0 for a library stored before there was one. */
  indexed: number
}

/** Serializable track record as persisted in IndexedDB (`tracks` store). */
export interface TrackRecord extends TrackMeta {
  id: string
  /** Dedupe key: `name|size|lastModified`. */
  key: string
  file: File
  /** Folder the file was imported from, relative to the picked/dropped folder root (`Music/Rock`); '' for loose files. */
  path: string
  coverBlob: Blob | null
  title: string
  artist: string
  album: string
  duration: number
  lyrics: Lyrics | null
  /** ReplayGain / measured loudness correction in dB, or null when unknown. */
  gainDb: number | null
  /** When the track was added to the library (ms since the epoch); 0 for tracks imported before this was recorded. */
  addedAt: number
  /** How many times it has been played (see `lib/plays.ts` for what counts); stored on this device only. */
  plays: number
  /** When it last counted as played (ms since the epoch), or null if never. */
  lastPlayedAt: number | null
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

/** Filter shapes available for an equalizer band (the Web Audio biquad types the editor exposes). */
export type BandType = 'peaking' | 'lowshelf' | 'highshelf' | 'notch'

/** One equalizer band. The 10-band graphic EQ is simply ten of these at fixed frequencies. */
export interface EqBand {
  /** Stable identity (survives edits and reordering); graphic bands are g0..g9. */
  id: string
  type: BandType
  /** Centre / corner frequency in Hz. */
  frequency: number
  /** Quality factor (width). Ignored by shelves. */
  q: number
  /** Boost/cut in dB. Ignored by notches. */
  gain: number
}

/** A user-saved equalizer curve. */
export interface EqPreset {
  name: string
  bands: EqBand[]
}

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

/** Room character for the reverb; each has its own early reflections, tail colour and default decay. */
export type RoomKind = 'small' | 'hall' | 'cathedral' | 'plate'

export interface ReverbSettings {
  enabled: boolean
  room: RoomKind
  /** Seconds for the tail to fall by 60 dB (RT60). */
  decay: number
  /** Silence before the reverb starts, in milliseconds. */
  preDelayMs: number
  /** 0 = dry .. 1 = reverb only, equal-power crossfade. */
  mix: number
}

export interface CompressorSettings {
  enabled: boolean
  /** Level above which gain reduction starts, in dBFS. */
  threshold: number
  /** Input dB per output dB above the threshold (1 = no compression). */
  ratio: number
  /** Milliseconds to react to a loud signal. */
  attack: number
  /** Milliseconds to recover after it. */
  release: number
  /** Width in dB of the soft transition around the threshold. */
  knee: number
  /** Gain added after compression, in dB. */
  makeup: number
}

export interface LimiterSettings {
  enabled: boolean
  /** The level the output is held under, in dBFS. */
  ceiling: number
}

export interface DynamicsSettings {
  compressor: CompressorSettings
  limiter: LimiterSettings
}

/** Mid/side stereo processing. */
export interface StereoSettings {
  /** 0 = mono, 1 = unchanged, 2 = twice as wide. */
  width: number
  /** Sum both channels to mono (same as width 0, kept as its own switch for clarity). */
  mono: boolean
}

/** Simple bass / treble shelves in dB. */
export interface ToneSettings {
  bass: number
  treble: number
}

/** User preferences persisted in localStorage under `wl-settings`. */
export interface Settings {
  volume: number
  muted: boolean
  repeat: RepeatMode
  shuffle: boolean
  transition: TransitionMode
  /** The equalizer used by tracks without their own remembered EQ. */
  eqBands: EqBand[]
  eqPresets: EqPreset[]
  eqOn: boolean
  speed: number
  preservePitch: boolean
  normalize: boolean
  spatial: SpatialSettings
  reverb: ReverbSettings
  dynamics: DynamicsSettings
  stereo: StereoSettings
  tone: ToneSettings
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

/** A partial update to the dynamics settings (each processor merged separately). */
export interface DynamicsPatch {
  compressor?: Partial<CompressorSettings>
  limiter?: Partial<LimiterSettings>
}

/** Progress of a file import (`PlayerApi.importProgress`). */
export interface ImportProgress {
  /** Audio files to read in this import. */
  total: number
  /** Files read so far. */
  done: number
  /** Tracks added to the library so far. */
  added: number
}

/** Progress of the background library upgrade (`PlayerApi.upgradeProgress`). */
export interface UpgradeProgress {
  total: number
  done: number
}

/** Result of `PlayerApi.editTags`. */
export type TagEditOutcome = { ok: true; embedded: boolean } | { ok: false; error: string }

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
  /** Gains of every band in order (for the graphic view). */
  setEqBand: (index: number, gainDb: number) => void
  /** Apply a built-in graphic preset (replaces the bands with the standard 10-band layout). */
  applyPreset: (name: string) => void
  eqBands: EqBand[]
  updateEqBand: (id: string, patch: Partial<Omit<EqBand, 'id'>>) => void
  /** Add a band (default: a peak at 1 kHz) and return its id, or null when the limit is reached. */
  addEqBand: (band?: Partial<Omit<EqBand, 'id'>>) => string | null
  removeEqBand: (id: string) => void
  /** Back to the flat 10-band graphic layout. */
  resetEq: () => void
  /** True when the current track has its own remembered equalizer curve. */
  eqRemembered: boolean
  /** Give the current track its own equalizer (starting from the current curve), or return it to the shared one. */
  setEqRemembered: (on: boolean) => void
  eqPresets: EqPreset[]
  saveEqPreset: (name: string) => void
  loadEqPreset: (name: string) => void
  deleteEqPreset: (name: string) => void
  spatial: SpatialSettings
  /** Merge a change into the spatial settings (values are clamped/sanitized). */
  setSpatial: (patch: Partial<SpatialSettings>) => void
  reverb: ReverbSettings
  /** Merge a change into the reverb settings; picking a different room also loads that room's default decay and pre-delay. */
  setReverb: (patch: Partial<ReverbSettings>) => void
  dynamics: DynamicsSettings
  setDynamics: (patch: DynamicsPatch) => void
  stereo: StereoSettings
  setStereo: (patch: Partial<StereoSettings>) => void
  tone: ToneSettings
  setTone: (patch: Partial<ToneSettings>) => void
  /** Seconds left on the sleep timer, or null when it is off. */
  sleepLeft: number | null
  /** Start the sleep timer for `minutes`; 0 or null cancels it. */
  setSleep: (minutes: number | null) => void
  /** True while files are being imported (kept for callers that only need a spinner). */
  loading: boolean
  /** The import in progress: audio files read so far out of all, and tracks added; null when none is running. */
  importProgress: ImportProgress | null
  /** Stop the import in progress and any queued behind it. What was already read stays in the library. */
  cancelImport: () => void
  /** Background analysis of tracks stored before their details (durations, track numbers, format) were read; null when idle. */
  upgradeProgress: UpgradeProgress | null
  notice: string
  hydrated: boolean
  /** Progress (0..1) while the current WAV/FLAC file is being decoded in JavaScript, otherwise null. */
  decoding: number | null
  play: (id: string) => void
  toggle: () => void
  next: () => void
  prev: () => void
  seek: (seconds: number) => void
  /** The exact playhead in seconds, read from the audio element (`time` only updates a few times a second). */
  position: () => number
  seekBy: (delta: number) => void
  setVolume: (v: number) => void
  volumeBy: (delta: number) => void
  toggleMute: () => void
  cycleRepeat: () => void
  toggleShuffle: () => void
  /** Import files (audio plus optional `.lrc`); resolves with the number of tracks added. */
  addFiles: (files: Iterable<File> | ArrayLike<File>) => Promise<number>
  attachLrc: (file: Blob) => Promise<void>
  /**
   * Edit a track's title, artist, album and cover. The library record always changes; for MP3s the tags are also
   * written into the stored copy of the file. Never rejects: failures come back as `{ ok: false, error }`.
   */
  editTags: (id: string, edit: TagEdit) => Promise<TagEditOutcome>
  remove: (id: string) => void
  clear: () => void
  reorder: (from: number, to: number) => void
  createPlaylist: (name?: string, trackIds?: string[]) => string
  addToPlaylist: (playlistId: string, trackId: string) => void
  deletePlaylist: (id: string) => void
  /** Forget every play count and last-played time (the "most played" lists start over). */
  resetPlays: () => void
  /** The library's metadata, playlists and play counts (no audio) as the text of a JSON backup file. */
  exportBackup: () => string
  /** What restoring `backup` would do, without doing it. */
  previewBackup: (backup: Backup) => RestoreSummary
  /** Merge `backup` into the library. Whatever refers to files not in the library yet completes when they are added. */
  applyBackup: (backup: Backup) => RestoreSummary
  /** How many tracks from a restored backup are still waiting for their files. */
  pendingRestoreCount: number
  /** Give up on the tracks a restore is still waiting for. */
  discardPendingRestore: () => void
}

/** Keys and value shapes of the IndexedDB `meta` store. */
export interface MetaValues {
  order: string[]
  playlists: Playlist[]
  resume: ResumePoint | null
  /** Per-track equalizer curves, keyed by track id. */
  trackEq: Record<string, EqBand[]>
  /** The part of a restored backup still waiting for its files. */
  pendingRestore: PendingRestore | null
}
