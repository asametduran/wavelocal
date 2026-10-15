import { describe, expect, it } from 'vitest'
import {
  DEFAULT_SPATIAL,
  MAX_RADIUS_M,
  MIN_RADIUS_M,
  ORBIT_MAX_SECONDS,
  ORBIT_MIN_SECONDS,
  azimuthDegrees,
  clampPad,
  describePosition,
  equalPowerMix,
  mergeSpatial,
  normalizeSpatial,
  orbitAngle,
  orbitCurve,
  orbitPosition,
  orbitRadiusMeters,
  orbitRadiusPad,
  padFromAzimuth,
  padToPosition,
  radiusMeters,
} from './spatial'

const TAU = Math.PI * 2

describe('clampPad', () => {
  it('leaves points inside the unit disc alone', () => {
    expect(clampPad(0.3, -0.4)).toEqual({ x: 0.3, y: -0.4 })
    expect(clampPad(0, 0)).toEqual({ x: 0, y: 0 })
  })

  it('projects points outside the disc onto its edge, keeping the direction', () => {
    const p = clampPad(3, 4)
    expect(Math.hypot(p.x, p.y)).toBeCloseTo(1, 10)
    expect(p.x / p.y).toBeCloseTo(3 / 4, 10)
  })

  it('corner positions of the pad square end up on the circle', () => {
    const p = clampPad(1, 1)
    expect(p.x).toBeCloseTo(Math.SQRT1_2, 10)
    expect(p.y).toBeCloseTo(Math.SQRT1_2, 10)
  })

  it.each([NaN, Infinity, -Infinity])('treats %s as the centre', (bad) => {
    expect(clampPad(bad, bad)).toEqual({ x: 0, y: 0 })
  })
})

describe('distance', () => {
  it('maps 0..1 onto 1..10 metres and clamps', () => {
    expect(radiusMeters(0)).toBe(MIN_RADIUS_M)
    expect(radiusMeters(1)).toBe(MAX_RADIUS_M)
    expect(radiusMeters(0.5)).toBeCloseTo(5.5, 10)
    expect(radiusMeters(-3)).toBe(MIN_RADIUS_M)
    expect(radiusMeters(9)).toBe(MAX_RADIUS_M)
    expect(radiusMeters(NaN)).toBe(MIN_RADIUS_M)
  })
})

describe('padToPosition', () => {
  const at = (x: number, y: number, distance = 0) => padToPosition({ x, y, distance })

  it('puts the front of the pad at -z (the Web Audio forward direction)', () => {
    expect(at(0, -1)).toEqual({ x: 0, y: 0, z: -1 })
  })

  it.each([
    ['right', 1, 0, { x: 1, z: 0 }],
    ['behind', 0, 1, { x: 0, z: 1 }],
    ['left', -1, 0, { x: -1, z: 0 }],
  ])('maps %s correctly', (_name, x, y, expected) => {
    const p = at(x, y)
    expect(p.x).toBeCloseTo(expected.x, 10)
    expect(p.z).toBeCloseTo(expected.z, 10)
    expect(p.y).toBe(0)
  })

  it('scales with the distance setting', () => {
    expect(at(0, -1, 1).z).toBe(-MAX_RADIUS_M)
    expect(at(1, 0, 0.5).x).toBeCloseTo(5.5, 10)
  })

  it('is closer to the listener for dots nearer the centre of the pad', () => {
    expect(Math.hypot(at(0.3, 0, 1).x, at(0.3, 0, 1).z)).toBeCloseTo(3, 10)
  })

  it('never leaves the maximum radius, even for out-of-range pad input', () => {
    const p = at(50, 50, 1)
    expect(Math.hypot(p.x, p.z)).toBeCloseTo(MAX_RADIUS_M, 10)
  })
})

