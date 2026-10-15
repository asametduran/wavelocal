/** Deterministic synthetic signal generators and measurements for audio tests. Everything is pure and seedable. */

import { seededRandom } from '../lib/dsp'

export const DEFAULT_SAMPLE_RATE = 44100

interface Base {
  seconds: number
  sampleRate?: number
}

const frameCount = ({ seconds, sampleRate = DEFAULT_SAMPLE_RATE }: Base): number => Math.max(0, Math.round(seconds * sampleRate))

/** Pure tone. `amplitude` is the peak value (0..1). */
export function sine({ frequency, amplitude = 0.5, phase = 0, ...base }: Base & { frequency: number; amplitude?: number; phase?: number }): Float32Array {
  const rate = base.sampleRate ?? DEFAULT_SAMPLE_RATE
  const out = new Float32Array(frameCount(base))
  for (let i = 0; i < out.length; i++) out[i] = amplitude * Math.sin(2 * Math.PI * frequency * (i / rate) + phase)
  return out
}

/** Logarithmic frequency sweep from `from` to `to` Hz over the duration. */
export function sweep({ from, to, amplitude = 0.5, ...base }: Base & { from: number; to: number; amplitude?: number }): Float32Array {
  if (from <= 0 || to <= 0) throw new RangeError('sweep frequencies must be positive')
  const rate = base.sampleRate ?? DEFAULT_SAMPLE_RATE
  const out = new Float32Array(frameCount(base))
  const k = to / from
  for (let i = 0; i < out.length; i++) {
    const t = i / rate
    // instantaneous phase of an exponential chirp: 2*pi*f0*T/ln(k) * (k^(t/T) - 1)
    const phase = k === 1 ? 2 * Math.PI * from * t : ((2 * Math.PI * from * base.seconds) / Math.log(k)) * (k ** (t / base.seconds) - 1)
    out[i] = amplitude * Math.sin(phase)
  }
  return out
}

export function silence(base: Base): Float32Array {
  return new Float32Array(frameCount(base))
}

export { seededRandom }

/** White noise with uniform distribution in [-amplitude, amplitude]. */
export function whiteNoise({ amplitude = 0.3, seed = 1, ...base }: Base & { amplitude?: number; seed?: number }): Float32Array {
  const rand = seededRandom(seed)
  const out = new Float32Array(frameCount(base))
  for (let i = 0; i < out.length; i++) out[i] = (rand() * 2 - 1) * amplitude
  return out
}

/** A hot tone: `drive`x overdriven then hard-clipped to full scale, like a badly mastered track. */
export function clipped({ frequency, drive = 3, ...base }: Base & { frequency: number; drive?: number }): Float32Array {
  const out = sine({ frequency, amplitude: drive, ...base })
  for (let i = 0; i < out.length; i++) out[i] = Math.max(-1, Math.min(1, out[i] ?? 0))
  return out
}

/** A sine whose RMS level is `rmsDb` dBFS (RMS of a sine is amplitude / sqrt(2)). */
export function sineAtRms({ frequency, rmsDb, ...base }: Base & { frequency: number; rmsDb: number }): Float32Array {
  return sine({ frequency, amplitude: 10 ** (rmsDb / 20) * Math.SQRT2, ...base })
}

/** Impulse train: a single full-scale sample at the start of each period. Handy for timing/seek checks. */
export function clicks({ everySeconds, amplitude = 1, ...base }: Base & { everySeconds: number; amplitude?: number }): Float32Array {
  const rate = base.sampleRate ?? DEFAULT_SAMPLE_RATE
  const out = new Float32Array(frameCount(base))
  const step = Math.max(1, Math.round(everySeconds * rate))
  for (let i = 0; i < out.length; i += step) out[i] = amplitude
  return out
}

export function concat(...parts: readonly Float32Array[]): Float32Array {
  const out = new Float32Array(parts.reduce((n, p) => n + p.length, 0))
  let offset = 0
  for (const p of parts) {
    out.set(p, offset)
    offset += p.length
  }
  return out
}

/** Multiply by a linear gain (does not clip; encoders do). */
export function scale(samples: Float32Array, gain: number): Float32Array {
  return samples.map((v) => v * gain)
}

export function fadeInOut(samples: Float32Array, fadeFrames: number): Float32Array {
  const out = samples.slice()
  const n = Math.min(fadeFrames, Math.floor(out.length / 2))
  for (let i = 0; i < n; i++) {
    const g = i / n
    out[i] = (out[i] ?? 0) * g
    out[out.length - 1 - i] = (out[out.length - 1 - i] ?? 0) * g
  }
  return out
}

// ---- measurements ----

export function peak(samples: ArrayLike<number>): number {
  let p = 0
  for (let i = 0; i < samples.length; i++) p = Math.max(p, Math.abs(samples[i] ?? 0))
  return p
}

export function rms(samples: ArrayLike<number>): number {
  if (!samples.length) return 0
  let sum = 0
  for (let i = 0; i < samples.length; i++) sum += (samples[i] ?? 0) ** 2
  return Math.sqrt(sum / samples.length)
}

/** RMS level in dBFS (-Infinity for pure silence). */
export function rmsDbfs(samples: ArrayLike<number>): number {
  return 20 * Math.log10(rms(samples))
}

export function peakDbfs(samples: ArrayLike<number>): number {
  return 20 * Math.log10(peak(samples))
}

/** Fundamental frequency estimate from interpolated positive-going zero crossings (good for clean tones). */
export function estimateFrequency(samples: ArrayLike<number>, sampleRate = DEFAULT_SAMPLE_RATE): number {
  const crossings: number[] = []
  for (let i = 1; i < samples.length; i++) {
    const a = samples[i - 1] ?? 0
    const b = samples[i] ?? 0
    if (a < 0 && b >= 0) crossings.push(i - 1 + -a / (b - a))
  }
  const first = crossings[0]
  const last = crossings[crossings.length - 1]
  if (first === undefined || last === undefined || crossings.length < 2) return 0
  return ((crossings.length - 1) * sampleRate) / (last - first)
}

/**
 * Number of samples at (or within `threshold` of) full scale, i.e. how hard a signal is clipped.
 * The default sits just below 1 because PCM16 cannot store +1.0 exactly (it decodes to 32767/32768).
 */
export function clippedSamples(samples: ArrayLike<number>, threshold = 0.9999): number {
  let n = 0
  for (let i = 0; i < samples.length; i++) if (Math.abs(samples[i] ?? 0) >= threshold) n++
  return n
}
