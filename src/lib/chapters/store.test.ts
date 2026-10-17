// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { loadChapters, pruneChapters, readChaptersRecord, saveChapters } from './store'
import { MAX_CHAPTERS, MAX_TITLE } from './normalize'
import type { Chapter } from './types'
import { memoryKv } from '../../test-utils/memorykv'

const book: Chapter[] = [
  { start: 0, end: 10, title: 'A' },
  { start: 10, end: 30, title: 'B' },
]

describe('saving and loading', () => {
  it('gives back what was saved, for the track it was saved for', async () => {
    const kv = memoryKv()
    await saveChapters(kv, 't1', book)
    expect(await loadChapters(kv, 't1')).toEqual(book)
    expect(await loadChapters(kv, 'other')).toBeNull()
  })

  it('keeps "looked, and there are none" apart from "never looked", so a book without chapters is not read again', async () => {
    const kv = memoryKv()
    await saveChapters(kv, 't1', [])
    expect(await loadChapters(kv, 't1')).toEqual([])
    expect(await loadChapters(kv, 't2')).toBeNull()
  })

  it('keeps each track under a key of its own in the "chapters:" family', async () => {
    const kv = memoryKv()
    await saveChapters(kv, 'abc', book)
    expect([...kv.data.keys()]).toEqual(['chapters:abc'])
  })

  it('does not fail the player when the disk is full or blocked: chapters are only a cache', async () => {
    const kv = memoryKv()
    kv.fail.set = true
    await expect(saveChapters(kv, 't1', book)).resolves.toBeUndefined()
    kv.fail.set = false
    kv.fail.get = true
    await expect(loadChapters(kv, 't1')).resolves.toBeNull()
  })
})

describe('readChaptersRecord', () => {
  const ok = { v: 1, chapters: book }
  const bad: [string, unknown][] = [
    ['nothing', undefined],
    ['null', null],
    ['a number', 3],
    ['another layout', { ...ok, v: 2 }],
    ['no list', { v: 1 }],
    ['a list that is not a list', { v: 1, chapters: { length: 1 } }],
    ['too many chapters', { v: 1, chapters: Array.from({ length: MAX_CHAPTERS + 1 }, (_, i) => ({ start: i, end: i + 1, title: 'x' })) }],
    ['an entry that is not an object', { v: 1, chapters: [null] }],
    ['a start that is not a number', { v: 1, chapters: [{ start: '0', end: 1, title: 'x' }] }],
    ['a negative start', { v: 1, chapters: [{ start: -1, end: 1, title: 'x' }] }],
    ['a start that is not finite', { v: 1, chapters: [{ start: Number.POSITIVE_INFINITY, end: 5, title: 'x' }] }],
    ['an end before the start', { v: 1, chapters: [{ start: 5, end: 2, title: 'x' }] }],
    ['an end that is not finite', { v: 1, chapters: [{ start: 0, end: Number.NaN, title: 'x' }] }],
    ['a title that is not text', { v: 1, chapters: [{ start: 0, end: 1, title: 7 }] }],
    ['a title longer than any is kept', { v: 1, chapters: [{ start: 0, end: 1, title: 'x'.repeat(MAX_TITLE + 1) }] }],
    ['starts that do not go forward', { v: 1, chapters: [{ start: 5, end: 6, title: 'a' }, { start: 5, end: 6, title: 'b' }] }],
    ['starts in the wrong order', { v: 1, chapters: [{ start: 5, end: 6, title: 'a' }, { start: 1, end: 2, title: 'b' }] }],
  ]

  it('accepts exactly what this version writes, and drops any extra fields of a chapter', () => {
    expect(readChaptersRecord(ok)).toEqual(book)
    expect(readChaptersRecord({ v: 1, chapters: [{ start: 0, end: 1, title: 'x', extra: true }] })).toEqual([{ start: 0, end: 1, title: 'x' }])
    expect(readChaptersRecord({ v: 1, chapters: [] })).toEqual([])
  })

  it.each(bad)('reads %s as "read the file again", never as chapters', (_name, value) => {
    expect(readChaptersRecord(value)).toBeNull()
  })
})

describe('pruneChapters', () => {
  it('forgets the chapters of tracks that are no longer in the library, and leaves every other kind of record alone', async () => {
    const kv = memoryKv({ 'chapters:keep': { v: 1, chapters: [] }, 'chapters:gone': { v: 1, chapters: [] }, 'peaks:gone': {}, 'listen:gone': {}, order: [] })
    expect(await pruneChapters(kv, new Set(['keep']))).toBe(1)
    expect([...kv.data.keys()].sort()).toEqual(['chapters:keep', 'listen:gone', 'order', 'peaks:gone'])
  })
})
