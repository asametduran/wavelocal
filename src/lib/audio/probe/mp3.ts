import { ascii, be32, le32 } from '../source'
import type { ByteSource } from '../source'
import { skipId3v2 } from './id3'
import { blankFormat } from './types'
import type { AudioCodec, ProbeOptions, ProbeResult } from './types'

/**
 * MP3 (MPEG audio layers I-III) probe. The duration comes from, in order of trust: a Xing/Info or VBRI header (exact
 * frame count, plus the LAME encoder delay and padding), a walk over every frame (variable bitrate without a header),
 * or the file size and the bitrate (constant bitrate). Only the first frames and the last few bytes are read, except
 * for the variable-bitrate walk, which is capped.
 */

type Version = 1 | 2 | 2.5
type Layer = 1 | 2 | 3

interface Frame {
  version: Version
  layer: Layer
  /** Bits per second. */
  bitrate: number
  sampleRate: number
  /** Channel mode bits: 3 is mono. */
  mode: number
  crc: boolean
  /** Bytes, header included. */
  length: number
  /** Samples of audio per channel in this frame. */
  samples: number
}

const BITRATES: readonly (readonly (readonly number[])[])[] = [
  // MPEG-1, layers I, II, III
  [
    [0, 32, 64, 96, 128, 160, 192, 224, 256, 288, 320, 352, 384, 416, 448],
    [0, 32, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320, 384],
    [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320],
  ],
  // MPEG-2 and 2.5, layers I, II, III
  [
    [0, 32, 48, 56, 64, 80, 96, 112, 128, 144, 160, 176, 192, 224, 256],
    [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160],
    [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160],
  ],
]
const SAMPLE_RATES: Record<Version, readonly number[]> = { 1: [44100, 48000, 32000], 2: [22050, 24000, 16000], 2.5: [11025, 12000, 8000] }

/** How far past the ID3 tag the first frame is looked for: a short first look, then the whole range if that finds nothing. */
const SYNC_NEAR = 32 * 1024
const SYNC_SEARCH = 64 * 1024
/** Extra bytes read so the frames after a candidate near the end of the search can be checked too. */
const SYNC_MARGIN = 8 * 1024
/** A candidate must be followed by this many frames of the same stream (fewer only when the file ends first). */
const CHAIN = 3
const SCAN_BLOCK = 256 * 1024
const DEFAULT_MAX_SCAN = 48 * 1024 * 1024

const CODECS: Record<Layer, AudioCodec> = { 1: 'mp1', 2: 'mp2', 3: 'mp3' }

function parseFrame(b: Uint8Array, o: number): Frame | null {
  if (o < 0 || o + 4 > b.length || b[o] !== 0xff) return null
  const h1 = b[o + 1] ?? 0
  if ((h1 & 0xe0) !== 0xe0) return null
  const versionBits = (h1 >> 3) & 3
  const layerBits = (h1 >> 1) & 3
  if (versionBits === 1 || layerBits === 0) return null
  const h2 = b[o + 2] ?? 0
  const bitrateIndex = h2 >> 4
  const rateIndex = (h2 >> 2) & 3
  if (bitrateIndex === 0 || bitrateIndex === 15 || rateIndex === 3) return null
  const version: Version = versionBits === 3 ? 1 : versionBits === 2 ? 2 : 2.5
  const layer = (4 - layerBits) as Layer
  const kbps = BITRATES[version === 1 ? 0 : 1]?.[layer - 1]?.[bitrateIndex] ?? 0
  const sampleRate = SAMPLE_RATES[version][rateIndex] ?? 0
  if (!kbps || !sampleRate) return null
  const bitrate = kbps * 1000
  const padding = (h2 >> 1) & 1
  const samples = layer === 1 ? 384 : layer === 2 || version === 1 ? 1152 : 576
  const length = layer === 1 ? (Math.floor((12 * bitrate) / sampleRate) + padding) * 4 : Math.floor(((layer === 3 && version !== 1 ? 72 : 144) * bitrate) / sampleRate) + padding
  return { version, layer, bitrate, sampleRate, mode: ((b[o + 3] ?? 0) >> 6) & 3, crc: (h1 & 1) === 0, length, samples }
}

