// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { MAX_CHAPTERS, MAX_TITLE, normalizeChapters } from './normalize'

const at = (start: number, title = `T${start}`) => ({ start, title })

describe('normalizeChapters', () => {
  it('puts the chapters in time order and ends each where the next begins, the last at the end of the file', () => {
    const chapters = normalizeChapters([at(20, 'B'), at(0, 'A'), at(10, 'C')], 30)
    expect(chapters).toEqual([
      { start: 0, end: 10, title: 'A' },
      { start: 10, end: 20, title: 'C' },
      { start: 20, end: 30, title: 'B' },
    ])
  })

  it('ends the last chapter at its own start when the length of the file is not known, rather than at a number nobody gave', () => {
    expect(normalizeChapters([at(0, 'A'), at(5, 'B')], 0)).toEqual([
      { start: 0, end: 5, title: 'A' },
      { start: 5, end: 5, title: 'B' },
    ])
  })

  it('leaves a gap before the first chapter alone: nothing is invented, the file simply has no chapter there yet', () => {
    expect(normalizeChapters([at(12, 'A')], 100)).toEqual([{ start: 12, end: 100, title: 'A' }])
  })

  it('drops chapters that start before the file, after its end, or at a time that is not a time', () => {
    const chapters = normalizeChapters([at(-1, 'before'), at(0, 'A'), at(Number.NaN, 'nan'), at(Number.POSITIVE_INFINITY, 'inf'), at(50, 'at the end'), at(60, 'beyond'), at(49.9, 'last')], 50)
    expect(chapters.map((c) => c.title)).toEqual(['A', 'last'])
  })

  it('keeps any plausible start when the length is not known, but not one that is days long', () => {
    expect(normalizeChapters([at(0, 'A'), at(36_000, 'ten hours'), at(10 * 86_400, 'ten days')], 0).map((c) => c.title)).toEqual(['A', 'ten hours'])
  })

  it('keeps one chapter for a start that two entries give, preferring the one that has a title', () => {
    const chapters = normalizeChapters([{ start: 5, title: '' }, { start: 5, title: 'Named' }, { start: 5, title: 'Other' }], 10)
    expect(chapters).toEqual([{ start: 5, end: 10, title: 'Named' }])
  })

  it('treats starts that differ by less than a millisecond as the same start', () => {
    expect(normalizeChapters([at(1.0004, 'first'), at(1.0001, 'second')], 10)).toHaveLength(1)
  })

  it('names a chapter that has no title by its place in the list', () => {
    const chapters = normalizeChapters([{ start: 0, title: '' }, { start: 10, title: '   ' }, { start: 20, title: 'Named' }], 30)
    expect(chapters.map((c) => c.title)).toEqual(['Chapter 1', 'Chapter 2', 'Named'])
  })

  it('cleans titles: control characters and line breaks become spaces, runs of space become one, the ends are trimmed', () => {
    const [chapter] = normalizeChapters([{ start: 0, title: '  A\tvery\r\nlong \u0000\u0007 title\u007f ' }], 10)
    expect(chapter?.title).toBe('A very long title')
  })

  it('removes the characters that make a title read differently from how it is written: direction overrides and invisible spaces', () => {
    const [chapter] = normalizeChapters([{ start: 0, title: 'Chapter ‮1‬​X⁦Y⁩﻿Z' }], 10)
    expect(chapter?.title).toBe('Chapter 1XYZ')
  })

  it('replaces half of a surrogate pair, which no font can show, with the replacement character', () => {
    const [chapter] = normalizeChapters([{ start: 0, title: 'a\ud800b\udc00c' }], 10)
    expect(chapter?.title).toBe('a�b�c')
  })

  it('cuts a long title to the limit without splitting a character that takes two code units', () => {
    const [chapter] = normalizeChapters([{ start: 0, title: '😀'.repeat(MAX_TITLE + 50) }], 10)
    expect([...(chapter?.title ?? '')]).toHaveLength(MAX_TITLE)
    expect(chapter?.title).not.toContain('�')
  })

  it('does not trust the type of a title', () => {
    const hostile = [{ start: 0, title: 42 }, { start: 1, title: null }, { start: 2, title: { toString: () => 'object' } }] as unknown as { start: number; title: string }[]
    expect(normalizeChapters(hostile, 10).map((c) => c.title)).toEqual(['Chapter 1', 'Chapter 2', 'Chapter 3'])
  })

  it('keeps at most the first thousand chapters', () => {
    const many = Array.from({ length: MAX_CHAPTERS + 500 }, (_, i) => at(i))
    const chapters = normalizeChapters(many, MAX_CHAPTERS + 500)
    expect(chapters).toHaveLength(MAX_CHAPTERS)
    expect(chapters.at(-1)?.start).toBe(MAX_CHAPTERS - 1)
  })

  it('has no chapters for nothing, and does not change what it was given', () => {
    expect(normalizeChapters([], 10)).toEqual([])
    const input = [at(20, 'B'), at(0, 'A')]
    const copy = structuredClone(input)
    normalizeChapters(input, 30)
    expect(input).toEqual(copy)
  })

  it('reads a duration that is not a number as unknown', () => {
    expect(normalizeChapters([at(0, 'A'), at(5, 'B')], Number.NaN).map((c) => c.end)).toEqual([5, 5])
    expect(normalizeChapters([at(0, 'A')], -3).map((c) => c.end)).toEqual([0])
  })
})
