/**
 * Byte-exact builders for MP3, ADTS, MP4/M4A, Ogg and RIFF containers, so the container probes can be tested against
 * files whose duration, sample rate and tags are known by construction. The audio payload is silence: the frames are
 * structurally valid (which is also what a browser's own demuxer needs to report a duration), but nothing here is a
 * real encoder. The tables below are deliberately written out again instead of imported from the code under test.
 */

import type { ByteSource } from '../lib/audio/source'

type Bytes = ArrayLike<number>

/** Wrap a source and count what is read from it, to prove a probe only touches headers. */
export function countingSource(inner: ByteSource): ByteSource & { reads: number; bytes: number } {
  const counter = {
    size: inner.size,
    reads: 0,
    bytes: 0,
    async read(offset: number, length: number): Promise<Uint8Array> {
      const out = await inner.read(offset, length)
      counter.reads++
      counter.bytes += out.length
      return out
    },
  }
  return counter
}

/**
 * A huge file that exists only as its first bytes and, optionally, its last bytes (everything in between reads as
 * zeros) and costs no memory.
 */
export function virtualSource(size: number, head: Uint8Array, tail: Uint8Array = new Uint8Array(0)): ByteSource {
  return {
    size,
    async read(offset, length) {
      if (length <= 0 || offset < 0 || offset >= size) return new Uint8Array(0)
      const out = new Uint8Array(Math.min(length, size - offset))
      if (offset < head.length) out.set(head.subarray(offset, offset + out.length))
      const tailStart = size - tail.length
      if (offset + out.length > tailStart) {
        const from = Math.max(offset, tailStart)
        out.set(tail.subarray(from - tailStart, offset + out.length - tailStart), from - offset)
      }
      return out
    },
  }
}

/** Concatenate byte sequences. */
export function cat(...parts: Bytes[]): Uint8Array<ArrayBuffer> {
  let total = 0
  for (const p of parts) total += p.length
  const out = new Uint8Array(total)
  let at = 0
  for (const p of parts) {
    out.set(p, at)
    at += p.length
  }
  return out
}

export const ascii = (s: string): number[] => Array.from(s, (c) => c.charCodeAt(0) & 0xff)
const utf8 = (s: string): Uint8Array => new TextEncoder().encode(s)
const zeros = (n: number): number[] => new Array<number>(n).fill(0)

export const w16be = (n: number): number[] => [(n >> 8) & 0xff, n & 0xff]
export const w24be = (n: number): number[] => [(n >> 16) & 0xff, (n >> 8) & 0xff, n & 0xff]
export const w32be = (n: number): number[] => [Math.floor(n / 0x1000000) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff]
export const w64be = (n: number): number[] => [...w32be(Math.floor(n / 0x100000000)), ...w32be(n % 0x100000000)]
export const w16le = (n: number): number[] => [n & 0xff, (n >> 8) & 0xff]
export const w32le = (n: number): number[] => [n & 0xff, (n >>> 8) & 0xff, (n >>> 16) & 0xff, Math.floor(n / 0x1000000) & 0xff]
export const w64le = (n: number): number[] => [...w32le(n % 0x100000000), ...w32le(Math.floor(n / 0x100000000))]

// ---- ID3 ------------------------------------------------------------------------------------------------------

export const syncsafe = (n: number): number[] => [(n >> 21) & 0x7f, (n >> 14) & 0x7f, (n >> 7) & 0x7f, n & 0x7f]

/** An ID3v2.4 tag of `total` bytes (header included) that holds nothing but padding; optionally with a footer. */
export function id3v2Blank(total: number, { footer = false }: { footer?: boolean } = {}): Uint8Array<ArrayBuffer> {
  const body = total - 10 - (footer ? 10 : 0)
  if (body < 0) throw new RangeError('ID3 tag too small')
  const flags = footer ? 0x10 : 0
  const head = [...ascii('ID3'), 4, 0, flags, ...syncsafe(body)]
  const tail = footer ? [...ascii('3DI'), 4, 0, flags, ...syncsafe(body)] : []
  return cat(head, zeros(body), tail)
}

/** The 128-byte ID3v1 trailer. */
export const id3v1Tag = (): Uint8Array<ArrayBuffer> => cat(ascii('TAG'), zeros(125))

// ---- MP3 -------------------------------------------------------------------------------------------------------

