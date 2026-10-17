import type { AudioContainer } from '../audio/probe/types'

/**
 * How a track's waveform is to be measured, decided from what is known about the file before any audio is read (pure, so
 * every rule is tested exactly). The browser can decode almost any format but only into memory as a whole, and a long file
 * decodes to far more than its size: an hour-long MP3 of 60 MB is over a gigabyte of floats. So the rules are:
 *
 * - WAV and FLAC are read by the built-in decoders in a worker, in chunks, whatever their length.
 * - MP3 and ADTS AAC are cut into windows at byte offsets (the decoder finds the next frame by itself), each decoded and released.
 * - Anything else the browser can decode is decoded whole, but only if the decoded audio fits in a fixed amount of memory.
 */

const MiB = 1024 * 1024

export type PeaksMethod = 'lossless' | 'sliced' | 'whole'
export type PeaksPlan = { method: PeaksMethod } | { method: 'none'; why: 'too-long' | 'unsupported' }

export interface PlanInput {
  /** The container the probe found, or null when nothing recognised the file (the browser may still decode it). */
  container: AudioContainer | null
  /** Bytes. */
  size: number
  /** Seconds, 0 when the headers did not say. */
  duration: number
  /** Hz, 0 when unknown. */
  sampleRate: number
  /** 0 when unknown. */
  channels: number
}

/** A WAV or FLAC file is held in the worker's memory whole while it is decoded in chunks. */
export const LOSSLESS_LIMIT_BYTES = 512 * MiB
/** What `decodeAudioData` may be asked to produce in one go: samples as 32-bit floats, all channels. */
const WHOLE_DECODE_LIMIT_BYTES = 200 * MiB
/** A file that nothing recognised and whose length is unknown: small enough to try. */
const UNKNOWN_LENGTH_LIMIT_BYTES = 12 * MiB
const FLOAT_BYTES = 4
const ASSUMED_RATE = 48_000
const ASSUMED_CHANNELS = 2

export function planPeaks({ container, size, duration, sampleRate, channels }: PlanInput): PeaksPlan {
  if (container === 'wav' || container === 'flac') return size <= LOSSLESS_LIMIT_BYTES ? { method: 'lossless' } : { method: 'none', why: 'too-long' }
  if (container === 'mp3' || container === 'aac') return { method: 'sliced' }
  const decoded = duration > 0 ? duration * (sampleRate || ASSUMED_RATE) * (channels || ASSUMED_CHANNELS) * FLOAT_BYTES : Number.POSITIVE_INFINITY
  if (duration > 0 ? decoded <= WHOLE_DECODE_LIMIT_BYTES : size <= UNKNOWN_LENGTH_LIMIT_BYTES) return { method: 'whole' }
  return { method: 'none', why: 'too-long' }
}

/** A part of the file, `[start, end)` in bytes. */
export interface ByteWindow {
  start: number
  end: number
}

/** About how much audio one window holds. */
export const WINDOW_SECONDS = 90
/** A song up to this long is decoded in one go (about 127 MB of floats at 48 kHz stereo): exact, with no seams. */
const SINGLE_WINDOW_SECONDS = 330
const MIN_WINDOW_BYTES = 64 * 1024
const MAX_WINDOW_BYTES = 24 * MiB
const MAX_WINDOWS = 1000
/** 128 kbit/s, for a file whose length is not known. */
const ASSUMED_BYTES_PER_SECOND = 16_000

/**
 * Where to cut an MP3 (or ADTS AAC) file of `size` bytes whose audio starts at `audioStart` (after any ID3 tag) and lasts
 * `duration` seconds. The windows follow each other exactly, cover all the audio and are of equal size (a short last piece
 * would be a few frames the decoder could not make sense of).
 */
export function planWindows(size: number, audioStart: number, duration: number, seconds: number = WINDOW_SECONDS): ByteWindow[] {
  if (!Number.isFinite(size) || !Number.isFinite(audioStart)) return []
  const start = Math.max(0, Math.floor(audioStart))
  const audio = Math.floor(size) - start
  if (audio <= 0) return []
  const known = Number.isFinite(duration) && duration > 0
  if (known && duration <= SINGLE_WINDOW_SECONDS && audio <= MAX_WINDOW_BYTES) return [{ start, end: start + audio }]
  const perSecond = known ? audio / duration : ASSUMED_BYTES_PER_SECOND
  const target = Math.min(MAX_WINDOW_BYTES, Math.max(MIN_WINDOW_BYTES, Math.round(perSecond * seconds)))
  // never more than a thousand decode calls, but never a window above the byte limit either (that wins for absurd sizes)
  const count = Math.max(Math.min(Math.ceil(audio / target), MAX_WINDOWS), Math.ceil(audio / MAX_WINDOW_BYTES))
  return Array.from({ length: count }, (_, i) => ({ start: start + Math.floor((i * audio) / count), end: start + Math.floor(((i + 1) * audio) / count) }))
}
