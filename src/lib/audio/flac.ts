import { crc16, crc8 } from './crc'
import { Md5 } from './md5'
import { AudioDecodeError } from './pcm'
import type { PcmChunk } from './pcm'

/**
 * A complete FLAC decoder in plain TypeScript (format specification: xiph.org/flac/format.html).
 *
 * Handles every subframe type (constant, verbatim, fixed, LPC), both Rice residual codings including escape
 * partitions, wasted bits, all four channel assignments, fixed and variable block sizes, any sample rate the
 * header can express, 4-24 bit audio and up to eight channels. Frames are validated with their CRC-8 and CRC-16,
 * and the decoded PCM can be checked against the MD5 in STREAMINFO. In lenient mode a damaged frame is replaced by
 * silence and decoding resumes at the next valid frame instead of giving up.
 */

export interface FlacStreamInfo {
  minBlockSize: number
  maxBlockSize: number
  minFrameSize: number
  maxFrameSize: number
  sampleRate: number
  channels: number
  bitsPerSample: number
  /** 0 when the encoder did not know the length. */
  totalSamples: number
  md5: Uint8Array
}

export interface FlacSeekPoint {
  sample: number
  offset: number
  samples: number
}

export interface FlacMetadata {
  info: FlacStreamInfo
  seekTable: FlacSeekPoint[]
  vendor: string | null
  comments: string[]
  pictureCount: number
  /** Byte offset of the first audio frame. */
  firstFrameOffset: number
}

export interface FlacFrame {
  /** One Int32Array of `blockSize` samples per channel, fully decorrelated. */
  samples: Int32Array[]
  blockSize: number
  /** Index of this frame's first sample within the stream. */
  sampleNumber: number
  byteOffset: number
  byteLength: number
  bitsPerSample: number
  sampleRate: number
  /** True when the frame was damaged and replaced by silence (lenient mode only). */
  concealed: boolean
}

export interface FlacDecoderOptions {
  /** Compare the decoded PCM with the MD5 stored in STREAMINFO once the stream has been fully read. */
  verifyMd5?: boolean
  /** Conceal damaged frames and resynchronise instead of throwing. */
  lenient?: boolean
}

export type Md5Status = 'skipped' | 'unavailable' | 'verified' | 'mismatch'

const BLOCK_STREAMINFO = 0
const BLOCK_SEEKTABLE = 3
const BLOCK_VORBIS_COMMENT = 4
const BLOCK_PICTURE = 6
const MAX_BITS_PER_SAMPLE = 24

// ---- container ----

const ascii = (b: Uint8Array, o: number, n: number) => String.fromCharCode(...b.subarray(o, o + n))

/** Offset of the `fLaC` marker: 0, or just past a leading ID3v2 tag. Returns -1 when there is no FLAC stream. */
function markerOffset(bytes: Uint8Array): number {
  let offset = 0
  if (bytes.length >= 10 && ascii(bytes, 0, 3) === 'ID3') {
    const size = ((bytes[6] ?? 0) << 21) | ((bytes[7] ?? 0) << 14) | ((bytes[8] ?? 0) << 7) | (bytes[9] ?? 0)
    offset = 10 + size + ((bytes[5] ?? 0) & 0x10 ? 10 : 0)
  }
  return bytes.length >= offset + 4 && ascii(bytes, offset, 4) === 'fLaC' ? offset : -1
}

export const looksLikeFlac = (bytes: Uint8Array): boolean => markerOffset(bytes) >= 0

