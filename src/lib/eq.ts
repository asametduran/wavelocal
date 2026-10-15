import type { BandType, EqBand, EqPreset } from '../types'
import { clamp, finite } from './dsp'

/**
 * Equalizer model and maths. Bands are the single source of truth: the 10-band graphic EQ is just ten
 * bands at fixed frequencies, and the parametric editor can change any band's type, frequency, Q and gain.
 * The biquad maths mirrors the Web Audio specification (RBJ cookbook), so the on-screen response curve
 * matches what the audio engine actually does - without needing an AudioContext to draw it.
 */

export const FREQ_MIN = 20
export const FREQ_MAX = 20000
export const Q_MIN = 0.1
export const Q_MAX = 18
export const GAIN_LIMIT = 12
export const MAX_BANDS = 12
export const MAX_PRESETS = 20
export const PRESET_NAME_MAX = 40
export const GRAPHIC_FREQS: readonly number[] = [31, 62, 125, 250, 500, 1000, 2000, 4000, 8000, 16000]
export const GRAPHIC_Q = 1.1
const DEFAULT_Q = 1

export interface BandTypeInfo {
  type: BandType
  label: string
  usesGain: boolean
  usesQ: boolean
}

export const BAND_TYPES: readonly BandTypeInfo[] = [
  { type: 'peaking', label: 'Peak', usesGain: true, usesQ: true },
  { type: 'lowshelf', label: 'Low shelf', usesGain: true, usesQ: false },
  { type: 'highshelf', label: 'High shelf', usesGain: true, usesQ: false },
  { type: 'notch', label: 'Notch', usesGain: false, usesQ: true },
]

export const bandTypeInfo = (type: BandType): BandTypeInfo => BAND_TYPES.find((t) => t.type === type) ?? (BAND_TYPES[0] as BandTypeInfo)

// ---- band lists ----

/** The standard ten-band layout (low shelf, eight peaks, high shelf) with the given gains in dB. */
export function graphicBands(gains: readonly number[] = []): EqBand[] {
  return GRAPHIC_FREQS.map((frequency, i) => ({
    id: `g${i}`,
    type: i === 0 ? 'lowshelf' : i === GRAPHIC_FREQS.length - 1 ? 'highshelf' : 'peaking',
    frequency,
    q: GRAPHIC_Q,
    gain: clamp(finite(gains[i], 0), -GAIN_LIMIT, GAIN_LIMIT),
  }))
}

/** True while the bands are exactly the standard ten-band layout, i.e. the graphic sliders can represent them. */
export function isGraphicLayout(bands: readonly EqBand[]): boolean {
  const reference = graphicBands()
  return bands.length === reference.length && bands.every((b, i) => {
    const r = reference[i]
    return r !== undefined && b.id === r.id && b.type === r.type && b.frequency === r.frequency && b.q === r.q
  })
}

/** Validate one band (clamping everything); returns null for non-objects. */
export function normalizeBand(raw: unknown, fallbackId: string): EqBand | null {
  if (typeof raw !== 'object' || raw === null) return null
  const r = raw as Record<string, unknown>
  const type = BAND_TYPES.find((t) => t.type === r.type)?.type ?? 'peaking'
  const info = bandTypeInfo(type)
  return {
    id: typeof r.id === 'string' && r.id !== '' ? r.id : fallbackId,
    type,
    frequency: clamp(finite(r.frequency, 1000), FREQ_MIN, FREQ_MAX),
    q: clamp(finite(r.q, DEFAULT_Q), Q_MIN, Q_MAX),
    gain: info.usesGain ? clamp(finite(r.gain, 0), -GAIN_LIMIT, GAIN_LIMIT) : 0,
  }
}

/** Smallest unused `b<number>` id. */
export function nextBandId(bands: readonly EqBand[]): string {
  const used = new Set(bands.map((b) => b.id))
  let n = 1
  while (used.has(`b${n}`)) n++
  return `b${n}`
}

/** Validate a stored band list (unique ids, at most MAX_BANDS); null when it is not an array at all. */
export function normalizeBands(raw: unknown): EqBand[] | null {
  if (!Array.isArray(raw)) return null
  const out: EqBand[] = []
  for (const item of raw) {
    if (out.length >= MAX_BANDS) break // junk entries do not count against the limit
    const band = normalizeBand(item, nextBandId(out))
    if (!band) continue
    out.push(out.some((b) => b.id === band.id) ? { ...band, id: nextBandId(out) } : band)
  }
  return out
}

