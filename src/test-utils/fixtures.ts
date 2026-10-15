/**
 * Named synthetic audio fixtures shared by unit tests and the Playwright e2e suite.
 * Nothing here ships in the app bundle and no real audio is ever committed: every file is generated on demand.
 */
import { clipped, concat, fadeInOut, silence, sine, sineAtRms, sweep } from './signals'
import { encodeWav } from './wav'
import type { WavFormat } from './wav'

export interface Fixture {
  /** Stable id, also the file stem. */
  name: string
  fileName: string
  description: string
  seconds: number
  sampleRate: number
  channels: number
  format: WavFormat
  bytes: Uint8Array<ArrayBuffer>
}

interface Recipe {
  description: string
  seconds: number
  sampleRate?: number
  format?: WavFormat
  /** One entry per channel. */
  channels: (rate: number, seconds: number) => Float32Array[]
}

const recipes = {
  'tone-440': {
    description: 'A4 sine, mono, -6 dBFS peak',
    seconds: 4,
    channels: (sampleRate, seconds) => [sine({ frequency: 440, amplitude: 0.5, seconds, sampleRate })],
  },
  'tone-880': {
    description: 'A5 sine, mono, -6 dBFS peak (a second, distinguishable track)',
    seconds: 4,
    channels: (sampleRate, seconds) => [sine({ frequency: 880, amplitude: 0.5, seconds, sampleRate })],
  },
  sweep: {
    description: 'Logarithmic sweep 100 Hz -> 8 kHz',
    seconds: 4,
    channels: (sampleRate, seconds) => [fadeInOut(sweep({ from: 100, to: 8000, amplitude: 0.5, seconds, sampleRate }), 441)],
  },
  silence: {
    description: 'Digital silence',
    seconds: 2,
    channels: (sampleRate, seconds) => [silence({ seconds, sampleRate })],
  },
  quiet: {
    description: '1 kHz sine at -30 dBFS RMS (normalization should boost it)',
    seconds: 4,
    channels: (sampleRate, seconds) => [sineAtRms({ frequency: 1000, rmsDb: -30, seconds, sampleRate })],
  },
  loud: {
    description: '1 kHz sine at -8 dBFS RMS (normalization should cut it)',
    seconds: 4,
    channels: (sampleRate, seconds) => [sineAtRms({ frequency: 1000, rmsDb: -8, seconds, sampleRate })],
  },
  clipped: {
    description: '440 Hz sine overdriven 4x and hard clipped',
    seconds: 3,
    channels: (sampleRate, seconds) => [clipped({ frequency: 440, drive: 4, seconds, sampleRate })],
  },
  'stereo-split': {
    description: 'Left 440 Hz, right 880 Hz',
    seconds: 4,
    channels: (sampleRate, seconds) => [
      sine({ frequency: 440, amplitude: 0.5, seconds, sampleRate }),
      sine({ frequency: 880, amplitude: 0.5, seconds, sampleRate }),
    ],
  },
  'tone-24bit': {
    description: '440 Hz sine stored as 24-bit PCM',
    seconds: 3,
    format: 'pcm24',
    channels: (sampleRate, seconds) => [sine({ frequency: 440, amplitude: 0.5, seconds, sampleRate })],
  },
  'tone-float': {
    description: '440 Hz sine stored as 32-bit float',
    seconds: 3,
    format: 'float32',
    channels: (sampleRate, seconds) => [sine({ frequency: 440, amplitude: 0.5, seconds, sampleRate })],
  },
  long: {
    description: '30 s tone at 8 kHz (small file, long enough for seek/resume tests)',
    seconds: 30,
    sampleRate: 8000,
    channels: (sampleRate, seconds) => [sine({ frequency: 330, amplitude: 0.4, seconds, sampleRate })],
  },
  'loud-then-quiet': {
    description: '2 s at -8 dBFS RMS followed by 2 s at -30 dBFS RMS',
    seconds: 4,
    channels: (sampleRate) => [
      concat(sineAtRms({ frequency: 1000, rmsDb: -8, seconds: 2, sampleRate }), sineAtRms({ frequency: 1000, rmsDb: -30, seconds: 2, sampleRate })),
    ],
  },
} satisfies Record<string, Recipe>

export type FixtureName = keyof typeof recipes

export const FIXTURE_NAMES = Object.keys(recipes) as FixtureName[]

/** Generate a fixture's WAV bytes. Deterministic: the same name always yields identical bytes. */
export function buildFixture(name: FixtureName): Fixture {
  const recipe: Recipe = recipes[name]
  const sampleRate = recipe.sampleRate ?? 44100
  const format = recipe.format ?? 'pcm16'
  const channels = recipe.channels(sampleRate, recipe.seconds)
  return {
    name,
    fileName: `${name}.wav`,
    description: recipe.description,
    seconds: recipe.seconds,
    sampleRate,
    channels: channels.length,
    format,
    bytes: encodeWav(channels, { sampleRate, format }),
  }
}

/** A `File` for a fixture (works in jsdom and in Node 20+). `lastModified` is pinned so the dedupe key is stable. */
export function fixtureFile(name: FixtureName, fileName?: string): File {
  const f = buildFixture(name)
  return new File([f.bytes], fileName ?? f.fileName, { type: 'audio/wav', lastModified: 1_700_000_000_000 })
}

/** Build LRC text from [seconds, text] pairs. */
export function lrcText(lines: readonly (readonly [seconds: number, text: string])[]): string {
  return lines
    .map(([s, text]) => {
      const m = Math.floor(s / 60)
      const rest = (s - m * 60).toFixed(2).padStart(5, '0')
      return `[${String(m).padStart(2, '0')}:${rest}]${text}`
    })
    .join('\n')
}