export function parseFlacMetadata(bytes: Uint8Array): FlacMetadata {
  const marker = markerOffset(bytes)
  if (marker < 0) throw new AudioDecodeError('Not a FLAC file', 'corrupt')
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)

  let info: FlacStreamInfo | null = null
  const seekTable: FlacSeekPoint[] = []
  let vendor: string | null = null
  const comments: string[] = []
  let pictureCount = 0

  let pos = marker + 4
  for (;;) {
    if (pos + 4 > bytes.length) throw new AudioDecodeError('FLAC metadata is cut short', 'truncated')
    const header = bytes[pos] ?? 0
    const last = (header & 0x80) !== 0
    const type = header & 0x7f
    const length = view.getUint32(pos, false) & 0xffffff
    const body = pos + 4
    if (body + length > bytes.length) throw new AudioDecodeError('FLAC metadata is cut short', 'truncated')

    if (type === BLOCK_STREAMINFO) {
      if (length < 34) throw new AudioDecodeError('FLAC STREAMINFO block is too short', 'corrupt')
      const tail = view.getUint32(body + 10, false) // 20 bits rate, 3 bits channels, 5 bits depth, high 4 bits of the sample count
      const low = view.getUint32(body + 14, false)
      info = {
        minBlockSize: view.getUint16(body, false),
        maxBlockSize: view.getUint16(body + 2, false),
        minFrameSize: view.getUint32(body + 4, false) >>> 8,
        maxFrameSize: view.getUint32(body + 7, false) >>> 8,
        sampleRate: tail >>> 12,
        channels: ((tail >>> 9) & 7) + 1,
        bitsPerSample: ((tail >>> 4) & 31) + 1,
        totalSamples: (tail & 15) * 4294967296 + low,
        md5: bytes.slice(body + 18, body + 34),
      }
    } else if (type === BLOCK_SEEKTABLE) {
      for (let p = body; p + 18 <= body + length; p += 18) {
        const sample = view.getUint32(p, false) * 4294967296 + view.getUint32(p + 4, false)
        if (view.getUint32(p, false) === 0xffffffff && view.getUint32(p + 4, false) === 0xffffffff) continue // placeholder
        seekTable.push({ sample, offset: view.getUint32(p + 8, false) * 4294967296 + view.getUint32(p + 12, false), samples: view.getUint16(p + 16, false) })
      }
    } else if (type === BLOCK_VORBIS_COMMENT && length >= 8) {
      const decode = (o: number, n: number) => new TextDecoder().decode(bytes.subarray(o, o + n))
      const vendorLength = view.getUint32(body, true)
      vendor = decode(body + 4, vendorLength)
      let p = body + 4 + vendorLength
      const count = p + 4 <= body + length ? view.getUint32(p, true) : 0
      p += 4
      for (let i = 0; i < count && p + 4 <= body + length; i++) {
        const n = view.getUint32(p, true)
        comments.push(decode(p + 4, Math.min(n, body + length - p - 4)))
        p += 4 + n
      }
    } else if (type === BLOCK_PICTURE) {
      pictureCount++
    }

    pos = body + length
    if (last) break
  }
  if (!info) throw new AudioDecodeError('FLAC file has no STREAMINFO block', 'corrupt')
  if (info.sampleRate === 0 || info.channels === 0) throw new AudioDecodeError('FLAC STREAMINFO is invalid', 'corrupt')
  return { info, seekTable, vendor, comments, pictureCount, firstFrameOffset: pos }
}

// ---- bit reading ----

class BitReader {
  /** Position in bits from the start of `data`. */
  pos: number

  constructor(
    readonly data: Uint8Array,
    startByte: number,
  ) {
    this.pos = startByte * 8
  }

  get bytePos(): number {
    return this.pos >> 3
  }

  /** Unsigned value of the next `n` bits (0..32), most significant bit first. */
  readBits(n: number): number {
    let value = 0
    let remaining = n
    while (remaining > 0) {
      const byte = this.data[this.pos >> 3]
      if (byte === undefined) throw new AudioDecodeError('FLAC frame is cut short', 'truncated')
      const offset = this.pos & 7
      const take = Math.min(remaining, 8 - offset)
      value = value * (1 << take) + ((byte >> (8 - offset - take)) & ((1 << take) - 1))
      this.pos += take
      remaining -= take
    }
    return value
  }

  /** Two's-complement value of the next `n` bits. */
  readSigned(n: number): number {
    if (n === 0) return 0
    const v = this.readBits(n)
    return v >= 2 ** (n - 1) ? v - 2 ** n : v
  }

  /** Count of zero bits before the next 1 bit (which is consumed). */
  readUnary(): number {
    let count = 0
    for (;;) {
      const byte = this.data[this.pos >> 3]
      if (byte === undefined) throw new AudioDecodeError('FLAC frame is cut short', 'truncated')
      const offset = this.pos & 7
      const rest = byte & (0xff >> offset)
      if (rest !== 0) {
        const skip = Math.clz32(rest) - 24 - offset
        count += skip
        this.pos += skip + 1
        return count
      }
      count += 8 - offset
      this.pos = ((this.pos >> 3) + 1) * 8
    }
  }

  alignToByte(): void {
    this.pos = (this.pos + 7) & ~7
  }
}

