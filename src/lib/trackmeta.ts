import type { TrackMeta } from '../types'
import type { AudioCodec, AudioContainer, AudioFormat } from './audio/probe/types'
import { cleanField } from './tags'

/**
 * The analysis fields of a library record. Records come out of IndexedDB, where an older version of the app (or a
 * damaged profile) may have left them missing or odd, so they are normalised on the way in.
 */

/**
 * Bumped whenever the analysis learns something new about files. A record analysed with an older version is upgraded in
 * the background (see `lib/upgrade.ts`); one that has never been analysed has version 0.
 */
export const INDEX_VERSION = 1

export const EMPTY_META: Readonly<TrackMeta> = Object.freeze({
  albumArtist: '',
  trackNo: 0,
  trackTotal: 0,
  discNo: 0,
  discTotal: 0,
  year: 0,
  genre: '',
  compilation: false,
  audio: null,
  indexed: 0,
})

const CONTAINERS: ReadonlySet<string> = new Set<AudioContainer>(['mp3', 'aac', 'mp4', 'ogg', 'flac', 'wav'])
const CODECS: ReadonlySet<string> = new Set<AudioCodec>(['mp1', 'mp2', 'mp3', 'aac', 'alac', 'vorbis', 'opus', 'flac', 'pcm', 'float', 'alaw', 'mulaw', 'unknown'])

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)
const count = (v: unknown, max: number): number => (typeof v === 'number' && Number.isInteger(v) && v >= 0 && v <= max ? v : 0)

/** A stored `AudioFormat`, or null when it is missing or not one. Numbers are repaired, the container and codec must be known. */
export function normalizeAudio(raw: unknown): AudioFormat | null {
  if (!isObj(raw) || !CONTAINERS.has(String(raw.container)) || !CODECS.has(String(raw.codec))) return null
  return {
    container: raw.container as AudioContainer,
    codec: raw.codec as AudioCodec,
    sampleRate: count(raw.sampleRate, 1_048_575),
    channels: count(raw.channels, 255),
    bitrate: count(raw.bitrate, 1e10),
    bitDepth: count(raw.bitDepth, 64),
    lossless: raw.lossless === true,
    vbr: raw.vbr === true,
    encoderDelay: count(raw.encoderDelay, 1e6),
    encoderPadding: count(raw.encoderPadding, 1e6),
  }
}

/** The analysis fields of a stored record, whatever state they are in: missing ones become neutral, odd ones are repaired. */
export function normalizeMeta(raw: unknown): TrackMeta {
  const r: Record<string, unknown> = isObj(raw) ? raw : {}
  const year = count(r.year, 2999)
  return {
    albumArtist: typeof r.albumArtist === 'string' ? cleanField(r.albumArtist) : '',
    trackNo: count(r.trackNo, 9999),
    trackTotal: count(r.trackTotal, 9999),
    discNo: count(r.discNo, 9999),
    discTotal: count(r.discTotal, 9999),
    year: year >= 1000 ? year : 0,
    genre: typeof r.genre === 'string' ? cleanField(r.genre).slice(0, 100) : '',
    compilation: r.compilation === true,
    audio: normalizeAudio(r.audio),
    indexed: count(r.indexed, 1000),
  }
}
