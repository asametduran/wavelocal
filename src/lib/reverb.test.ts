import { describe, expect, it } from 'vitest'
import {
  DECAY_MAX,
  DECAY_MIN,
  DEFAULT_REVERB,
  PRE_DELAY_MAX_MS,
  ROOM_KINDS,
  ROOM_PROFILES,
  generateImpulseResponse,
  impulseKey,
  irEnvelope,
  mergeReverb,
  normalizeReverb,
} from './reverb'
import type { RoomKind } from '../types'

const FAST = 16000

/** Reverberation time from Schroeder backward integration, extrapolated from the -5..-25 dB slope (T20). */
function rt60(ir: Float32Array, sampleRate: number): number {
  const n = ir.length
  const edc = new Float64Array(n)
  let acc = 0
  for (let i = n - 1; i >= 0; i--) {
    acc += (ir[i] ?? 0) ** 2
    edc[i] = acc
  }
  const db = (i: number) => 10 * Math.log10((edc[i] ?? 1e-30) / (edc[0] || 1e-30))
  let from = 0
  while (from < n && db(from) > -5) from++
  let to = from
  while (to < n && db(to) > -25) to++
  // least-squares slope of dB over time between the two points
  let sx = 0, sy = 0, sxx = 0, sxy = 0
  const m = to - from
  for (let i = from; i < to; i++) {
    const x = i / sampleRate
    const y = db(i)
    sx += x
    sy += y
    sxx += x * x
    sxy += x * y
  }
  const slope = (m * sxy - sx * sy) / (m * sxx - sx * sx)
  return -60 / slope
}

const energy = (a: Float32Array, from: number, to: number) => {
  let s = 0
  for (let i = from; i < to && i < a.length; i++) s += (a[i] ?? 0) ** 2
  return s
}

const rms = (a: Float32Array, from: number, to: number) => Math.sqrt(energy(a, from, to) / Math.max(1, Math.min(to, a.length) - from))

/** Spectral brightness proxy: energy of the first difference relative to the signal (white noise = 2, dark = small). */
function brightness(a: Float32Array, from: number, to: number): number {
  let d = 0
  let e = 0
  for (let i = Math.max(1, from); i < to && i < a.length; i++) {
    d += ((a[i] ?? 0) - (a[i - 1] ?? 0)) ** 2
    e += (a[i] ?? 0) ** 2
  }
  return e === 0 ? 0 : d / e
}

const crest = (a: Float32Array, from: number, to: number) => {
  let peak = 0
  for (let i = from; i < to && i < a.length; i++) peak = Math.max(peak, Math.abs(a[i] ?? 0))
  return peak / rms(a, from, to)
}

function correlation(a: Float32Array, b: Float32Array, from: number, to: number): number {
  let ab = 0, aa = 0, bb = 0
  for (let i = from; i < to; i++) {
    ab += (a[i] ?? 0) * (b[i] ?? 0)
    aa += (a[i] ?? 0) ** 2
    bb += (b[i] ?? 0) ** 2
  }
  return ab / Math.sqrt(aa * bb)
}

const ms = (seconds: number, sr = FAST) => Math.round(seconds * sr)

