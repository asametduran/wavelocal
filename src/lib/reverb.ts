import type { ReverbSettings, RoomKind } from '../types'
import { clamp, finite, seededRandom } from './dsp'

/**
 * Procedural room reverb. Impulse responses are synthesized from seeded noise: a diffuse tail with an
 * exponential envelope and a darkening low-pass (air absorption), plus discrete early reflections.
 * Everything is deterministic and independent of the sample rate, so it is unit-testable and the
 * same room always sounds the same.
 */

export const ROOM_KINDS: readonly RoomKind[] = ['small', 'hall', 'cathedral', 'plate']

export const DECAY_MIN = 0.2
export const DECAY_MAX = 8
export const PRE_DELAY_MAX_MS = 200

export interface RoomProfile {
  label: string
  description: string
  /** Default RT60 in seconds. */
  decay: number
  /** Default pre-delay in milliseconds. */
  preDelayMs: number
  /** Discrete early reflections: how many, when the first/last arrive (s) and their level. */
  early: { count: number; start: number; span: number; gain: number }
  /** Level of the diffuse tail relative to its raw noise. */
  tailGain: number
  /** Seconds before the diffuse tail starts, then how long it takes to fade in. */
  tailDelay: number
  buildup: number
  /** Tail low-pass cutoff at t=0 and at the end of the decay (Hz): higher frequencies die first. */
  dampStart: number
  dampEnd: number
}

export const ROOM_PROFILES: Record<RoomKind, RoomProfile> = {
  small: {
    label: 'Small room',
    description: 'Tight, close reflections - a living room or studio booth.',
    decay: 0.6,
    preDelayMs: 4,
    early: { count: 14, start: 0.003, span: 0.035, gain: 2.5 },
    tailGain: 0.5,
    tailDelay: 0.008,
    buildup: 0.012,
    dampStart: 9000,
    dampEnd: 2500,
  },
  hall: {
    label: 'Concert hall',
    description: 'Spacious and warm, with a gentle build-up.',
    decay: 2.4,
    preDelayMs: 22,
    early: { count: 18, start: 0.012, span: 0.09, gain: 2 },
    tailGain: 0.6,
    tailDelay: 0.04,
    buildup: 0.03,
    dampStart: 7000,
    dampEnd: 1800,
  },
  cathedral: {
    label: 'Cathedral',
    description: 'Vast and dark: a long gap, a slow bloom and a very long tail.',
    decay: 6,
    preDelayMs: 45,
    early: { count: 12, start: 0.03, span: 0.18, gain: 2.5 },
    tailGain: 0.65,
    tailDelay: 0.1,
    buildup: 0.09,
    dampStart: 5000,
    dampEnd: 700,
  },
  plate: {
    label: 'Plate',
    description: 'Bright and dense from the very first moment, like a studio plate.',
    decay: 2.2,
    preDelayMs: 0,
    early: { count: 0, start: 0, span: 0, gain: 0 },
    tailGain: 1,
    tailDelay: 0,
    buildup: 0.002,
    dampStart: 16000,
    dampEnd: 7000,
  },
}

export const DEFAULT_REVERB: ReverbSettings = {
  enabled: false,
  room: 'hall',
  decay: ROOM_PROFILES.hall.decay,
  preDelayMs: ROOM_PROFILES.hall.preDelayMs,
  mix: 0.3,
}

export interface ImpulseResponse {
  sampleRate: number
  left: Float32Array<ArrayBuffer>
  right: Float32Array<ArrayBuffer>
}

const ROOM_SEED: Record<RoomKind, number> = { small: 101, hall: 202, cathedral: 303, plate: 404 }

function buildChannel(profile: RoomProfile, decay: number, sampleRate: number, length: number, seed: number): Float32Array<ArrayBuffer> {
  const rng = seededRandom(seed)
  const out = new Float32Array(length)
  // a room with a shorter decay than its profile is a smaller room: shrink the gap, bloom and reflection spread with it
  const scale = clamp(decay / profile.decay, 0.25, 1)
  const tailDelay = profile.tailDelay * scale
  const buildup = profile.buildup * scale

  // diffuse tail: white noise -> time-varying one-pole low-pass -> exponential envelope
  const glide = Math.log(profile.dampEnd / profile.dampStart)
  let y = 0
  for (let n = 0; n < length; n++) {
    const t = n / sampleRate
    const fc = profile.dampStart * Math.exp(glide * Math.min(1, t / decay))
    const a = Math.exp((-2 * Math.PI * fc) / sampleRate) // 0 = bright, ->1 = dark
    y = (1 - a) * (rng() * 2 - 1) + a * y
    // the filter removes noise power by (1-a)/(1+a); put it back so the envelope really is the requested RT60
    const compensation = Math.sqrt((1 + a) / (1 - a))
    const envelope = 10 ** ((-3 * t) / decay)
    const into = t - tailDelay
    const fadeIn = into < 0 ? 0 : buildup > 0 ? 1 - Math.exp(-into / buildup) : 1
    out[n] = y * compensation * envelope * fadeIn * profile.tailGain
  }

  // early reflections: sparse signed impulses, fractional-delay interpolated
  const { count, gain } = profile.early
  const start = profile.early.start * scale
  const span = profile.early.span * scale
  for (let i = 0; i < count; i++) {
    const time = start + span * ((i + rng()) / count)
    const level = (gain * (0.6 + 0.4 * rng()) * 10 ** ((-3 * time) / decay)) / (1 + 6 * time)
    const signed = rng() < 0.5 ? -level : level
    const position = time * sampleRate
    const index = Math.floor(position)
    const frac = position - index
    if (index < length) out[index] = (out[index] ?? 0) + signed * (1 - frac)
    if (index + 1 < length) out[index + 1] = (out[index + 1] ?? 0) + signed * frac
  }
  return out
}

