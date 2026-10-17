// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { MAX_BOOKMARKS, MAX_LABEL, SAME_PLACE, addBookmark, cleanLabel, insertBookmark, mergeBookmarks, normalizeBookmarks, removeBookmark, renameBookmark } from './bookmarks'
import type { Bookmark } from './types'

const mark = (t: number, label = `at ${t}`, id = `id${t}`, at = 1000): Bookmark => ({ id, t, label, at })
const options = (extra: { duration?: number; label?: string; id?: string } = {}) => ({ duration: 600, now: 5000, id: 'new', ...extra })

describe('addBookmark', () => {
  it('adds a bookmark at the time, named "Bookmark 1" until the person names it', () => {
    const result = addBookmark([], 62.5, options())
    expect(result).toEqual({ ok: true, list: [{ id: 'new', t: 62.5, label: 'Bookmark 1', at: 5000 }], bookmark: { id: 'new', t: 62.5, label: 'Bookmark 1', at: 5000 } })
  })

  it('keeps the list in order of time, wherever the new one lands', () => {
    const list = [mark(10), mark(300)]
    const result = addBookmark(list, 100, options())
    expect(result.ok && result.list.map((b) => b.t)).toEqual([10, 100, 300])
  })

  it('numbers the default names with the first number that is free, so a deleted one is not skipped for good', () => {
    const list = [mark(10, 'Bookmark 1'), mark(30, 'Bookmark 3')]
    const result = addBookmark(list, 20, options())
    expect(result.ok && result.bookmark.label).toBe('Bookmark 2')
    const next = addBookmark(result.ok ? result.list : [], 40, options({ id: 'other' }))
    expect(next.ok && next.bookmark.label).toBe('Bookmark 4')
  })

  it('uses the name it is given, cleaned and cut to a length a list can show', () => {
    const named = addBookmark([], 5, options({ label: '  The\u0000 plot\nthickens ' }))
    expect(named.ok && named.bookmark.label).toBe('The plot thickens')
    const long = addBookmark([], 5, options({ label: 'x'.repeat(500) }))
    expect(long.ok && [...long.bookmark.label].length).toBe(MAX_LABEL)
    const blank = addBookmark([], 5, options({ label: '   ' }))
    expect(blank.ok && blank.bookmark.label).toBe('Bookmark 1') // nothing to show: it gets the default name
  })

  it('says the place is already marked when another bookmark is less than half a second away, and gives that bookmark', () => {
    const list = [mark(100)]
    for (const t of [100, 100.2, 99.6, 100.49]) {
      const result = addBookmark(list, t, options())
      expect(result, `at ${t}`).toEqual({ ok: false, reason: 'there', existing: mark(100) })
    }
    expect(addBookmark(list, 100 + SAME_PLACE, options()).ok).toBe(true) // exactly half a second away is another place
  })

  it('stops at the most a track can hold', () => {
    const full = Array.from({ length: MAX_BOOKMARKS }, (_, i) => mark(i * 2, `m${i}`, `m${i}`))
    expect(addBookmark(full, 399, options({ duration: 0 }))).toEqual({ ok: false, reason: 'full' })
    expect(addBookmark(full.slice(1), 399, options({ duration: 0 })).ok).toBe(true)
  })

  it('refuses a time that is not a place in the file', () => {
    for (const t of [Number.NaN, Number.POSITIVE_INFINITY, -1, 601]) expect(addBookmark([], t, options()), `at ${t}`).toEqual({ ok: false, reason: 'bad' })
    expect(addBookmark([], 600, options()).ok).toBe(true) // the very end is still in the file
  })

  it('takes any time from zero when the length of the file is not known yet', () => {
    for (const duration of [0, Number.NaN, -1]) expect(addBookmark([], 5000, options({ duration })).ok, `duration ${duration}`).toBe(true)
  })

  it('does not change the list it was given', () => {
    const list = Object.freeze([Object.freeze(mark(10))])
    expect(() => addBookmark(list, 20, options())).not.toThrow()
    expect(list).toEqual([mark(10)])
  })
})

