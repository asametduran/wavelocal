import { ascii } from '../source'
import type { ByteSource } from '../source'
import { probeAdts } from './adts'
import { probeFlac } from './flac'
import { skipId3v2 } from './id3'
import { probeMp3 } from './mp3'
import { probeMp4 } from './mp4'
import { probeOgg } from './ogg'
import { probeWav } from './wav'
import type { ProbeOptions, ProbeResult } from './types'

export type { AudioCodec, AudioContainer, AudioFormat, ProbeOptions, ProbeResult, TagValues } from './types'
export { MAX_PICTURE_BYTES } from '../vorbis'

/** Top-level box types an MP4 / MOV file may start with. */
const MP4_BOXES = new Set(['ftyp', 'moov', 'mdat', 'free', 'skip', 'wide', 'pnot', 'styp', 'uuid'])

/** Sample rates outside this range come from a damaged header, and so does a duration beyond a week. */
const MIN_SAMPLE_RATE = 1000
const MAX_SAMPLE_RATE = 1_048_575
const MAX_DURATION = 7 * 24 * 3600
const MAX_CHANNELS = 255

/**
 * Whatever a damaged header claims, what leaves the probe is plausible: an absurd sample rate (and the duration worked
 * out from it), duration, channel count or bitrate is dropped to "unknown" instead of reaching the library.
 */
function sanitize(r: ProbeResult | null): ProbeResult | null {
  if (!r) return null
  const format = { ...r.format }
  let duration = r.duration
  if (format.sampleRate !== 0 && (format.sampleRate < MIN_SAMPLE_RATE || format.sampleRate > MAX_SAMPLE_RATE)) {
    format.sampleRate = 0
    duration = null
  }
  if (format.channels > MAX_CHANNELS) format.channels = 0
  if (!Number.isFinite(format.bitrate) || format.bitrate < 0 || format.bitrate > 1e10) format.bitrate = 0
  if (duration !== null && (!Number.isFinite(duration) || duration < 0 || duration > MAX_DURATION)) duration = null
  return { ...r, format, duration }
}

/**
 * Identify an audio file from its bytes (names and MIME types lie) and read what its headers say: duration, sample
 * rate, channels, bitrate, bit depth, gapless padding, and the tags and artwork of the formats whose tags are not read
 * by jsmediatags (Ogg, FLAC, WAV). Reads only headers and the end of the file; resolves to null when the bytes are not
 * a container this knows (WebM, exotic formats, damaged files), and never throws on malformed input.
 */
export async function probeAudio(source: ByteSource, options: ProbeOptions = {}): Promise<ProbeResult | null> {
  return sanitize(await dispatch(source, options))
}

async function dispatch(source: ByteSource, options: ProbeOptions): Promise<ProbeResult | null> {
  const head = await source.read(0, 12)
  if (head.length < 4) return null
  const magic = ascii(head, 0, 4)
  if (magic === 'RIFF' || magic === 'RF64' || magic === 'BW64') return probeWav(source)
  if (magic === 'fLaC') return probeFlac(source)
  if (magic === 'OggS') return probeOgg(source)
  if (head.length >= 8 && MP4_BOXES.has(ascii(head, 4, 4))) return probeMp4(source)
  if (magic.startsWith('ID3') && ascii(await source.read(await skipId3v2(source), 4), 0, 4) === 'fLaC') return probeFlac(source)
  return (await probeMp3(source, options)) ?? (await probeAdts(source, options))
}
