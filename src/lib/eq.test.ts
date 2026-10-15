import { describe, expect, it } from 'vitest'
import {
  BAND_TYPES,
  FREQ_MAX,
  FREQ_MIN,
  GAIN_LIMIT,
  GRAPHIC_FREQS,
  GRAPHIC_Q,
  MAX_BANDS,
  MAX_PRESETS,
  PRESET_NAME_MAX,
  Q_MAX,
  Q_MIN,
  addBand,
  bandResponseDb,
  bandTypeInfo,
  bandsEqual,
  bandsFromSettings,
  coefficients,
  deletePreset,
  describeBand,
  findPreset,
  formatFrequency,
  formatGain,
  freqToPos,
  graphicBands,
  isGraphicLayout,
  magnitudeDb,
  nextBandId,
  normalizeBand,
  normalizeBands,
  normalizePresets,
  normalizeTrackEq,
  posToFreq,
  removeBand,
  responseCurve,
  savePreset,
  updateBand,
} from './eq'
import type { EqBand } from '../types'

const SR = 48000
const band = (over: Partial<EqBand> = {}): EqBand => ({ id: 'x', type: 'peaking', frequency: 1000, q: 1, gain: 0, ...over })
const db = (b: Partial<EqBand>, f: number) => bandResponseDb(band(b), f, SR)

describe('filter maths', () => {
  it('a peak with 0 dB gain is perfectly flat', () => {
    for (const f of [20, 100, 1000, 5000, 20000]) expect(db({ gain: 0 }, f)).toBeCloseTo(0, 6)
  })

  it.each([-12, -6, 3, 9, 12])('a peak of %s dB has exactly that gain at its centre', (gain) => {
    expect(db({ gain }, 1000)).toBeCloseTo(gain, 4)
  })

  it('a peak returns to unity far from its centre', () => {
    expect(Math.abs(db({ gain: 12 }, 30))).toBeLessThan(0.1)
    expect(Math.abs(db({ gain: 12 }, 18000))).toBeLessThan(0.5)
  })

  it('a higher Q makes a narrower peak', () => {
    const width = (q: number) => {
      let w = 0
      for (let f = 200; f <= 5000; f *= 1.01) if (db({ gain: 12, q }, f) > 3) w++
      return w
    }
    expect(width(4)).toBeLessThan(width(1))
    expect(width(1)).toBeLessThan(width(0.3))
  })

  it('a low shelf lifts the lows, leaves the highs, and has half its gain at the corner', () => {
    expect(db({ type: 'lowshelf', gain: 8 }, 20)).toBeCloseTo(8, 0)
    expect(db({ type: 'lowshelf', gain: 8 }, 1000)).toBeCloseTo(4, 1)
    expect(Math.abs(db({ type: 'lowshelf', gain: 8 }, 18000))).toBeLessThan(0.1)
  })

  it('a high shelf lifts the highs, leaves the lows, and has half its gain at the corner', () => {
    expect(db({ type: 'highshelf', gain: -6 }, 20000)).toBeCloseTo(-6, 0)
    expect(db({ type: 'highshelf', gain: -6 }, 1000)).toBeCloseTo(-3, 1)
    expect(Math.abs(db({ type: 'highshelf', gain: -6 }, 25))).toBeLessThan(0.1)
  })

  it('a notch removes its centre frequency and spares the rest', () => {
    expect(db({ type: 'notch', q: 4 }, 1000)).toBeLessThan(-40)
    expect(Math.abs(db({ type: 'notch', q: 4 }, 100))).toBeLessThan(0.1)
    expect(Math.abs(db({ type: 'notch', q: 4 }, 10000))).toBeLessThan(0.2)
  })

  it('a higher Q makes a narrower notch', () => {
    expect(db({ type: 'notch', q: 10 }, 1100)).toBeGreaterThan(db({ type: 'notch', q: 1 }, 1100))
  })

  it('a notch ignores its gain', () => {
    expect(db({ type: 'notch', gain: 12, q: 4 }, 1000)).toBe(db({ type: 'notch', gain: 0, q: 4 }, 1000))
  })

  it('a boost and a cut of equal size cancel out', () => {
    for (const f of [100, 700, 1000, 3000]) expect(db({ gain: 7 }, f) + db({ gain: -7 }, f)).toBeCloseTo(0, 6)
  })

  it('stays stable and finite across the whole range at both sample rates', () => {
    for (const rate of [22050, 44100, 48000, 96000]) {
      for (const type of BAND_TYPES.map((t) => t.type)) {
        for (const frequency of [FREQ_MIN, 1000, FREQ_MAX]) {
          const c = coefficients({ type, frequency, q: Q_MAX, gain: GAIN_LIMIT }, rate)
          expect(Object.values(c).every(Number.isFinite)).toBe(true)
          expect(Number.isFinite(magnitudeDb(c, 500, rate))).toBe(true)
          // poles inside the unit circle: |a2| < 1 and |a1| < 1 + a2
          expect(Math.abs(c.a2)).toBeLessThan(1)
          expect(Math.abs(c.a1)).toBeLessThan(1 + c.a2 + 1e-9)
        }
      }
    }
  })

  it('frequencies above Nyquist are clamped instead of producing NaN', () => {
    const c = coefficients({ type: 'peaking', frequency: 30000, q: 1, gain: 6 }, 44100)
    expect(Number.isFinite(magnitudeDb(c, 1000, 44100))).toBe(true)
  })
})

