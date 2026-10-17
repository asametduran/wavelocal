/**
 * What the waveform seek bar draws: the loudness of a track in a fixed number of slices. Type-only (no runtime code), so the
 * start-up code and the tests can import it freely.
 */

/** A track's loudness, cut into slices of equal length. Small enough (2 kB) to keep one for every track in the library. */
export interface Peaks {
  /** Layout version of the stored record: a change of the maths or the scale bumps it, and every track is computed again. */
  v: 1
  /** Seconds of audio the slices cover: the decoded length, which can differ a little from what the tag says. */
  duration: number
  /** Number of slices (`peak.length`, `rms.length`): fewer than the usual count for a very short track. */
  length: number
  /** The loudest sample of each slice, 0 (at or below the floor) to 255 (full scale), on the dB scale of `level()`. */
  peak: Uint8Array
  /** The RMS level of each slice, on the same scale. */
  rms: Uint8Array
}

/** Why a track has no waveform when that will not change by itself. */
export type NoPeaks = 'unsupported' | 'too-long'

export interface PeaksNone {
  v: 1
  none: NoPeaks
}

/** What is kept for a track: the waveform, or the reason there is none. */
export type PeaksRecord = Peaks | PeaksNone
