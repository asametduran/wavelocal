/**
 * Loudness estimation for volume normalization (ReplayGain-style, computed locally).
 * Decodes the track once, measures RMS and peak, and returns the gain (dB) that brings it to TARGET_DBFS
 * without pushing the peak past full scale. The result is cached on the track and in IndexedDB.
 */
export const TARGET_DBFS = -18
export const MAX_GAIN_DB = 12
export const MIN_GAIN_DB = -12
const MAX_DECODE_BYTES = 60 * 1024 * 1024 // skip very large files: decoding them would cost too much memory

const toDb = (x: number): number => 20 * Math.log10(Math.max(x, 1e-9))

/** Pure maths, split out so it can be unit tested: samples -> suggested gain in dB. */
export function gainFromSamples(samples: ArrayLike<number> | null | undefined): number {
  if (!samples?.length) return 0
  const step = Math.max(1, Math.floor(samples.length / 2_000_000))
  let sum = 0
  let peak = 0
  let n = 0
  for (let i = 0; i < samples.length; i += step) {
    const v = samples[i] ?? 0
    sum += v * v
    const a = Math.abs(v)
    if (a > peak) peak = a
    n++
  }
  const rmsDb = toDb(Math.sqrt(sum / n))
  if (rmsDb < -70) return 0 // silence / near-silence: leave alone
  let gain = TARGET_DBFS - rmsDb
  gain = Math.min(gain, -toDb(peak) - 0.3) // never boost into clipping
  return Math.round(Math.min(MAX_GAIN_DB, Math.max(MIN_GAIN_DB, gain)) * 10) / 10
}

type WebkitWindow = Window & { webkitOfflineAudioContext?: typeof OfflineAudioContext }

/** Decode a file and estimate its normalization gain in dB (0 when it cannot be analysed). */
export async function estimateGainDb(file: Blob | null | undefined): Promise<number> {
  const Offline = window.OfflineAudioContext || (window as WebkitWindow).webkitOfflineAudioContext
  if (!Offline || !file || file.size > MAX_DECODE_BYTES) return 0
  try {
    const ctx = new Offline(1, 2, 44100)
    const audio = await ctx.decodeAudioData(await file.arrayBuffer())
    return gainFromSamples(audio.getChannelData(0))
  } catch {
    return 0
  }
}