describe('responseCurve', () => {
  it('has the requested number of log-spaced points from 20 Hz to 20 kHz', () => {
    const c = responseCurve([], { points: 100 })
    expect(c.frequencies).toHaveLength(100)
    expect(c.db).toHaveLength(100)
    expect(c.frequencies[0]).toBeCloseTo(FREQ_MIN, 6)
    expect(c.frequencies[99]).toBeCloseTo(FREQ_MAX, 3)
    const ratios = Array.from({ length: 99 }, (_, i) => c.frequencies[i + 1]! / c.frequencies[i]!)
    expect(Math.max(...ratios) - Math.min(...ratios)).toBeLessThan(1e-9)
  })

  it('no bands is flat', () => {
    expect(responseCurve([]).db.every((v) => v === 0)).toBe(true)
  })

  it('a flat graphic layout is flat', () => {
    expect(responseCurve(graphicBands()).db.every((v) => Math.abs(v) < 1e-9)).toBe(true)
  })

  it('adds the decibels of bands in series', () => {
    const a = band({ gain: 6, frequency: 500 })
    const b = band({ id: 'y', type: 'highshelf', gain: -4, frequency: 4000 })
    const both = responseCurve([a, b])
    const onlyA = responseCurve([a])
    const onlyB = responseCurve([b])
    for (let i = 0; i < both.db.length; i++) expect(both.db[i]).toBeCloseTo(onlyA.db[i]! + onlyB.db[i]!, 9)
  })

  it('peaks where the bass boost preset is strongest', () => {
    const c = responseCurve(graphicBands([7, 6, 5, 3, 1, 0, 0, 0, 0, 0]))
    const max = Math.max(...c.db)
    expect(c.frequencies[c.db.indexOf(max)]!).toBeLessThan(80)
    expect(c.db[c.db.length - 1]!).toBeCloseTo(0, 1)
  })

  it('the default 160 points are cheap and finite', () => {
    const c = responseCurve(graphicBands([12, -12, 12, -12, 12, -12, 12, -12, 12, -12]))
    expect(c.db).toHaveLength(160)
    expect(c.db.every(Number.isFinite)).toBe(true)
  })
})

describe('frequency axis', () => {
  it('maps the ends and the middle', () => {
    expect(freqToPos(FREQ_MIN)).toBe(0)
    expect(freqToPos(FREQ_MAX)).toBe(1)
    expect(freqToPos(Math.sqrt(FREQ_MIN * FREQ_MAX))).toBeCloseTo(0.5, 10)
    expect(posToFreq(0)).toBe(FREQ_MIN)
    expect(posToFreq(1)).toBeCloseTo(FREQ_MAX, 6)
  })

  it('round-trips', () => {
    for (const f of [20, 31, 440, 1000, 9999, 20000]) expect(posToFreq(freqToPos(f))).toBeCloseTo(f, 6)
  })

  it('clamps out-of-range input', () => {
    expect(freqToPos(1)).toBe(0)
    expect(freqToPos(1e6)).toBe(1)
    expect(posToFreq(-2)).toBe(FREQ_MIN)
  })

  it('is exactly three decades wide, so each decade covers a third', () => {
    expect(freqToPos(200)).toBeCloseTo(1 / 3, 10)
    expect(freqToPos(2000)).toBeCloseTo(2 / 3, 10)
  })
})

