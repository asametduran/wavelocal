import { seededRandom } from '../dsp'

/** One block of decoded audio: a Float32Array per channel (equal lengths), samples in [-1, 1). */
export type PcmChunk = Float32Array[]

/** Why decoding failed: the format is not handled, the data is damaged, or it ends early. */
export class AudioDecodeError extends Error {
  constructor(
    message: string,
    readonly code: 'unsupported' | 'corrupt' | 'truncated' | 'aborted',
  ) {
    super(message)
    this.name = 'AudioDecodeError'
  }
}

const SQRT1_2 = Math.SQRT1_2

/**
 * Speaker roles for the standard WAVE/FLAC channel orders, used to fold surround sound down to two channels.
 * C = centre, S = surround/back, X = ignored (LFE).
 */
const LAYOUTS: Record<number, readonly ('L' | 'R' | 'C' | 'X' | 'SL' | 'SR' | 'BC')[]> = {
  3: ['L', 'R', 'C'],
  4: ['L', 'R', 'SL', 'SR'],
  5: ['L', 'R', 'C', 'SL', 'SR'],
  6: ['L', 'R', 'C', 'X', 'SL', 'SR'],
  7: ['L', 'R', 'C', 'X', 'BC', 'SL', 'SR'],
  8: ['L', 'R', 'C', 'X', 'SL', 'SR', 'SL', 'SR'],
}

/**
 * Fold more than two channels down to stereo (centre and surrounds at -3 dB, LFE dropped), scaled so that full-scale
 * input can never clip. One or two channels pass through untouched.
 */
export function downmixToStereo(chunk: PcmChunk): PcmChunk {
  if (chunk.length <= 2) return chunk
  const roles = LAYOUTS[chunk.length]
  const frames = chunk[0]?.length ?? 0
  const left = new Float32Array(frames)
  const right = new Float32Array(frames)
  if (!roles) {
    // unknown layout: alternate channels left/right
    chunk.forEach((ch, i) => {
      const target = i % 2 === 0 ? left : right
      for (let n = 0; n < frames; n++) target[n] = (target[n] ?? 0) + (ch[n] ?? 0)
    })
    const scale = 2 / chunk.length
    for (let n = 0; n < frames; n++) {
      left[n] = (left[n] ?? 0) * scale
      right[n] = (right[n] ?? 0) * scale
    }
    return [left, right]
  }
  // weight of each channel in the left and right output
  const weights = roles.map((role) => {
    if (role === 'L') return { l: 1, r: 0 }
    if (role === 'R') return { l: 0, r: 1 }
    if (role === 'SL') return { l: SQRT1_2, r: 0 }
    if (role === 'SR') return { l: 0, r: SQRT1_2 }
    if (role === 'C' || role === 'BC') return { l: SQRT1_2, r: SQRT1_2 }
    return { l: 0, r: 0 } // LFE
  })
  // scale by the largest possible sum, so every channel at full scale lands exactly at full scale
  const norm = 1 / Math.max(weights.reduce((s, w) => s + w.l, 0), weights.reduce((s, w) => s + w.r, 0))
  chunk.forEach((ch, i) => {
    const w = weights[i]
    if (!w || (w.l === 0 && w.r === 0)) return
    for (let n = 0; n < frames; n++) {
      const v = (ch[n] ?? 0) * norm
      left[n] = (left[n] ?? 0) + v * w.l
      right[n] = (right[n] ?? 0) + v * w.r
    }
  })
  return [left, right]
}

/** The 44-byte header of a canonical PCM WAV file. */
export function wavHeader(frames: number, channels: number, sampleRate: number, bitsPerSample = 16): Uint8Array<ArrayBuffer> {
  const bytesPerSample = bitsPerSample / 8
  const dataBytes = frames * channels * bytesPerSample
  if (dataBytes > 0xffffffff - 36) throw new RangeError('Audio is too long for a WAV file')
  const out = new Uint8Array(44)
  const view = new DataView(out.buffer)
  const ascii = (offset: number, text: string) => {
    for (let i = 0; i < text.length; i++) out[offset + i] = text.charCodeAt(i)
  }
  ascii(0, 'RIFF')
  view.setUint32(4, 36 + dataBytes, true)
  ascii(8, 'WAVE')
  ascii(12, 'fmt ')
  view.setUint32(16, 16, true)
  view.setUint16(20, 1, true)
  view.setUint16(22, channels, true)
  view.setUint32(24, sampleRate, true)
  view.setUint32(28, sampleRate * channels * bytesPerSample, true)
  view.setUint16(32, channels * bytesPerSample, true)
  view.setUint16(34, bitsPerSample, true)
  ascii(36, 'data')
  view.setUint32(40, dataBytes, true)
  return out
}

export interface Pcm16EncoderOptions {
  channels: number
  sampleRate: number
  /** Add TPDF dither before rounding. Use it when reducing from more than 16 bits; unnecessary for 16-bit sources. */
  dither: boolean
  /** Seed for the dither noise, so output is reproducible. */
  seed?: number
}

const PAGE_SAMPLES = 1 << 20

/**
 * Streams decoded float audio into a 16-bit PCM WAV `Blob` without ever holding the whole track as floats:
 * each chunk is quantized straight into fixed-size pages that become Blob parts.
 */
export class Pcm16Encoder {
  readonly channels: number
  readonly sampleRate: number
  private readonly dither: boolean
  private readonly random: () => number
  private pages: Int16Array<ArrayBuffer>[] = []
  private page = new Int16Array(PAGE_SAMPLES)
  private used = 0
  private frames = 0

  constructor(options: Pcm16EncoderOptions) {
    this.channels = Math.min(2, Math.max(1, options.channels))
    this.sampleRate = options.sampleRate
    this.dither = options.dither
    this.random = seededRandom(options.seed ?? 1)
  }

  /** Frames written so far. */
  get length(): number {
    return this.frames
  }

  push(input: PcmChunk): void {
    const chunk = downmixToStereo(input)
    const n = chunk[0]?.length ?? 0
    for (let i = 0; i < n; i++) {
      for (let c = 0; c < this.channels; c++) {
        let v = (chunk[c]?.[i] ?? 0) * 32768
        if (this.dither) v += this.random() - this.random() // triangular, +-1 LSB
        const q = Math.round(v)
        this.page[this.used++] = q > 32767 ? 32767 : q < -32768 ? -32768 : q
        if (this.used === PAGE_SAMPLES) this.flushPage()
      }
    }
    this.frames += n
  }

  /** Finish and build the WAV file. The encoder must not be used afterwards. */
  finish(): Blob {
    if (this.used > 0) this.pages.push(this.page.slice(0, this.used))
    const header = wavHeader(this.frames, this.channels, this.sampleRate, 16)
    const blob = new Blob([header, ...this.pages], { type: 'audio/wav' })
    this.pages = []
    this.used = 0
    return blob
  }

  private flushPage(): void {
    this.pages.push(this.page)
    this.page = new Int16Array(PAGE_SAMPLES)
    this.used = 0
  }
}
