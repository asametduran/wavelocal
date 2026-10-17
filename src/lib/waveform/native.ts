import { AudioDecodeError } from '../audio/pcm'
import { PEAK_BUCKETS, PeakBuilder } from './builder'
import type { ByteWindow } from './plan'
import type { Peaks } from './types'

/**
 * The waveform of a file only the browser can decode (MP3, AAC, Ogg, ...). `decodeAudioData` takes a whole file and returns
 * all of its audio at once, so a long file is handed over in windows (see `planWindows`): each is read from the stored file,
 * decoded, scanned into a `PeakBuilder` and let go before the next is touched, so memory is one window, not the file.
 * The decoder itself is passed in, which keeps every rule here testable without a browser.
 */

/** Audio decoded by the browser: one array per channel. */
export interface DecodedAudio {
  sampleRate: number
  channels: Float32Array[]
}

export type DecodeFn = (data: ArrayBuffer) => Promise<DecodedAudio>

/** The sample rate the browser is asked to resample to: ample for a waveform, and half the memory of CD rate. */
export const DECODE_RATE = 22_050

/** Frames scanned between two looks at the clock. */
const BLOCK = 32_768

export interface NativeOptions {
  /** Seconds the audio lasts according to the headers (0: not known). It sizes the silence that stands in for a window that could not be decoded. */
  duration?: number
  signal?: AbortSignal
  /** Called with a fraction in [0, 1] after each window. */
  onProgress?: (fraction: number) => void
  /** How many slices to cut the track into. */
  buckets?: number
  /** The sample rate `decode` returns. */
  sampleRate?: number
  /** Give the event loop a turn at least this often, in milliseconds, so the page stays responsive. 0 never does. */
  yieldEveryMs?: number
}

const yieldToEventLoop = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0))

/**
 * Measure `windows` of `file`, one after the other. A window the decoder rejects (damaged data) stands in as silence of the
 * length it should have had, so everything after it stays in place; if more than half are rejected, or none decodes, the
 * file is not something the browser can decode and the error says so.
 */
export async function peaksFromWindows(file: Blob, windows: readonly ByteWindow[], decode: DecodeFn, options: NativeOptions = {}): Promise<Peaks> {
  const { duration = 0, signal, onProgress, buckets = PEAK_BUCKETS, sampleRate = DECODE_RATE, yieldEveryMs = 10 } = options
  const stopIfCancelled = (): void => {
    if (signal?.aborted) throw new AudioDecodeError('Measuring the waveform was cancelled', 'aborted')
  }
  const builder = new PeakBuilder(sampleRate)
  const audioBytes = windows.reduce((sum, w) => sum + Math.max(0, w.end - w.start), 0)
  let decoded = 0
  let lastYield = Date.now()

  for (const [i, window] of windows.entries()) {
    stopIfCancelled()
    try {
      const audio = await decode(await file.slice(window.start, window.end).arrayBuffer())
      stopIfCancelled()
      const frames = audio.channels.reduce((least, channel) => Math.min(least, channel.length), Number.POSITIVE_INFINITY)
      if (!(frames > 0) || frames === Number.POSITIVE_INFINITY) throw new AudioDecodeError('Nothing could be decoded here', 'corrupt')
      for (let at = 0; at < frames; at += BLOCK) {
        builder.push(audio.channels.map((channel) => channel.subarray(at, at + BLOCK)))
        if (yieldEveryMs > 0 && Date.now() - lastYield >= yieldEveryMs) {
          await yieldToEventLoop()
          stopIfCancelled()
          lastYield = Date.now()
        }
      }
      decoded++
    } catch (error) {
      if (error instanceof AudioDecodeError && error.code === 'aborted') throw error
      const seconds = duration > 0 && audioBytes > 0 ? (duration * (window.end - window.start)) / audioBytes : 0
      builder.skip(Math.round(seconds * sampleRate))
    }
    onProgress?.((i + 1) / windows.length)
  }

  if (decoded === 0 || (windows.length - decoded) * 2 > windows.length) throw new AudioDecodeError('The browser could not decode this file', 'unsupported')
  const peaks = builder.finish(buckets)
  if (!peaks) throw new AudioDecodeError('The file has no audio in it', 'corrupt')
  return peaks
}

/** Measure a file the browser decodes in one go. */
export function peaksFromWhole(file: Blob, decode: DecodeFn, options: NativeOptions = {}): Promise<Peaks> {
  return peaksFromWindows(file, [{ start: 0, end: file.size }], decode, options)
}

type Scope = typeof globalThis & { webkitOfflineAudioContext?: typeof OfflineAudioContext }

/** The browser's decoder: `decodeAudioData` of an offline context, resampled to `rate`. */
export function browserDecode(scope: Scope = globalThis as Scope, rate: number = DECODE_RATE): DecodeFn {
  return async (data) => {
    const Offline = scope.OfflineAudioContext ?? scope.webkitOfflineAudioContext
    if (!Offline) throw new AudioDecodeError('This browser cannot decode audio', 'unsupported')
    const audio = await new Offline(2, 2, rate).decodeAudioData(data)
    return { sampleRate: audio.sampleRate, channels: Array.from({ length: audio.numberOfChannels }, (_, c) => audio.getChannelData(c)) }
  }
}