/** Synthesize a stereo impulse response of `decay` seconds (the tail ends at -60 dB). */
export function generateImpulseResponse(opts: { room: RoomKind; decay: number; sampleRate: number }): ImpulseResponse {
  const profile = ROOM_PROFILES[opts.room]
  const decay = clamp(finite(opts.decay, profile.decay), DECAY_MIN, DECAY_MAX)
  const sampleRate = Math.max(1000, Math.round(finite(opts.sampleRate, 44100)))
  const length = Math.max(64, Math.ceil(decay * sampleRate))
  return {
    sampleRate,
    left: buildChannel(profile, decay, sampleRate, length, ROOM_SEED[opts.room]),
    right: buildChannel(profile, decay, sampleRate, length, ROOM_SEED[opts.room] + 7919),
  }
}

/**
 * Loudness envelope for drawing: RMS per bin on a -60..0 dB scale mapped to 0..1,
 * where 1 is the loudest bin. Useful as a tiny preview of the decay shape.
 */
export function irEnvelope(data: ArrayLike<number>, bins: number): Float32Array {
  const n = Math.max(1, Math.floor(bins))
  const out = new Float32Array(n)
  if (!data.length) return out
  const rms = new Float64Array(n)
  let loudest = 0
  for (let b = 0; b < n; b++) {
    const from = Math.floor((b * data.length) / n)
    const to = Math.max(from + 1, Math.floor(((b + 1) * data.length) / n))
    let sum = 0
    for (let i = from; i < to && i < data.length; i++) sum += (data[i] ?? 0) ** 2
    rms[b] = Math.sqrt(sum / (to - from))
    loudest = Math.max(loudest, rms[b] ?? 0)
  }
  if (loudest === 0) return out
  for (let b = 0; b < n; b++) out[b] = clamp(1 + (20 * Math.log10(Math.max(rms[b] ?? 0, 1e-9) / loudest)) / 60, 0, 1)
  return out
}

/** Validate untrusted input (localStorage, partial updates) into well-formed reverb settings. */
export function normalizeReverb(raw: unknown): ReverbSettings {
  if (typeof raw !== 'object' || raw === null) return { ...DEFAULT_REVERB }
  const r = raw as Record<string, unknown>
  const room = ROOM_KINDS.find((k) => k === r.room) ?? DEFAULT_REVERB.room
  const profile = ROOM_PROFILES[room]
  return {
    enabled: r.enabled === true,
    room,
    decay: clamp(finite(r.decay, profile.decay), DECAY_MIN, DECAY_MAX),
    preDelayMs: clamp(finite(r.preDelayMs, profile.preDelayMs), 0, PRE_DELAY_MAX_MS),
    mix: clamp(finite(r.mix, DEFAULT_REVERB.mix), 0, 1),
  }
}

/** Merge a patch. Switching rooms loads the new room's default decay and pre-delay unless the patch sets them. */
export function mergeReverb(current: ReverbSettings, patch: Partial<ReverbSettings>): ReverbSettings {
  const next: Record<string, unknown> = { ...current, ...patch }
  if (patch.room !== undefined && patch.room !== current.room) {
    const profile = ROOM_PROFILES[patch.room] as RoomProfile | undefined
    if (profile) {
      if (patch.decay === undefined) next.decay = profile.decay
      if (patch.preDelayMs === undefined) next.preDelayMs = profile.preDelayMs
    }
  }
  return normalizeReverb(next)
}

/** Cache key for a generated buffer: settings that change the impulse response itself (not pre-delay or mix). */
export const impulseKey = (s: Pick<ReverbSettings, 'room' | 'decay'>, sampleRate: number): string => `${s.room}|${s.decay.toFixed(2)}|${sampleRate}`