describe('orbit geometry', () => {
  it('starts straight ahead and goes clockwise', () => {
    const start = orbitPosition(0, 2)
    expect(start.x).toBeCloseTo(0, 10)
    expect(start.z).toBeCloseTo(-2, 10)
    const quarter = orbitPosition(Math.PI / 2, 2)
    expect(quarter.x).toBeCloseTo(2, 10)
    expect(quarter.z).toBeCloseTo(0, 10)
    const half = orbitPosition(Math.PI, 2)
    expect(half.z).toBeCloseTo(2, 10)
  })

  it('advances one full turn per orbit period', () => {
    expect(orbitAngle(0, 8)).toBe(0)
    expect(orbitAngle(2, 8)).toBeCloseTo(Math.PI / 2, 10)
    expect(orbitAngle(4, 8)).toBeCloseTo(Math.PI, 10)
    expect(orbitAngle(8, 8)).toBeCloseTo(0, 10)
    expect(orbitAngle(10, 8)).toBeCloseTo(Math.PI / 2, 10)
  })

  it('honours the start angle and stays within [0, 2*PI)', () => {
    expect(orbitAngle(0, 8, Math.PI)).toBeCloseTo(Math.PI, 10)
    for (const t of [0, 1.3, 7.99, 8, 123.456, 1e5]) {
      const a = orbitAngle(t, 8, 5)
      expect(a).toBeGreaterThanOrEqual(0)
      expect(a).toBeLessThan(TAU)
    }
  })

  it('wraps negative angles', () => {
    expect(orbitAngle(0, 8, -Math.PI / 2)).toBeCloseTo((3 * Math.PI) / 2, 10)
  })

  it('orbit radius follows the pad dot but never collapses into the head', () => {
    expect(orbitRadiusPad(0, 0)).toBe(0.5)
    expect(orbitRadiusPad(0.2, 0.1)).toBe(0.5)
    expect(orbitRadiusPad(0, -0.8)).toBeCloseTo(0.8, 10)
    expect(orbitRadiusPad(0, -5)).toBeCloseTo(1, 10)
  })

  it('orbit radius in metres combines pad radius and distance', () => {
    expect(orbitRadiusMeters({ x: 0, y: -1, distance: 1 })).toBe(MAX_RADIUS_M)
    expect(orbitRadiusMeters({ x: 0, y: 0, distance: 0 })).toBe(0.5)
  })
})

describe('orbitCurve', () => {
  const curve = orbitCurve({ startAngle: 0, orbitSeconds: 8, radius: 3, duration: 8 })

  it('has matching, sufficiently dense arrays', () => {
    expect(curve.x).toHaveLength(curve.z.length)
    expect(curve.x.length).toBe(65) // 64 points per turn, one turn, plus the closing point
  })

  it('starts at the start angle and closes the circle after one orbit', () => {
    expect(curve.x[0]).toBeCloseTo(0, 5)
    expect(curve.z[0]).toBeCloseTo(-3, 5)
    expect(curve.x[curve.x.length - 1]).toBeCloseTo(0, 4)
    expect(curve.z[curve.z.length - 1]).toBeCloseTo(-3, 4)
  })

  it('stays on the circle (and between samples within 0.2%)', () => {
    for (let i = 0; i < curve.x.length; i++) expect(Math.hypot(curve.x[i]!, curve.z[i]!)).toBeCloseTo(3, 4)
    const mid = { x: (curve.x[0]! + curve.x[1]!) / 2, z: (curve.z[0]! + curve.z[1]!) / 2 }
    expect(Math.abs(Math.hypot(mid.x, mid.z) - 3) / 3).toBeLessThan(0.002)
  })

  it('goes clockwise: x grows first', () => {
    expect(curve.x[1]!).toBeGreaterThan(0)
  })

  it('is half way round after half the period', () => {
    const half = (curve.x.length - 1) / 2
    expect(curve.x[half]).toBeCloseTo(0, 4)
    expect(curve.z[half]).toBeCloseTo(3, 4)
  })

  it('scales the number of points with duration and speed', () => {
    const long = orbitCurve({ startAngle: 0, orbitSeconds: 2, radius: 1, duration: 300 })
    expect(long.x.length).toBe(Math.ceil((300 / 2) * 64) + 1)
  })

  it('always returns at least two points (the minimum for setValueCurveAtTime)', () => {
    expect(orbitCurve({ startAngle: 0, orbitSeconds: 8, radius: 1, duration: 0.001 }).x.length).toBeGreaterThanOrEqual(2)
  })

  it('continues seamlessly from an arbitrary start angle', () => {
    const c = orbitCurve({ startAngle: 1.2, orbitSeconds: 4, radius: 2, duration: 1 })
    const p = orbitPosition(1.2, 2)
    expect(c.x[0]).toBeCloseTo(p.x, 5)
    expect(c.z[0]).toBeCloseTo(p.z, 5)
  })
})

describe('equalPowerMix', () => {
  it('is fully dry at 0 and fully wet at 1', () => {
    expect(equalPowerMix(0)).toEqual({ dry: 1, wet: 0 })
    const wet = equalPowerMix(1)
    expect(wet.dry).toBeCloseTo(0, 10)
    expect(wet.wet).toBe(1)
  })

  it('keeps constant power across the sweep', () => {
    for (let m = 0; m <= 1; m += 0.1) {
      const { dry, wet } = equalPowerMix(m)
      expect(dry ** 2 + wet ** 2).toBeCloseTo(1, 10)
    }
  })

  it('is -3 dB on each side at the midpoint', () => {
    const { dry, wet } = equalPowerMix(0.5)
    expect(dry).toBeCloseTo(Math.SQRT1_2, 10)
    expect(wet).toBeCloseTo(Math.SQRT1_2, 10)
  })

  it('clamps out-of-range and invalid values', () => {
    expect(equalPowerMix(-1)).toEqual({ dry: 1, wet: 0 })
    expect(equalPowerMix(7).wet).toBe(1)
    expect(equalPowerMix(NaN).wet).toBe(1) // falls back to the fully spatial default
  })
})