export type MpegVersion = 1 | 2 | 2.5
export type MpegLayer = 1 | 2 | 3
export type ChannelMode = 'stereo' | 'joint' | 'dual' | 'mono'

const BITRATES: Record<string, readonly number[]> = {
  '1-1': [0, 32, 64, 96, 128, 160, 192, 224, 256, 288, 320, 352, 384, 416, 448],
  '1-2': [0, 32, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320, 384],
  '1-3': [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320],
  '2-1': [0, 32, 48, 56, 64, 80, 96, 112, 128, 144, 160, 176, 192, 224, 256],
  '2-2': [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160],
  '2-3': [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160],
}
const SAMPLE_RATES: Record<string, readonly number[]> = { '1': [44100, 48000, 32000], '2': [22050, 24000, 16000], '2.5': [11025, 12000, 8000] }
const MODE_BITS: Record<ChannelMode, number> = { stereo: 0, joint: 1, dual: 2, mono: 3 }

export interface Mp3FrameSpec {
  version?: MpegVersion
  layer?: MpegLayer
  bitrateKbps?: number
  sampleRate?: number
  mode?: ChannelMode
  /** Frames carry a (zeroed) 16-bit CRC after the header. */
  crc?: boolean
}

interface Frame {
  version: MpegVersion
  layer: MpegLayer
  bitrateKbps: number
  sampleRate: number
  mode: ChannelMode
  crc: boolean
}

function resolveFrame(spec: Mp3FrameSpec): Frame {
  const version = spec.version ?? 1
  return {
    version,
    layer: spec.layer ?? 3,
    bitrateKbps: spec.bitrateKbps ?? (version === 1 ? 128 : 64),
    sampleRate: spec.sampleRate ?? (version === 1 ? 44100 : version === 2 ? 22050 : 11025),
    mode: spec.mode ?? 'stereo',
    crc: spec.crc ?? false,
  }
}

/** Samples of audio in one frame. */
export const mpegSamplesPerFrame = (version: MpegVersion, layer: MpegLayer): number => (layer === 1 ? 384 : layer === 2 ? 1152 : version === 1 ? 1152 : 576)

function frameSize(frame: Frame, bitrateKbps: number): { base: number; slot: number; fraction: number } {
  const coefficient = frame.layer === 1 ? 12 : frame.layer === 3 && frame.version !== 1 ? 72 : 144
  const slot = frame.layer === 1 ? 4 : 1
  const exact = (coefficient * bitrateKbps * 1000) / frame.sampleRate
  return { base: Math.floor(exact) * slot, slot, fraction: exact - Math.floor(exact) }
}

/** One frame of silence with a valid header. `padding` adds the padding slot (the encoder's way of hitting an exact average). */
export function mp3Frame(spec: Mp3FrameSpec = {}, padding = false, bitrateKbps?: number): Uint8Array<ArrayBuffer> {
  const f = resolveFrame(spec)
  const kbps = bitrateKbps ?? f.bitrateKbps
  const table = BITRATES[`${f.version === 1 ? 1 : 2}-${f.layer}`] ?? []
  const bitrateIndex = table.indexOf(kbps)
  const rateIndex = (SAMPLE_RATES[String(f.version)] ?? []).indexOf(f.sampleRate)
  if (bitrateIndex < 1) throw new RangeError(`no MPEG${f.version} layer ${f.layer} bitrate of ${kbps} kbps`)
  if (rateIndex < 0) throw new RangeError(`no MPEG${f.version} sample rate of ${f.sampleRate} Hz`)
  const versionBits = f.version === 1 ? 3 : f.version === 2 ? 2 : 0
  const header = [0xff, 0xe0 | (versionBits << 3) | ((4 - f.layer) << 1) | (f.crc ? 0 : 1), (bitrateIndex << 4) | (rateIndex << 2) | (padding ? 2 : 0), MODE_BITS[f.mode] << 6]
  const size = frameSize(f, kbps)
  const frame = new Uint8Array(size.base + (padding ? size.slot : 0))
  frame.set(header)
  return frame
}

export interface XingSpec {
  tag?: 'Xing' | 'Info'
  /** The frame count the header declares (default: the real count); `null` leaves the field out. */
  frames?: number | null
  bytes?: boolean
  toc?: boolean
  quality?: boolean
  /** The LAME extension that follows the Xing fields. */
  lame?: { encoder?: string; delay: number; padding: number } | null
}

