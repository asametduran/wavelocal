import type { ByteSource } from '../source'
import { skipId3v2 } from './id3'
import { blankFormat } from './types'
import type { ProbeOptions, ProbeResult } from './types'

/**
 * ADTS probe: raw AAC streams (`.aac`). There is no header with a length, so the frames are counted by hopping from
 * header to header (each states its own size); a very long stream is sampled and extrapolated.
 */

const SAMPLE_RATES = [96000, 88200, 64000, 48000, 44100, 32000, 24000, 22050, 16000, 12000, 11025, 8000, 7350]
const CHANNELS = [0, 1, 2, 3, 4, 5, 6, 8]
const SAMPLES_PER_BLOCK = 1024
const CHAIN = 3
const SEARCH = 4096
const WINDOW = 64 * 1024
const BLOCK = 256 * 1024
const DEFAULT_MAX_SCAN = 48 * 1024 * 1024

interface Header {
  sf: number
  cc: number
  sampleRate: number
  channels: number
  /** Bytes, header included. */
  length: number
  /** Raw data blocks in the frame (1024 samples each). */
  blocks: number
}

function parseHeader(b: Uint8Array, o: number): Header | null {
  // 12 sync bits, and layer 00 (which is what tells ADTS from MP3)
  if (o < 0 || o + 7 > b.length || b[o] !== 0xff || ((b[o + 1] ?? 0) & 0xf6) !== 0xf0) return null
  const b2 = b[o + 2] ?? 0
  const b3 = b[o + 3] ?? 0
  const sf = (b2 >> 2) & 15
  const sampleRate = SAMPLE_RATES[sf]
  if (!sampleRate) return null
  const cc = ((b2 & 1) << 2) | (b3 >> 6)
  const length = ((b3 & 3) << 11) | ((b[o + 4] ?? 0) << 3) | ((b[o + 5] ?? 0) >> 5)
  if (length < 7) return null
  return { sf, cc, sampleRate, channels: CHANNELS[cc] ?? 0, length, blocks: ((b[o + 6] ?? 0) & 3) + 1 }
}

const sameStream = (a: Header, b: Header): boolean => a.sf === b.sf && a.cc === b.cc

/** True when the frame at `o` starts a run of `CHAIN` frames of one stream (or one that ends exactly at `limit`). */
function chained(b: Uint8Array, o: number, limit: number): boolean {
  let pos = o
  let first: Header | null = null
  let count = 0
  while (count < CHAIN && pos < limit) {
    const h = parseHeader(b, pos)
    if (!h || (first && !sameStream(first, h))) return false
    first ??= h
    count++
    pos += h.length
  }
  return count >= CHAIN || (count > 0 && pos === limit)
}

export async function probeAdts(source: ByteSource, options: ProbeOptions = {}): Promise<ProbeResult | null> {
  const start = await skipId3v2(source)
  const end = source.size
  if (start + 7 > end) return null
  const window = await source.read(start, WINDOW)
  let offset = -1
  for (let p = window.indexOf(0xff); p >= 0 && p < SEARCH; p = window.indexOf(0xff, p + 1)) {
    if (chained(window, p, end - start)) {
      offset = p
      break
    }
  }
  if (offset < 0) return null
  const first = parseHeader(window, offset)
  if (!first) return null

  const from = start + offset
  const budget = options.maxScanBytes ?? DEFAULT_MAX_SCAN
  let block: Uint8Array = new Uint8Array(0)
  let blockStart = 0
  let pos = from
  let frames = 0
  let bytes = 0
  let complete = true
  while (pos < end) {
    if (bytes >= budget) {
      complete = false
      break
    }
    if (pos < blockStart || pos + 7 > blockStart + block.length) {
      blockStart = pos
      block = await source.read(pos, Math.min(BLOCK, end - pos))
      if (block.length < 7) break
    }
    const h = parseHeader(block, pos - blockStart)
    if (!h || !sameStream(first, h)) break // the rest is not part of the stream
    frames += h.blocks
    bytes += h.length
    pos += h.length
  }
  if (frames === 0) return null

  const scale = complete ? 1 : (end - from) / Math.max(1, bytes)
  const duration = ((frames * SAMPLES_PER_BLOCK) / first.sampleRate) * scale
  return {
    format: {
      ...blankFormat('aac', 'aac'),
      sampleRate: first.sampleRate,
      channels: first.channels,
      bitrate: duration > 0 ? Math.round((Math.min(bytes * scale, end - from) * 8) / duration) : 0,
    },
    duration,
    tags: {},
    picture: null,
  }
}
