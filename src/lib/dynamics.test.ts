import { describe, expect, it } from 'vitest'
import {
  ATTACK_RANGE_MS,
  CEILING_RANGE,
  DEFAULT_COMPRESSOR,
  DEFAULT_DYNAMICS,
  DEFAULT_LIMITER,
  DEFAULT_STEREO,
  DEFAULT_TONE,
  KNEE_RANGE,
  MAKEUP_RANGE,
  RATIO_RANGE,
  RELEASE_RANGE_MS,
  THRESHOLD_RANGE,
  TONE_LIMIT,
  WIDTH_RANGE,
  autoMakeupDb,
  compressorOutputDb,
  dbToGain,
  describeStereo,
  gainReductionDb,
  gainToDb,
  mergeDynamics,
  mergeStereo,
  mergeTone,
  msToSeconds,
  normalizeCompressor,
  normalizeDynamics,
  normalizeLimiter,
  normalizeStereo,
  normalizeTone,
  stereoMatrix,
  transferCurve,
} from './dynamics'

describe('stereoMatrix', () => {
  it('width 1 is the identity (nothing changes)', () => {
    expect(stereoMatrix(1)).toEqual({ ll: 1, lr: 0, rl: 0, rr: 1 })
  })

  it('width 0 and the mono switch both sum to mono (0.5 of each channel in both ears)', () => {
    expect(stereoMatrix(0)).toEqual({ ll: 0.5, lr: 0.5, rl: 0.5, rr: 0.5 })
    expect(stereoMatrix(1.7, true)).toEqual({ ll: 0.5, lr: 0.5, rl: 0.5, rr: 0.5 })
  })

  it('width 2 doubles the side signal (cross-feed becomes negative)', () => {
    expect(stereoMatrix(2)).toEqual({ ll: 1.5, lr: -0.5, rl: -0.5, rr: 1.5 })
  })

  it('is symmetric between the channels', () => {
    for (const w of [0, 0.3, 1, 1.5, 2]) {
      const m = stereoMatrix(w)
      expect(m.ll).toBe(m.rr)
      expect(m.lr).toBe(m.rl)
    }
  })

  it('never changes a centred (mono) signal: L = R passes through at unity for every width', () => {
    for (const w of [0, 0.4, 1, 1.6, 2]) {
      const m = stereoMatrix(w)
      expect(m.ll + m.rl).toBeCloseTo(1, 12) // left output for L = R = 1
      expect(m.lr + m.rr).toBeCloseTo(1, 12)
    }
  })

  it('removes a pure side signal at width 0 and amplifies it by the width otherwise', () => {
    for (const w of [0, 0.5, 1, 2]) {
      const m = stereoMatrix(w)
      const left = m.ll * 1 + m.rl * -1 // L = 1, R = -1 (side only)
      const right = m.lr * 1 + m.rr * -1
      expect(left).toBeCloseTo(w, 12)
      expect(right).toBeCloseTo(-w, 12)
    }
  })

  it('clamps and tolerates bad widths', () => {
    expect(stereoMatrix(9)).toEqual(stereoMatrix(WIDTH_RANGE.max))
    expect(stereoMatrix(-4)).toEqual(stereoMatrix(0))
    expect(stereoMatrix(NaN)).toEqual(stereoMatrix(1))
  })

  it('describes the setting for display', () => {
    expect(describeStereo({ width: 1, mono: false })).toBe('Original')
    expect(describeStereo({ width: 1.5, mono: false })).toBe('150% width')
    expect(describeStereo({ width: 0, mono: false })).toBe('Mono')
    expect(describeStereo({ width: 1.2, mono: true })).toBe('Mono')
  })
})