export interface Mp3Options extends Mp3FrameSpec {
  /** How many audio frames to write (the Xing/VBRI frame is extra). */
  frames: number
  /** Bitrates (kbps) cycled frame by frame: a variable-bitrate stream. */
  vbrKbps?: readonly number[]
  xing?: XingSpec
  vbri?: { frames?: number }
  id3v2?: Uint8Array
  /** Zero bytes between the ID3v2 tag and the first frame (some taggers leave padding). */
  gap?: number
  /** Bytes before everything else (a damaged or stripped file). */
  leading?: Uint8Array
  id3v1?: boolean
  trailing?: Uint8Array
}

const lameTag = ({ encoder = 'LAME3.99r', delay, padding }: { encoder?: string; delay: number; padding: number }): number[] => [
  ...ascii(encoder.padEnd(9, ' ').slice(0, 9)),
  0, // info tag revision / VBR method
  0, // lowpass
  ...zeros(4), // replay gain peak
  ...zeros(2), // radio gain
  ...zeros(2), // audiophile gain
  0, // encoding flags
  0, // ABR / minimum bitrate
  delay >> 4,
  ((delay & 0xf) << 4) | (padding >> 8),
  padding & 0xff,
  0, // misc
  0, // MP3 gain
  ...zeros(2), // preset / surround
  ...zeros(4), // music length
  ...zeros(2), // music CRC
  ...zeros(2), // tag CRC
]

const sideInfoBytes = (f: Frame): number => (f.version === 1 ? (f.mode === 'mono' ? 17 : 32) : f.mode === 'mono' ? 9 : 17)

function xingFrame(f: Frame, x: XingSpec, realFrames: number, audioBytes: number): Uint8Array<ArrayBuffer> {
  const frame = mp3Frame(f)
  const fields: number[] = []
  let flags = 0
  const declared = x.frames === undefined ? realFrames : x.frames
  if (declared !== null) {
    flags |= 1
    fields.push(...w32be(declared))
  }
  if (x.bytes) {
    flags |= 2
    fields.push(...w32be(audioBytes))
  }
  if (x.toc) {
    flags |= 4
    fields.push(...Array.from({ length: 100 }, (_, i) => Math.min(255, i * 2)))
  }
  if (x.quality) {
    flags |= 8
    fields.push(...w32be(75))
  }
  const body = [...ascii(x.tag ?? 'Xing'), 0, 0, 0, flags, ...fields, ...(x.lame ? lameTag(x.lame) : [])]
  const at = 4 + (f.crc ? 2 : 0) + sideInfoBytes(f)
  if (at + body.length > frame.length) throw new RangeError('frame too small for the Xing header')
  frame.set(body, at)
  return frame
}

function vbriFrame(f: Frame, frames: number, audioBytes: number): Uint8Array<ArrayBuffer> {
  const frame = mp3Frame(f)
  const body = [...ascii('VBRI'), ...w16be(1), ...w16be(0), ...w16be(0), ...w32be(audioBytes), ...w32be(frames), ...w16be(1), ...w16be(1), ...w16be(1), ...w16be(1)]
  frame.set(body, 36)
  return frame
}

/** Build an MP3 file of silence. The padding slot is spread over the frames like a real encoder does, so the average is exact. */
export function buildMp3(o: Mp3Options): Uint8Array<ArrayBuffer> {
  const f = resolveFrame(o)
  const audio: Uint8Array[] = []
  let carry = 0
  for (let i = 0; i < o.frames; i++) {
    const kbps = o.vbrKbps && o.vbrKbps.length ? (o.vbrKbps[i % o.vbrKbps.length] ?? f.bitrateKbps) : f.bitrateKbps
    carry += frameSize(f, kbps).fraction
    const pad = carry >= 1
    if (pad) carry -= 1
    audio.push(mp3Frame(f, pad, kbps))
  }
  const audioBytes = audio.reduce((n, a) => n + a.length, 0)
  const info = o.xing ? xingFrame(f, o.xing, o.frames, audioBytes) : o.vbri ? vbriFrame(f, o.vbri.frames ?? o.frames, audioBytes) : null
  return cat(o.leading ?? [], o.id3v2 ?? [], zeros(o.gap ?? 0), info ?? [], ...audio, o.id3v1 ? id3v1Tag() : [], o.trailing ?? [])
}