describe('generateImpulseResponse', () => {
  it.each(ROOM_KINDS)('%s: stereo, finite, the requested length', (room) => {
    const ir = generateImpulseResponse({ room, decay: 1.5, sampleRate: FAST })
    expect(ir.left).toHaveLength(ms(1.5))
    expect(ir.right).toHaveLength(ms(1.5))
    expect(ir.sampleRate).toBe(FAST)
    for (const ch of [ir.left, ir.right]) expect(ch.every(Number.isFinite)).toBe(true)
  })

  it('is deterministic', () => {
    const a = generateImpulseResponse({ room: 'hall', decay: 1, sampleRate: FAST })
    const b = generateImpulseResponse({ room: 'hall', decay: 1, sampleRate: FAST })
    expect(a.left.every((v, i) => v === b.left[i])).toBe(true)
    expect(a.right.every((v, i) => v === b.right[i])).toBe(true)
  })

  it('differs between rooms', () => {
    const a = generateImpulseResponse({ room: 'hall', decay: 1, sampleRate: FAST })
    const b = generateImpulseResponse({ room: 'plate', decay: 1, sampleRate: FAST })
    expect(a.left.some((v, i) => v !== b.left[i])).toBe(true)
  })

  it('clamps the decay and survives bad input', () => {
    expect(generateImpulseResponse({ room: 'hall', decay: 0, sampleRate: FAST }).left).toHaveLength(ms(DECAY_MIN))
    expect(generateImpulseResponse({ room: 'hall', decay: 99, sampleRate: 4000 }).left).toHaveLength(4000 * DECAY_MAX)
    expect(generateImpulseResponse({ room: 'hall', decay: NaN, sampleRate: FAST }).left).toHaveLength(ms(ROOM_PROFILES.hall.decay))
    expect(generateImpulseResponse({ room: 'hall', decay: 1, sampleRate: NaN }).sampleRate).toBe(44100)
  })

  describe('decay time (RT60 by Schroeder integration)', () => {
    const cases = ROOM_KINDS.flatMap((room) => [0.5, 1.5, 3].map((decay) => [room, decay] as const))
    it.each(cases)('%s with decay %s s measures within 20% of the request', (room, decay) => {
      const ir = generateImpulseResponse({ room, decay, sampleRate: FAST })
      for (const ch of [ir.left, ir.right]) {
        const measured = rt60(ch, FAST)
        expect(Math.abs(measured - decay) / decay).toBeLessThan(0.2)
      }
    })

    it('does not depend on the sample rate', () => {
      for (const sr of [8000, 22050, 44100]) {
        const ir = generateImpulseResponse({ room: 'hall', decay: 1.2, sampleRate: sr })
        expect(Math.abs(rt60(ir.left, sr) - 1.2) / 1.2).toBeLessThan(0.2)
      }
    })

    it('a longer decay is measurably longer', () => {
      const short = rt60(generateImpulseResponse({ room: 'hall', decay: 1, sampleRate: FAST }).left, FAST)
      const long = rt60(generateImpulseResponse({ room: 'hall', decay: 4, sampleRate: FAST }).left, FAST)
      expect(long).toBeGreaterThan(short * 3)
    })
  })

  it('the tail keeps getting quieter', () => {
    for (const room of ROOM_KINDS) {
      const decay = 2
      const { left } = generateImpulseResponse({ room, decay, sampleRate: FAST })
      const windows = 8
      const start = ms(0.3 * decay)
      const size = Math.floor((left.length - start) / windows)
      const levels = Array.from({ length: windows }, (_, w) => energy(left, start + w * size, start + (w + 1) * size))
      for (let w = 1; w < windows; w++) expect(levels[w]!).toBeLessThan(levels[w - 1]!)
    }
  })

  it('ends about 60 dB below where the decay begins', () => {
    const { left } = generateImpulseResponse({ room: 'plate', decay: 2, sampleRate: FAST })
    const early = rms(left, ms(0.05), ms(0.15))
    const end = rms(left, left.length - ms(0.1), left.length)
    expect(20 * Math.log10(end / early)).toBeLessThan(-50)
  })

  describe('room character', () => {
    const ir = (room: RoomKind, decay = ROOM_PROFILES[room].decay) => generateImpulseResponse({ room, decay, sampleRate: FAST })

    it('a small room has distinct early reflections, a plate does not', () => {
      const small = ir('small')
      const plate = ir('plate')
      expect(crest(small.left, 0, ms(0.05))).toBeGreaterThan(6)
      expect(crest(plate.left, 0, ms(0.05))).toBeLessThan(4.5)
    })

    it('a cathedral has a silent gap before anything arrives', () => {
      const { left, right } = ir('cathedral')
      expect(energy(left, 0, ms(0.025))).toBe(0)
      expect(energy(right, 0, ms(0.025))).toBe(0)
      expect(energy(left, ms(0.03), ms(0.25))).toBeGreaterThan(0)
    })

    it('a plate is dense immediately', () => {
      const { left } = ir('plate')
      expect(rms(left, 0, ms(0.01))).toBeGreaterThan(0.2)
    })

    it('high frequencies die faster than lows in dark rooms', () => {
      const { left } = ir('cathedral', 4)
      expect(brightness(left, ms(2.5), ms(3.5))).toBeLessThan(brightness(left, ms(0.3), ms(0.6)) * 0.5)
    })

    it('a plate stays brighter than a cathedral late in the tail', () => {
      const plate = ir('plate', 2)
      const cathedral = ir('cathedral', 2)
      const late = [ms(1.2), ms(1.7)] as const
      expect(brightness(plate.left, ...late)).toBeGreaterThan(brightness(cathedral.left, ...late) * 2)
    })

    it('the channels are decorrelated for a wide, enveloping image', () => {
      for (const room of ROOM_KINDS) {
        const { left, right } = ir(room, 2)
        expect(Math.abs(correlation(left, right, ms(0.1), left.length))).toBeLessThan(0.1)
      }
    })

    it('rooms are ordered by size: default decays grow small < plate < hall < cathedral', () => {
      const d = (k: RoomKind) => ROOM_PROFILES[k].decay
      expect(d('small')).toBeLessThan(d('plate'))
      expect(d('plate')).toBeLessThan(d('hall'))
      expect(d('hall')).toBeLessThan(d('cathedral'))
    })
  })
})