/** The variable-length UTF-8-style number that holds the frame or sample index (up to 36 bits). */
function readUtf8Number(br: BitReader): number {
  const first = br.readBits(8)
  if (first < 0x80) return first
  let extra: number
  let value: number
  if ((first & 0xe0) === 0xc0) [extra, value] = [1, first & 0x1f]
  else if ((first & 0xf0) === 0xe0) [extra, value] = [2, first & 0x0f]
  else if ((first & 0xf8) === 0xf0) [extra, value] = [3, first & 0x07]
  else if ((first & 0xfc) === 0xf8) [extra, value] = [4, first & 0x03]
  else if ((first & 0xfe) === 0xfc) [extra, value] = [5, first & 0x01]
  else if (first === 0xfe) [extra, value] = [6, 0]
  else throw new AudioDecodeError('Invalid FLAC frame number', 'corrupt')
  for (let i = 0; i < extra; i++) {
    const next = br.readBits(8)
    if ((next & 0xc0) !== 0x80) throw new AudioDecodeError('Invalid FLAC frame number', 'corrupt')
    value = value * 64 + (next & 0x3f)
  }
  return value
}

// ---- subframes ----

function decodeResidual(br: BitReader, blockSize: number, order: number, out: Int32Array): void {
  const method = br.readBits(2)
  if (method > 1) throw new AudioDecodeError('Reserved FLAC residual coding method', 'corrupt')
  const paramBits = method === 0 ? 4 : 5
  const escape = method === 0 ? 15 : 31
  const partitionOrder = br.readBits(4)
  const partitions = 1 << partitionOrder
  if (blockSize % partitions !== 0 || blockSize >> partitionOrder < order) throw new AudioDecodeError('Invalid FLAC partition order', 'corrupt')

  const perPartition = blockSize >> partitionOrder
  let pos = order
  for (let p = 0; p < partitions; p++) {
    const count = p === 0 ? perPartition - order : perPartition
    const param = br.readBits(paramBits)
    if (param === escape) {
      const bits = br.readBits(5)
      for (let i = 0; i < count; i++) out[pos++] = br.readSigned(bits)
      continue
    }
    for (let i = 0; i < count; i++) {
      const quotient = br.readUnary()
      const folded = quotient * 2 ** param + (param > 0 ? br.readBits(param) : 0)
      out[pos++] = folded < 2147483648 ? (folded >>> 1) ^ -(folded & 1) : (folded % 2 === 0 ? folded / 2 : -(folded + 1) / 2)
    }
  }
}

function applyFixed(order: number, out: Int32Array, n: number): void {
  for (let i = order; i < n; i++) {
    const a = out[i - 1] ?? 0
    const b = out[i - 2] ?? 0
    const c = out[i - 3] ?? 0
    const d = out[i - 4] ?? 0
    const predicted = order === 1 ? a : order === 2 ? 2 * a - b : order === 3 ? 3 * a - 3 * b + c : order === 4 ? 4 * a - 6 * b + 4 * c - d : 0
    out[i] = ((out[i] ?? 0) + predicted) | 0
  }
}

function applyLpc(order: number, coefficients: Int32Array, shift: number, out: Int32Array, n: number): void {
  const divisor = 2 ** shift
  for (let i = order; i < n; i++) {
    let sum = 0
    for (let j = 0; j < order; j++) sum += (coefficients[j] ?? 0) * (out[i - 1 - j] ?? 0)
    // arithmetic shift right; done by floor division so sums beyond 32 bits stay exact
    const predicted = sum >= -2147483648 && sum < 2147483648 ? sum >> shift : Math.floor(sum / divisor)
    out[i] = ((out[i] ?? 0) + predicted) | 0
  }
}