/** The duration in seconds of `frames` frames, by the definition every decoder uses. */
export const mp3Seconds = (frames: number, spec: Mp3FrameSpec = {}): number => {
  const f = resolveFrame(spec)
  return (frames * mpegSamplesPerFrame(f.version, f.layer)) / f.sampleRate
}

// ---- ADTS (raw AAC) --------------------------------------------------------------------------------------------

const ADTS_RATES = [96000, 88200, 64000, 48000, 44100, 32000, 24000, 22050, 16000, 12000, 11025, 8000, 7350]

export interface AdtsOptions {
  frames: number
  sampleRate?: number
  channels?: number
  /** Bytes per frame including the 7-byte header (default 400). */
  frameBytes?: number
  id3v2?: Uint8Array
  /** A frame count that the file physically has fewer of (truncated download). */
  cutBytes?: number
}

export function buildAdts(o: AdtsOptions): Uint8Array<ArrayBuffer> {
  const rate = o.sampleRate ?? 44100
  const index = ADTS_RATES.indexOf(rate)
  if (index < 0) throw new RangeError(`no ADTS sample rate of ${rate} Hz`)
  const channels = o.channels ?? 2
  const size = o.frameBytes ?? 400
  const frames: Uint8Array[] = []
  for (let i = 0; i < o.frames; i++) {
    const frame = new Uint8Array(size)
    frame.set([0xff, 0xf1, (1 << 6) | (index << 2) | ((channels >> 2) & 1), ((channels & 3) << 6) | ((size >> 11) & 3), (size >> 3) & 0xff, ((size & 7) << 5) | 0x1f, 0xfc])
    frames.push(frame)
  }
  const whole = cat(o.id3v2 ?? [], ...frames)
  return o.cutBytes ? whole.slice(0, whole.length - o.cutBytes) : whole
}

// ---- MP4 / M4A -------------------------------------------------------------------------------------------------

/** An ISO base media box (or a 64-bit "largesize" box). */
export function mp4Box(type: string, payload: Bytes = [], { large = false }: { large?: boolean } = {}): Uint8Array<ArrayBuffer> {
  return large ? cat(w32be(1), ascii(type), w64be(16 + payload.length), payload) : cat(w32be(8 + payload.length), ascii(type), payload)
}
const fullBox = (type: string, version: number, flags: number, payload: Bytes): Uint8Array<ArrayBuffer> => mp4Box(type, cat([version], w24be(flags), payload))

export interface Mp4Options {
  seconds: number
  codec?: 'aac' | 'alac' | 'mp3'
  sampleRate?: number
  channels?: number
  bitDepth?: number
  /** Average bit rate written into the codec configuration (0 = leave unknown). */
  avgBitrate?: number
  /** The movie header's own time scale (audio tracks use the sample rate). Default 1000. */
  movieTimescale?: number
  /** Put `moov` after `mdat` (a file that was not optimised for streaming). */
  moovAtEnd?: boolean
  /** 64-bit mvhd/mdhd fields. */
  version1?: boolean
  /** Give `mdat` a 64-bit size. */
  largeMdat?: boolean
  /** A video track in front of the audio track (cover art stored as a track, or a music video). */
  videoTrackFirst?: boolean
  mdatBytes?: number
  /** Leave the audio track's own durations (media and track header) at 0; the movie header still has it. */
  noMediaDuration?: boolean
  /** Extra samples at the start of the media that the edit list skips (AAC encoders add 1024): `mdhd` is longer than the track. */
  priming?: number
  /** Write a sample size table (`stsz`): every sample's size in bytes, or `{ count, size }` for a constant size. */
  samples?: number[] | { count: number; size: number }
  /** Wrap `moov` in extra boxes the walker has to skip. */
  freeBefore?: number
}

const IDENTITY_MATRIX = [...w32be(0x10000), ...zeros(12), ...w32be(0x10000), ...zeros(12), ...w32be(0x40000000)]

