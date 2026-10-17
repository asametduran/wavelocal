// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { MAX_BOOKMARKS, MAX_LABEL, SAME_PLACE, addBookmark, cleanLabel, insertBookmark, mergeBookmarks, normalizeBookmarks, removeBookmark, renameBookmark } from './bookmarks'
import { readListenRecord } from './store'
import type { Bookmark } from './types'
import { FUZZ_TIMEOUT, clock, eachSeed, int, mutateText, pick, randomText, since } from '../../test-utils/fuzz'

// Bookmarks come back from the database and from backup files: whatever is in there, the list that comes out must obey the rules
// of a list a person made (ordered, apart, unique, bounded, clean, only the known fields), and every operation must keep it so.

/** What is wrong with `list` for a list a person could have made (nothing, when it is one). Collected, not asserted one by one: there are thousands of marks. */
function problems(list: readonly Bookmark[]): string[] {
  const found: string[] = []
  if (list.length > MAX_BOOKMARKS) found.push(`${list.length} bookmarks`)
  const ids = new Set<string>()
  let before = -Infinity
  for (const mark of list) {
    const name = `at ${mark.t}`
    if (Object.keys(mark).sort().join() !== 'at,id,label,t') found.push(`${name}: fields ${Object.keys(mark).join()}`)
    if (!(Number.isFinite(mark.t) && mark.t >= 0)) found.push(`${name}: not a time`)
    if (!(mark.t - before >= SAME_PLACE)) found.push(`${name}: less than ${SAME_PLACE} after ${before}`)
    if (!(Number.isFinite(mark.at) && mark.at >= 0)) found.push(`${name}: date ${mark.at}`)
    if (mark.id.length === 0 || mark.id.length > 64) found.push(`${name}: id of ${mark.id.length} characters`)
    if (ids.has(mark.id)) found.push(`${name}: id ${mark.id} again`)
    if (mark.label.length === 0 || [...mark.label].length > MAX_LABEL) found.push(`${name}: name of ${mark.label.length} characters`)
    if (cleanLabel(mark.label) !== mark.label) found.push(`${name}: name not clean`)
    ids.add(mark.id)
    before = mark.t
  }
  return found
}

const wellFormed = (list: readonly Bookmark[]): void => expect(problems(list)).toEqual([])

const WILD_TIMES = [0, 0.2, 0.5, 1, 59.99, 600, 1e6, -1, -0.0001, Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, 1e300, 5e-324, 2 ** 53]

function wildEntry(random: () => number): unknown {
  const kind = int(random, 10)
  if (kind === 0) return null
  if (kind === 1) return pick(random, [5, 'x', true, [], '', 'bookmark'])
  const t = random() < 0.6 ? random() * 600 : pick(random, WILD_TIMES)
  const label = random() < 0.4 ? randomText(random, int(random, 200)) : random() < 0.5 ? mutateText(random, 'Intro ‮\u0000 \ud83d end\r\n') : pick(random, [undefined, null, 5, '', '   ', {}, 'x'.repeat(400)])
  return { t, label, id: pick(random, [undefined, 5, 'a', 'same', 'y'.repeat(300), randomText(random, 20)]), at: pick(random, [undefined, 'x', -5, 1e15, Number.NaN, 1_700_000_000_000]), extra: 1 }
}

const counter = () => {
  let n = 0
  return () => `gen${++n}`
}

describe('normalising bookmarks under fuzzing', { timeout: FUZZ_TIMEOUT }, () => {
  it('turns any value into a list a person could have made, and leaves what it was given alone', async () => {
    await eachSeed(1500, (random) => {
      const raw = random() < 0.1 ? pick<unknown>(random, [null, undefined, 'x', 5, {}, true]) : Array.from({ length: int(random, random() < 0.05 ? 800 : 30) }, () => wildEntry(random))
      const before = JSON.stringify(raw)
      wellFormed(normalizeBookmarks(raw, { duration: pick(random, [0, Number.NaN, -3, 30, 3600]), newId: counter() }))
      expect(JSON.stringify(raw), 'what it was given is left alone').toBe(before)
    })
  })

  it('has nothing more to mend in what it hands over: normalising it again changes nothing', async () => {
    await eachSeed(800, (random) => {
      const raw = Array.from({ length: int(random, 40) }, () => wildEntry(random))
      const once = normalizeBookmarks(raw, { newId: counter() })
      expect(normalizeBookmarks(once, { newId: counter() })).toEqual(once)
    })
  })

  it('takes no time worth speaking of for a huge, hostile list', () => {
    const random = (() => {
      let seed = 12345
      return () => (seed = (seed * 16807) % 2147483647) / 2147483647
    })()
    const raw = Array.from({ length: 20_000 }, () => wildEntry(random))
    const start = clock()
    wellFormed(normalizeBookmarks(raw, { newId: counter() }))
    expect(since(start)).toBeLessThan(2500)
  })

  it('copies the fields it knows and nothing else, so a "__proto__" key in a stored record changes nothing', () => {
    const polluted = JSON.parse('{"v":1,"at":1,"bookmarks":[{"t":1,"label":"x","id":"a","at":5,"__proto__":{"polluted":true}}]}') as unknown
    const [mark] = readListenRecord(polluted, counter())
    expect(mark).toEqual({ id: 'a', t: 1, label: 'x', at: 5 })
    expect(({} as { polluted?: boolean }).polluted).toBeUndefined()
  })
})