describe('formatting', () => {
  it.each([
    [31, '31 Hz'],
    [999.4, '999 Hz'],
    [1000, '1.0 kHz'],
    [2500, '2.5 kHz'],
    [16000, '16 kHz'],
    [20000, '20 kHz'],
  ])('formats %s Hz as %s', (f, text) => expect(formatFrequency(f)).toBe(text))

  it('formats gains with an explicit sign', () => {
    expect(formatGain(3)).toBe('+3.0 dB')
    expect(formatGain(-2.5)).toBe('-2.5 dB')
    expect(formatGain(0)).toBe('0.0 dB')
  })

  it('describes only the parameters a band type actually uses', () => {
    expect(describeBand(band({ gain: 3 }))).toBe('Peak, 1.0 kHz, +3.0 dB, Q 1.0')
    expect(describeBand(band({ type: 'lowshelf', frequency: 100, gain: -2 }))).toBe('Low shelf, 100 Hz, -2.0 dB')
    expect(describeBand(band({ type: 'notch', q: 8 }))).toBe('Notch, 1.0 kHz, Q 8.0')
  })

  it('knows which parameters each type uses', () => {
    expect(bandTypeInfo('peaking')).toMatchObject({ usesGain: true, usesQ: true })
    expect(bandTypeInfo('highshelf')).toMatchObject({ usesGain: true, usesQ: false })
    expect(bandTypeInfo('notch')).toMatchObject({ usesGain: false, usesQ: true })
  })
})

describe('graphic layout', () => {
  it('has ten bands at the standard frequencies: shelf, eight peaks, shelf', () => {
    const bands = graphicBands()
    expect(bands.map((b) => b.frequency)).toEqual([...GRAPHIC_FREQS])
    expect(bands.map((b) => b.type)).toEqual(['lowshelf', ...Array(8).fill('peaking'), 'highshelf'])
    expect(bands.every((b) => b.q === GRAPHIC_Q && b.gain === 0)).toBe(true)
    expect(bands.map((b) => b.id)).toEqual(['g0', 'g1', 'g2', 'g3', 'g4', 'g5', 'g6', 'g7', 'g8', 'g9'])
  })

  it('applies and clamps the given gains', () => {
    const bands = graphicBands([5, -3, 99, -99, NaN])
    expect(bands.map((b) => b.gain).slice(0, 6)).toEqual([5, -3, GAIN_LIMIT, -GAIN_LIMIT, 0, 0])
  })

  it('is recognised until a band is edited', () => {
    const bands = graphicBands([1, 2, 3])
    expect(isGraphicLayout(bands)).toBe(true) // gains do not matter
    expect(isGraphicLayout(updateBand(bands, 'g3', { frequency: 300 }))).toBe(false)
    expect(isGraphicLayout(updateBand(bands, 'g3', { q: 2 }))).toBe(false)
    expect(isGraphicLayout(updateBand(bands, 'g3', { type: 'notch' }))).toBe(false)
    expect(isGraphicLayout(addBand(bands))).toBe(false)
    expect(isGraphicLayout(removeBand(bands, 'g9'))).toBe(false)
    expect(isGraphicLayout([])).toBe(false)
  })
})

