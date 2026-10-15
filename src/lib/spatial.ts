import type { SpatialSettings } from '../types'

/**
 * Pure geometry for 3D spatial audio. The listener sits at the origin facing -z (the Web Audio default);
 * the UI pad is the same plane seen from above, so pad `y` maps straight onto world `z`.
 */

export const ORBIT_MIN_SECONDS = 2
export const ORBIT_MAX_SECONDS = 30
export const MIN_RADIUS_M = 1
export const MAX_RADIUS_M = 10
/** How far ahead an orbit is scheduled on the audio clock before it is refreshed. */
export const ORBIT_HORIZON_SECONDS = 300
/** Curve resolution; linear interpolation between 64 points per turn deviates from a circle by about 0.1%. */
export const ORBIT_POINTS_PER_TURN = 64

export const DEFAULT_SPATIAL: SpatialSettings = {
  enabled: false,
  x: 0,
  y: -1, // straight ahead
  distance: 0.15,
  mix: 1,
  rotate: false,
  orbitSeconds: 8,
}

const TAU = Math.PI * 2

const finite = (v: unknown, fallback: number): number => (typeof v === 'number' && Number.isFinite(v) ? v : fallback)
const clamp = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, v))

export interface Point2 {
  x: number
  y: number
}

export interface Position3 {
  x: number
  y: number
  z: number
}

/** Keep a pad position inside the unit disc (non-finite input becomes the centre). */
export function clampPad(x: number, y: number): Point2 {
  const px = finite(x, 0)
  const py = finite(y, 0)
  const len = Math.hypot(px, py)
  return len > 1 ? { x: px / len, y: py / len } : { x: px, y: py }
}

/** Source distance in metres for a 0..1 distance setting. */
export const radiusMeters = (distance: number): number => MIN_RADIUS_M + clamp(finite(distance, 0), 0, 1) * (MAX_RADIUS_M - MIN_RADIUS_M)

/** World position (metres) of a static source for the given pad position and distance setting. */
export function padToPosition({ x, y, distance }: Pick<SpatialSettings, 'x' | 'y' | 'distance'>): Position3 {
  const p = clampPad(x, y)
  const r = radiusMeters(distance)
  return { x: p.x * r, y: 0, z: p.y * r }
}

/** While orbiting, the circle's radius (in pad units) follows how far out the pad dot sits, but never collapses into the head. */
export const orbitRadiusPad = (x: number, y: number): number => {
  const p = clampPad(x, y)
  return Math.max(0.5, Math.hypot(p.x, p.y))
}

export const orbitRadiusMeters = (s: Pick<SpatialSettings, 'x' | 'y' | 'distance'>): number => orbitRadiusPad(s.x, s.y) * radiusMeters(s.distance)

/** Position on a circle: angle 0 is straight ahead, increasing clockwise (towards the right ear). */
export function orbitPosition(angle: number, radius: number): { x: number; z: number } {
  return { x: radius * Math.sin(angle), z: -radius * Math.cos(angle) }
}

/** Orbit angle in [0, 2*PI) after `elapsedSeconds`, starting from `startAngle`. */
export function orbitAngle(elapsedSeconds: number, orbitSeconds: number, startAngle = 0): number {
  const turn = (TAU * elapsedSeconds) / orbitSeconds
  return (((startAngle + turn) % TAU) + TAU) % TAU
}

/** Azimuth of a pad position in radians [0, 2*PI): 0 = front, PI/2 = right, PI = behind, 3*PI/2 = left. */
export function azimuth(x: number, y: number): number {
  return ((Math.atan2(x, -y) % TAU) + TAU) % TAU
}

export const azimuthDegrees = (x: number, y: number): number => (azimuth(x, y) * 180) / Math.PI

/** Pad position at a given azimuth (degrees, 0 = front, clockwise) and radius in pad units. */
export function padFromAzimuth(degrees: number, radius = 1): Point2 {
  const a = (degrees * Math.PI) / 180
  const r = clamp(finite(radius, 1), 0, 1)
  return { x: r * Math.sin(a), y: -r * Math.cos(a) }
}

export interface OrbitCurve {
  x: Float32Array
  z: Float32Array
}

/**
 * Sample a circular orbit for `AudioParam.setValueCurveAtTime`. Both arrays span `duration` seconds,
 * start at `startAngle`, and share the same length.
 */
export function orbitCurve(opts: {
  startAngle: number
  orbitSeconds: number
  radius: number
  duration: number
  pointsPerTurn?: number
}): OrbitCurve {
  const { startAngle, orbitSeconds, radius, duration, pointsPerTurn = ORBIT_POINTS_PER_TURN } = opts
  const n = Math.max(2, Math.ceil((duration / orbitSeconds) * pointsPerTurn) + 1)
  const x = new Float32Array(n)
  const z = new Float32Array(n)
  for (let i = 0; i < n; i++) {
    const t = (duration * i) / (n - 1)
    const p = orbitPosition(startAngle + (TAU * t) / orbitSeconds, radius)
    x[i] = p.x
    z[i] = p.z
  }
  return { x, z }
}

/** Equal-power crossfade so the loudness stays steady while sweeping from dry (0) to wet (1). */
export function equalPowerMix(mix: number): { dry: number; wet: number } {
  const m = clamp(finite(mix, 1), 0, 1)
  return { dry: Math.cos((m * Math.PI) / 2), wet: Math.sin((m * Math.PI) / 2) }
}

const SECTORS = ['Front', 'Front right', 'Right', 'Behind right', 'Behind', 'Behind left', 'Left', 'Front left'] as const

/** Human-readable direction for a pad position (used for screen-reader value text). */
export function describePosition(x: number, y: number): string {
  const p = clampPad(x, y)
  if (Math.hypot(p.x, p.y) < 0.12) return 'Centre'
  const sector = SECTORS[Math.round(azimuthDegrees(p.x, p.y) / 45) % 8]
  return sector ?? 'Front'
}

export const PAD_PRESETS: readonly { label: string; x: number; y: number }[] = [
  { label: 'Front', x: 0, y: -1 },
  { label: 'Right', x: 1, y: 0 },
  { label: 'Behind', x: 0, y: 1 },
  { label: 'Left', x: -1, y: 0 },
]

/** Validate untrusted input (localStorage, partial updates) into well-formed settings. */
export function normalizeSpatial(raw: unknown): SpatialSettings {
  if (typeof raw !== 'object' || raw === null) return { ...DEFAULT_SPATIAL }
  const r = raw as Record<string, unknown>
  const pad = clampPad(finite(r.x, DEFAULT_SPATIAL.x), finite(r.y, DEFAULT_SPATIAL.y))
  return {
    enabled: r.enabled === true,
    x: pad.x,
    y: pad.y,
    distance: clamp(finite(r.distance, DEFAULT_SPATIAL.distance), 0, 1),
    mix: clamp(finite(r.mix, DEFAULT_SPATIAL.mix), 0, 1),
    rotate: r.rotate === true,
    orbitSeconds: clamp(finite(r.orbitSeconds, DEFAULT_SPATIAL.orbitSeconds), ORBIT_MIN_SECONDS, ORBIT_MAX_SECONDS),
  }
}

export const mergeSpatial = (current: SpatialSettings, patch: Partial<SpatialSettings>): SpatialSettings => normalizeSpatial({ ...current, ...patch })