function mvhd(timescale: number, duration: number, v1: boolean): Uint8Array<ArrayBuffer> {
  const times = v1 ? [...w64be(0), ...w64be(0), ...w32be(timescale), ...w64be(duration)] : [...w32be(0), ...w32be(0), ...w32be(timescale), ...w32be(duration)]
  return fullBox('mvhd', v1 ? 1 : 0, 0, [...times, ...w32be(0x10000), ...w16be(0x100), ...zeros(10), ...IDENTITY_MATRIX, ...zeros(24), ...w32be(2)])
}

function mdhd(timescale: number, duration: number, v1: boolean): Uint8Array<ArrayBuffer> {
  const times = v1 ? [...w64be(0), ...w64be(0), ...w32be(timescale), ...w64be(duration)] : [...w32be(0), ...w32be(0), ...w32be(timescale), ...w32be(duration)]
  return fullBox('mdhd', v1 ? 1 : 0, 0, [...times, ...w16be(0x55c4), ...w16be(0)])
}

const hdlr = (kind: 'soun' | 'vide'): Uint8Array<ArrayBuffer> => fullBox('hdlr', 0, 0, [...w32be(0), ...ascii(kind), ...zeros(12), ...ascii('x'), 0])

/** The track header; its duration is in movie time-scale units and already reflects the edit list (priming samples cut). */
const tkhd = (id: number, duration: number): Uint8Array<ArrayBuffer> => fullBox('tkhd', 0, 7, [...w32be(0), ...w32be(0), ...w32be(id), ...w32be(0), ...w32be(duration), ...zeros(8), ...w16be(0), ...w16be(0), ...w16be(0x100), ...w16be(0), ...IDENTITY_MATRIX, ...w32be(0), ...w32be(0)])

/** An expandable descriptor length, one byte (the builder keeps every descriptor under 128 bytes). */
const descriptor = (tag: number, body: Bytes): number[] => [tag, body.length, ...Array.from(body)]

function esds(objectType: number, avgBitrate: number): Uint8Array<ArrayBuffer> {
  const config = descriptor(0x04, [objectType, 0x15, ...w24be(0), ...w32be(avgBitrate), ...w32be(avgBitrate), ...descriptor(0x05, [0x12, 0x10])])
  return fullBox('esds', 0, 0, descriptor(0x03, [...w16be(1), 0, ...config, ...descriptor(0x06, [2])]))
}

function audioEntry(type: string, o: { channels: number; bitDepth: number; sampleRate: number }, children: Bytes[]): Uint8Array<ArrayBuffer> {
  // the entry's 16.16 fixed-point rate cannot hold 65536 Hz or more: real files leave it 0 and the rate lives elsewhere
  const body = cat(zeros(6), w16be(1), zeros(8), w16be(o.channels), w16be(o.bitDepth), w16be(0), w16be(0), w32be(o.sampleRate < 65536 ? o.sampleRate * 0x10000 : 0), ...children)
  return mp4Box(type, body)
}

function stsdFor(o: Mp4Options): Uint8Array<ArrayBuffer> {
  const codec = o.codec ?? 'aac'
  const sampleRate = o.sampleRate ?? 44100
  const channels = o.channels ?? 2
  if (codec === 'alac') {
    const bitDepth = o.bitDepth ?? 16
    const magic = fullBox('alac', 0, 0, [...w32be(4096), 0, bitDepth, 40, 10, 14, channels, ...w16be(255), ...w32be(0), ...w32be(o.avgBitrate ?? 0), ...w32be(sampleRate)])
    return fullBox('stsd', 0, 0, cat(w32be(1), audioEntry('alac', { channels, bitDepth, sampleRate }, [magic])))
  }
  const entry = audioEntry('mp4a', { channels, bitDepth: 16, sampleRate }, [esds(codec === 'mp3' ? 0x6b : 0x40, o.avgBitrate ?? 0)])
  return fullBox('stsd', 0, 0, cat(w32be(1), entry))
}

