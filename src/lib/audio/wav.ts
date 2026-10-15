import { AudioDecodeError } from './pcm'
import type { PcmChunk } from './pcm'

/**
 * A forgiving WAV reader for the fallback path: 8/16/24/32-bit integer PCM, 32/64-bit float, A-law and mu-law,
 * WAVE_FORMAT_EXTENSIBLE, RF64, odd chunk padding, streaming files whose length field is 0 or 0xFFFFFFFF,
 * and files cut short. Decoding is lazy, one chunk of frames at a time.
 */

export type WavEncoding = 'pcm' | 'float' | 'alaw' | 'mulaw'

export interface WavInfo {
  encoding: WavEncoding
  /** Bits per sample as stored in the file. */
  bitsPerSample: number
  /** Significant bits (<= bitsPerSample), e.g. 20 in a 24-bit container. */
  validBits: number
  channels: number
  sampleRate: number
  blockAlign: number
  dataOffset: number
  /** Bytes of audio actually available (after clamping to the file size). */
  dataBytes: number
  frames: number
  /** The header promised more audio than the file contains. */
  truncated: boolean
  /** True for RF64/BW64 files (64-bit sizes). */
  rf64: boolean
}

const TAG_PCM = 1
const TAG_FLOAT = 3
const TAG_ALAW = 6
const TAG_MULAW = 7
const TAG_EXTENSIBLE = 0xfffe

const fourCC = (b: Uint8Array, o: number) => String.fromCharCode(b[o] ?? 0, b[o + 1] ?? 0, b[o + 2] ?? 0, b[o + 3] ?? 0)

/** True when the bytes start like a RIFF/RF64 WAVE file. */
export function looksLikeWav(b: Uint8Array): boolean {
  const id = fourCC(b, 0)
  return b.length >= 12 && (id === 'RIFF' || id === 'RF64' || id === 'BW64') && fourCC(b, 8) === 'WAVE'
}

export function parseWav(bytes: Uint8Array): WavInfo {
  if (!looksLikeWav(bytes)) throw new AudioDecodeError('Not a RIFF/WAVE file', 'corrupt')
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const rf64 = fourCC(bytes, 0) !== 'RIFF'

  let ds64DataSize: number | null = null
  let fmt: { tag: number; channels: number; sampleRate: number; blockAlign: number; bits: number; validBits: number } | null = null
  let data: { offset: number; declared: number } | null = null

  let pos = 12
  while (pos + 8 <= bytes.length) {
    const id = fourCC(bytes, pos)
    let size = view.getUint32(pos + 4, true)
    const body = pos + 8
    if (id === 'ds64' && body + 16 <= bytes.length) {
      ds64DataSize = view.getUint32(body + 8, true) + view.getUint32(body + 12, true) * 4294967296
    } else if (id === 'fmt ' && body + 16 <= bytes.length) {
      let tag = view.getUint16(body, true)
      const bits = view.getUint16(body + 14, true)
      let validBits = bits
      if (tag === TAG_EXTENSIBLE && size >= 40 && body + 40 <= bytes.length) {
        validBits = view.getUint16(body + 18, true) || bits
        tag = view.getUint16(body + 24, true) // first two bytes of the sub-format GUID
      }
      fmt = {
        tag,
        channels: view.getUint16(body + 2, true),
        sampleRate: view.getUint32(body + 4, true),
        blockAlign: view.getUint16(body + 12, true),
        bits,
        validBits,
      }
    } else if (id === 'data') {
      if (rf64 && size === 0xffffffff && ds64DataSize !== null) size = ds64DataSize
      data = { offset: body, declared: size }
      break // audio always comes last for our purposes; anything after it is metadata
    }
    pos = body + size + (size % 2)
    if (size > bytes.length) break
  }

  if (!fmt) throw new AudioDecodeError('WAV file has no fmt chunk', 'corrupt')
  if (!data) throw new AudioDecodeError('WAV file has no data chunk', 'corrupt')
  if (fmt.channels < 1) throw new AudioDecodeError('WAV declares no channels', 'corrupt')
  if (fmt.sampleRate < 1) throw new AudioDecodeError('WAV declares no sample rate', 'corrupt')

  let encoding: WavEncoding
  if (fmt.tag === TAG_PCM) encoding = 'pcm'
  else if (fmt.tag === TAG_FLOAT) encoding = 'float'
  else if (fmt.tag === TAG_ALAW) encoding = 'alaw'
  else if (fmt.tag === TAG_MULAW) encoding = 'mulaw'
  else throw new AudioDecodeError(`Unsupported WAV encoding (format tag ${fmt.tag})`, 'unsupported')

  const supported =
    (encoding === 'pcm' && [8, 16, 24, 32].includes(fmt.bits)) ||
    (encoding === 'float' && (fmt.bits === 32 || fmt.bits === 64)) ||
    ((encoding === 'alaw' || encoding === 'mulaw') && fmt.bits === 8)
  if (!supported) throw new AudioDecodeError(`Unsupported WAV sample size (${fmt.bits}-bit ${encoding})`, 'unsupported')

  const blockAlign = (fmt.bits / 8) * fmt.channels // trust the arithmetic over a damaged header field
  const available = Math.max(0, bytes.length - data.offset)
  const streaming = data.declared === 0 || data.declared === 0xffffffff
  const dataBytes = streaming ? available : Math.min(data.declared, available)
  return {
    encoding,
    bitsPerSample: fmt.bits,
    validBits: Math.min(fmt.validBits, fmt.bits),
    channels: fmt.channels,
    sampleRate: fmt.sampleRate,
    blockAlign,
    dataOffset: data.offset,
    dataBytes,
    frames: Math.floor(dataBytes / blockAlign),
    truncated: !streaming && data.declared > available,
    rf64,
  }
}