describe('compressor transfer curve', () => {
  const hard = { threshold: -24, ratio: 4, knee: 0 }
  const soft = { threshold: -24, ratio: 4, knee: 12 }

  it('leaves signals below the threshold untouched', () => {
    for (const x of [-60, -40, -30, -24.01]) expect(compressorOutputDb(x, hard)).toBe(x)
  })

  it('divides the excess over the threshold by the ratio', () => {
    expect(compressorOutputDb(-24, hard)).toBe(-24)
    expect(compressorOutputDb(-8, hard)).toBeCloseTo(-24 + 16 / 4, 10)
    expect(compressorOutputDb(0, hard)).toBeCloseTo(-18, 10)
  })

  it('a ratio of 1 does nothing at all', () => {
    for (const x of [-50, -20, 0]) expect(compressorOutputDb(x, { threshold: -30, ratio: 1, knee: 10 })).toBeCloseTo(x, 10)
  })

  it('never makes the signal louder', () => {
    for (let x = -60; x <= 0; x += 1.5) {
      expect(gainReductionDb(x, soft)).toBeLessThanOrEqual(1e-12)
      expect(gainReductionDb(x, hard)).toBeLessThanOrEqual(1e-12)
    }
  })

  it('is continuous across both ends of a soft knee', () => {
    const lowEdge = soft.threshold - soft.knee / 2
    const highEdge = soft.threshold + soft.knee / 2
    expect(compressorOutputDb(lowEdge - 1e-6, soft)).toBeCloseTo(compressorOutputDb(lowEdge + 1e-6, soft), 5)
    expect(compressorOutputDb(highEdge - 1e-6, soft)).toBeCloseTo(compressorOutputDb(highEdge + 1e-6, soft), 5)
  })

  it('a soft knee starts reducing before the threshold, so it is already working where a hard knee still is not', () => {
    expect(gainReductionDb(-28, soft)).toBeLessThan(0)
    expect(gainReductionDb(-28, hard)).toBe(0)
    expect(gainReductionDb(-24, hard)).toBe(0)
    expect(gainReductionDb(-24, soft)).toBeCloseTo(-1.125, 10) // (1/4 - 1) * (6^2) / (2 * 12)
  })

  it('is monotonic: louder in is never quieter out', () => {
    let previous = -Infinity
    for (let x = -60; x <= 0; x += 0.5) {
      const y = compressorOutputDb(x, soft)
      expect(y).toBeGreaterThanOrEqual(previous)
      previous = y
    }
  })

  it('has slope 1/ratio well above the knee and slope 1 well below it', () => {
    const slope = (a: number, b: number) => (compressorOutputDb(b, soft) - compressorOutputDb(a, soft)) / (b - a)
    expect(slope(-60, -50)).toBeCloseTo(1, 10)
    expect(slope(-10, 0)).toBeCloseTo(1 / 4, 10)
  })

  it('handles a zero-width knee without dividing by zero', () => {
    expect(Number.isFinite(compressorOutputDb(-24, { threshold: -24, ratio: 4, knee: 0 }))).toBe(true)
  })

  it('transferCurve spans -60..0 dBFS, applies the make-up gain and stays finite', () => {
    const c = transferCurve({ ...soft, makeup: 6 }, 61)
    expect(c.input).toHaveLength(61)
    expect(c.input[0]).toBe(-60)
    expect(c.input[60]).toBe(0)
    expect(c.output[0]).toBeCloseTo(-60 + 6, 10)
    expect(Array.from(c.output).every(Number.isFinite)).toBe(true)
    expect(transferCurve({ ...soft, makeup: 0 }, 1).input).toHaveLength(2)
  })
})

describe('autoMakeupDb (the gain Web Audio adds inside the compressor)', () => {
  it('is 0.6 times the amount the curve pulls 0 dBFS down', () => {
    // threshold -20 dB, 20:1, hard knee: 0 dBFS comes out at -19 dB
    expect(autoMakeupDb({ threshold: -20, ratio: 20, knee: 0 })).toBeCloseTo(0.6 * 19, 10)
    // threshold -24 dB, 4:1: 0 dBFS comes out at -18 dB
    expect(autoMakeupDb({ threshold: -24, ratio: 4, knee: 0 })).toBeCloseTo(0.6 * 18, 10)
  })

  it('is zero when nothing is compressed', () => {
    expect(autoMakeupDb({ threshold: -24, ratio: 1, knee: 12 })).toBeCloseTo(0, 10)
    expect(autoMakeupDb({ threshold: 0, ratio: 20, knee: 0 })).toBeCloseTo(0, 10)
  })

  it('grows with the ratio and with a lower threshold, and is never negative', () => {
    const at = (threshold: number, ratio: number) => autoMakeupDb({ threshold, ratio, knee: 6 })
    expect(at(-24, 8)).toBeGreaterThan(at(-24, 2))
    expect(at(-40, 4)).toBeGreaterThan(at(-10, 4))
    for (let r = 1; r <= 20; r += 3) for (let t = -60; t <= 0; t += 12) expect(at(t, r)).toBeGreaterThanOrEqual(-1e-9)
  })

  it('cancels the loudest-signal reduction at the make-up weighting the spec uses', () => {
    const s = { threshold: -20, ratio: 20, knee: 0 }
    const reduction = gainReductionDb(0, s) // dB the curve removes at 0 dBFS
    expect(autoMakeupDb(s)).toBeCloseTo(-0.6 * reduction, 10)
  })
})