describe('cleaning a name under fuzzing', { timeout: FUZZ_TIMEOUT }, () => {
  it('turns any value into one clean line of at most as many characters as a name may have, and cleaning twice is cleaning once', async () => {
    await eachSeed(2000, (random) => {
      const label = cleanLabel(random() < 0.5 ? mutateText(random, 'Chapter 2: ​The‮ End\r\n') : randomText(random, int(random, 400)))
      expect([...label].length).toBeLessThanOrEqual(MAX_LABEL)
      expect(label).toBe(label.trim())
      expect(label).not.toMatch(/[\u0000-\u001f\u007f-\u009f]/)
      expect(cleanLabel(label)).toBe(label)
    })
  })
})

describe('changing a list under fuzzing', { timeout: FUZZ_TIMEOUT }, () => {
  it('keeps a list well formed through any run of adding, removing, putting back, renaming and merging', async () => {
    await eachSeed(300, (random) => {
      const newId = counter()
      let list: readonly Bookmark[] = []
      const removed: Bookmark[] = []
      for (let step = 0; step < 60; step++) {
        const duration = pick(random, [0, 600])
        switch (int(random, 5)) {
          case 0: {
            const t = random() < 0.8 ? random() * 600 : pick(random, WILD_TIMES)
            const result = addBookmark(list, t, { duration, now: 1000 + step, id: newId(), label: pick(random, [undefined, '', 'Named', randomText(random, 30)]) })
            if (result.ok) {
              expect(result.list).toHaveLength(list.length + 1)
              list = result.list
            } else if (result.reason === 'there') expect(Math.abs(result.existing.t - t)).toBeLessThan(SAME_PLACE)
            break
          }
          case 1: {
            const target = list[int(random, Math.max(1, list.length))]
            const result = removeBookmark(list, target?.id ?? 'nope')
            if (result) {
              removed.push(result.removed)
              list = result.list
            }
            break
          }
          case 2: {
            const back = removed.splice(int(random, Math.max(1, removed.length)), 1)[0]
            if (back) list = insertBookmark(list, back)
            break
          }
          case 3: {
            const next = renameBookmark(list, list[int(random, Math.max(1, list.length))]?.id ?? 'nope', pick(random, ['New name', '', '   ', randomText(random, 100)]))
            if (next) list = next
            break
          }
          default: {
            const incoming = Array.from({ length: int(random, 8) }, () => ({ t: random() * 600, label: pick(random, ['A', 'B', 'plot']) }))
            const merged = mergeBookmarks(list, incoming, { now: 5, newId })
            expect(merged.list.length - list.length).toBe(merged.added)
            list = merged.list
          }
        }
        wellFormed(list)
      }
    })
  })

  it('merging the same bookmarks again adds nothing', async () => {
    await eachSeed(400, (random) => {
      const incoming = Array.from({ length: int(random, 60) }, () => ({ t: random() * 300, label: 'x' }))
      const first = mergeBookmarks([], incoming, { now: 1, newId: counter() })
      const second = mergeBookmarks(first.list, incoming, { now: 2, newId: counter() })
      expect(second.added).toBe(0)
      expect(second.list).toEqual(first.list)
    })
  })
})

describe('the stored record under fuzzing', { timeout: FUZZ_TIMEOUT }, () => {
  it('reads anything that is stored as a list a person could have made, or as none, and never throws', async () => {
    await eachSeed(1500, (random) => {
      const record = pick<unknown>(random, [
        { v: 1, at: 5, bookmarks: Array.from({ length: int(random, 30) }, () => wildEntry(random)) },
        { v: pick(random, [0, 2, '1', null]), bookmarks: [{ t: 1, label: 'x' }] },
        { v: 1, bookmarks: pick(random, ['x', 5, {}, null]) },
        pick(random, [null, undefined, 'x', 5, [], true]),
      ])
      wellFormed(readListenRecord(record, counter()))
    })
  })
})