/** Restore bands from persisted settings, migrating the old format (ten plain gains) when needed. */
export function bandsFromSettings(saved: { eqBands?: unknown; eq?: unknown }): EqBand[] {
  const stored = normalizeBands(saved.eqBands)
  if (stored) return stored
  if (Array.isArray(saved.eq) && saved.eq.length === GRAPHIC_FREQS.length) return graphicBands(saved.eq as number[])
  return graphicBands()
}

/** Append a band (default: a 1 kHz peak). Returns the same array when the band limit is reached. */
export function addBand(bands: EqBand[], partial: Partial<Omit<EqBand, 'id'>> = {}): EqBand[] {
  if (bands.length >= MAX_BANDS) return bands
  const band = normalizeBand({ type: 'peaking', frequency: 1000, q: DEFAULT_Q, gain: 0, ...partial }, nextBandId(bands))
  return band ? [...bands, { ...band, id: nextBandId(bands) }] : bands
}

export function updateBand(bands: EqBand[], id: string, patch: Partial<Omit<EqBand, 'id'>>): EqBand[] {
  return bands.map((b) => (b.id === id ? (normalizeBand({ ...b, ...patch, id: b.id }, b.id) ?? b) : b))
}

export const removeBand = (bands: EqBand[], id: string): EqBand[] => bands.filter((b) => b.id !== id)

/** Same bands, same order, same parameters (used to highlight the active preset). */
export function bandsEqual(a: readonly EqBand[], b: readonly EqBand[]): boolean {
  return a.length === b.length && a.every((x, i) => {
    const y = b[i]
    return y !== undefined && x.id === y.id && x.type === y.type && x.frequency === y.frequency && x.q === y.q && x.gain === y.gain
  })
}

// ---- biquad maths (Web Audio / RBJ cookbook) ----

export interface Biquad {
  b0: number
  b1: number
  b2: number
  a1: number
  a2: number
}

/** Normalized (a0 = 1) coefficients for a band at the given sample rate. */
export function coefficients(band: Pick<EqBand, 'type' | 'frequency' | 'q' | 'gain'>, sampleRate: number): Biquad {
  const w0 = (2 * Math.PI * clamp(band.frequency, 1, sampleRate / 2 - 1)) / sampleRate
  const cos = Math.cos(w0)
  const sin = Math.sin(w0)
  const A = 10 ** (band.gain / 40)
  let b0: number, b1: number, b2: number, a0: number, a1: number, a2: number

  if (band.type === 'peaking') {
    const alpha = sin / (2 * band.q)
    b0 = 1 + alpha * A
    b1 = -2 * cos
    b2 = 1 - alpha * A
    a0 = 1 + alpha / A
    a1 = -2 * cos
    a2 = 1 - alpha / A
  } else if (band.type === 'notch') {
    const alpha = sin / (2 * band.q)
    b0 = 1
    b1 = -2 * cos
    b2 = 1
    a0 = 1 + alpha
    a1 = -2 * cos
    a2 = 1 - alpha
  } else {
    // shelves use slope S = 1, as the Web Audio specification does
    const beta = 2 * Math.sqrt(A) * (sin / Math.SQRT2)
    if (band.type === 'lowshelf') {
      b0 = A * (A + 1 - (A - 1) * cos + beta)
      b1 = 2 * A * (A - 1 - (A + 1) * cos)
      b2 = A * (A + 1 - (A - 1) * cos - beta)
      a0 = A + 1 + (A - 1) * cos + beta
      a1 = -2 * (A - 1 + (A + 1) * cos)
      a2 = A + 1 + (A - 1) * cos - beta
    } else {
      b0 = A * (A + 1 + (A - 1) * cos + beta)
      b1 = -2 * A * (A - 1 + (A + 1) * cos)
      b2 = A * (A + 1 + (A - 1) * cos - beta)
      a0 = A + 1 - (A - 1) * cos + beta
      a1 = 2 * (A - 1 - (A + 1) * cos)
      a2 = A + 1 - (A - 1) * cos - beta
    }
  }
  return { b0: b0 / a0, b1: b1 / a0, b2: b2 / a0, a1: a1 / a0, a2: a2 / a0 }
}

/** Magnitude of the filter at `frequency`, in dB. */
export function magnitudeDb(c: Biquad, frequency: number, sampleRate: number): number {
  const w = (2 * Math.PI * frequency) / sampleRate
  const c1 = Math.cos(w)
  const s1 = Math.sin(w)
  const c2 = Math.cos(2 * w)
  const s2 = Math.sin(2 * w)
  const nr = c.b0 + c.b1 * c1 + c.b2 * c2
  const ni = -(c.b1 * s1 + c.b2 * s2)
  const dr = 1 + c.a1 * c1 + c.a2 * c2
  const di = -(c.a1 * s1 + c.a2 * s2)
  return 10 * Math.log10((nr * nr + ni * ni) / (dr * dr + di * di))
}

