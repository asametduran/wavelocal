import { describe, expect, it } from 'vitest'
import {
  DEFAULT_SAMPLE_RATE,
  clicks,
  clipped,
  clippedSamples,
  concat,
  estimateFrequency,
  fadeInOut,
  peak,
  peakDbfs,
  rms,
  rmsDbfs,
  scale,
  seededRandom,
  silence,
  sine,
  sineAtRms,
  sweep,
  whiteNoise,
} from './signals'

describe('sine', () => {
  it('has the requested length, rate and peak', () => {
    const s = sine({ frequency: 440, amplitude: 0.5, seconds: 1 })
    expect(s).toHaveLength(DEFAULT_SAMPLE_RATE)
    expect(peak(s)).toBeCloseTo(0.5, 3)
    expect(sine({ frequency: 440, seconds: 0.5, sampleRate: 8000 })).toHaveLength(4000)
  })

  it.each([50, 440, 1000, 5000])('is measured at %i Hz', (frequency) => {
    const measured = estimateFrequency(sine({ frequency, seconds: 1 }))
    expect(Math.abs(measured - frequency) / frequency).toBeLessThan(0.002)
  })

  it('has RMS of amplitude / sqrt(2)', () => {
    expect(rms(sine({ frequency: 440, amplitude: 0.8, seconds: 1 }))).toBeCloseTo(0.8 / Math.SQRT2, 3)
  })

  it('honours the phase offset', () => {
    expect(sine({ frequency: 1, amplitude: 1, seconds: 0.001, phase: Math.PI / 2 })[0]).toBeCloseTo(1, 5)
  })

  it('is deterministic', () => {
    expect(sine({ frequency: 123, seconds: 0.1 })).toEqual(sine({ frequency: 123, seconds: 0.1 }))
  })
})

describe('sweep', () => {
  const s = sweep({ from: 100, to: 8000, seconds: 4 })

  it('rises in frequency over time', () => {
    const rate = DEFAULT_SAMPLE_RATE
    const head = estimateFrequency(s.subarray(0, Math.floor(0.2 * rate)))
    const tail = estimateFrequency(s.subarray(Math.floor(3.8 * rate)))
    expect(head).toBeGreaterThan(90)
    expect(head).toBeLessThan(200)
    expect(tail).toBeGreaterThan(5000)
    expect(tail).toBeLessThan(9000)
  })

  it('stays within the requested amplitude', () => {
    expect(peak(sweep({ from: 100, to: 1000, amplitude: 0.3, seconds: 1 }))).toBeLessThanOrEqual(0.3 + 1e-6)
  })

  it('degenerates to a plain tone when from equals to', () => {
    expect(estimateFrequency(sweep({ from: 500, to: 500, seconds: 1 }))).toBeCloseTo(500, 0)
  })

  it('rejects non-positive frequencies', () => {
    expect(() => sweep({ from: 0, to: 100, seconds: 1 })).toThrow(RangeError)
    expect(() => sweep({ from: 100, to: -1, seconds: 1 })).toThrow(RangeError)
  })
})

describe('silence and noise', () => {
  it('silence is all zeros', () => {
    const s = silence({ seconds: 0.5 })
    expect(s).toHaveLength(22050)
    expect(peak(s)).toBe(0)
    expect(rmsDbfs(s)).toBe(-Infinity)
  })

  it('white noise is seed-deterministic and bounded', () => {
    const a = whiteNoise({ seconds: 0.5, seed: 7, amplitude: 0.4 })
    expect(a).toEqual(whiteNoise({ seconds: 0.5, seed: 7, amplitude: 0.4 }))
    expect(a).not.toEqual(whiteNoise({ seconds: 0.5, seed: 8, amplitude: 0.4 }))
    expect(peak(a)).toBeLessThanOrEqual(0.4)
  })

  it('white noise is zero-mean with RMS of amplitude / sqrt(3)', () => {
    const n = whiteNoise({ seconds: 2, amplitude: 0.6, seed: 3 })
    const mean = n.reduce((sum, v) => sum + v, 0) / n.length
    expect(Math.abs(mean)).toBeLessThan(0.01)
    expect(rms(n)).toBeCloseTo(0.6 / Math.sqrt(3), 2)
  })

  it('seededRandom yields reproducible values in [0, 1)', () => {
    const r1 = seededRandom(42)
    const r2 = seededRandom(42)
    for (let i = 0; i < 1000; i++) {
      const v = r1()
      expect(v).toBe(r2())
      expect(v).toBeGreaterThanOrEqual(0)
      expect(v).toBeLessThan(1)
    }
  })
})

describe('level helpers', () => {
  it.each([-30, -18, -12, -3])('sineAtRms hits %i dBFS RMS', (rmsDb) => {
    expect(rmsDbfs(sineAtRms({ frequency: 1000, rmsDb, seconds: 1 }))).toBeCloseTo(rmsDb, 1)
  })

  it('reports peak level in dBFS', () => {
    expect(peakDbfs(sine({ frequency: 440, amplitude: 0.5, seconds: 1 }))).toBeCloseTo(-6.02, 1)
  })

  it('clipped signals sit on the rails', () => {
    const c = clipped({ frequency: 440, drive: 4, seconds: 1 })
    expect(peak(c)).toBe(1)
    expect(clippedSamples(c)).toBeGreaterThan(c.length * 0.5)
    expect(clippedSamples(sine({ frequency: 440, amplitude: 0.9, seconds: 1 }))).toBe(0)
  })

  it('estimateFrequency returns 0 when there is no oscillation', () => {
    expect(estimateFrequency(new Float32Array(1000))).toBe(0)
    expect(estimateFrequency(new Float32Array(1000).fill(0.5))).toBe(0)
  })
})

describe('editing helpers', () => {
  it('clicks places an impulse at each period', () => {
    const c = clicks({ everySeconds: 0.5, seconds: 2, sampleRate: 1000 })
    const hits = [...c].flatMap((v, i) => (v ? [i] : []))
    expect(hits).toEqual([0, 500, 1000, 1500])
  })

  it('concat joins in order', () => {
    expect([...concat(Float32Array.of(1, 2), Float32Array.of(), Float32Array.of(3))]).toEqual([1, 2, 3])
  })

  it('scale multiplies without mutating', () => {
    const input = Float32Array.of(0.5, -0.5)
    expect([...scale(input, 2)]).toEqual([1, -1])
    expect([...input]).toEqual([0.5, -0.5])
  })

  it('fadeInOut silences the edges and keeps the middle', () => {
    const faded = fadeInOut(new Float32Array(100).fill(1), 10)
    expect(faded[0]).toBe(0)
    expect(faded[99]).toBe(0)
    expect(faded[50]).toBe(1)
    expect(faded[5]).toBeCloseTo(0.5, 5)
  })
})