/** A `trak` for sound (or, for the decoy video track, an empty video description). */
function trak(o: Mp4Options, kind: 'soun' | 'vide', id: number): Uint8Array<ArrayBuffer> {
  const rate = o.sampleRate ?? 44100
  const v1 = o.version1 ?? false
  const timescale = kind === 'soun' ? rate : 600
  const movieScale = o.movieTimescale ?? 1000
  const none = kind === 'soun' && o.noMediaDuration
  const mediaDuration = none ? 0 : Math.round(o.seconds * timescale) + (kind === 'soun' ? (o.priming ?? 0) : 0)
  const trackDuration = none ? 0 : Math.round(o.seconds * movieScale)
  const sizes = o.samples
  const stsz = sizes
    ? Array.isArray(sizes)
      ? fullBox('stsz', 0, 0, cat(w32be(0), w32be(sizes.length), ...sizes.map(w32be)))
      : fullBox('stsz', 0, 0, cat(w32be(sizes.size), w32be(sizes.count)))
    : null
  const stbl = mp4Box('stbl', kind === 'soun' ? cat(stsdFor(o), stsz ?? []) : fullBox('stsd', 0, 0, cat(w32be(1), mp4Box('avc1', zeros(78)))))
  return mp4Box('trak', cat(tkhd(id, trackDuration), mp4Box('mdia', cat(mdhd(timescale, mediaDuration, v1), hdlr(kind), mp4Box('minf', stbl)))))
}

export function buildMp4(o: Mp4Options): Uint8Array<ArrayBuffer> {
  const movieTimescale = o.movieTimescale ?? 1000
  const ftyp = mp4Box('ftyp', [...ascii('M4A '), ...w32be(0), ...ascii('M4A '), ...ascii('mp42'), ...ascii('isom')])
  const moov = mp4Box('moov', cat(mvhd(movieTimescale, Math.round(o.seconds * movieTimescale), o.version1 ?? false), ...(o.videoTrackFirst ? [trak(o, 'vide', 1)] : []), trak(o, 'soun', o.videoTrackFirst ? 2 : 1)))
  const mdat = mp4Box('mdat', new Uint8Array(o.mdatBytes ?? 2048), { large: o.largeMdat ?? false })
  const free = o.freeBefore ? [mp4Box('free', new Uint8Array(o.freeBefore))] : []
  return o.moovAtEnd ? cat(ftyp, ...free, mdat, moov) : cat(ftyp, ...free, moov, mdat)
}

// ---- Ogg ---------------------------------------------------------------------------------------------------------

const OGG_CRC = (() => {
  const table = new Uint32Array(256)
  for (let i = 0; i < 256; i++) {
    let r = i << 24
    for (let j = 0; j < 8; j++) r = r & 0x80000000 ? (r << 1) ^ 0x04c11db7 : r << 1
    table[i] = r >>> 0
  }
  return table
})()

function oggCrc(bytes: Uint8Array): number {
  let crc = 0
  for (const b of bytes) crc = ((crc << 8) ^ (OGG_CRC[((crc >>> 24) ^ b) & 0xff] ?? 0)) >>> 0
  return crc
}

export interface OggPageSpec {
  packets: Uint8Array[]
  /** Granule position; -1 means "no packet finishes on this page". */
  granule: number
  headerType?: number
  serial?: number
  sequence?: number
}

interface RawPage {
  lacing: number[]
  body: Uint8Array[]
  granule: number
  headerType: number
  serial: number
  sequence: number
}

function oggPageRaw(p: RawPage): Uint8Array<ArrayBuffer> {
  if (p.lacing.length > 255) throw new RangeError('too many segments for one Ogg page')
  const granule = p.granule < 0 ? [0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff] : w64le(p.granule)
  const head = [...ascii('OggS'), 0, p.headerType, ...granule, ...w32le(p.serial), ...w32le(p.sequence), 0, 0, 0, 0, p.lacing.length, ...p.lacing]
  const page = cat(head, ...p.body)
  page.set(w32le(oggCrc(page)), 22)
  return page
}

/** One Ogg page with a correct CRC. Each packet must be shorter than 255 * 255 bytes. */
export function oggPage(spec: OggPageSpec): Uint8Array<ArrayBuffer> {
  const lacing: number[] = []
  for (const p of spec.packets) {
    let left = p.length
    while (left >= 255) {
      lacing.push(255)
      left -= 255
    }
    lacing.push(left)
  }
  return oggPageRaw({ lacing, body: spec.packets, granule: spec.granule, headerType: spec.headerType ?? 0, serial: spec.serial ?? 1, sequence: spec.sequence ?? 0 })
}

/**
 * Pack packets into as many pages as they need, the way a real muxer does: a long packet continues on the next page
 * (continued-packet flag set, granule position -1 on the page that ends mid-packet).
 */
