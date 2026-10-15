import { describe, expect, it } from 'vitest'
import { activeIndex, parseLrc } from './lrc'

describe('parseLrc', () => {
  it('parses timestamped lines into synced lyrics', () => {
    expect(parseLrc('[00:12.00]Hello\n[00:15.50]World')).toEqual({
      synced: true,
      lines: [
        { t: 12, text: 'Hello' },
        { t: 15.5, text: 'World' },
      ],
    })
  })

  it.each([
    ['[00:01.5]x', 1.5],
    ['[00:01.50]x', 1.5],
    ['[00:01.500]x', 1.5],
    ['[00:01:25]x', 1.25],
    ['[00:01]x', 1],
    ['[02:03.00]x', 123],
  ])('reads the time in %s', (line, seconds) => {
    expect(parseLrc(line)?.lines[0]?.t).toBeCloseTo(seconds, 5)
  })

  it('expands a line with several timestamps and sorts the result', () => {
    const lyrics = parseLrc('[00:30.00]Outro\n[00:10.00][00:20.00]Chorus')
    expect(lyrics?.lines).toEqual([
      { t: 10, text: 'Chorus' },
      { t: 20, text: 'Chorus' },
      { t: 30, text: 'Outro' },
    ])
  })

  it('applies [offset:] in milliseconds (positive shows lines earlier)', () => {
    expect(parseLrc('[offset:500]\n[00:10.00]x')?.lines[0]?.t).toBeCloseTo(9.5, 5)
    expect(parseLrc('[offset:-1000]\n[00:10.00]x')?.lines[0]?.t).toBeCloseTo(11, 5)
  })

  it('never produces a negative time', () => {
    expect(parseLrc('[offset:5000]\n[00:01.00]x')?.lines[0]?.t).toBe(0)
  })

  it('skips metadata tags', () => {
    const lyrics = parseLrc('[ti:Song]\n[ar:Artist]\n[al:Album]\n[by:Me]\n[length:03:00]\n[00:01.00]only line')
    expect(lyrics?.lines).toEqual([{ t: 1, text: 'only line' }])
  })

  it('strips enhanced word-level tags', () => {
    expect(parseLrc('[00:01.00]<00:01.00>Hel<00:01.40>lo')?.lines[0]?.text).toBe('Hello')
  })

  it('keeps empty-bodied timestamps (instrumental gaps)', () => {
    expect(parseLrc('[00:05.00]')?.lines).toEqual([{ t: 5, text: '' }])
  })

  it('handles CRLF line endings and blank lines', () => {
    const lyrics = parseLrc('[00:01.00]a\r\n\r\n[00:02.00]b\r\n')
    expect(lyrics?.lines.map((l) => l.text)).toEqual(['a', 'b'])
  })

  it('treats text without timestamps as unsynced lyrics', () => {
    expect(parseLrc('line one\nline two')).toEqual({
      synced: false,
      lines: [
        { t: null, text: 'line one' },
        { t: null, text: 'line two' },
      ],
    })
  })

  it('ignores untimed lines when timed lines exist', () => {
    const lyrics = parseLrc('plain\n[00:01.00]timed')
    expect(lyrics?.synced).toBe(true)
    expect(lyrics?.lines).toEqual([{ t: 1, text: 'timed' }])
  })

  it.each([[''], ['   \n \n'], [null], [undefined], [42], [{}]])('returns null for %j', (input) => {
    expect(parseLrc(input)).toBeNull()
  })

  it('returns null when only metadata is present', () => {
    expect(parseLrc('[ti:Song]\n[ar:Artist]')).toBeNull()
  })
})

describe('activeIndex', () => {
  const lines = [
    { t: 1, text: 'a' },
    { t: 5, text: 'b' },
    { t: 9, text: 'c' },
  ]

  it.each([
    [0, -1],
    [0.99, -1],
    [1, 0],
    [4.99, 0],
    [5, 1],
    [8.5, 1],
    [9, 2],
    [1000, 2],
  ])('at %s seconds the active line is %s', (time, expected) => {
    expect(activeIndex(lines, time)).toBe(expected)
  })

  it('returns -1 for no lines', () => {
    expect(activeIndex([], 10)).toBe(-1)
  })

  it('never matches untimed lines', () => {
    expect(activeIndex([{ t: null, text: 'x' }], 10)).toBe(-1)
  })

  it('finds the right line in a long list', () => {
    const many = Array.from({ length: 10_000 }, (_, i) => ({ t: i * 2, text: String(i) }))
    expect(activeIndex(many, 9_999)).toBe(4_999)
    expect(activeIndex(many, 20_000)).toBe(9_999)
  })
})
