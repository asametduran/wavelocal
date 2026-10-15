import { FlacDecoder, frameToChunk } from './flac'
import { AudioDecodeError, Pcm16Encoder } from './pcm'
import type { PcmChunk } from './pcm'
import { sniffContainer } from './sniff'
import type { Container } from './sniff'
import { looksLikeWav, parseWav, wavChunks } from './wav'

/**
 * Turns a WAV or FLAC file into a plain 16-bit PCM WAV that every browser plays. The decode is streamed: frames
 * are decoded, dithered and quantized one at a time straight into the output, so a long hi-res track never exists
 * as floats in memory, progress is reported as it goes, and the job can be cancelled.
 */

export interface ConvertOptions {
  /** Called with a fraction in [0, 1] as decoding proceeds. */
  onProgress?: (fraction: number) => void
  signal?: AbortSignal
  /** Treat damaged FLAC frames as silence instead of failing (default true: a click beats a skipped song). */
  lenient?: boolean
  /** Check the FLAC MD5 as a final integrity test (slower; mostly useful in tests). */
  verifyMd5?: boolean
  /** Yield to the event loop at least this often, in milliseconds, when running on the main thread. 0 disables yielding. */
  yieldEveryMs?: number
}

export interface ConvertResult {
  /** A 16-bit PCM WAV file (stereo at most). */
  blob: Blob
  container: Exclude<Container, 'other'>
  sampleRate: number
  /** Channels in the output (surround is folded down to stereo). */
  channels: number
  sourceChannels: number
  sourceBitsPerSample: number
  frames: number
  duration: number
  warnings: string[]
}

const yieldToEventLoop = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0))

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw new AudioDecodeError('Decoding was cancelled', 'aborted')
}

/** Decode `file` (a Blob or raw bytes) to a 16-bit WAV. */
export async function convertToWav(file: Blob | Uint8Array, options: ConvertOptions = {}): Promise<ConvertResult> {
  const { onProgress, signal, lenient = true, verifyMd5 = false, yieldEveryMs = 25 } = options
  throwIfAborted(signal)
  const bytes = file instanceof Uint8Array ? file : new Uint8Array(await file.arrayBuffer())
  throwIfAborted(signal)

  const container = sniffContainer(bytes)
  if (container === 'other') throw new AudioDecodeError('Not a WAV or FLAC file', 'unsupported')

  let sampleRate: number
  let sourceChannels: number
  let sourceBits: number
  let totalFrames: number
  let chunks: Iterable<PcmChunk>
  let flac: FlacDecoder | null = null

  if (container === 'wav') {
    if (!looksLikeWav(bytes)) throw new AudioDecodeError('Not a WAV file', 'corrupt')
    const info = parseWav(bytes)
    sampleRate = info.sampleRate
    sourceChannels = info.channels
    sourceBits = info.encoding === 'float' ? 32 : info.encoding === 'pcm' ? info.validBits : 16
    totalFrames = info.frames
    chunks = wavChunks(bytes, info)
  } else {
    flac = new FlacDecoder(bytes, { lenient, verifyMd5 })
    sampleRate = flac.info.sampleRate
    sourceChannels = flac.info.channels
    sourceBits = flac.info.bitsPerSample
    totalFrames = flac.info.totalSamples
    const decoder = flac
    chunks = (function* () {
      for (const frame of decoder.frames()) yield frameToChunk(frame)
    })()
  }

  // dither only when reducing word length; a 16-bit (or narrower) source is quantized without adding noise
  const encoder = new Pcm16Encoder({ channels: sourceChannels, sampleRate, dither: sourceBits > 16 })
  let done = 0
  let lastYield = Date.now()
  let lastProgress = -1

  for (const chunk of chunks) {
    throwIfAborted(signal)
    encoder.push(chunk)
    done += chunk[0]?.length ?? 0
    if (onProgress && totalFrames > 0) {
      const fraction = Math.min(1, done / totalFrames)
      if (fraction - lastProgress >= 0.01 || fraction === 1) {
        lastProgress = fraction
        onProgress(fraction)
      }
    }
    if (yieldEveryMs > 0 && Date.now() - lastYield >= yieldEveryMs) {
      await yieldToEventLoop()
      lastYield = Date.now()
    }
  }
  throwIfAborted(signal)
  onProgress?.(1)

  const warnings = flac ? [...flac.warnings] : []
  return {
    blob: encoder.finish(),
    container,
    sampleRate,
    channels: encoder.channels,
    sourceChannels,
    sourceBitsPerSample: sourceBits,
    frames: encoder.length,
    duration: encoder.length / sampleRate,
    warnings,
  }
}

/**
 * Decode only the first channel as floats, e.g. to measure loudness when the browser cannot decode the file.
 * Returns the chunks lazily so callers can accumulate statistics without holding the whole track.
 */
export function* firstChannelChunks(bytes: Uint8Array): Generator<Float32Array> {
  const container = sniffContainer(bytes)
  if (container === 'wav') {
    for (const chunk of wavChunks(bytes, parseWav(bytes))) if (chunk[0]) yield chunk[0]
  } else if (container === 'flac') {
    for (const frame of new FlacDecoder(bytes, { lenient: true }).frames()) {
      const chunk = frameToChunk(frame)
      if (chunk[0]) yield chunk[0]
    }
  } else {
    throw new AudioDecodeError('Not a WAV or FLAC file', 'unsupported')
  }
}