describe('irEnvelope', () => {
  it('has the requested number of bins within [0, 1] and peaks at 1', () => {
    const { left } = generateImpulseResponse({ room: 'hall', decay: 2, sampleRate: FAST })
    const env = irEnvelope(left, 64)
    expect(env).toHaveLength(64)
    expect(Math.max(...env)).toBe(1)
    expect(Math.min(...env)).toBeGreaterThanOrEqual(0)
  })

  it('falls from start to end for a decaying response', () => {
    const { left } = generateImpulseResponse({ room: 'plate', decay: 3, sampleRate: FAST })
    const env = irEnvelope(left, 32)
    expect(env[0]!).toBeGreaterThan(env[31]!)
    expect(env[31]!).toBeLessThan(0.3)
  })

  it('handles empty, silent and tiny inputs', () => {
    expect(irEnvelope([], 8)).toEqual(new Float32Array(8))
    expect(irEnvelope(new Float32Array(100), 8)).toEqual(new Float32Array(8))
    expect(irEnvelope([1], 4)).toHaveLength(4)
    expect(irEnvelope([1, 2, 3], 0)).toHaveLength(1)
  })

  it('maps -60 dB to 0 and -30 dB to 0.5', () => {
    const data = [1, 1, 0.0316, 0.0316, 0.001, 0.001]
    const env = irEnvelope(data, 3)
    expect(env[0]!).toBe(1)
    expect(env[1]!).toBeCloseTo(0.5, 1)
    expect(env[2]!).toBeLessThan(0.02)
  })
})

describe('normalizeReverb', () => {
  it('returns defaults for garbage', () => {
    for (const bad of [null, undefined, 4, 'x', [], true]) expect(normalizeReverb(bad)).toEqual(DEFAULT_REVERB)
  })

  it('keeps valid values', () => {
    const s = { enabled: true, room: 'plate', decay: 3.5, preDelayMs: 30, mix: 0.6 } as const
    expect(normalizeReverb(s)).toEqual(s)
  })

  it('clamps numbers and rejects unknown rooms', () => {
    const s = normalizeReverb({ enabled: true, room: 'bathroom', decay: 100, preDelayMs: 9999, mix: 5 })
    expect(s.room).toBe(DEFAULT_REVERB.room)
    expect(s.decay).toBe(DECAY_MAX)
    expect(s.preDelayMs).toBe(PRE_DELAY_MAX_MS)
    expect(s.mix).toBe(1)
    expect(normalizeReverb({ decay: -1 }).decay).toBe(DECAY_MIN)
  })

  it('uses the chosen room\'s defaults for missing numbers', () => {
    const s = normalizeReverb({ room: 'cathedral' })
    expect(s.decay).toBe(ROOM_PROFILES.cathedral.decay)
    expect(s.preDelayMs).toBe(ROOM_PROFILES.cathedral.preDelayMs)
  })

  it('only accepts a real boolean for enabled', () => {
    expect(normalizeReverb({ enabled: 'yes' }).enabled).toBe(false)
  })
})

describe('mergeReverb', () => {
  const base = { ...DEFAULT_REVERB, enabled: true, decay: 3, preDelayMs: 50, mix: 0.7 }

  it('changing the room loads that room\'s default decay and pre-delay', () => {
    const next = mergeReverb(base, { room: 'cathedral' })
    expect(next).toMatchObject({ room: 'cathedral', decay: ROOM_PROFILES.cathedral.decay, preDelayMs: ROOM_PROFILES.cathedral.preDelayMs, mix: 0.7, enabled: true })
  })

  it('an explicit decay in the same patch wins over the room default', () => {
    expect(mergeReverb(base, { room: 'small', decay: 1.1 })).toMatchObject({ room: 'small', decay: 1.1, preDelayMs: ROOM_PROFILES.small.preDelayMs })
  })

  it('re-selecting the current room keeps the user\'s tweaks', () => {
    expect(mergeReverb(base, { room: 'hall' })).toMatchObject({ decay: 3, preDelayMs: 50 })
  })

  it('patches without a room leave the rest alone and re-clamp', () => {
    expect(mergeReverb(base, { mix: 4 })).toMatchObject({ mix: 1, decay: 3, room: 'hall' })
    expect(base.mix).toBe(0.7)
  })

  it('ignores an invalid room in the patch', () => {
    expect(mergeReverb(base, { room: 'nope' as RoomKind }).room).toBe(DEFAULT_REVERB.room)
  })
})

describe('impulseKey', () => {
  it('changes with room, decay and sample rate but not with pre-delay or mix', () => {
    const a = impulseKey({ room: 'hall', decay: 2 }, 48000)
    expect(impulseKey({ room: 'plate', decay: 2 }, 48000)).not.toBe(a)
    expect(impulseKey({ room: 'hall', decay: 2.1 }, 48000)).not.toBe(a)
    expect(impulseKey({ room: 'hall', decay: 2 }, 44100)).not.toBe(a)
    expect(impulseKey({ room: 'hall', decay: 2 }, 48000)).toBe(a)
  })
})
