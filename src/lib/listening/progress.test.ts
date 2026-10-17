// @vitest-environment node
import { describe, expect, it } from 'vitest'
import {
  DEFAULT_THRESHOLD,
  FINISHED,
  KEEP_RECENT,
  MIN_KEPT,
  REWIND,
  STALE_DAYS,
  THRESHOLDS,
  classify,
  cleanSpeed,
  isEmpty,
  isLongForm,
  normalizeProgress,
  parseThreshold,
  planSpeed,
  rememberSpeed,
  resumeAt,
  staleKeys,
} from './progress'
import type { Mode, Progress } from './progress'

const DAY = 86_400_000

describe('classify', () => {
  it('calls a place near the beginning the start: not worth coming back to', () => {
    for (const t of [0, 1, MIN_KEPT - 0.01]) expect(classify(t, 3600), `at ${t}`).toBe('start')
  })

  it('keeps a place from five seconds in to fifteen seconds before the end', () => {
    for (const t of [MIN_KEPT, 60, 1800, 3600 - FINISHED]) expect(classify(t, 3600), `at ${t}`).toBe('kept')
  })

  it('calls the last fifteen seconds the end: the recording is finished', () => {
    for (const t of [3600 - FINISHED + 0.01, 3598, 3600, 4000]) expect(classify(t, 3600), `at ${t}`).toBe('finished')
  })

  it('keeps any place after the start when the length is not known', () => {
    for (const duration of [0, Number.NaN, -1]) {
      expect(classify(1000, duration), `length ${duration}`).toBe('kept')
      expect(classify(3, duration), `length ${duration}`).toBe('start')
    }
  })

  it('has no place in a recording shorter than the start and the end together (under twenty seconds): it is never worth resuming', () => {
    for (let t = 0; t <= 20; t += 0.5) expect(classify(t, 19.9), `at ${t}`).not.toBe('kept')
  })

  it('has no answer for a time that is not a time', () => {
    for (const t of [Number.NaN, -1, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) expect(classify(t, 3600), `at ${t}`).toBeNull()
  })
})

describe('resumeAt', () => {
  it('goes back a few seconds, so the last words are heard again, and never before the start', () => {
    expect(resumeAt(100)).toBe(100 - REWIND)
    expect(resumeAt(REWIND)).toBe(0)
    expect(resumeAt(1)).toBe(0)
  })
})

describe('the length from which a track is a long recording', () => {
  it('has seven choices, the third of them (twenty minutes) the default', () => {
    expect(THRESHOLDS.map((t) => t.id)).toEqual(['never', '5', '10', '20', '30', '60', 'all'])
    expect(DEFAULT_THRESHOLD).toBe('20')
  })

  it('reads a stored choice back, and falls back to the default for anything else', () => {
    for (const { id } of THRESHOLDS) expect(parseThreshold(id)).toBe(id)
    for (const bad of [null, undefined, '', '15', 'ALL', 20, {}, true]) expect(parseThreshold(bad), String(bad)).toBe(DEFAULT_THRESHOLD)
  })
})

describe('isLongForm', () => {
  const auto = (duration: number, threshold = DEFAULT_THRESHOLD) => isLongForm({ duration, threshold, mode: 'auto' })

  it('is true from the chosen length on, and not a second before', () => {
    expect(auto(20 * 60)).toBe(true)
    expect(auto(20 * 60 - 1)).toBe(false)
    expect(auto(5 * 60, '5')).toBe(true)
    expect(auto(5 * 60 - 1, '5')).toBe(false)
    expect(auto(60 * 60, '60')).toBe(true)
    expect(auto(60 * 60 - 1, '60')).toBe(false)
  })

  it('is never true when the choice is never, and always true when it is every file', () => {
    expect(auto(10 * 3600, 'never')).toBe(false)
    expect(auto(120, 'all')).toBe(true)
    expect(auto(0, 'all')).toBe(true) // before the length is known
  })

  it('follows the choice made for this track whatever the length or the setting', () => {
    expect(isLongForm({ duration: 120, threshold: 'never', mode: 'always' })).toBe(true)
    expect(isLongForm({ duration: 0, threshold: 'never', mode: 'always' })).toBe(true)
    expect(isLongForm({ duration: 10 * 3600, threshold: 'all', mode: 'never' })).toBe(false)
  })

  it('does not take a length that is not known, or never ends, for a long recording', () => {
    for (const duration of [0, -4, Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) expect(auto(duration), String(duration)).toBe(false)
  })
})

describe('cleanSpeed', () => {
  it('keeps a speed the player offers, to the step it offers', () => {
    expect(cleanSpeed(1)).toBe(1)
    expect(cleanSpeed(1.5)).toBe(1.5)
    expect(cleanSpeed(0.5)).toBe(0.5)
    expect(cleanSpeed(2)).toBe(2)
    expect(cleanSpeed(1.234)).toBe(1.25)
  })

  it('is nothing for what is not a speed: out of range, or not a number', () => {
    for (const bad of [0, 0.4, 2.1, 100, -1, Number.NaN, Number.POSITIVE_INFINITY, '1.5', null, undefined, {}]) expect(cleanSpeed(bad), String(bad)).toBeNull()
  })
})

describe('normalizeProgress', () => {
  const good: Progress = { v: 1, at: 1_700_000_000_000, t: 1234.5, speed: 1.5, mode: 'always' }

  it('reads what is stored back as it was', () => {
    expect(normalizeProgress(good)).toEqual(good)
  })

  it('reads anything that is not a record of this version as nothing', () => {
    for (const raw of [null, undefined, 'x', 5, [], true, { ...good, v: 2 }, { ...good, v: '1' }, { at: 1, t: 5 }]) expect(normalizeProgress(raw), JSON.stringify(raw)).toBeNull()
  })

  it('mends a record field by field: a damaged part reads as absent', () => {
    expect(normalizeProgress({ v: 1, at: 'x', t: -3, speed: 9, mode: 'sometimes' })).toEqual({ v: 1, at: 0, t: null, speed: null, mode: 'auto' })
    expect(normalizeProgress({ v: 1, at: -5, t: Number.NaN, speed: Number.NaN, mode: 5 })).toEqual({ v: 1, at: 0, t: null, speed: null, mode: 'auto' })
    expect(normalizeProgress({ v: 1 })).toEqual({ v: 1, at: 0, t: null, speed: null, mode: 'auto' })
  })

  it('copies only the fields it knows', () => {
    const read = normalizeProgress({ ...good, extra: 'x', __proto__: { polluted: true } })
    expect(Object.keys(read ?? {}).sort()).toEqual(['at', 'mode', 'speed', 't', 'v'])
  })
})

describe('isEmpty', () => {
  it('is true for a record with nothing to remember: no place, no speed, no choice', () => {
    expect(isEmpty({ t: null, speed: null, mode: 'auto' })).toBe(true)
    expect(isEmpty({ t: 10, speed: null, mode: 'auto' })).toBe(false)
    expect(isEmpty({ t: null, speed: 1.5, mode: 'auto' })).toBe(false)
    expect(isEmpty({ t: null, speed: null, mode: 'never' })).toBe(false)
  })
})

describe('the speed of a track', () => {
  it('is the speed chosen for a long recording, and the usual speed for everything else', () => {
    expect(planSpeed({ long: true, stored: 1.5, usual: 1 })).toBe(1.5)
    expect(planSpeed({ long: true, stored: null, usual: 1.25 })).toBe(1.25)
    expect(planSpeed({ long: false, stored: 1.5, usual: 1 })).toBe(1) // a song does not take the speed of a book
  })

  it('is learnt from a change: on a long recording it belongs to that recording, anywhere else it is the usual speed', () => {
    expect(rememberSpeed({ long: true, speed: 1.75, usual: 1 })).toEqual({ usual: 1, stored: 1.75 })
    expect(rememberSpeed({ long: false, speed: 1.25, usual: 1 })).toEqual({ usual: 1.25, stored: null })
  })
})

describe('staleKeys', () => {
  const NOW = 1_800_000_000_000
  const entry = (key: string, daysOld: number, mode: Mode = 'auto') => ({ key, at: NOW - daysOld * DAY, mode })

  it('drops a place nobody has come back to for half a year', () => {
    expect(staleKeys([entry('old', STALE_DAYS + 1), entry('recent', 3), entry('border', STALE_DAYS)], NOW)).toEqual(['old'])
  })

  it('never drops a recording the person made a choice about: forgetting it would undo the choice', () => {
    expect(staleKeys([entry('always', 900, 'always'), entry('never', 900, 'never'), entry('plain', 900)], NOW)).toEqual(['plain'])
  })

  it('keeps the most recent few hundred and drops the oldest of the rest', () => {
    const many = Array.from({ length: KEEP_RECENT + 30 }, (_, i) => entry(`k${i}`, i / 10)) // all within 180 days, k0 the newest
    const dropped = staleKeys(many, NOW)
    expect(dropped).toHaveLength(30)
    expect(new Set(dropped)).toEqual(new Set(Array.from({ length: 30 }, (_, i) => `k${KEEP_RECENT + i}`)))
  })

  it('does not count the choices a person made against that limit, nor drop them to meet it', () => {
    const entries = [...Array.from({ length: KEEP_RECENT }, (_, i) => entry(`k${i}`, i / 10)), ...Array.from({ length: 50 }, (_, i) => entry(`chosen${i}`, 1, 'never'))]
    expect(staleKeys(entries, NOW)).toEqual([])
  })

  it('answers the same whatever order the records come in', () => {
    const entries = [entry('a', 200), entry('b', 1), entry('c', 300), entry('d', 2)]
    expect([...staleKeys([...entries].reverse(), NOW)].sort()).toEqual(['a', 'c'])
    expect([...staleKeys(entries, NOW)].sort()).toEqual(['a', 'c'])
  })

  it('has nothing to drop from nothing', () => {
    expect(staleKeys([], NOW)).toEqual([])
  })
})
