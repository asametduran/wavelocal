import type { CompressorSettings, DynamicsPatch, DynamicsSettings, LimiterSettings, StereoSettings, ToneSettings } from '../types'
import { clamp, finite } from './dsp'

/**
 * Pure model for the dynamics and stereo stages: compressor, limiter, mid/side stereo width, mono and the
 * bass/treble shelves. Ranges, validation and the static maths live here so they are unit-testable and
 * shared between the audio engine and the on-screen previews.
 */

export const THRESHOLD_RANGE = { min: -60, max: 0 } as const
export const RATIO_RANGE = { min: 1, max: 20 } as const
export const ATTACK_RANGE_MS = { min: 0, max: 200 } as const
export const RELEASE_RANGE_MS = { min: 10, max: 1000 } as const
export const KNEE_RANGE = { min: 0, max: 40 } as const
export const MAKEUP_RANGE = { min: 0, max: 24 } as const
export const CEILING_RANGE = { min: -20, max: 0 } as const
export const WIDTH_RANGE = { min: 0, max: 2 } as const
export const TONE_LIMIT = 12
export const TONE_BASS_HZ = 100
export const TONE_TREBLE_HZ = 8000

export const DEFAULT_COMPRESSOR: CompressorSettings = {
  enabled: false,
  threshold: -24,
  ratio: 4,
  attack: 10,
  release: 200,
  knee: 12,
  makeup: 0,
}
export const DEFAULT_LIMITER: LimiterSettings = { enabled: false, ceiling: -1 }
export const DEFAULT_DYNAMICS: DynamicsSettings = { compressor: { ...DEFAULT_COMPRESSOR }, limiter: { ...DEFAULT_LIMITER } }
export const DEFAULT_STEREO: StereoSettings = { width: 1, mono: false }
export const DEFAULT_TONE: ToneSettings = { bass: 0, treble: 0 }

const within = (v: unknown, fallback: number, range: { min: number; max: number }) => clamp(finite(v, fallback), range.min, range.max)
const record = (raw: unknown): Record<string, unknown> => (typeof raw === 'object' && raw !== null ? (raw as Record<string, unknown>) : {})

export function normalizeCompressor(raw: unknown): CompressorSettings {
  const r = record(raw)
  return {
    enabled: r.enabled === true,
    threshold: within(r.threshold, DEFAULT_COMPRESSOR.threshold, THRESHOLD_RANGE),
    ratio: within(r.ratio, DEFAULT_COMPRESSOR.ratio, RATIO_RANGE),
    attack: within(r.attack, DEFAULT_COMPRESSOR.attack, ATTACK_RANGE_MS),
    release: within(r.release, DEFAULT_COMPRESSOR.release, RELEASE_RANGE_MS),
    knee: within(r.knee, DEFAULT_COMPRESSOR.knee, KNEE_RANGE),
    makeup: within(r.makeup, DEFAULT_COMPRESSOR.makeup, MAKEUP_RANGE),
  }
}

export function normalizeLimiter(raw: unknown): LimiterSettings {
  const r = record(raw)
  return { enabled: r.enabled === true, ceiling: within(r.ceiling, DEFAULT_LIMITER.ceiling, CEILING_RANGE) }
}

export const normalizeDynamics = (raw: unknown): DynamicsSettings => {
  const r = record(raw)
  return { compressor: normalizeCompressor(r.compressor), limiter: normalizeLimiter(r.limiter) }
}

export const mergeDynamics = (current: DynamicsSettings, patch: DynamicsPatch): DynamicsSettings => ({
  compressor: normalizeCompressor({ ...current.compressor, ...patch.compressor }),
  limiter: normalizeLimiter({ ...current.limiter, ...patch.limiter }),
})

export function normalizeStereo(raw: unknown): StereoSettings {
  const r = record(raw)
  return { width: within(r.width, DEFAULT_STEREO.width, WIDTH_RANGE), mono: r.mono === true }
}

export const mergeStereo = (current: StereoSettings, patch: Partial<StereoSettings>): StereoSettings => normalizeStereo({ ...current, ...patch })

