// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { FUZZ_TIMEOUT, eachSeed, int, pick, randomText } from '../../test-utils/fuzz'
import type { Random } from '../../test-utils/fuzz'
import { memoryKv } from '../../test-utils/memorykv'
import { FINISHED, KEEP_RECENT, MAX_SPEED, MIN_KEPT, MIN_SPEED, MODES, STALE_DAYS, normalizeProgress, staleKeys } from './progress'
import type { Progress } from './progress'
import { loadAllProgress } from './progressstore'
import { ProgressService } from './progressservice'
import { LongFormSession } from './session'
import type { Moment, SessionPort, SessionStore } from './session'

// Where a person stopped comes back from the database: whatever is in there, what comes out must be a record the rules could
// have written (a place that is a time, a speed the player offers, a known choice), and the session that writes records must
// never write one that is not, ask the player for a speed it does not offer, or throw, whatever the player reports.

const NOW = 1_800_000_000_000
const DAY = 86_400_000
const SPEEDS = Array.from({ length: 31 }, (_, i) => Math.round((MIN_SPEED + i * 0.05) * 20) / 20)

const validSpeed = (speed: number): boolean => Number.isFinite(speed) && speed >= MIN_SPEED && speed <= MAX_SPEED && Math.abs(speed * 20 - Math.round(speed * 20)) < 1e-9

/** What is wrong with a record for one the rules could have written (nothing, when it is one). */
function problems(p: Progress): string[] {
  const found: string[] = []
  if (Object.keys(p).sort().join() !== 'at,mode,speed,t,v') found.push(`fields ${Object.keys(p).join()}`)
  if (p.v !== 1) found.push(`version ${p.v}`)
  if (!(Number.isFinite(p.at) && p.at >= 0)) found.push(`at ${p.at}`)
  if (p.t !== null && !(Number.isFinite(p.t) && p.t >= 0)) found.push(`t ${p.t}`)
  if (p.speed !== null && !validSpeed(p.speed)) found.push(`speed ${p.speed}`)
  if (!MODES.includes(p.mode)) found.push(`mode ${p.mode}`)
  return found
}

const WILD: readonly unknown[] = [0, 5, 14.9, 600, 1e9, -1, Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, '600', null, undefined, {}, [], true, 2 ** 53, 1.23456, 5e-324]

function wildRecord(random: Random): unknown {
  if (int(random, 12) === 0) return pick<unknown>(random, [null, undefined, 'x', 5, [], true])
  const fields: Record<string, unknown> = {}
  if (random() < 0.9) fields.v = random() < 0.85 ? 1 : pick<unknown>(random, [0, 2, '1', null, {}])
  if (random() < 0.9) fields.at = pick(random, WILD)
  if (random() < 0.9) fields.t = random() < 0.5 ? random() * 7200 : pick(random, WILD)
  if (random() < 0.9) fields.speed = random() < 0.5 ? pick(random, SPEEDS) : pick(random, WILD)
  if (random() < 0.9) fields.mode = random() < 0.5 ? pick(random, MODES) : pick<unknown>(random, ['', 'ALWAYS', 5, null, 'sometimes'])
  if (random() < 0.2) fields.extra = randomText(random, 20)
  return fields
}

