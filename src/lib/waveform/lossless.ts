import { FlacDecoder, frameToChunk } from '../audio/flac'
import { AudioDecodeError } from '../audio/pcm'
import type { PcmChunk } from '../audio/pcm'
import { sniffContainer } from '../audio/sniff'
import { looksLikeWav, parseWav, wavChunks } from '../audio/wav'
import { PEAK_BUCKETS, PeakBuilder } from './builder'
import type { Peaks } from './types'

/**
 * The waveform of a WAV or FLAC file, measured with the built-in decoders. The audio is decoded a block at a time and handed to
 * a `PeakBuilder`, so a long track never exists as floats in memory; this runs in a worker (`audio/decode.worker.ts`), and
 * gives the event loop a turn every few milliseconds so that a `cancel` message is heard while it works.
 */

export interface LosslessOptions {
  signal?: AbortSignal
  /** Called with a fraction in [0, 1] as the file is read. */
  onProgress?: (fraction: number) => void
  /** How many slices to cut the track into. */
  buckets?: number
  /** Give the event loop a turn at least this often, in milliseconds. 0 never does. */
  yieldEveryMs?: number
}

const yieldToEventLoop = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0))

export async function peaksFromLossless(file: Blob | Uint8Array, options: LosslessOptions = {}): Promise<Peaks> {
  const { signal, onProgress, buckets = PEAK_BUCKETS, yieldEveryMs = 25 } = options
  const stopIfCancelled = (): void => {
    if (signal?.aborted) throw new AudioDecodeError('Measuring the waveform was cancelled', 'aborted')
  }
  stopIfCancelled()
  const bytes = file instanceof Uint8Array ? file : new Uint8Array(await file.arrayBuffer())
  stopIfCancelled()

  const container = sniffContainer(bytes)
  let sampleRate: number
  let totalFrames: number
  let chunks: Iterable<PcmChunk>
  if (container === 'wav') {
    if (!looksLikeWav(bytes)) throw new AudioDecodeError('Not a WAV file', 'corrupt')
    const info = parseWav(bytes)
    sampleRate = info.sampleRate
    totalFrames = info.frames
    chunks = wavChunks(bytes, info)
  } else if (container === 'flac') {
    const decoder = new FlacDecoder(bytes, { lenient: true }) // a damaged frame is a gap in the waveform, not a missing waveform
    sampleRate = decoder.info.sampleRate
    totalFrames = decoder.info.totalSamples
    chunks = (function* () {
      for (const frame of decoder.frames()) yield frameToChunk(frame)
    })()
  } else {
    throw new AudioDecodeError('Not a WAV or FLAC file', 'unsupported')
  }
  if (!(sampleRate > 0)) throw new AudioDecodeError('The file does not say its sample rate', 'corrupt')

  const builder = new PeakBuilder(sampleRate)
  let lastYield = Date.now()
  let lastProgress = -1
  for (const chunk of chunks) {
    stopIfCancelled()
    builder.push(chunk)
    if (onProgress && totalFrames > 0) {
      const fraction = Math.min(1, builder.frames / totalFrames)
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
  stopIfCancelled()
  onProgress?.(1)
  const peaks = builder.finish(buckets)
  if (!peaks) throw new AudioDecodeError('The file has no audio in it', 'corrupt')
  return peaks
}