export function oggPackets(packets: Uint8Array[], o: { granule: number; serial?: number; firstSequence?: number; headerType?: number }): Uint8Array<ArrayBuffer>[] {
  const segments: { bytes: Uint8Array; ends: boolean }[] = []
  for (const p of packets) {
    let at = 0
    for (;;) {
      const take = Math.min(255, p.length - at)
      segments.push({ bytes: p.subarray(at, at + take), ends: take < 255 })
      at += take
      if (take < 255) break
      if (at === p.length) {
        segments.push({ bytes: new Uint8Array(0), ends: true }) // a packet that is an exact multiple of 255 needs a 0 to end it
        break
      }
    }
  }
  const pages: Uint8Array<ArrayBuffer>[] = []
  let continued = false
  for (let i = 0; i < segments.length; i += 255) {
    const chunk = segments.slice(i, i + 255)
    const endsPacket = chunk[chunk.length - 1]?.ends ?? true
    pages.push(
      oggPageRaw({
        lacing: chunk.map((s) => s.bytes.length),
        body: chunk.map((s) => s.bytes),
        granule: endsPacket ? o.granule : -1,
        headerType: (i === 0 ? (o.headerType ?? 0) : 0) | (continued ? 1 : 0),
        serial: o.serial ?? 1,
        sequence: (o.firstSequence ?? 0) + pages.length,
      }),
    )
    continued = !endsPacket
  }
  return pages
}

export interface OggOptions {
  codec: 'vorbis' | 'opus'
  seconds: number
  /** Vorbis: the stream's rate. Opus: the original input rate stored in the header (decoding is always 48 kHz). */
  sampleRate?: number
  channels?: number
  preSkip?: number
  vendor?: string
  comments?: readonly string[]
  nominalBitrate?: number
  /** Pages of audio between the headers and the end of the stream. */
  audioPages?: number
  /** The final page carries no granule position (its last packet continues on a page that never came). */
  unsetFinalGranule?: boolean
  /** Junk after the last page. */
  trailing?: number
}

/** A Vorbis comment block (vendor string, then `NAME=value` entries), the layout shared by Ogg, Opus and FLAC. */
export const vorbisComments = (vendor: string, comments: readonly string[]): number[] => {
  const v = utf8(vendor)
  const entries = comments.flatMap((c) => {
    const e = utf8(c)
    return [...w32le(e.length), ...e]
  })
  return [...w32le(v.length), ...v, ...w32le(comments.length), ...entries]
}
const commentBlock = vorbisComments

export function buildOgg(o: OggOptions): Uint8Array<ArrayBuffer> {
  const channels = o.channels ?? 2
  const sampleRate = o.sampleRate ?? (o.codec === 'opus' ? 48000 : 44100)
  const vendor = o.vendor ?? 'wavelocal-test'
  const comments = o.comments ?? []
  const preSkip = o.preSkip ?? 312
  const rate = o.codec === 'opus' ? 48000 : sampleRate
  const total = Math.round(o.seconds * rate) + (o.codec === 'opus' ? preSkip : 0)
  const bitrate = o.nominalBitrate ?? 0

  const pages: Uint8Array[] = []
  let sequence = 0
  const push = (spec: Omit<OggPageSpec, 'sequence'>) => pages.push(oggPage({ ...spec, sequence: sequence++ }))
  const pushPackets = (packets: Uint8Array[]) => {
    const made = oggPackets(packets, { granule: 0, firstSequence: sequence })
    pages.push(...made)
    sequence += made.length
  }
  // parts are numbers or byte lists: nothing is spread into a call, because a cover-art comment can be hundreds of KB
  const bytes = (...parts: (number | ArrayLike<number>)[]): Uint8Array => cat(...parts.map((p) => (typeof p === 'number' ? [p] : p)))

  if (o.codec === 'vorbis') {
    const id = bytes(1, ascii('vorbis'), w32le(0), channels, w32le(sampleRate), w32le(0), w32le(bitrate), w32le(0), 0xb8, 1)
    const comment = bytes(3, ascii('vorbis'), commentBlock(vendor, comments), 1)
    const setup = bytes(5, ascii('vorbis'), zeros(64))
    push({ packets: [id], granule: 0, headerType: 2 })
    pushPackets([comment, setup])
  } else {
    const head = bytes(ascii('OpusHead'), 1, channels, w16le(preSkip), w32le(sampleRate), w16le(0), 0)
    const tags = bytes(ascii('OpusTags'), commentBlock(vendor, comments))
    push({ packets: [head], granule: 0, headerType: 2 })
    pushPackets([tags])
  }

  const count = Math.max(1, o.audioPages ?? 4)
  const silence = new Uint8Array(120)
  for (let i = 0; i < count; i++) {
    const last = i === count - 1
    const second = o.unsetFinalGranule && count > 1 && i === count - 2
    let granule = Math.round((total * (i + 1)) / count)
    if (o.unsetFinalGranule && count > 1) granule = second ? total : last ? -1 : Math.round((total * (i + 1)) / count)
    push({ packets: [silence], granule, headerType: last ? 4 : 0 })
  }
  return cat(...pages, zeros(o.trailing ?? 0))
}