describe('reading a stored record under fuzzing', { timeout: FUZZ_TIMEOUT }, () => {
  it('turns any value into a record the rules could have written, or into none, and leaves what it was given alone', async () => {
    await eachSeed(3000, (random) => {
      const raw = wildRecord(random)
      const before = JSON.stringify(raw)
      const read = normalizeProgress(raw)
      if (read) expect(problems(read), before).toEqual([])
      expect(JSON.stringify(raw), 'what it was given is left alone').toBe(before)
    })
  })

  it('has nothing more to mend in what it hands over: reading it again changes nothing', async () => {
    await eachSeed(1500, (random) => {
      const once = normalizeProgress(wildRecord(random))
      if (once) expect(normalizeProgress(once)).toEqual(once)
    })
  })

  it('reads a whole database of damaged records: only the records of this kind come out, all well formed, and nothing throws', async () => {
    await eachSeed(300, async (random) => {
      const data: Record<string, unknown> = {}
      for (let i = int(random, 40); i > 0; i--) data[`${pick(random, ['heard:', 'heard:', 'listen:', 'peaks:'])}${randomText(random, 1 + int(random, 12))}`] = wildRecord(random)
      const kv = memoryKv(data)
      const all = await loadAllProgress(kv)
      expect(all).not.toBeNull()
      const bad: string[] = []
      for (const [key, record] of all ?? []) {
        if (!(`heard:${key}` in data)) bad.push(`${key} is not a stored heard: key`)
        bad.push(...problems(record).map((p) => `${key}: ${p}`))
      }
      expect(bad).toEqual([])
    })
  })

  it('says it could not read, and not that there is nothing, when the database fails', async () => {
    const kv = memoryKv({ 'heard:a|1|1': { v: 1, at: 1, t: 10, speed: null, mode: 'auto' } })
    kv.fail.get = true
    expect(await loadAllProgress(kv)).toBeNull()
  })
})

describe('forgetting old places under fuzzing', { timeout: FUZZ_TIMEOUT }, () => {
  it('forgets exactly the places nobody came back to for half a year and the oldest beyond the most recent, never a choice', async () => {
    await eachSeed(400, (random) => {
      const count = random() < 0.2 ? KEEP_RECENT + 50 + int(random, 300) : int(random, 80)
      const entries = Array.from({ length: count }, (_, i) => ({ key: `k${i}`, at: NOW - Math.floor(random() * 1.3 * STALE_DAYS * DAY * (random() < 0.5 ? 1 : 3)), mode: pick(random, MODES) }))
      const stale = staleKeys(entries, NOW)
      const gone = new Set(stale)
      const bad: string[] = []
      if (gone.size !== stale.length) bad.push('a key twice')
      const young: typeof entries = []
      for (const entry of entries) {
        if (entry.mode !== 'auto') {
          if (gone.has(entry.key)) bad.push(`${entry.key}: a choice was forgotten`)
        } else if (NOW - entry.at > STALE_DAYS * DAY) {
          if (!gone.has(entry.key)) bad.push(`${entry.key}: an old place was kept`)
        } else young.push(entry)
      }
      for (const key of stale) if (!entries.some((e) => e.key === key)) bad.push(`${key}: not an entry`)
      const kept = young.filter((e) => !gone.has(e.key))
      const cut = young.filter((e) => gone.has(e.key))
      if (kept.length > KEEP_RECENT) bad.push(`${kept.length} kept`)
      if (kept.length < Math.min(KEEP_RECENT, young.length)) bad.push(`only ${kept.length} of ${young.length} kept`)
      if (kept.length > 0 && cut.length > 0 && Math.min(...kept.map((e) => e.at)) < Math.max(...cut.map((e) => e.at))) bad.push('an older place outlived a newer one')
      expect(bad).toEqual([])
    })
  })
})