const sameStream = (a: Frame, b: Frame): boolean => a.version === b.version && a.layer === b.layer && a.sampleRate === b.sampleRate

/**
 * The frames that chain from `o`: each starts where the previous one ends and belongs to the same stream. `limit` is
 * where the audio ends in this buffer's coordinates; a sequence that tiles the audio exactly to that point is complete
 * even when it is shorter than `CHAIN` (a file of one or two frames).
 */
function chainFrom(b: Uint8Array, o: number, limit: number): { count: number; atEnd: boolean } {
  let pos = o
  let first: Frame | null = null
  let count = 0
  while (count < CHAIN && pos < limit) {
    const f = parseFrame(b, pos)
    if (!f || (first && !sameStream(first, f))) break
    first ??= f
    count++
    pos += f.length
  }
  return { count, atEnd: count > 0 && pos === limit }
}

/** Offset (from the buffer start) of the first frame that really starts an MP3 stream, or -1. */
function findFirstFrame(b: Uint8Array, from: number, limit: number, searchEnd: number): number {
  for (let p = b.indexOf(0xff, from); p >= 0 && p < searchEnd; p = b.indexOf(0xff, p + 1)) {
    const { count, atEnd } = chainFrom(b, p, limit)
    if (count >= CHAIN || (count >= 1 && atEnd)) return p
  }
  return -1
}

/** Where the audio ends: before an ID3v1 trailer and an APEv2 tag. */
async function audioEnd(source: ByteSource, start: number): Promise<number> {
  let end = source.size
  if (end - start >= 128) {
    const tail = await source.read(end - 128, 3)
    if (ascii(tail, 0, 3) === 'TAG') end -= 128
  }
  if (end - start >= 32) {
    const footer = await source.read(end - 32, 32)
    if (ascii(footer, 0, 8) === 'APETAGEX') {
      const size = le32(footer, 12)
      const hasHeader = (le32(footer, 20) & 0x80000000) !== 0
      const total = size + (hasHeader ? 32 : 0)
      if (total > 0 && total <= end - start) end -= total
    }
  }
  return Math.max(start, end)
}

interface Header {
  kind: 'xing' | 'info' | 'vbri'
  frames: number
  bytes: number
  delay: number
  padding: number
}

const printable = (s: string): boolean => /^[A-Za-z][\x20-\x7e]{8}$/.test(s)

/** The Xing/Info or VBRI header inside the first frame, if it has one. `b` holds the frame at `at`. */
function readHeader(b: Uint8Array, at: number, f: Frame): Header | null {
  const sideInfo = f.version === 1 ? (f.mode === 3 ? 17 : 32) : f.mode === 3 ? 9 : 17
  const base = at + 4 + sideInfo
  for (const x of f.crc ? [base + 2, base] : [base]) {
    const tag = ascii(b, x, 4)
    if (tag !== 'Xing' && tag !== 'Info') continue
    const flags = be32(b, x + 4)
    let o = x + 8
    let frames = 0
    let bytes = 0
    if (flags & 1) {
      frames = be32(b, o)
      o += 4
    }
    if (flags & 2) {
      bytes = be32(b, o)
      o += 4
    }
    if (flags & 4) o += 100
    if (flags & 8) o += 4
    let delay = 0
    let padding = 0
    if (o + 24 <= b.length && printable(ascii(b, o, 9))) {
      delay = ((b[o + 21] ?? 0) << 4) | ((b[o + 22] ?? 0) >> 4)
      padding = (((b[o + 22] ?? 0) & 0x0f) << 8) | (b[o + 23] ?? 0)
    }
    return { kind: tag === 'Xing' ? 'xing' : 'info', frames, bytes, delay, padding }
  }
  if (ascii(b, at + 36, 4) === 'VBRI') return { kind: 'vbri', frames: be32(b, at + 36 + 14), bytes: be32(b, at + 36 + 10), delay: 0, padding: 0 }
  return null
}

interface Walk {
  frames: number
  samples: number
  bytes: number
  /** True when the walk reached the end of the audio instead of running out of budget. */
  complete: boolean
}