function decodeSubframe(br: BitReader, blockSize: number, bitsPerSample: number): Int32Array {
  if (br.readBits(1) !== 0) throw new AudioDecodeError('Invalid FLAC subframe header', 'corrupt')
  const type = br.readBits(6)
  let wasted = 0
  if (br.readBits(1) === 1) wasted = br.readUnary() + 1
  const bits = bitsPerSample - wasted
  if (bits <= 0) throw new AudioDecodeError('Invalid FLAC wasted-bits count', 'corrupt')
  const out = new Int32Array(blockSize)

  if (type === 0) {
    out.fill(br.readSigned(bits))
  } else if (type === 1) {
    for (let i = 0; i < blockSize; i++) out[i] = br.readSigned(bits)
  } else if (type >= 8 && type <= 12) {
    const order = type - 8
    if (order > blockSize) throw new AudioDecodeError('FLAC predictor order exceeds block size', 'corrupt')
    for (let i = 0; i < order; i++) out[i] = br.readSigned(bits)
    decodeResidual(br, blockSize, order, out)
    applyFixed(order, out, blockSize)
  } else if (type >= 32) {
    const order = type - 31
    if (order > blockSize) throw new AudioDecodeError('FLAC predictor order exceeds block size', 'corrupt')
    for (let i = 0; i < order; i++) out[i] = br.readSigned(bits)
    const precision = br.readBits(4) + 1
    if (precision === 16) throw new AudioDecodeError('Invalid FLAC LPC precision', 'corrupt')
    const shift = br.readSigned(5)
    if (shift < 0) throw new AudioDecodeError('Negative FLAC LPC shift', 'corrupt')
    const coefficients = new Int32Array(order)
    for (let i = 0; i < order; i++) coefficients[i] = br.readSigned(precision)
    decodeResidual(br, blockSize, order, out)
    applyLpc(order, coefficients, shift, out, blockSize)
  } else {
    throw new AudioDecodeError('Reserved FLAC subframe type', 'corrupt')
  }

  if (wasted > 0) {
    const scale = 2 ** wasted
    for (let i = 0; i < blockSize; i++) out[i] = (out[i] ?? 0) * scale
  }
  return out
}

// ---- frames ----

const BLOCK_SIZES: Record<number, number> = { 1: 192, 2: 576, 3: 1152, 4: 2304, 5: 4608, 8: 256, 9: 512, 10: 1024, 11: 2048, 12: 4096, 13: 8192, 14: 16384, 15: 32768 }
const SAMPLE_RATES: Record<number, number> = { 1: 88200, 2: 176400, 3: 192000, 4: 8000, 5: 16000, 6: 22050, 7: 24000, 8: 32000, 9: 44100, 10: 48000, 11: 96000 }
const SAMPLE_SIZES: Record<number, number> = { 1: 8, 2: 12, 4: 16, 5: 20, 6: 24, 7: 32 }

interface FrameHeader {
  blockSize: number
  sampleRate: number
  bitsPerSample: number
  channels: number
  assignment: number
  /** Frame number (fixed block size) or first sample number (variable block size). */
  number: number
  variable: boolean
  headerBytes: number
}

function readFrameHeader(data: Uint8Array, start: number, info: FlacStreamInfo): FrameHeader {
  const br = new BitReader(data, start)
  if (br.readBits(14) !== 0x3ffe) throw new AudioDecodeError('Missing FLAC frame sync code', 'corrupt')
  if (br.readBits(1) !== 0) throw new AudioDecodeError('Invalid FLAC frame header', 'corrupt')
  const variable = br.readBits(1) === 1
  const blockCode = br.readBits(4)
  const rateCode = br.readBits(4)
  const channelCode = br.readBits(4)
  const sizeCode = br.readBits(3)
  if (br.readBits(1) !== 0) throw new AudioDecodeError('Invalid FLAC frame header', 'corrupt')
  const number = readUtf8Number(br)

  let blockSize: number
  if (blockCode === 6) blockSize = br.readBits(8) + 1
  else if (blockCode === 7) blockSize = br.readBits(16) + 1
  else {
    const known = BLOCK_SIZES[blockCode]
    if (known === undefined) throw new AudioDecodeError('Reserved FLAC block size', 'corrupt')
    blockSize = known
  }

  let sampleRate: number
  if (rateCode === 0) sampleRate = info.sampleRate
  else if (rateCode === 12) sampleRate = br.readBits(8) * 1000
  else if (rateCode === 13) sampleRate = br.readBits(16)
  else if (rateCode === 14) sampleRate = br.readBits(16) * 10
  else {
    const known = SAMPLE_RATES[rateCode]
    if (known === undefined) throw new AudioDecodeError('Invalid FLAC sample rate code', 'corrupt')
    sampleRate = known
  }

  let bitsPerSample: number
  if (sizeCode === 0) bitsPerSample = info.bitsPerSample
  else {
    const known = SAMPLE_SIZES[sizeCode]
    if (known === undefined) throw new AudioDecodeError('Reserved FLAC sample size', 'corrupt')
    bitsPerSample = known
  }

  let channels: number
  if (channelCode <= 7) channels = channelCode + 1
  else if (channelCode <= 10) channels = 2
  else throw new AudioDecodeError('Reserved FLAC channel assignment', 'corrupt')

  const headerEnd = br.bytePos
  if (br.readBits(8) !== crc8(data, start, headerEnd)) throw new AudioDecodeError('FLAC frame header CRC mismatch', 'corrupt')
  return { blockSize, sampleRate, bitsPerSample, channels, assignment: channelCode, number, variable, headerBytes: br.bytePos - start }
}