describe('conversions', () => {
  it('dB and gain round-trip', () => {
    for (const db of [-40, -6, 0, 3, 12]) expect(gainToDb(dbToGain(db))).toBeCloseTo(db, 10)
    expect(dbToGain(0)).toBe(1)
    expect(dbToGain(6)).toBeCloseTo(1.9953, 3)
    expect(gainToDb(0)).toBeLessThan(-150)
  })

  it('converts milliseconds to the seconds Web Audio wants', () => {
    expect(msToSeconds(250)).toBe(0.25)
  })
})

describe('normalizing settings', () => {
  it('returns defaults for garbage', () => {
    for (const bad of [null, undefined, 3, 'x', [], true]) {
      expect(normalizeCompressor(bad)).toEqual(DEFAULT_COMPRESSOR)
      expect(normalizeLimiter(bad)).toEqual(DEFAULT_LIMITER)
      expect(normalizeDynamics(bad)).toEqual(DEFAULT_DYNAMICS)
      expect(normalizeStereo(bad)).toEqual(DEFAULT_STEREO)
      expect(normalizeTone(bad)).toEqual(DEFAULT_TONE)
    }
  })

  it('keeps valid values', () => {
    const c = { enabled: true, threshold: -30, ratio: 8, attack: 5, release: 300, knee: 6, makeup: 4 }
    expect(normalizeCompressor(c)).toEqual(c)
    expect(normalizeLimiter({ enabled: true, ceiling: -3 })).toEqual({ enabled: true, ceiling: -3 })
    expect(normalizeStereo({ width: 1.4, mono: true })).toEqual({ width: 1.4, mono: true })
    expect(normalizeTone({ bass: 5, treble: -3 })).toEqual({ bass: 5, treble: -3 })
  })

  it('clamps every numeric field into the documented range', () => {
    const c = normalizeCompressor({ threshold: -999, ratio: 99, attack: -5, release: 99999, knee: 99, makeup: 99 })
    expect(c).toMatchObject({
      threshold: THRESHOLD_RANGE.min,
      ratio: RATIO_RANGE.max,
      attack: ATTACK_RANGE_MS.min,
      release: RELEASE_RANGE_MS.max,
      knee: KNEE_RANGE.max,
      makeup: MAKEUP_RANGE.max,
    })
    expect(normalizeLimiter({ ceiling: 5 }).ceiling).toBe(CEILING_RANGE.max)
    expect(normalizeLimiter({ ceiling: -99 }).ceiling).toBe(CEILING_RANGE.min)
    expect(normalizeStereo({ width: 9 }).width).toBe(WIDTH_RANGE.max)
    expect(normalizeTone({ bass: 99, treble: -99 })).toEqual({ bass: TONE_LIMIT, treble: -TONE_LIMIT })
  })

  it('only accepts real booleans for flags', () => {
    expect(normalizeCompressor({ enabled: 'yes' }).enabled).toBe(false)
    expect(normalizeLimiter({ enabled: 1 }).enabled).toBe(false)
    expect(normalizeStereo({ mono: 'true' }).mono).toBe(false)
  })

  it('fills missing nested sections with defaults', () => {
    expect(normalizeDynamics({ compressor: { enabled: true } })).toEqual({ compressor: { ...DEFAULT_COMPRESSOR, enabled: true }, limiter: DEFAULT_LIMITER })
  })
})

describe('merging patches', () => {
  it('merges each processor separately without touching the other', () => {
    const base = normalizeDynamics({ compressor: { enabled: true, ratio: 6 }, limiter: { enabled: true, ceiling: -2 } })
    const next = mergeDynamics(base, { compressor: { threshold: -40 } })
    expect(next.compressor).toMatchObject({ enabled: true, ratio: 6, threshold: -40 })
    expect(next.limiter).toEqual(base.limiter)
    expect(mergeDynamics(base, { limiter: { ceiling: 9 } }).limiter.ceiling).toBe(CEILING_RANGE.max)
    expect(base.compressor.threshold).toBe(DEFAULT_COMPRESSOR.threshold) // not mutated
  })

  it('re-clamps stereo and tone patches', () => {
    expect(mergeStereo(DEFAULT_STEREO, { width: 5 }).width).toBe(2)
    expect(mergeStereo(DEFAULT_STEREO, { mono: true })).toEqual({ width: 1, mono: true })
    expect(mergeTone(DEFAULT_TONE, { bass: 40 })).toEqual({ bass: TONE_LIMIT, treble: 0 })
  })

  it('has sane defaults: everything is off or neutral', () => {
    expect(DEFAULT_COMPRESSOR.enabled).toBe(false)
    expect(DEFAULT_LIMITER.enabled).toBe(false)
    expect(DEFAULT_STEREO).toEqual({ width: 1, mono: false })
    expect(DEFAULT_TONE).toEqual({ bass: 0, treble: 0 })
  })
})
