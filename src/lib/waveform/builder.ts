import type { Peaks } from './types'

/**
 * Measures how loud a track is, slice by slice, from PCM chunks in any size, without ever holding the audio: the audio is
 * measured in fixed short windows (25 ms, 12 bytes each, so a three-hour file costs about 5 MB) and `finish()` merges those
 * into the slices the seek bar draws. Time is therefore exact whatever the length of the file or of the chunks it arrives in.
 */

/** How many slices a full track is cut into: wide enough for any seek bar, small enough to keep one for every track. */
export const PEAK_BUCKETS = 1024

/** Anything quieter than this, in dBFS, is drawn as flat: speech stays readable and silence between chapters is visible. */
const FLOOR_DB = -50
const WINDOW_SECONDS = 0.025
const FIRST_WINDOWS = 4096

/** A level from 0 to 255 for an amplitude (1 is full scale) on a scale that is linear in decibels from the floor to 0 dBFS. */
export function level(amplitude: number): number {
  if (!(amplitude > 0)) return 0
  return Math.min(255, Math.round(Math.max(0, 1 + (20 * Math.log10(amplitude)) / -FLOOR_DB) * 255))
}

export class PeakBuilder {
  readonly sampleRate: number
  /** Frames in a window. */
  private readonly size: number
  /** The loudest sample (0 to 1) of each window. */
  private top = new Float32Array(FIRST_WINDOWS)
  /** The summed power of each window: squares of the samples, averaged over the channels. Doubles, so chunking cannot change the sum. */
  private power = new Float64Array(FIRST_WINDOWS)
  /** Windows begun so far; the last one may be shorter than `size`. */
  private windows = 0
  /** Frames in the last window. */
  private fill = 0
  private total = 0

  constructor(sampleRate: number) {
    if (!Number.isFinite(sampleRate) || sampleRate <= 0) throw new RangeError('The sample rate must be a positive number')
    this.sampleRate = sampleRate
    this.size = Math.max(1, Math.round(sampleRate * WINDOW_SECONDS))
  }

  /** Frames measured so far. */
  get frames(): number {
    return this.total
  }

  /** Seconds measured so far. */
  get duration(): number {
    return this.total / this.sampleRate
  }

  /** Measure a chunk (one array per channel). Channels of different lengths are read as far as the shortest goes. */
  push(channels: readonly Float32Array[]): void {
    const count = channels.length
    if (count === 0) return
    let frames = Number.POSITIVE_INFINITY
    for (const channel of channels) frames = Math.min(frames, channel.length)
    if (!(frames > 0) || frames === Number.POSITIVE_INFINITY) return

    for (let at = 0; at < frames; ) {
      const w = this.open()
      const end = Math.min(frames, at + (this.size - this.fill))
      let peak = this.top[w] ?? 0
      let squares = 0
      for (const channel of channels) {
        for (let f = at; f < end; f++) {
          const x = channel[f] ?? 0
          const a = x < 0 ? -x : x
          // not a number or infinite: silence; above full scale: full scale
          const v = a <= 1 ? a : a < Number.POSITIVE_INFINITY ? 1 : 0
          if (v > peak) peak = v
          squares += v * v
        }
      }
      this.top[w] = peak
      this.power[w] = (this.power[w] ?? 0) + squares / count
      this.fill += end - at
      this.total += end - at
      at = end
    }
  }

  /** Count `frames` of silence: a stretch that could not be decoded still takes its place in time. */
  skip(frames: number): void {
    for (let left = Math.floor(frames); left > 0; ) {
      this.open()
      const take = Math.min(left, this.size - this.fill)
      this.fill += take
      this.total += take
      left -= take
    }
  }

  /** The window the next frames go into: the last one if it has room, else a new one. */
  private open(): number {
    if (this.windows === 0 || this.fill === this.size) {
      if (this.windows === this.top.length) {
        const top = new Float32Array(this.windows * 2)
        top.set(this.top)
        const power = new Float64Array(this.windows * 2)
        power.set(this.power)
        this.top = top
        this.power = power
      }
      this.windows++
      this.fill = 0
    }
    return this.windows - 1
  }

  /**
   * Merge the windows into `buckets` slices (fewer if there is less audio than that): each takes the windows that fall in
   * it, the loudest sample of them for the peak and the power over their real number of frames for the RMS. Null when no
   * audio was measured.
   */
  finish(buckets: number = PEAK_BUCKETS): Peaks | null {
    const m = this.windows
    if (m === 0 || this.total === 0) return null
    const length = Math.max(1, Math.min(Math.floor(buckets), m))
    const peak = new Uint8Array(length)
    const rms = new Uint8Array(length)
    for (let j = 0; j < length; j++) {
      const from = Math.floor((j * m) / length)
      const to = Math.floor(((j + 1) * m) / length)
      let top = 0
      let power = 0
      let frames = 0
      for (let w = from; w < to; w++) {
        top = Math.max(top, this.top[w] ?? 0)
        power += this.power[w] ?? 0
        frames += w === m - 1 ? this.fill : this.size
      }
      peak[j] = level(top)
      rms[j] = level(frames > 0 ? Math.sqrt(power / frames) : 0)
    }
    return { v: 1, duration: this.duration, length, peak, rms }
  }
}