/** Decode one complete frame starting at `start`, verifying both checksums. */
function decodeFrame(data: Uint8Array, start: number, info: FlacStreamInfo): { header: FrameHeader; samples: Int32Array[]; end: number } {
  const header = readFrameHeader(data, start, info)
  if (header.bitsPerSample > MAX_BITS_PER_SAMPLE) throw new AudioDecodeError(`${header.bitsPerSample}-bit FLAC is not supported (24-bit maximum)`, 'unsupported')

  const br = new BitReader(data, start + header.headerBytes)
  const side = header.assignment === 8 ? 1 : header.assignment === 9 ? 0 : header.assignment === 10 ? 1 : -1
  const samples: Int32Array[] = []
  for (let c = 0; c < header.channels; c++) samples.push(decodeSubframe(br, header.blockSize, header.bitsPerSample + (c === side ? 1 : 0)))
  br.alignToByte()
  const footer = br.bytePos
  if (br.readBits(16) !== crc16(data, start, footer)) throw new AudioDecodeError('FLAC frame CRC mismatch', 'corrupt')

  const [a, b] = samples
  if (a && b && header.assignment >= 8) {
    for (let i = 0; i < header.blockSize; i++) {
      const x = a[i] ?? 0
      const y = b[i] ?? 0
      if (header.assignment === 8) b[i] = x - y // left/side: right = left - side
      else if (header.assignment === 9) a[i] = x + y // side/right: left = side + right
      else {
        const mid = (x << 1) | (y & 1) // mid/side
        a[i] = (mid + y) >> 1
        b[i] = (mid - y) >> 1
      }
    }
  }
  return { header, samples, end: br.bytePos }
}

const isSync = (data: Uint8Array, pos: number): boolean => data[pos] === 0xff && ((data[pos + 1] ?? 0) & 0xfe) === 0xf8

/** The next offset (>= from) that begins a frame whose header passes its CRC-8, or -1. */
function findFrame(data: Uint8Array, from: number, info: FlacStreamInfo): number {
  for (let pos = from; pos + 6 < data.length; pos++) {
    if (!isSync(data, pos)) continue
    try {
      readFrameHeader(data, pos, info)
      return pos
    } catch {
      /* not a frame header, keep looking */
    }
  }
  return -1
}

export class FlacDecoder {
  readonly metadata: FlacMetadata
  readonly info: FlacStreamInfo
  /** Problems that were survived (lenient mode) or noticed (length / MD5 mismatches). */
  readonly warnings: string[] = []
  md5Status: Md5Status = 'skipped'

  constructor(
    private readonly bytes: Uint8Array,
    private readonly options: FlacDecoderOptions = {},
  ) {
    this.metadata = parseFlacMetadata(bytes)
    this.info = this.metadata.info
    if (this.info.bitsPerSample > MAX_BITS_PER_SAMPLE) {
      throw new AudioDecodeError(`${this.info.bitsPerSample}-bit FLAC is not supported (24-bit maximum)`, 'unsupported')
    }
  }

