// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { chapterIndexAt, nextChapterStart, previousChapterStart } from './navigate'
import type { Chapter } from './types'

const book: Chapter[] = [
  { start: 0, end: 100, title: 'One' },
  { start: 100, end: 250, title: 'Two' },
  { start: 250, end: 600, title: 'Three' },
  { start: 600, end: 900, title: 'Four' },
]

describe('chapterIndexAt', () => {
  it('is the chapter that has begun, the last one whose start is not after the time', () => {
    expect(chapterIndexAt(book, 0)).toBe(0)
    expect(chapterIndexAt(book, 50)).toBe(0)
    expect(chapterIndexAt(book, 100)).toBe(1)
    expect(chapterIndexAt(book, 249.8)).toBe(1)
    expect(chapterIndexAt(book, 250)).toBe(2)
    expect(chapterIndexAt(book, 899)).toBe(3)
    expect(chapterIndexAt(book, 5000)).toBe(3)
  })

  it('counts a position a hair before a start as already there, since a seek to a start rarely lands exactly on it', () => {
    expect(chapterIndexAt(book, 99.8)).toBe(0)
    expect(chapterIndexAt(book, 99.95)).toBe(1)
    expect(chapterIndexAt(book, 249.95)).toBe(2)
  })

  it('is -1 before the first chapter, and for no chapters at all', () => {
    const late: Chapter[] = [{ start: 12, end: 50, title: 'Late' }]
    expect(chapterIndexAt(late, 5)).toBe(-1)
    expect(chapterIndexAt(late, 12)).toBe(0)
    expect(chapterIndexAt([], 10)).toBe(-1)
    expect(chapterIndexAt(book, -5)).toBe(-1)
  })

  it('reads a time that is not a number as the start of the file', () => {
    expect(chapterIndexAt(book, Number.NaN)).toBe(0)
    expect(chapterIndexAt(book, Number.POSITIVE_INFINITY)).toBe(0)
  })

  it('finds the chapter in a list of a thousand, whichever it is', () => {
    const many: Chapter[] = Array.from({ length: 1000 }, (_, i) => ({ start: i * 10, end: i * 10 + 10, title: `C${i}` }))
    for (const i of [0, 1, 499, 500, 998, 999]) expect(chapterIndexAt(many, i * 10 + 5)).toBe(i)
  })
})

describe('nextChapterStart', () => {
  it('is where the next chapter begins', () => {
    expect(nextChapterStart(book, 0)).toBe(100)
    expect(nextChapterStart(book, 150)).toBe(250)
    expect(nextChapterStart(book, 599)).toBe(600)
  })

  it('moves on from a position that is on, or a hair before, a start, instead of jumping to where it already is', () => {
    expect(nextChapterStart(book, 100)).toBe(250)
    expect(nextChapterStart(book, 99.95)).toBe(250)
  })

  it('has nowhere to go from the last chapter', () => {
    expect(nextChapterStart(book, 600)).toBeNull()
    expect(nextChapterStart(book, 850)).toBeNull()
    expect(nextChapterStart([], 5)).toBeNull()
  })

  it('goes to the first chapter from before it', () => {
    expect(nextChapterStart([{ start: 12, end: 50, title: 'Late' }], 3)).toBe(12)
  })
})

describe('previousChapterStart', () => {
  it('restarts the chapter when more than a few seconds into it', () => {
    expect(previousChapterStart(book, 150)).toBe(100)
    expect(previousChapterStart(book, 300)).toBe(250)
  })

  it('goes to the chapter before when only just into one, the way "previous" works for tracks', () => {
    expect(previousChapterStart(book, 101)).toBe(0)
    expect(previousChapterStart(book, 252.9)).toBe(100)
    expect(previousChapterStart(book, 250)).toBe(100)
  })

  it('has a grace time that can be changed', () => {
    expect(previousChapterStart(book, 108, 10)).toBe(0)
    expect(previousChapterStart(book, 108, 5)).toBe(100)
  })

  it('goes to the start of the file from just inside a first chapter that begins later, and nowhere from the start itself', () => {
    expect(previousChapterStart([{ start: 12, end: 50, title: 'Late' }], 13)).toBe(0)
    expect(previousChapterStart(book, 2)).toBeNull()
    expect(previousChapterStart(book, 0)).toBeNull()
  })

  it('restarts the first chapter when well into it, and goes to the start of the file from before it', () => {
    expect(previousChapterStart(book, 60)).toBe(0)
    expect(previousChapterStart([{ start: 12, end: 50, title: 'Late' }], 5)).toBe(0)
    expect(previousChapterStart([{ start: 12, end: 50, title: 'Late' }], 0)).toBeNull()
  })

  it('has nowhere to go without chapters', () => {
    expect(previousChapterStart([], 50)).toBeNull()
  })
})
