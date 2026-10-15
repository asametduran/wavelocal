import { describe, expect, it } from 'vitest'
import { MAX_GAIN_DB, MIN_GAIN_DB, TARGET_DBFS, estimateGainDb, gainFromSamples } from './loudness'

/** A sine wave of the given peak amplitude (RMS = amplitude / sqrt(2)). */
function sine(amplitude: number, length = 48_000, cycles = 440): Float32Array {
  const out = new Float32Array(length)
  for (let i = 0; i < length; i++) out[i] = amplitude * Math.sin((2 * Math.PI * cycles * i) / length)
  return out
}

const peakAfter = (peak: number, gainDb: number) => peak * 10 ** (gainDb / 20)

describe('gainFromSamples', () => {
  it('returns 0 for empty input', () => {
    expect(gainFromSamples(new Float32Array(0))).toBe(0)
    expect(gainFromSamples(null)).toBe(0)
    expect(gainFromSamples(undefined)).toBe(0)
  })

  it('leaves digital silence and near-silence alone', () => {
    expect(gainFromSamples(new Float32Array(48_000))).toBe(0)
    expect(gainFromSamples(sine(1e-5))).toBe(0)
  })

  it('boosts a quiet track towards the target level', () => {
    // amplitude 0.1 => RMS -23.01 dBFS => +5.0 dB to reach -18
    expect(gainFromSamples(sine(0.1))).toBeCloseTo(TARGET_DBFS - 20 * Math.log10(0.1 / Math.SQRT2), 1)
    expect(gainFromSamples(sine(0.1))).toBeCloseTo(5, 1)
  })

  it('attenuates a loud track', () => {
    // amplitude 0.5 => RMS -9.03 dBFS => -8.97 dB
    expect(gainFromSamples(sine(0.5))).toBeCloseTo(-9, 1)
  })

  it('clamps to the maximum boost and cut', () => {
    expect(gainFromSamples(sine(0.01))).toBe(MAX_GAIN_DB)
    expect(gainFromSamples(sine(0.99))).toBe(MIN_GAIN_DB)
  })

  it('never boosts a peaky track into clipping', () => {
    const peaky = sine(0.02)
    peaky[100] = 0.95
    const gain = gainFromSamples(peaky)
    expect(gain).toBeLessThan(MAX_GAIN_DB)
    expect(peakAfter(0.95, gain)).toBeLessThanOrEqual(1)
  })

  it('rounds to one decimal place', () => {
    const gain = gainFromSamples(sine(0.123))
    expect(gain * 10).toBeCloseTo(Math.round(gain * 10), 9)
  })

  it('is independent of the loudness it is fed once normalized', () => {
    for (const amplitude of [0.05, 0.1, 0.2, 0.4]) {
      const gain = gainFromSamples(sine(amplitude))
      const rms = (amplitude / Math.SQRT2) * 10 ** (gain / 20)
      expect(20 * Math.log10(rms)).toBeCloseTo(TARGET_DBFS, 0)
    }
  })

  it('decimates very long inputs without changing the answer', () => {
    const long = new Float32Array(4_100_000).fill(0.1)
    expect(gainFromSamples(long)).toBeCloseTo(2, 1) // constant 0.1 => RMS -20 dBFS
  })

  it('accepts plain arrays', () => {
    expect(gainFromSamples([0.1, -0.1, 0.1, -0.1])).toBeCloseTo(2, 1)
  })
})

describe('estimateGainDb', () => {
  it('returns 0 without a file', async () => {
    expect(await estimateGainDb(null)).toBe(0)
    expect(await estimateGainDb(undefined)).toBe(0)
  })

  it('returns 0 when audio decoding is unavailable (jsdom has no OfflineAudioContext)', async () => {
    expect(await estimateGainDb(new Blob([new Uint8Array(16)]))).toBe(0)
  })
})