describe('band editing', () => {
  it('normalizes a band and clamps every field', () => {
    expect(normalizeBand({ id: 'k', type: 'peaking', frequency: 5, q: 99, gain: 40 }, 'fb')).toEqual({ id: 'k', type: 'peaking', frequency: FREQ_MIN, q: Q_MAX, gain: GAIN_LIMIT })
    expect(normalizeBand({ frequency: 99999, q: 0, gain: -40 }, 'fb')).toMatchObject({ id: 'fb', frequency: FREQ_MAX, q: Q_MIN, gain: -GAIN_LIMIT })
  })

  it('falls back to a peak for unknown types and to defaults for junk values', () => {
    expect(normalizeBand({ type: 'allpass', frequency: 'x', q: null, gain: undefined }, 'a')).toEqual({ id: 'a', type: 'peaking', frequency: 1000, q: 1, gain: 0 })
    expect(normalizeBand(5, 'a')).toBeNull()
    expect(normalizeBand(null, 'a')).toBeNull()
  })

  it('forces the gain of a notch to 0', () => {
    expect(normalizeBand({ type: 'notch', gain: 9 }, 'n')?.gain).toBe(0)
  })

  it('adds bands with fresh ids up to the limit', () => {
    let bands: EqBand[] = []
    for (let i = 0; i < MAX_BANDS + 3; i++) bands = addBand(bands, { frequency: 200 + i })
    expect(bands).toHaveLength(MAX_BANDS)
    expect(new Set(bands.map((b) => b.id)).size).toBe(MAX_BANDS)
    expect(bands[0]).toMatchObject({ id: 'b1', type: 'peaking', gain: 0 })
  })

  it('reuses freed ids', () => {
    const bands = addBand(addBand([]))
    expect(nextBandId(removeBand(bands, 'b1'))).toBe('b1')
  })

  it('updates one band by id, re-validating the result, without mutating', () => {
    const bands = graphicBands()
    const next = updateBand(bands, 'g5', { gain: 50, frequency: 1200 })
    expect(next[5]).toMatchObject({ gain: GAIN_LIMIT, frequency: 1200 })
    expect(bands[5]?.gain).toBe(0)
    expect(next[4]).toBe(bands[4])
  })

  it('switching a band to a notch clears its gain', () => {
    const next = updateBand([band({ gain: 8 })], 'x', { type: 'notch' })
    expect(next[0]).toMatchObject({ type: 'notch', gain: 0 })
  })

  it('ignores updates and removals for unknown ids', () => {
    const bands = graphicBands()
    expect(updateBand(bands, 'zzz', { gain: 3 })).toEqual(bands)
    expect(removeBand(bands, 'zzz')).toEqual(bands)
  })

  it('removes a band by id', () => {
    expect(removeBand(graphicBands(), 'g4').map((b) => b.id)).not.toContain('g4')
  })
})

describe('normalizeBands / bandsFromSettings', () => {
  it('rejects non-arrays', () => {
    for (const bad of [null, undefined, 4, 'x', {}]) expect(normalizeBands(bad)).toBeNull()
  })

  it('drops junk entries, fixes duplicate ids and caps the length', () => {
    const many = Array.from({ length: 30 }, (_, i) => ({ id: 'same', type: 'peaking', frequency: 100 + i, q: 1, gain: 0 }))
    const out = normalizeBands([null, 5, ...many]) ?? []
    expect(out).toHaveLength(MAX_BANDS)
    expect(new Set(out.map((b) => b.id)).size).toBe(MAX_BANDS)
  })

  it('accepts an empty list (an EQ with no bands is flat)', () => {
    expect(normalizeBands([])).toEqual([])
  })

  it('prefers stored bands', () => {
    const stored = [band({ id: 'a', frequency: 300 })]
    expect(bandsFromSettings({ eqBands: stored, eq: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10] })).toEqual(stored)
  })

  it('migrates the old ten-gain format', () => {
    const bands = bandsFromSettings({ eq: [7, 6, 5, 3, 1, 0, 0, 0, 0, 0] })
    expect(isGraphicLayout(bands)).toBe(true)
    expect(bands.map((b) => b.gain)).toEqual([7, 6, 5, 3, 1, 0, 0, 0, 0, 0])
  })

  it('falls back to the flat graphic layout', () => {
    for (const saved of [{}, { eq: [1, 2] }, { eq: 'nope' }, { eqBands: 'nope' }]) expect(bandsFromSettings(saved)).toEqual(graphicBands())
  })
})

describe('bandsEqual', () => {
  it('compares every field and the order', () => {
    const a = graphicBands([1, 2, 3])
    expect(bandsEqual(a, graphicBands([1, 2, 3]))).toBe(true)
    expect(bandsEqual(a, graphicBands([1, 2, 4]))).toBe(false)
    expect(bandsEqual(a, [...a].reverse())).toBe(false)
    expect(bandsEqual(a, a.slice(1))).toBe(false)
    expect(bandsEqual(a, updateBand(a, 'g2', { q: 2 }))).toBe(false)
    expect(bandsEqual([], [])).toBe(true)
  })
})

