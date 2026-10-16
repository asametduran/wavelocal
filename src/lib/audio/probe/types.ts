/** What a container probe reports. Type-only: no runtime code, so it can be imported anywhere (including `types.ts`). */

export type AudioContainer = 'mp3' | 'aac' | 'mp4' | 'ogg' | 'flac' | 'wav'

export type AudioCodec = 'mp1' | 'mp2' | 'mp3' | 'aac' | 'alac' | 'vorbis' | 'opus' | 'flac' | 'pcm' | 'float' | 'alaw' | 'mulaw' | 'unknown'

/**
 * What a file's headers say about its audio, everything except the duration (which lives on the track itself).
 * Unknown numbers are 0, never null, so the UI can test them with a plain truthiness check.
 */
export interface AudioFormat {
  container: AudioContainer
  codec: AudioCodec
  /** Hz. */
  sampleRate: number
  channels: number
  /** Average bits per second. */
  bitrate: number
  /** Bits per sample, for lossless sources. */
  bitDepth: number
  lossless: boolean
  vbr: boolean
  /** Samples a gapless player drops at the start and at the end (the LAME tag of an MP3). */
  encoderDelay: number
  encoderPadding: number
}

/** Raw tag text as found in a file, before it is turned into numbers (see `lib/tagfields.ts`). Every value is optional. */
export interface TagValues {
  title?: string
  artist?: string
  album?: string
  albumArtist?: string
  /** "3" or "3/12". */
  track?: string
  /** "1" or "1/2". */
  disc?: string
  /** A year or a full date. */
  date?: string
  genre?: string
  compilation?: string
  /** A ReplayGain track (or album) gain such as "-6.50 dB". */
  replayGain?: string
  lyrics?: string
}

export interface ProbeResult {
  format: AudioFormat
  /** Seconds, or null when the headers do not say. */
  duration: number | null
  /** Tags the probe read itself (Ogg, FLAC and WAV); MP3 and MP4 tags come from jsmediatags. */
  tags: TagValues
  /** Embedded cover art the probe found, as a slice of the file. */
  picture: Blob | null
}

export interface ProbeOptions {
  /** How far a variable-bitrate MP3 without a header is walked before the rest is extrapolated. Default 48 MiB. */
  maxScanBytes?: number
}

/** An `AudioFormat` for a container that could be identified but told us nothing else. */
export const blankFormat = (container: AudioContainer, codec: AudioCodec = 'unknown'): AudioFormat => ({
  container,
  codec,
  sampleRate: 0,
  channels: 0,
  bitrate: 0,
  bitDepth: 0,
  lossless: false,
  vbr: false,
  encoderDelay: 0,
  encoderPadding: 0,
})
