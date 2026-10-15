/** Small numeric helpers shared by the DSP modules (spatial, reverb) and the synthetic-audio test tools. */

export const finite = (v: unknown, fallback: number): number => (typeof v === 'number' && Number.isFinite(v) ? v : fallback)

export const clamp = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, v))

/** mulberry32: a tiny seeded PRNG, so "random" impulse responses and fixtures are reproducible. */
export function seededRandom(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/** Equal-power crossfade so the loudness stays steady while sweeping from dry (0) to wet (1). */
export function equalPowerMix(mix: number): { dry: number; wet: number } {
  const m = clamp(finite(mix, 1), 0, 1)
  return { dry: Math.cos((m * Math.PI) / 2), wet: Math.sin((m * Math.PI) / 2) }
}
