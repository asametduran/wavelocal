/**
 * Minimal RIFF/WAVE codec for building and verifying synthetic audio in tests.
 * Supports 16-bit PCM, 24-bit PCM and 32-bit float, mono or multichannel. Pure functions, no DOM needed.
 */

export type WavFormat = 'pcm16' | 'pcm24' | 'float32'

export interface WavOptions {
  sampleRate?: number
  format?: WavFormat
}

export interface DecodedWav {
  sampleRate: number
  format: WavFormat
  /** One Float32Array per channel, samples in [-1, 1]. */
  channels: Float32Array[]
}

const FORMAT_INFO: Record<WavFormat, { tag: number; bits: number }> = {
  pcm16: { tag: 1, bits: 16 },
  pcm24: { tag: 1, bits: 24 },
  float32: { tag: 3, bits: 32 },
}

const clampUnit = (v: number): number => (v > 1 ? 1 : v < -1 ? -1 : v)

/** Encode channels (equal length, samples in [-1, 1]; out-of-range values are clipped) as a WAV file. */
export function encodeWav(channels: readonly Float32Array[], { sampleRate = 44100, format = 'pcm16' }: WavOptions = {}): Uint8Array<ArrayBuffer> {
  const first = channels[0]
  if (!first) throw new RangeError('encodeWav needs at least one channel')
  if (channels.some((c) => c.length !== first.length)) throw new RangeError('encodeWav channels must have equal length')
  if (!Number.isInteger(sampleRate) || sampleRate <= 0) throw new RangeError('encodeWav sampleRate must be a positive integer')

  const { tag, bits } = FORMAT_INFO[format]
  const bytesPer = bits / 8
  const frames = first.length
  const blockAlign = channels.length * bytesPer
  const dataBytes = frames * blockAlign
  const out = new Uint8Array(44 + dataBytes)
  const view = new DataView(out.buffer)
  const ascii = (offset: number, text: string) => {
    for (let i = 0; i < text.length; i++) out[offset + i] = text.charCodeAt(i)
  }

  ascii(0, 'RIFF')
  view.setUint32(4, 36 + dataBytes, true)
  ascii(8, 'WAVE')
  ascii(12, 'fmt ')
  view.setUint32(16, 16, true)
  view.setUint16(20, tag, true)
  view.setUint16(22, channels.length, true)
  view.setUint32(24, sampleRate, true)
  view.setUint32(28, sampleRate * blockAlign, true)
  view.setUint16(32, blockAlign, true)
  view.setUint16(34, bits, true)
  ascii(36, 'data')
  view.setUint32(40, dataBytes, true)

  let o = 44
  for (let i = 0; i < frames; i++) {
    for (const ch of channels) {
      const v = clampUnit(ch[i] ?? 0)
      if (format === 'float32') {
        view.setFloat32(o, v, true)
      } else if (format === 'pcm16') {
        view.setInt16(o, Math.min(32767, Math.round(v * 32768)), true)
      } else {
        const n = Math.min(8388607, Math.round(v * 8388608))
        out[o] = n & 0xff
        out[o + 1] = (n >> 8) & 0xff
        out[o + 2] = (n >> 16) & 0xff
      }
      o += bytesPer
    }
  }
  return out
}

/** Decode a WAV file produced by `encodeWav` (or any plain PCM16/24 / float32 WAV). Unknown chunks are skipped. */
export function decodeWav(bytes: Uint8Array): DecodedWav {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const tag4 = (offset: number) => String.fromCharCode(bytes[offset] ?? 0, bytes[offset + 1] ?? 0, bytes[offset + 2] ?? 0, bytes[offset + 3] ?? 0)
  if (bytes.length < 12 || tag4(0) !== 'RIFF' || tag4(8) !== 'WAVE') throw new Error('Not a RIFF/WAVE file')

  let fmt: { tag: number; channels: number; sampleRate: number; bits: number } | null = null
  let data: { offset: number; length: number } | null = null
  let pos = 12
  while (pos + 8 <= bytes.length) {
    const id = tag4(pos)
    const size = view.getUint32(pos + 4, true)
    const body = pos + 8
    if (id === 'fmt ') {
      fmt = { tag: view.getUint16(body, true), channels: view.getUint16(body + 2, true), sampleRate: view.getUint32(body + 4, true), bits: view.getUint16(body + 14, true) }
    } else if (id === 'data') {
      data = { offset: body, length: Math.min(size, bytes.length - body) }
    }
    pos = body + size + (size % 2) // chunks are word aligned
  }
  if (!fmt) throw new Error('WAV has no fmt chunk')
  if (!data) throw new Error('WAV has no data chunk')

  const format = (Object.keys(FORMAT_INFO) as WavFormat[]).find((f) => FORMAT_INFO[f].tag === fmt.tag && FORMAT_INFO[f].bits === fmt.bits)
  if (!format) throw new Error(`Unsupported WAV encoding (tag ${fmt.tag}, ${fmt.bits}-bit)`)
  if (fmt.channels < 1) throw new Error('WAV declares no channels')

  const bytesPer = fmt.bits / 8
  const frames = Math.floor(data.length / (bytesPer * fmt.channels))
  const channels = Array.from({ length: fmt.channels }, () => new Float32Array(frames))
  let o = data.offset
  for (let i = 0; i < frames; i++) {
    for (const ch of channels) {
      if (format === 'float32') ch[i] = view.getFloat32(o, true)
      else if (format === 'pcm16') ch[i] = view.getInt16(o, true) / 32768
      else ch[i] = (((bytes[o] ?? 0) | ((bytes[o + 1] ?? 0) << 8) | ((bytes[o + 2] ?? 0) << 16)) << 8 >> 8) / 8388608
      o += bytesPer
    }
  }
  return { sampleRate: fmt.sampleRate, format, channels }
}