/** Count the frames of a stream from `from` to `to`, at most `budget` bytes of it. */
async function walk(source: ByteSource, first: Frame, from: number, to: number, budget: number): Promise<Walk> {
  const out: Walk = { frames: 0, samples: 0, bytes: 0, complete: false }
  let block: Uint8Array = new Uint8Array(0)
  let blockStart = 0
  let pos = from
  while (pos < to) {
    if (out.bytes >= budget) return out
    if (pos < blockStart || pos + 4 > blockStart + block.length) {
      blockStart = pos
      block = await source.read(pos, Math.min(SCAN_BLOCK, budget - out.bytes + 4096, to - pos))
      if (block.length < 4) break
    }
    const f = parseFrame(block, pos - blockStart)
    if (!f || !sameStream(first, f)) {
      // lost sync: look a little further for the stream to pick up again, otherwise treat the rest as non-audio
      const next = findFirstFrame(block, pos - blockStart + 1, to - blockStart, Math.min(block.length, pos - blockStart + 4096))
      if (next < 0) break
      pos = blockStart + next
      continue
    }
    out.frames++
    out.samples += f.samples
    out.bytes += f.length
    pos += f.length
  }
  out.complete = true
  return out
}

export async function probeMp3(source: ByteSource, options: ProbeOptions = {}): Promise<ProbeResult | null> {
  if (source.size < 4) return null
  const start = await skipId3v2(source)
  if (start + 4 > source.size) return null
  const end = await audioEnd(source, start)

  let window = await source.read(start, SYNC_NEAR + SYNC_MARGIN)
  let offset = findFirstFrame(window, 0, end - start, Math.min(window.length, SYNC_NEAR))
  if (offset < 0 && end - start > SYNC_NEAR) {
    window = await source.read(start, SYNC_SEARCH + SYNC_MARGIN)
    offset = findFirstFrame(window, 0, end - start, Math.min(window.length, SYNC_SEARCH))
  }
  if (offset < 0) return null
  const first = parseFrame(window, offset)
  if (!first) return null
  const firstAt = start + offset

  const header = readHeader(window, offset, first)
  const audioStart = header ? firstAt + first.length : firstAt
  const available = Math.max(0, end - audioStart)
  const seconds = (samples: number): number => samples / first.sampleRate

  let duration: number | null = null
  let bitrate = first.bitrate
  let vbr = false
  let delay = 0
  let padding = 0

  if (header && header.frames > 0) {
    let frames = header.frames
    // a download that stopped early still carries the full count: believe the bytes that are really there
    if (header.bytes > 0 && header.bytes > available * 1.02 + first.length) frames = Math.floor((frames * available) / header.bytes)
    const total = frames * first.samples
    if (header.delay + header.padding < total) {
      delay = header.delay
      padding = header.padding
    }
    duration = seconds(Math.max(0, total - delay - padding))
    vbr = header.kind !== 'info'
    // a constant-bitrate file says what its bitrate is; for the others the average is bytes over duration
    if (vbr && duration > 0) bitrate = Math.round(((header.bytes > 0 ? Math.min(header.bytes, available) : available) * 8) / duration)
  } else {
    // no usable header: is the bitrate constant? (the window already holds the first frames)
    let pos = offset + (header ? first.length : 0)
    const rates = new Set<number>()
    for (let i = 0; i < 64; i++) {
      const f = parseFrame(window, pos)
      if (!f || !sameStream(first, f)) break
      rates.add(f.bitrate)
      pos += f.length
    }
    if (rates.size <= 1) {
      duration = (available * 8) / first.bitrate
    } else {
      const budget = options.maxScanBytes ?? DEFAULT_MAX_SCAN
      const w = await walk(source, first, audioStart, end, budget)
      if (w.frames > 0) {
        const scale = w.complete ? 1 : available / Math.max(1, w.bytes)
        duration = seconds(w.samples) * scale
        bitrate = duration > 0 ? Math.round((available * 8) / duration) : first.bitrate
      }
      vbr = true
    }
  }

  return {
    format: { ...blankFormat('mp3', CODECS[first.layer]), sampleRate: first.sampleRate, channels: first.mode === 3 ? 1 : 2, bitrate, vbr, encoderDelay: delay, encoderPadding: padding },
    duration: duration !== null && Number.isFinite(duration) ? Math.max(0, duration) : null,
    tags: {},
    picture: null,
  }
}