describe('removeBookmark and insertBookmark', () => {
  const list = [mark(10), mark(20), mark(30)]

  it('takes a bookmark out and hands it back, so it can be put back', () => {
    const result = removeBookmark(list, 'id20')
    expect(result?.removed).toEqual(mark(20))
    expect(result?.list.map((b) => b.t)).toEqual([10, 30])
    expect(insertBookmark(result?.list ?? [], result?.removed ?? mark(0))).toEqual(list) // an undo puts it back where it was
  })

  it('has nothing to remove for an id that is not there', () => {
    expect(removeBookmark(list, 'nope')).toBeNull()
  })

  it('puts a bookmark back in time order, and not twice', () => {
    const again = insertBookmark(list, mark(25, 'late', 'late'))
    expect(again.map((b) => b.t)).toEqual([10, 20, 25, 30])
    expect(insertBookmark(again, mark(25, 'late', 'late'))).toEqual(again) // the same id is already there
  })

  it('does not put one back into a list that is full', () => {
    const full = Array.from({ length: MAX_BOOKMARKS }, (_, i) => mark(i * 2, `m${i}`, `m${i}`))
    expect(insertBookmark(full, mark(1000, 'one too many', 'extra'))).toEqual(full)
  })
})

describe('renameBookmark', () => {
  const list = [mark(10), mark(20)]

  it('gives the bookmark its new name, cleaned, and leaves the rest alone', () => {
    const renamed = renameBookmark(list, 'id10', '  Chapter\u0001 one  ')
    expect(renamed).toEqual([{ ...mark(10), label: 'Chapter one' }, mark(20)])
  })

  it('has nothing to do for an id that is not there, or a name that is nothing once cleaned', () => {
    expect(renameBookmark(list, 'nope', 'x')).toBeNull()
    expect(renameBookmark(list, 'id10', '   ')).toBeNull()
    expect(renameBookmark(list, 'id10', '\u0000\u0001')).toBeNull()
  })

  it('cuts a very long name to the limit', () => {
    const long = renameBookmark(list, 'id10', 'y'.repeat(300))
    expect([...(long?.[0]?.label ?? '')].length).toBe(MAX_LABEL)
  })
})

describe('cleanLabel', () => {
  it('turns anything into text that can be shown on one line, or nothing', () => {
    expect(cleanLabel('Plain')).toBe('Plain')
    expect(cleanLabel('a\r\nb\tc')).toBe('a b c')
    expect(cleanLabel('‮reversed‬')).toBe('reversed')
    expect(cleanLabel('half \ud83d pair')).toBe('half � pair')
    for (const bad of [null, undefined, 5, {}, [], true]) expect(cleanLabel(bad)).toBe('')
  })

  it('does not split a character that takes two code units when it cuts', () => {
    expect(cleanLabel('😀'.repeat(200))).toBe('😀'.repeat(MAX_LABEL))
  })
})

describe('normalizeBookmarks', () => {
  const ids = () => {
    let n = 0
    return () => `gen${++n}`
  }

  it('takes what addBookmark makes, in time order', () => {
    expect(normalizeBookmarks([mark(30), mark(10)], { newId: ids() })).toEqual([mark(10), mark(30)])
  })

  it('has nothing for what is not a list', () => {
    for (const raw of [null, undefined, 'x', 5, {}, true]) expect(normalizeBookmarks(raw, { newId: ids() })).toEqual([])
  })

  it('drops an entry that is not a bookmark: no time, a time that is not a place, not an object', () => {
    const raw = [null, 5, 'x', { t: 'soon', label: 'a' }, { t: -1, label: 'b' }, { t: Number.NaN, label: 'c' }, { label: 'd' }, mark(7)]
    expect(normalizeBookmarks(raw, { newId: ids() })).toEqual([mark(7)])
  })

  it('drops a time beyond the end of the file when the length is known, and keeps it when it is not', () => {
    expect(normalizeBookmarks([mark(10), mark(900)], { duration: 600, newId: ids() }).map((b) => b.t)).toEqual([10])
    expect(normalizeBookmarks([mark(10), mark(900)], { duration: 0, newId: ids() }).map((b) => b.t)).toEqual([10, 900])
  })

  it('gives an entry a name, an id and a date when it comes without them (a backup holds only the time and the name)', () => {
    const list = normalizeBookmarks([{ t: 12, label: 'Kept' }, { t: 40 }, { t: 70, label: '  ' }], { newId: ids() })
    expect(list).toEqual([
      { id: 'gen1', t: 12, label: 'Kept', at: 0 },
      { id: 'gen2', t: 40, label: 'Bookmark 1', at: 0 },
      { id: 'gen3', t: 70, label: 'Bookmark 2', at: 0 },
    ])
  })

  it('keeps one of two entries with the same id, and one of two at the same place', () => {
    const list = normalizeBookmarks([mark(10, 'a', 'same'), mark(50, 'b', 'same'), mark(100, 'c', 'c'), mark(100.2, 'd', 'd')], { newId: ids() })
    expect(list.map((b) => b.label)).toEqual(['a', 'c'])
  })

  it('copies only the fields it knows, so nothing else from a stored or imported file comes along', () => {
    const [kept] = normalizeBookmarks([{ ...mark(5), extra: 'x', __proto__: { polluted: true } }], { newId: ids() })
    expect(Object.keys(kept ?? {}).sort()).toEqual(['at', 'id', 'label', 't'])
  })

  it('keeps at most as many as a track can hold, the earliest in the file', () => {
    const raw = Array.from({ length: MAX_BOOKMARKS + 50 }, (_, i) => mark(i * 2, `m${i}`, `m${i}`))
    const list = normalizeBookmarks(raw, { newId: ids() })
    expect(list).toHaveLength(MAX_BOOKMARKS)
    expect(list.at(-1)?.t).toBe((MAX_BOOKMARKS - 1) * 2)
  })

  it('reads a damaged date or id as missing, and cuts an id that is absurdly long', () => {
    const [a, b] = normalizeBookmarks([{ id: 5, t: 1, label: 'x', at: 'yesterday' }, { id: 'y'.repeat(500), t: 3, label: 'z', at: -5 }], { newId: ids() })
    expect(a).toEqual({ id: 'gen1', t: 1, label: 'x', at: 0 })
    expect(b?.id.length).toBeLessThanOrEqual(64)
    expect(b?.at).toBe(0)
  })

  it('does not let a generator that repeats itself turn two bookmarks into one', () => {
    const list = normalizeBookmarks([{ t: 1, label: 'a' }, { t: 5, label: 'b' }, { t: 9, label: 'c' }], { newId: () => 'same' })
    expect(list.map((b) => b.label)).toEqual(['a', 'b', 'c'])
    expect(new Set(list.map((b) => b.id)).size).toBe(3)
  })
})