export const bandResponseDb = (band: Pick<EqBand, 'type' | 'frequency' | 'q' | 'gain'>, frequency: number, sampleRate = 48000): number =>
  magnitudeDb(coefficients(band, sampleRate), frequency, sampleRate)

export interface ResponseCurve {
  frequencies: Float64Array
  db: Float64Array
}

/** Combined response of all bands (they run in series, so decibels add) on a logarithmic frequency grid. */
export function responseCurve(bands: readonly EqBand[], opts: { points?: number; sampleRate?: number } = {}): ResponseCurve {
  const { points = 160, sampleRate = 48000 } = opts
  const n = Math.max(2, Math.floor(points))
  const frequencies = new Float64Array(n)
  const db = new Float64Array(n)
  const filters = bands.map((b) => coefficients(b, sampleRate))
  for (let i = 0; i < n; i++) {
    const f = posToFreq(i / (n - 1))
    frequencies[i] = f
    let sum = 0
    for (const c of filters) sum += magnitudeDb(c, f, sampleRate)
    db[i] = sum
  }
  return { frequencies, db }
}

// ---- frequency axis ----

/** Position 0..1 on the logarithmic 20 Hz - 20 kHz axis. */
export const freqToPos = (frequency: number): number => clamp(Math.log(clamp(frequency, FREQ_MIN, FREQ_MAX) / FREQ_MIN) / Math.log(FREQ_MAX / FREQ_MIN), 0, 1)

export const posToFreq = (pos: number): number => FREQ_MIN * (FREQ_MAX / FREQ_MIN) ** clamp(pos, 0, 1)

export function formatFrequency(frequency: number): string {
  if (frequency < 1000) return `${Math.round(frequency)} Hz`
  const k = frequency / 1000
  return `${k >= 10 ? Math.round(k) : k.toFixed(1)} kHz`
}

export const formatGain = (gain: number): string => `${gain > 0 ? '+' : ''}${gain.toFixed(1)} dB`

/** Screen-reader description of a band. */
export function describeBand(band: EqBand): string {
  const info = bandTypeInfo(band.type)
  const parts = [info.label, formatFrequency(band.frequency)]
  if (info.usesGain) parts.push(formatGain(band.gain))
  if (info.usesQ) parts.push(`Q ${band.q.toFixed(1)}`)
  return parts.join(', ')
}

// ---- custom presets ----

const sameName = (a: string, b: string): boolean => a.trim().toLowerCase() === b.trim().toLowerCase()

/** Validate stored presets: valid band lists, unique non-empty names (case-insensitive), at most MAX_PRESETS. */
export function normalizePresets(raw: unknown): EqPreset[] {
  if (!Array.isArray(raw)) return []
  const out: EqPreset[] = []
  for (const item of raw) {
    if (typeof item !== 'object' || item === null) continue
    const r = item as Record<string, unknown>
    const name = typeof r.name === 'string' ? r.name.trim().slice(0, PRESET_NAME_MAX) : ''
    const bands = normalizeBands(r.bands)
    if (!name || !bands || out.some((p) => sameName(p.name, name))) continue
    out.push({ name, bands })
    if (out.length >= MAX_PRESETS) break
  }
  return out
}

/** Save (or overwrite, matching the name case-insensitively) a preset. Returns the same list when nothing can be saved. */
export function savePreset(presets: readonly EqPreset[], name: string, bands: readonly EqBand[]): EqPreset[] {
  const trimmed = name.trim().slice(0, PRESET_NAME_MAX)
  const copy = normalizeBands(bands.map((b) => ({ ...b })))
  if (!trimmed || !copy) return [...presets]
  const index = presets.findIndex((p) => sameName(p.name, trimmed))
  if (index >= 0) return presets.map((p, i) => (i === index ? { name: p.name, bands: copy } : p))
  if (presets.length >= MAX_PRESETS) return [...presets]
  return [...presets, { name: trimmed, bands: copy }]
}

export const deletePreset = (presets: readonly EqPreset[], name: string): EqPreset[] => presets.filter((p) => !sameName(p.name, name))

export const findPreset = (presets: readonly EqPreset[], name: string): EqPreset | undefined => presets.find((p) => sameName(p.name, name))
