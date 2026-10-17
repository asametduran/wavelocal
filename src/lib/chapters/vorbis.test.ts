// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { chaptersFromComments, parseChapterTime, readFlacChapters, readOggChapters } from './vorbis'
import { bytesSource } from '../audio/source'
import { buildOgg } from '../../test-utils/containers'
import { encodeFlac, floatToInt } from '../../test-utils/flac-encoder'

describe('parseChapterTime', () => {
  it('reads HH:MM:SS.mmm into seconds', () => {
    expect(parseChapterTime('00:00:00.000')).toBe(0)
    expect(parseChapterTime('00:01:02.500')).toBe(62.5)
    expect(parseChapterTime('01:02:03')).toBe(3723)
    expect(parseChapterTime('12:00:00.250')).toBe(43_200.25)
  })

  it('reads the shorter forms people write: no hours, one digit, a comma for the point', () => {
    expect(parseChapterTime('1:02:03')).toBe(3723)
    expect(parseChapterTime('02:03.5')).toBe(123.5)
    expect(parseChapterTime('0:0:5')).toBe(5)
    expect(parseChapterTime('00:00:01,250')).toBe(1.25)
    expect(parseChapterTime('  00:00:07  ')).toBe(7)
  })

  it('refuses what is not a time, and minutes or seconds that run past 59', () => {
    for (const text of ['', 'abc', '00:61:00', '00:00:61', '-1:00:00', '1:2:3:4', '12', '00:00:xx', '00:00:00.', '1e3:00:00', '00:00:00.1234567890']) {
      expect(parseChapterTime(text), JSON.stringify(text)).toBeNull()
    }
  })

  it('refuses a text too long to be a time without trying to read it', () => {
    expect(parseChapterTime(`00:00:00.${'1'.repeat(10_000)}`)).toBeNull()
  })
})

describe('chaptersFromComments', () => {
  const comments: [string, string][] = [
    ['CHAPTER001', '00:00:00.000'],
    ['CHAPTER001NAME', 'Intro'],
    ['CHAPTER002', '00:01:02.500'],
    ['CHAPTER002NAME', 'Part one'],
  ]

  it('pairs each chapter time with its name', () => {
    expect(chaptersFromComments(comments)).toEqual([
      { start: 0, title: 'Intro' },
      { start: 62.5, title: 'Part one' },
    ])
  })

  it('does not care in which order the fields come, or in which case the names are written', () => {
    expect(chaptersFromComments([...comments].reverse())).toEqual(
      expect.arrayContaining([
        { start: 0, title: 'Intro' },
        { start: 62.5, title: 'Part one' },
      ]),
    )
    expect(chaptersFromComments([['chapter001', '00:00:05'], ['Chapter001Name', 'Mixed case']])).toEqual([{ start: 5, title: 'Mixed case' }])
  })

  it('gives a chapter without a name an empty title, and ignores a name without a time and the fields it does not know', () => {
    expect(
      chaptersFromComments([
        ['CHAPTER003', '00:10:00'],
        ['CHAPTER004NAME', 'Nowhere'],
        ['CHAPTER003URL', 'https://example.com'],
        ['CHAPTERS', 'x'],
        ['CHAPTER', '00:00:01'],
        ['TITLE', 'A book'],
      ]),
    ).toEqual([{ start: 600, title: '' }])
  })

  it('takes numbers that skip, and four digits', () => {
    expect(chaptersFromComments([['CHAPTER007', '00:00:10'], ['CHAPTER100', '00:00:20'], ['CHAPTER0123', '00:00:30']]).map((c) => c.start)).toEqual([10, 20, 30])
  })

  it('takes the first of a field that is written twice', () => {
    expect(chaptersFromComments([['CHAPTER001', '00:00:10'], ['CHAPTER001', '00:00:99'], ['CHAPTER001NAME', 'First'], ['CHAPTER001NAME', 'Second']])).toEqual([{ start: 10, title: 'First' }])
  })

  it('skips a chapter whose time is not a time', () => {
    expect(chaptersFromComments([['CHAPTER001', 'soon'], ['CHAPTER001NAME', 'Lost'], ['CHAPTER002', '00:00:09'], ['CHAPTER002NAME', 'Kept']])).toEqual([{ start: 9, title: 'Kept' }])
  })

  it('reads at most two thousand chapters', () => {
    const flood: [string, string][] = Array.from({ length: 5000 }, (_, i): [string, string] => [`CHAPTER${String(i).padStart(4, '0')}`, '00:00:01'])
    expect(chaptersFromComments(flood).length).toBeLessThanOrEqual(2000)
  })

  it('has no chapters for no fields', () => {
    expect(chaptersFromComments([])).toEqual([])
  })
})

describe('chapters in the comments of real files', () => {
  const chapterFields = ['TITLE=A book', 'CHAPTER001=00:00:00.000', 'CHAPTER001NAME=Opening', 'CHAPTER002=00:00:01.500', 'CHAPTER002NAME=Second part']
  const expected = [
    { start: 0, title: 'Opening' },
    { start: 1.5, title: 'Second part' },
  ]

  it('reads them from the comment header of an Ogg Vorbis file', async () => {
    expect(await readOggChapters(bytesSource(buildOgg({ codec: 'vorbis', seconds: 5, comments: chapterFields })))).toEqual(expected)
  })

  it('reads them from the tags of an Opus file', async () => {
    expect(await readOggChapters(bytesSource(buildOgg({ codec: 'opus', seconds: 5, comments: chapterFields })))).toEqual(expected)
  })

  it('reads them from the Vorbis comment block of a FLAC file', async () => {
    const flac = encodeFlac([floatToInt(new Float32Array(8000), 16)], { sampleRate: 8000, bitsPerSample: 16, vorbis: { vendor: 'test', comments: chapterFields } })
    expect(await readFlacChapters(bytesSource(flac))).toEqual(expected)
  })

  it('has none for files whose comments name no chapters, and for files that are not Ogg or FLAC', async () => {
    expect(await readOggChapters(bytesSource(buildOgg({ codec: 'vorbis', seconds: 5, comments: ['TITLE=Plain'] })))).toEqual([])
    expect(await readOggChapters(bytesSource(new Uint8Array(500).fill(9)))).toEqual([])
    expect(await readFlacChapters(bytesSource(new Uint8Array(500).fill(9)))).toEqual([])
    expect(await readFlacChapters(bytesSource(new Uint8Array(0)))).toEqual([])
  })
})