describe('directions', () => {
  it.each([
    [0, -1, 0],
    [1, 0, 90],
    [0, 1, 180],
    [-1, 0, 270],
    [Math.SQRT1_2, -Math.SQRT1_2, 45],
  ])('azimuth of (%s, %s) is %s degrees', (x, y, deg) => {
    expect(azimuthDegrees(x, y)).toBeCloseTo(deg, 6)
  })

  it('padFromAzimuth is the inverse of azimuth', () => {
    for (const deg of [0, 30, 90, 135, 180, 225, 270, 359]) {
      const p = padFromAzimuth(deg)
      expect(azimuthDegrees(p.x, p.y)).toBeCloseTo(deg, 6)
      expect(Math.hypot(p.x, p.y)).toBeCloseTo(1, 10)
    }
  })

  it('padFromAzimuth clamps the radius', () => {
    expect(Math.hypot(padFromAzimuth(10, 5).x, padFromAzimuth(10, 5).y)).toBeCloseTo(1, 10)
    expect(padFromAzimuth(10, 0)).toEqual({ x: 0, y: -0 })
  })

  it.each([
    [0, -1, 'Front'],
    [0.7, -0.7, 'Front right'],
    [1, 0, 'Right'],
    [0.7, 0.7, 'Behind right'],
    [0, 1, 'Behind'],
    [-0.7, 0.7, 'Behind left'],
    [-1, 0, 'Left'],
    [-0.7, -0.7, 'Front left'],
    [0, 0, 'Centre'],
    [0.05, 0.05, 'Centre'],
  ])('describes (%s, %s) as %s', (x, y, label) => {
    expect(describePosition(x, y)).toBe(label)
  })
})

describe('normalizeSpatial / mergeSpatial', () => {
  it('returns the defaults for garbage input', () => {
    for (const bad of [null, undefined, 5, 'x', [], true]) expect(normalizeSpatial(bad)).toEqual(DEFAULT_SPATIAL)
  })

  it('keeps valid values', () => {
    const s = { enabled: true, x: 0.5, y: 0.25, distance: 0.7, mix: 0.4, rotate: true, orbitSeconds: 12 }
    expect(normalizeSpatial(s)).toEqual(s)
  })

  it('clamps every numeric field', () => {
    const s = normalizeSpatial({ enabled: true, x: 9, y: 9, distance: 5, mix: -2, rotate: true, orbitSeconds: 0.1 })
    expect(Math.hypot(s.x, s.y)).toBeCloseTo(1, 10)
    expect(s.distance).toBe(1)
    expect(s.mix).toBe(0)
    expect(s.orbitSeconds).toBe(ORBIT_MIN_SECONDS)
    expect(normalizeSpatial({ orbitSeconds: 999 }).orbitSeconds).toBe(ORBIT_MAX_SECONDS)
  })

  it('only accepts real booleans for the flags', () => {
    const s = normalizeSpatial({ enabled: 'yes', rotate: 1 })
    expect(s.enabled).toBe(false)
    expect(s.rotate).toBe(false)
  })

  it('falls back per field for wrong types', () => {
    const s = normalizeSpatial({ enabled: true, x: 'left', distance: null, mix: NaN })
    expect(s.enabled).toBe(true)
    expect(s.x).toBe(DEFAULT_SPATIAL.x)
    expect(s.distance).toBe(DEFAULT_SPATIAL.distance)
    expect(s.mix).toBe(DEFAULT_SPATIAL.mix)
  })

  it('merges a patch without mutating the original and re-clamps', () => {
    const base = { ...DEFAULT_SPATIAL, enabled: true }
    const next = mergeSpatial(base, { mix: 3, rotate: true })
    expect(next).toMatchObject({ enabled: true, mix: 1, rotate: true, x: base.x, y: base.y })
    expect(base.mix).toBe(1)
    expect(base.rotate).toBe(false)
  })

  it('has valid defaults', () => {
    expect(normalizeSpatial(DEFAULT_SPATIAL)).toEqual(DEFAULT_SPATIAL)
    expect(DEFAULT_SPATIAL.enabled).toBe(false)
  })
})