describe('mergeBookmarks', () => {
  const merge = (local: readonly Bookmark[], incoming: readonly { t: number; label: string }[]) => {
    let n = 0
    return mergeBookmarks(local, incoming, { now: 7000, newId: () => `m${++n}` })
  }

  it('adds what the other list has and this one does not, in time order, with a date of today', () => {
    const { list, added } = merge([mark(50)], [{ t: 100, label: 'Late' }, { t: 10, label: 'Early' }])
    expect(list.map((b) => [b.t, b.label])).toEqual([[10, 'Early'], [50, 'at 50'], [100, 'Late']])
    expect(list.filter((b) => b.at === 7000)).toHaveLength(2)
    expect(added).toBe(2)
  })

  it('keeps what this list has when the other has a bookmark in the same place: the name the person gave here is not replaced', () => {
    const { list, added } = merge([mark(100, 'My name')], [{ t: 100.3, label: 'Their name' }])
    expect(list).toEqual([mark(100, 'My name')])
    expect(added).toBe(0)
  })

  it('changes nothing the second time the same bookmarks come in', () => {
    const incoming = [{ t: 10, label: 'A' }, { t: 20, label: 'B' }]
    const once = merge([], incoming)
    const twice = merge(once.list, incoming)
    expect(once.added).toBe(2)
    expect(twice.added).toBe(0)
    expect(twice.list).toEqual(once.list)
  })

  it('takes two incoming bookmarks that are one place as one', () => {
    const { list, added } = merge([], [{ t: 10, label: 'First' }, { t: 10.2, label: 'Second' }])
    expect(list.map((b) => b.label)).toEqual(['First'])
    expect(added).toBe(1)
  })

  it('stops at what a track can hold, and counts only what it took', () => {
    const full = Array.from({ length: MAX_BOOKMARKS - 1 }, (_, i) => mark(i * 2, `m${i}`, `m${i}`))
    const { list, added } = merge(full, [{ t: 1001, label: 'Fits' }, { t: 1003, label: 'Does not' }])
    expect(list).toHaveLength(MAX_BOOKMARKS)
    expect(added).toBe(1)
  })

  it('does not change the lists it was given', () => {
    const local = Object.freeze([Object.freeze(mark(10))])
    const incoming = Object.freeze([Object.freeze({ t: 20, label: 'x' })])
    expect(() => merge(local, incoming)).not.toThrow()
    expect(local).toEqual([mark(10)])
  })

  it('has nothing to do for nothing', () => {
    const local = [mark(10)]
    expect(merge(local, [])).toEqual({ list: local, added: 0 })
  })
})