/** G.711 expansion tables. */
const ALAW = Float32Array.from({ length: 256 }, (_, i) => {
  const v = i ^ 0x55
  const exponent = (v >> 4) & 7
  const mantissa = v & 15
  const magnitude = exponent === 0 ? (mantissa << 4) + 8 : ((mantissa << 4) + 0x108) << (exponent - 1)
  return ((v & 0x80 ? magnitude : -magnitude) / 32768)
})
const MULAW = Float32Array.from({ length: 256 }, (_, i) => {
  const v = ~i & 0xff
  const exponent = (v >> 4) & 7
  const magnitude = (((v & 15) << 3) + 0x84) << exponent
  return ((v & 0x80 ? 0x84 - magnitude : magnitude - 0x84) / 32768)
})

/** Decode `count` frames starting at `startFrame` into one Float32Array per channel. */
export function readWavFrames(bytes: Uint8Array, info: WavInfo, startFrame: number, count: number): PcmChunk {
  const frames = Math.max(0, Math.min(count, info.frames - startFrame))
  const out: PcmChunk = Array.from({ length: info.channels }, () => new Float32Array(frames))
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const width = info.bitsPerSample / 8
  let o = info.dataOffset + startFrame * info.blockAlign

  for (let i = 0; i < frames; i++) {
    for (let c = 0; c < info.channels; c++) {
      let v: number
      if (info.encoding === 'pcm') {
        if (info.bitsPerSample === 8) v = ((bytes[o] ?? 128) - 128) / 128
        else if (info.bitsPerSample === 16) v = view.getInt16(o, true) / 32768
        else if (info.bitsPerSample === 24) v = (((bytes[o] ?? 0) | ((bytes[o + 1] ?? 0) << 8) | ((bytes[o + 2] ?? 0) << 16)) << 8 >> 8) / 8388608
        else v = view.getInt32(o, true) / 2147483648
      } else if (info.encoding === 'float') {
        v = info.bitsPerSample === 32 ? view.getFloat32(o, true) : view.getFloat64(o, true)
        if (!Number.isFinite(v)) v = 0
      } else if (info.encoding === 'alaw') {
        v = ALAW[bytes[o] ?? 0] ?? 0
      } else {
        v = MULAW[bytes[o] ?? 0] ?? 0
      }
      ;(out[c] as Float32Array)[i] = v
      o += width
    }
  }
  return out
}

/** Lazily decode a whole WAV file, `chunkFrames` frames at a time. */
export function* wavChunks(bytes: Uint8Array, info: WavInfo, chunkFrames = 16384): Generator<PcmChunk> {
  for (let start = 0; start < info.frames; start += chunkFrames) yield readWavFrames(bytes, info, start, chunkFrames)
}