// ---- RIFF / WAVE variants ----------------------------------------------------------------------------------------

export interface RiffOptions {
  sampleRate?: number
  channels?: number
  bits?: number
  /** WAVE format tag: 1 PCM (default), 3 IEEE float, 6 A-law, 7 mu-law. */
  tag?: number
  frames: number
  /** `LIST`/`INFO` entries, e.g. `{ INAM: 'Title' }`, written before the audio. */
  info?: Record<string, string>
  /** Write the INFO list after the audio instead. */
  infoAfter?: boolean
  /** Declare the data chunk as 0 bytes long (a streaming writer that never came back to fix the header). */
  streaming?: boolean
  /** A 64-bit RF64 file. */
  rf64?: boolean
  /** A chunk of this many padding bytes before `data`. */
  junk?: number
  /** Bytes cut from the end (a truncated download). */
  cut?: number
  /** Use a WAVE_FORMAT_EXTENSIBLE format chunk. */
  extensible?: boolean
}

function infoList(info: Record<string, string>): number[] {
  const items = Object.entries(info).flatMap(([id, value]) => {
    const text = [...utf8(value), 0]
    const padded = text.length % 2 ? [...text, 0] : text
    return [...ascii(id), ...w32le(text.length), ...padded]
  })
  return [...ascii('LIST'), ...w32le(4 + items.length), ...ascii('INFO'), ...items]
}

export function buildRiff(o: RiffOptions): Uint8Array<ArrayBuffer> {
  const channels = o.channels ?? 2
  const bits = o.bits ?? 16
  const rate = o.sampleRate ?? 44100
  const blockAlign = (channels * bits) / 8
  const dataBytes = o.frames * blockAlign
  const fmtBody = o.extensible
    ? [...w16le(0xfffe), ...w16le(channels), ...w32le(rate), ...w32le(rate * blockAlign), ...w16le(blockAlign), ...w16le(bits), ...w16le(22), ...w16le(bits), ...w32le(3), ...w16le(1), 0, 0, 0, 0, 0x10, 0, 0x80, 0, 0, 0xaa, 0, 0x38, 0x9b, 0x71]
    : [...w16le(o.tag ?? 1), ...w16le(channels), ...w32le(rate), ...w32le(rate * blockAlign), ...w16le(blockAlign), ...w16le(bits)]
  const fmt = [...ascii('fmt '), ...w32le(fmtBody.length), ...fmtBody]
  const list = o.info ? infoList(o.info) : []
  const junk = o.junk ? [...ascii('JUNK'), ...w32le(o.junk), ...zeros(o.junk + (o.junk % 2))] : []
  const declared = o.streaming ? 0 : dataBytes
  const data = [...ascii('data'), ...w32le(o.rf64 && !o.streaming ? 0xffffffff : declared)]
  const ds64 = o.rf64 ? [...ascii('ds64'), ...w32le(28), ...w64le(0), ...w64le(dataBytes), ...w64le(o.frames), ...w32le(0)] : []
  const audio = new Uint8Array(dataBytes)
  const body = cat(ascii('WAVE'), ds64, fmt, o.infoAfter ? [] : list, junk, data, audio, o.infoAfter ? list : [])
  const out = cat(ascii(o.rf64 ? 'RF64' : 'RIFF'), w32le(o.rf64 ? 0xffffffff : body.length), body)
  return o.cut ? out.slice(0, out.length - o.cut) : out
}