  /** Lazily decode the stream, one frame at a time. */
  *frames(): Generator<FlacFrame> {
    const { bytes, info } = this
    const lenient = this.options.lenient === true
    const md5 = this.options.verifyMd5 ? new Md5() : null
    let pos = this.metadata.firstFrameOffset
    let produced = 0
    let lastBlock = info.maxBlockSize || 4096

    while (pos < bytes.length) {
      if (!isSync(bytes, pos)) {
        if (!lenient) {
          if (bytes.length - pos <= 256) break // a trailing ID3v1/APE tag
          throw new AudioDecodeError('FLAC data is damaged (frame sync lost)', 'corrupt')
        }
        const next = findFrame(bytes, pos + 1, info)
        this.warnings.push(`Skipped ${(next < 0 ? bytes.length : next) - pos} bytes of unreadable data at offset ${pos}`)
        if (next < 0) break
        pos = next
        continue
      }

      let frame: FlacFrame
      try {
        const decoded = decodeFrame(bytes, pos, info)
        frame = {
          samples: decoded.samples,
          blockSize: decoded.header.blockSize,
          sampleNumber: decoded.header.variable ? decoded.header.number : produced,
          byteOffset: pos,
          byteLength: decoded.end - pos,
          bitsPerSample: decoded.header.bitsPerSample,
          sampleRate: decoded.header.sampleRate,
          concealed: false,
        }
        pos = decoded.end
        lastBlock = decoded.header.blockSize
      } catch (e) {
        if (!lenient || !(e instanceof AudioDecodeError) || e.code === 'unsupported') throw e
        const next = findFrame(bytes, pos + 1, info)
        this.warnings.push(`Concealed a damaged frame at offset ${pos}: ${e.message}`)
        frame = {
          samples: Array.from({ length: info.channels }, () => new Int32Array(lastBlock)),
          blockSize: lastBlock,
          sampleNumber: produced,
          byteOffset: pos,
          byteLength: (next < 0 ? bytes.length : next) - pos,
          bitsPerSample: info.bitsPerSample,
          sampleRate: info.sampleRate,
          concealed: true,
        }
        pos = next < 0 ? bytes.length : next
      }

      produced += frame.blockSize
      if (md5 && !frame.concealed) md5.update(interleave(frame))
      else if (md5) this.md5Status = 'mismatch' // concealed audio can never match the original checksum
      yield frame
    }

    if (info.totalSamples > 0 && produced !== info.totalSamples) {
      this.warnings.push(`Decoded ${produced} samples but the stream header declares ${info.totalSamples}`)
    }
    if (md5) this.finishMd5(md5)
  }

  private finishMd5(md5: Md5): void {
    if (this.md5Status === 'mismatch') return
    const expected = this.info.md5
    if (expected.every((b) => b === 0)) {
      this.md5Status = 'unavailable'
      return
    }
    const actual = md5.digest()
    this.md5Status = actual.every((b, i) => b === expected[i]) ? 'verified' : 'mismatch'
    if (this.md5Status === 'mismatch') this.warnings.push('Decoded audio does not match the MD5 stored in the file')
  }
}

/** The frame's samples as interleaved little-endian signed integers, the layout STREAMINFO's MD5 is defined over. */
function interleave(frame: FlacFrame): Uint8Array {
  const width = Math.ceil(frame.bitsPerSample / 8)
  const channels = frame.samples.length
  const out = new Uint8Array(frame.blockSize * channels * width)
  let o = 0
  for (let i = 0; i < frame.blockSize; i++) {
    for (let c = 0; c < channels; c++) {
      const v = frame.samples[c]?.[i] ?? 0
      for (let b = 0; b < width; b++) out[o++] = (v >> (8 * b)) & 0xff
    }
  }
  return out
}

export interface DecodedFlac {
  sampleRate: number
  channels: number
  bitsPerSample: number
  /** Total samples per channel. */
  length: number
  pcm: Int32Array[]
  warnings: string[]
  md5Status: Md5Status
}

/** Decode a whole file into one Int32Array per channel. */
export function decodeFlac(bytes: Uint8Array, options: FlacDecoderOptions = {}): DecodedFlac {
  const decoder = new FlacDecoder(bytes, options)
  const parts: Int32Array[][] = []
  let length = 0
  for (const frame of decoder.frames()) {
    parts.push(frame.samples)
    length += frame.blockSize
  }
  const channels = decoder.info.channels
  const pcm = Array.from({ length: channels }, () => new Int32Array(length))
  let offset = 0
  for (const samples of parts) {
    samples.forEach((s, c) => pcm[c]?.set(s, offset))
    offset += samples[0]?.length ?? 0
  }
  return { sampleRate: decoder.info.sampleRate, channels, bitsPerSample: decoder.info.bitsPerSample, length, pcm, warnings: decoder.warnings, md5Status: decoder.md5Status }
}

/** A decoded frame as floats in [-1, 1). 24-bit audio is represented exactly. */
export function frameToChunk(frame: FlacFrame): PcmChunk {
  const scale = 2 ** (frame.bitsPerSample - 1)
  return frame.samples.map((s) => Float32Array.from(s, (v) => v / scale))
}