export function normalizeTone(raw: unknown): ToneSettings {
  const r = record(raw)
  return { bass: clamp(finite(r.bass, 0), -TONE_LIMIT, TONE_LIMIT), treble: clamp(finite(r.treble, 0), -TONE_LIMIT, TONE_LIMIT) }
}

export const mergeTone = (current: ToneSettings, patch: Partial<ToneSettings>): ToneSettings => normalizeTone({ ...current, ...patch })

// ---- maths ----

export const dbToGain = (db: number): number => 10 ** (db / 20)
export const gainToDb = (gain: number): number => 20 * Math.log10(Math.max(gain, 1e-9))

export interface StereoMatrix {
  /** Left input -> left output. */
  ll: number
  /** Left input -> right output. */
  lr: number
  /** Right input -> left output. */
  rl: number
  /** Right input -> right output. */
  rr: number
}

/**
 * Mid/side width as a plain 2x2 matrix. With M = (L+R)/2 and S = (L-R)/2 the outputs are L' = M + w*S and
 * R' = M - w*S, which expands to: straight-through gains of (1+w)/2 and cross-feed gains of (1-w)/2.
 * Width 1 is the identity, 0 is mono, 2 doubles the side signal. `mono` forces width 0.
 */
export function stereoMatrix(width: number, mono = false): StereoMatrix {
  const w = mono ? 0 : clamp(finite(width, 1), WIDTH_RANGE.min, WIDTH_RANGE.max)
  const direct = (1 + w) / 2
  const cross = (1 - w) / 2
  return { ll: direct, lr: cross, rl: cross, rr: direct }
}

export function describeStereo(s: StereoSettings): string {
  if (s.mono || s.width === 0) return 'Mono'
  if (s.width === 1) return 'Original'
  return `${Math.round(s.width * 100)}% width`
}

/**
 * Static compressor curve with a quadratic soft knee (Giannoulis, Massberg & Reiss): the output level in dB
 * for a steady input level in dB. Used to draw the transfer curve and to sanity check the engine.
 */
export function compressorOutputDb(inputDb: number, s: Pick<CompressorSettings, 'threshold' | 'ratio' | 'knee'>): number {
  const { threshold: t, ratio: r, knee: w } = s
  const over = inputDb - t
  if (w <= 0) return over <= 0 ? inputDb : t + over / r
  if (2 * over < -w) return inputDb
  if (2 * Math.abs(over) <= w) return inputDb + ((1 / r - 1) * (over + w / 2) ** 2) / (2 * w)
  return t + over / r
}

/**
 * The make-up gain Web Audio applies on its own inside every DynamicsCompressorNode, in dB. The specification
 * defines it as the reciprocal of the compression curve's output at 0 dBFS, raised to the power 0.6, and it
 * cannot be switched off. Left alone it cancels the reduction (a -20 dB limiter would add about +11 dB right back),
 * so the engine trims exactly this amount to make the controls behave like a conventional compressor.
 */
export const autoMakeupDb = (s: Pick<CompressorSettings, 'threshold' | 'ratio' | 'knee'>): number => -0.6 * compressorOutputDb(0, s)

/** Gain reduction (a value <= 0 dB) applied at a given input level. */
export const gainReductionDb = (inputDb: number, s: Pick<CompressorSettings, 'threshold' | 'ratio' | 'knee'>): number => compressorOutputDb(inputDb, s) - inputDb

export interface TransferCurve {
  input: Float64Array
  output: Float64Array
}

/** Input/output levels from -60 dBFS to 0 dBFS, including make-up gain, for drawing. */
export function transferCurve(s: Pick<CompressorSettings, 'threshold' | 'ratio' | 'knee' | 'makeup'>, points = 61): TransferCurve {
  const n = Math.max(2, Math.floor(points))
  const input = new Float64Array(n)
  const output = new Float64Array(n)
  for (let i = 0; i < n; i++) {
    input[i] = -60 + (60 * i) / (n - 1)
    output[i] = compressorOutputDb(input[i] ?? 0, s) + s.makeup
  }
  return { input, output }
}

/** Seconds, as the DynamicsCompressorNode expects (the UI works in milliseconds). */
export const msToSeconds = (ms: number): number => ms / 1000
