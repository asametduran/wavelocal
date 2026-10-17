/**
 * Seeded fuzzing helpers for the parsers of untrusted input (tags, lyrics, backups, playlist files, pairing codes, audio
 * containers). Everything is deterministic: a failing case is reproduced by its seed, and the same seeds run everywhere.
 * `FUZZ_RUNS=20 npm test` multiplies the number of cases for a longer local session; `FUZZ_SEED=1000` shifts them.
 */
import { seededRandom } from '../lib/dsp'

export type Random = () => number

/**
 * The timeout of a fuzz suite, which grows with the number of cases (`FUZZ_RUNS`). It is wall time (the runner cannot count
 * anything else), so it is sized for a suite that shares the machine with dozens of others: the slowest takes 7 s alone and
 * 38 s when ninety files compete for the cores. The budgets inside the tests are in CPU time and say what is too slow.
 */
export const FUZZ_TIMEOUT = 60_000 * Math.min(1000, Math.max(1, Number((globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env?.FUZZ_RUNS) || 1))

/** Whether two byte arrays are equal, without the cost of a deep comparison that prints a diff (megabytes of it, on failure). */
export function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false
  return true
}

// the app's TypeScript project has no Node typings, and tests also run where there is no `process`
const env = (name: string): string | undefined => (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env?.[name]

/** The scale factor for the number of cases (`FUZZ_RUNS`, default 1, at most 1000). */
export const FUZZ_SCALE = Math.min(1000, Math.max(1, Number(env('FUZZ_RUNS')) || 1))
const FUZZ_SEED_SHIFT = Math.max(0, Math.trunc(Number(env('FUZZ_SEED')) || 0))

/** `count` times the scale factor seeds: the same ones every run unless `FUZZ_SEED` shifts them. */
export function seeds(count: number): number[] {
  return Array.from({ length: Math.max(1, Math.round(count * FUZZ_SCALE)) }, (_, i) => FUZZ_SEED_SHIFT + i + 1)
}

export const rng = (seed: number): Random => seededRandom(seed)

export const int = (random: Random, below: number): number => Math.floor(random() * below)
export const pick = <T>(random: Random, items: readonly T[]): T => items[int(random, items.length)] as T

/** Run `check` once per seed; the seed is in the failure message, so a failure can be replayed. */
export function eachSeed(count: number, check: (random: Random, seed: number) => void | Promise<void>): Promise<void> {
  return (async () => {
    for (const seed of seeds(count)) {
      try {
        await check(rng(seed), seed)
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        throw new Error(`fuzz seed ${seed}: ${message}`, { cause: error })
      }
    }
  })()
}

/** Byte values that break parsers: boundaries of signed and unsigned sizes, sync bytes, text terminators. */
const INTERESTING = [0x00, 0x01, 0x02, 0x7f, 0x80, 0x81, 0xfe, 0xff] as const

export function randomBytes(random: Random, length: number): Uint8Array {
  const out = new Uint8Array(length)
  for (let i = 0; i < length; i++) out[i] = random() < 0.2 ? pick(random, INTERESTING) : int(random, 256)
  return out
}

/**
 * A damaged copy of `input`: between one and four of flipped bits, bytes replaced by boundary values, a truncation, a
 * stretch of random bytes appended, a region repeated, a region cut out, two regions swapped, or a 16/32-bit field
 * overwritten with an extreme. Never returns the input itself.
 */
export function mutateBytes(random: Random, input: Uint8Array): Uint8Array {
  let bytes = Uint8Array.from(input)
  const rounds = 1 + int(random, 4)
  for (let round = 0; round < rounds; round++) {
    const length = bytes.length
    const at = length ? int(random, length) : 0
    switch (int(random, 8)) {
      case 0: // flip a few bits
        for (let i = 0; i < 1 + int(random, 4) && length; i++) bytes[int(random, length)] = (bytes[int(random, length)] ?? 0) ^ (1 << int(random, 8))
        break
      case 1: // boundary values
        for (let i = 0; i < 1 + int(random, 3) && length; i++) bytes[int(random, length)] = pick(random, INTERESTING)
        break
      case 2: // truncate
        bytes = bytes.slice(0, length ? int(random, length) : 0)
        break
      case 3: // append junk
        bytes = Uint8Array.from([...bytes, ...randomBytes(random, 1 + int(random, 64))])
        break
      case 4: { // repeat a region
        const end = Math.min(length, at + 1 + int(random, 64))
        bytes = Uint8Array.from([...bytes.slice(0, end), ...bytes.slice(at, end), ...bytes.slice(end)])
        break
      }
      case 5: // cut a region out
        bytes = Uint8Array.from([...bytes.slice(0, at), ...bytes.slice(Math.min(length, at + 1 + int(random, 64)))])
        break
      case 6: { // swap two regions
        const other = length ? int(random, length) : 0
        const size = Math.min(1 + int(random, 16), length - Math.max(at, other))
        for (let i = 0; i < size; i++) {
          const a = bytes[at + i] ?? 0
          bytes[at + i] = bytes[other + i] ?? 0
          bytes[other + i] = a
        }
        break
      }
      default: { // a size field set to an extreme
        const value = pick(random, [0, 1, 0x7fff, 0x8000, 0xffff, 0x7fffffff, 0x80000000, 0xffffffff])
        const wide = random() < 0.5
        for (let i = 0; i < (wide ? 4 : 2) && at + i < length; i++) bytes[at + i] = (value >>> (8 * (random() < 0.5 ? i : (wide ? 3 : 1) - i))) & 0xff
      }
    }
  }
  return bytes
}

const ODD_TEXT = ['\u0000', '\u0001', '\r', '\n', '\r\n', ' ', '﻿', '‮', '\ud800', '\udfff', '́', 'İ', 'ı', '\\', '"', "'", '[', ']', '{', '}', '<', '>', '%', '%zz', '..', '../', '​', '😀']

/** A damaged copy of `text`: odd characters inserted, regions repeated or cut, the text truncated. */
export function mutateText(random: Random, input: string): string {
  let text = input
  const rounds = 1 + int(random, 4)
  for (let round = 0; round < rounds; round++) {
    const at = text.length ? int(random, text.length) : 0
    switch (int(random, 5)) {
      case 0:
        text = text.slice(0, at) + pick(random, ODD_TEXT) + text.slice(at)
        break
      case 1:
        text = text.slice(0, at)
        break
      case 2:
        text = text.slice(0, at) + text.slice(at, at + 1 + int(random, 30)).repeat(2 + int(random, 20)) + text.slice(at)
        break
      case 3:
        text = text.slice(0, at) + text.slice(at + 1 + int(random, 30))
        break
      default:
        text = text.slice(0, at) + String.fromCharCode(int(random, 0x10000)) + text.slice(at)
    }
  }
  return text
}

export function randomText(random: Random, length: number, alphabet?: string): string {
  let out = ''
  for (let i = 0; i < length; i++) out += alphabet ? alphabet[int(random, alphabet.length)] : random() < 0.3 ? pick(random, ODD_TEXT) : String.fromCharCode(32 + int(random, 95))
  return out
}

const processCpu = (globalThis as { process?: { cpuUsage?: () => { user: number; system: number } } }).process

/** Whether `clock` counts CPU time (false: there is no `process`, and it is the wall clock). */
export const CPU_CLOCK = typeof processCpu?.cpuUsage === 'function'

/**
 * The reading of the clock that time budgets use, in milliseconds: the CPU time this process has spent, not the time on the
 * wall. The unit tests run dozens of files at once, on laptops and two-core CI runners that are busy with other things, so
 * a test can wait for a core several times longer than its work takes, and a budget that counted the waiting would fail for
 * no fault of the code. Vitest gives every test file its own process and runs its tests one after another, so the CPU time
 * that passes while a test runs is that test's (including threads that native work such as zlib runs on). The steps are
 * coarse on some systems (about 16 ms on Windows), which is nothing against budgets of half a second and more.
 */
export function clock(): number {
  if (!processCpu?.cpuUsage) return performance.now()
  const { user, system } = processCpu.cpuUsage()
  return (user + system) / 1000
}

/** Coverage instrumentation makes code two to four times slower; time budgets are in milliseconds of an uninstrumented run. */
export const SLOWDOWN = env('NODE_V8_COVERAGE') ? 4 : 1

/** Milliseconds since `start` (a `clock()` reading), as an uninstrumented run would have taken. */
export const since = (start: number): number => (clock() - start) / SLOWDOWN

/** Milliseconds of CPU `work` takes, as an uninstrumented run would have taken. */
export function timed<T>(work: () => T): { result: T; ms: number } {
  const start = clock()
  const result = work()
  return { result, ms: since(start) }
}