describe('the long-form session under fuzzing', { timeout: FUZZ_TIMEOUT }, () => {
  const TRACKS = [
    { key: 'a|1|1', duration: 3600 },
    { key: 'b|2|2', duration: 215 },
    { key: 'c|3|3', duration: 0 },
  ] as const
  const WILD_TIMES = [Number.NaN, -1, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, 0, 1e9, 5e-324]

  /** One random walk of the player's reports through a session: what went wrong, collected. */
  async function walk(random: Random): Promise<string[]> {
    const found: string[] = []
    let clock = 0
    let usual: number | null = random() < 0.5 ? null : pick(random, SPEEDS)
    const initial: Record<string, unknown> = {}
    for (const track of TRACKS) if (random() < 0.7) initial[`heard:${track.key}`] = wildRecord(random)
    const service = new ProgressService({ kv: memoryKv(initial), now: () => NOW + clock })
    await service.ready()
    // every write the session asks for is checked as it is asked for: a stored record may hold anything, what the session writes may not
    const store: SessionStore = {
      get: service.get,
      save: (key, patch) => {
        const duration = TRACKS.find((t) => t.key === key)?.duration ?? 0
        if (patch.t !== undefined && patch.t !== null && !(patch.t >= MIN_KEPT && (duration === 0 || patch.t <= duration - FINISHED))) found.push(`${key}: wrote the place ${patch.t}`)
        if (patch.speed !== undefined && patch.speed !== null && !validSpeed(patch.speed)) found.push(`${key}: wrote the speed ${patch.speed}`)
        if (patch.mode !== undefined) found.push(`${key}: wrote the choice ${patch.mode}`)
        return service.save(key, patch)
      },
    }
    let calls = 0
    const port: SessionPort = {
      position: () => (random() < 0.9 ? random() * 4000 : pick(random, WILD_TIMES)),
      seek: (s) => {
        calls++
        if (!(Number.isFinite(s) && s >= 0)) found.push(`seek(${s})`)
      },
      setSpeed: (s) => {
        calls++
        if (!validSpeed(s)) found.push(`setSpeed(${s})`)
      },
      readUsualSpeed: () => usual,
      writeUsualSpeed: (s) => {
        calls++
        if (!validSpeed(s)) found.push(`writeUsualSpeed(${s})`)
        usual = s
      },
      toast: () => {
        calls++
      },
      now: () => clock,
    }
    const session = new LongFormSession({ store, port })
    const snapshot = (): string => JSON.stringify(TRACKS.map((t) => service.get(t.key)))
    const longness: boolean[] = TRACKS.map(() => random() < 0.6)
    let m: Moment = { key: null, long: false, playing: false, time: 0, duration: 0, speed: pick(random, SPEEDS) }
    for (let step = 0; step < 80; step++) {
      const kind = int(random, 12)
      if (kind === 0) {
        const at = int(random, TRACKS.length + 1)
        const track = TRACKS[at]
        m = track ? { ...m, key: track.key, long: longness[at] ?? false, duration: track.duration, time: 0 } : { ...m, key: null, long: false, duration: 0, time: 0 }
      } else if (kind === 1) m = { ...m, playing: !m.playing }
      else if (kind === 2) m = { ...m, time: random() < 0.85 ? random() * (m.duration || 4000) : pick(random, WILD_TIMES) }
      else if (kind === 3) m = { ...m, speed: pick(random, SPEEDS) }
      else if (kind === 4) {
        const at = TRACKS.findIndex((t) => t.key === m.key)
        if (at >= 0) {
          longness[at] = !longness[at]
          m = { ...m, long: longness[at] ?? false }
        }
      } else m = { ...m, time: m.time + (m.playing ? random() * 2 : 0) } // the playhead plays on
      clock += pick(random, [0, 100, 250, 1000, 5000, 20_000])
      try {
        session.update(m)
        const used = calls
        const written = snapshot()
        session.update(m) // the same report again: nothing to do
        if (calls !== used || snapshot() !== written) found.push(`step ${step}: the same report twice did something`)
        if (kind === 11 && random() < 0.5) session.flush()
        if (kind === 11 && random() < 0.1) session.close()
      } catch (error) {
        found.push(`step ${step}: threw ${String(error)}`)
      }
      for (const track of TRACKS) {
        const record = service.get(track.key)
        if (record && problems(record).length) found.push(`${track.key}: ${problems(record).join('; ')}`)
      }
    }
    return found
  }

  it('never throws, never writes a place that is the beginning or the end, never asks for a speed the player does not offer, and a report twice is the same as once', async () => {
    const all: string[] = []
    await eachSeed(300, async (random, seed) => {
      for (const problem of await walk(random)) all.push(`seed ${seed}: ${problem}`)
    })
    expect(all.slice(0, 10)).toEqual([])
  })
})