describe('normalizeTrackEq (per-track curves)', () => {
  it('keeps valid curves keyed by track id', () => {
    const out = normalizeTrackEq({ t1: graphicBands([1, 2]), t2: [band({ id: 'k', frequency: 300 })] })
    expect(Object.keys(out)).toEqual(['t1', 't2'])
    expect(out.t1).toHaveLength(10)
    expect(out.t2?.[0]).toMatchObject({ id: 'k', frequency: 300 })
  })

  it('drops entries that are not band lists and clamps what it keeps', () => {
    const out = normalizeTrackEq({ ok: [{ id: 'z', type: 'peaking', frequency: 1, q: 1, gain: 99 }], bad: 'x', worse: null, num: 4 })
    expect(Object.keys(out)).toEqual(['ok'])
    expect(out.ok?.[0]).toMatchObject({ frequency: FREQ_MIN, gain: GAIN_LIMIT })
  })

  it('keeps an empty curve (a flat equalizer is a valid override)', () => {
    expect(normalizeTrackEq({ t: [] })).toEqual({ t: [] })
  })

  it('returns an empty map for anything that is not a plain object', () => {
    for (const bad of [null, undefined, 5, 'x', [], [[]], true]) expect(normalizeTrackEq(bad)).toEqual({})
  })
})

describe('custom presets', () => {
  const bands = [band({ id: 'a', frequency: 250, gain: 3 })]

  it('saves a copy of the bands', () => {
    const list = savePreset([], 'Warm', bands)
    expect(list).toEqual([{ name: 'Warm', bands }])
    expect(list[0]?.bands).not.toBe(bands)
    expect(list[0]?.bands[0]).not.toBe(bands[0])
  })

  it('trims and caps the name, and refuses empty names', () => {
    expect(savePreset([], '  Spaced  ', bands)[0]?.name).toBe('Spaced')
    expect(savePreset([], 'x'.repeat(100), bands)[0]?.name).toHaveLength(PRESET_NAME_MAX)
    expect(savePreset([], '   ', bands)).toEqual([])
  })

  it('overwrites a preset of the same name, ignoring case, keeping its position', () => {
    const first = savePreset(savePreset([], 'A', bands), 'B', bands)
    const next = savePreset(first, 'a', [band({ gain: -5 })])
    expect(next.map((p) => p.name)).toEqual(['A', 'B'])
    expect(next[0]?.bands[0]?.gain).toBe(-5)
  })

  it('stops accepting new names at the limit but still allows overwriting', () => {
    let list = [] as ReturnType<typeof savePreset>
    for (let i = 0; i < MAX_PRESETS; i++) list = savePreset(list, `P${i}`, bands)
    expect(list).toHaveLength(MAX_PRESETS)
    expect(savePreset(list, 'Overflow', bands)).toHaveLength(MAX_PRESETS)
    expect(savePreset(list, 'p3', [band({ gain: 1 })])[3]?.bands[0]?.gain).toBe(1)
  })

  it('deletes and finds by name regardless of case', () => {
    const list = savePreset(savePreset([], 'One', bands), 'Two', bands)
    expect(findPreset(list, 'two')?.name).toBe('Two')
    expect(deletePreset(list, 'ONE').map((p) => p.name)).toEqual(['Two'])
    expect(deletePreset(list, 'missing')).toHaveLength(2)
  })

  it('validates stored presets', () => {
    const raw = [
      { name: 'Good', bands },
      { name: 'good', bands }, // duplicate (case-insensitive)
      { name: '', bands },
      { name: 'No bands', bands: 'x' },
      null,
      7,
      { name: 'Clamped', bands: [{ id: 'z', type: 'peaking', frequency: 1, q: 1, gain: 99 }] },
    ]
    const out = normalizePresets(raw)
    expect(out.map((p) => p.name)).toEqual(['Good', 'Clamped'])
    expect(out[1]?.bands[0]).toMatchObject({ frequency: FREQ_MIN, gain: GAIN_LIMIT })
    expect(normalizePresets('nope')).toEqual([])
  })
})
