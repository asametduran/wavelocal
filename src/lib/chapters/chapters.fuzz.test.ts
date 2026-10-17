// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { readId3Chapters } from './id3'
import { readMp4Chapters } from './mp4'
import { chapterIndexAt, nextChapterStart, previousChapterStart } from './navigate'
import { MAX_CHAPTERS, MAX_TITLE, cleanTitle, normalizeChapters } from './normalize'
import { readChaptersRecord } from './store'
import { chaptersFromComments, parseChapterTime, readFlacChapters, readOggChapters } from './vorbis'
import type { Chapter, RawChapter } from './types'
import { bytesSource } from '../audio/source'
import type { ByteSource } from '../audio/source'
import { buildChapterTag, buildMp4WithChpl, buildMp4WithTextChapters, tagFrom } from '../../test-utils/chapters'
import type { ChapterSpec } from '../../test-utils/chapters'
import { ascii, buildOgg, cat, countingSource, virtualSource, w32be } from '../../test-utils/containers'
import { encodeFlac, floatToInt } from '../../test-utils/flac-encoder'
import { FUZZ_TIMEOUT, eachSeed, int, mutateBytes, mutateText, pick, randomBytes, randomText, since, clock } from '../../test-utils/fuzz'
import type { Random } from '../../test-utils/fuzz'

/**
 * What a tag says about chapters is untrusted input, so every reader gets damaged and random files from a seeded generator
 * (see `test-utils/fuzz.ts`: a failing case is replayed by its seed) and must keep its promises for any of them: it never
 * throws, what it returns is bounded and well formed, and it reads a bounded part of the file in a bounded time.
 */

const SPECS: ChapterSpec[] = [
  { startMs: 0, title: 'Opening' },
  { startMs: 61_500, title: 'Chapter 1: The Storm', subtitle: 'Part one' },
  { startMs: 3_600_000, title: 'Şiir — 第二章', imageBytes: 300 },
  { startMs: 7_200_000 },
]
const MP4_BOOK = [
  { start: 0, title: 'Opening Credits' },
  { start: 61.5, title: 'Chapter 1: The Storm' },
  { start: 3600, title: 'Şiir — 第二章' },
]
const COMMENTS = ['TITLE=A book', 'CHAPTER001=00:00:00.000', 'CHAPTER001NAME=Opening', 'CHAPTER002=00:01:01.500', 'CHAPTER002NAME=Second part', 'CHAPTER003=01:00:00']

const TAGS = [
  buildChapterTag(SPECS, { version: 3 }),
  buildChapterTag(SPECS, { version: 4, encoding: 3, toc: true }),
  buildChapterTag(SPECS, { version: 4, encoding: 1, chapFlags: 0x01 }),
  buildChapterTag(SPECS, { version: 3, flags: 0x40, padding: 40 }),
]
const MP4S = [
  buildMp4WithChpl(MP4_BOOK, { seconds: 7200 }),
  buildMp4WithChpl(MP4_BOOK, { seconds: 7200, version: 0 }),
  buildMp4WithTextChapters(MP4_BOOK, { seconds: 7200 }),
  buildMp4WithTextChapters(MP4_BOOK, { seconds: 7200, utf16: true, chunks: 2, largeOffsets: true, moovFirst: true }),
]
/** The file type box every MP4 starts with: 20 bytes, a brand, a version and one compatible brand. */
const FTYP = cat(w32be(20), ascii('ftyp'), ascii('M4A '), w32be(0), ascii('M4A '))
const OGGS = [buildOgg({ codec: 'vorbis', seconds: 5, comments: COMMENTS }), buildOgg({ codec: 'opus', seconds: 5, comments: COMMENTS })]
const FLAC = encodeFlac([floatToInt(new Float32Array(8000), 16)], { sampleRate: 8000, bitsPerSample: 16, vorbis: { vendor: 'test', comments: COMMENTS } })

/** What must hold for the chapters a reader hands over, whatever it was given. */
function rawSanely(chapters: readonly RawChapter[], limit: number): void {
  expect(chapters.length).toBeLessThanOrEqual(limit)
  for (const chapter of chapters) {
    expect(typeof chapter.title).toBe('string')
    expect(Number.isFinite(chapter.start), `start ${chapter.start}`).toBe(true)
    expect(chapter.start).toBeGreaterThanOrEqual(0)
  }
}

/** Read through a counting source, and check the reader did not wander all over the file. */
async function readSanely(read: (source: ByteSource) => Promise<RawChapter[]>, bytes: Uint8Array, limit: number): Promise<RawChapter[]> {
  const source = countingSource(bytesSource(bytes))
  const started = clock()
  const chapters = await read(source)
  rawSanely(chapters, limit)
  expect(source.reads, 'a bounded number of reads').toBeLessThanOrEqual(30_000)
  expect(since(started), 'a bounded time').toBeLessThan(1500)
  return chapters
}

/** What must hold for any title that is going to be shown: short, one line, nothing that cannot be drawn or that changes how text reads. */
function titleSanely(title: string): void {
  expect([...title].length).toBeLessThanOrEqual(MAX_TITLE)
  expect(title, 'no control characters, no invisible ones, no direction overrides').not.toMatch(/[\u0000-\u001f\u007f-\u009f​-‏‪-‮⁠-⁤⁦-⁩﻿]/)
  expect(title, 'no half of a surrogate pair').not.toMatch(/[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/)
  expect(title).toBe(title.trim())
}

/** The facts about normalised chapters that hold for any input. */
function normalisedSanely(chapters: readonly Chapter[], duration: number): void {
  expect(chapters.length).toBeLessThanOrEqual(MAX_CHAPTERS)
  let before = -1
  for (const [i, chapter] of chapters.entries()) {
    expect(chapter.start, `chapter ${i + 1} comes after the one before`).toBeGreaterThan(before)
    expect(chapter.end).toBeGreaterThanOrEqual(chapter.start)
    expect(chapter.end).toBe(chapters[i + 1]?.start ?? (duration > 0 ? duration : chapter.start))
    if (duration > 0) expect(chapter.start).toBeLessThan(duration)
    expect(chapter.title.length).toBeGreaterThan(0)
    titleSanely(chapter.title)
    before = chapter.start
  }
}

describe('the ID3 chapter reader under fuzzing', { timeout: FUZZ_TIMEOUT }, () => {
  it('reads damaged tags without throwing, and hands over only what it can back up', async () => {
    await eachSeed(500, (random) => readSanely(readId3Chapters, mutateBytes(random, mutateBytes(random, pick(random, TAGS))), 2000).then(() => undefined))
  })

  it('reads random bytes, and bytes that begin like a tag', async () => {
    await eachSeed(300, async (random) => {
      await readSanely(readId3Chapters, randomBytes(random, int(random, 400)), 2000)
      const head = [0x49, 0x44, 0x33, 3 + int(random, 2), 0, pick(random, [0, 0x40, 0x80, 0xc0]), ...[0, 1, 2, 3].map(() => int(random, 128))]
      await readSanely(readId3Chapters, Uint8Array.from([...head, ...randomBytes(random, int(random, 200))]), 2000)
    })
  })

  it('reads chapter frames put together from random parts: any element id, any times, any frames inside', async () => {
    await eachSeed(300, async (random) => {
      const frames: number[] = []
      for (let i = 0, n = 1 + int(random, 8); i < n; i++) {
        const id = random() < 0.8 ? 'CHAP' : pick(random, ['TIT2', 'CTOC', 'APIC', 'XXXX'])
        const body = cat(random() < 0.7 ? ascii('chp') : [], random() < 0.8 ? [0] : [], randomBytes(random, int(random, 80)))
        frames.push(...ascii(id), ...w32be(random() < 0.9 ? body.length : int(random, 2 ** 32)), 0, pick(random, [0, 0, 0, 0x01, 0x02, 0x40, 0x80]), ...body)
      }
      await readSanely(readId3Chapters, tagFrom(frames, random() < 0.5 ? 3 : 4, pick(random, [0, 0, 0x40])), 2000)
    })
  })

  it('reads a bounded part of a huge file whose tag claims to be huge', async () => {
    const head = Uint8Array.from([0x49, 0x44, 0x33, 3, 0, 0, 0x7f, 0x7f, 0x7f, 0x7f, ...ascii('CHAP'), ...w32be(0x7ffffff0), 0, 0])
    const source = countingSource(virtualSource(4 * 2 ** 30, head)) // four gigabytes that cost nothing
    const started = clock()
    expect(await readId3Chapters(source)).toEqual([])
    expect(source.bytes).toBeLessThan(64 * 1024)
    expect(since(started)).toBeLessThan(1000)
  })

  it('does a bounded amount of work for a tag that is nothing but empty frames', async () => {
    const frames = cat(...Array.from({ length: 30_000 }, () => cat(ascii('TXXX'), w32be(0), [0, 0])))
    const source = countingSource(bytesSource(tagFrom(frames, 3)))
    const started = clock()
    expect(await readId3Chapters(source)).toEqual([])
    expect(source.reads).toBeLessThan(30_000)
    expect(since(started)).toBeLessThan(1500)
  })

  it('reads the title of a chapter even when a picture in front of it has a size that is a lie', async () => {
    const lies = buildChapterTag([{ startMs: 1000, title: 'Kept', imageBytes: 200 }, { startMs: 2000, title: 'Also kept' }])
    expect((await readId3Chapters(bytesSource(lies))).map((c) => c.title)).toEqual(['Kept', 'Also kept'])
    // the same file with the first picture's size overwritten by an extreme: what cannot be trusted ends the walk, quietly
    const picture = [...lies].findIndex((_, i) => String.fromCharCode(...lies.subarray(i, i + 4)) === 'APIC')
    expect(picture, 'the fixture has a picture to damage').toBeGreaterThan(0)
    for (const size of [[0xff, 0xff, 0xff, 0xff], [0x7f, 0xff, 0xff, 0xff], [0, 0, 0, 0]]) {
      const damaged = Uint8Array.from(lies)
      damaged.set(size, picture + 4)
      rawSanely(await readId3Chapters(bytesSource(damaged)), 2000)
    }
  })
})

describe('the MP4 chapter reader under fuzzing', { timeout: FUZZ_TIMEOUT }, () => {
  it('reads damaged files without throwing, and hands over only what it can back up', async () => {
    await eachSeed(500, async (random) => {
      await readSanely(readMp4Chapters, mutateBytes(random, mutateBytes(random, pick(random, MP4S))), 2000)
    })
  })

  it('reads random bytes, and bytes that begin like an MP4', async () => {
    await eachSeed(300, async (random) => {
      await readSanely(readMp4Chapters, randomBytes(random, int(random, 600)), 2000)
      const head = cat(FTYP, w32be(8 + int(random, 4096)), ascii('moov'))
      await readSanely(readMp4Chapters, cat(head, randomBytes(random, int(random, 300))), 2000)
    })
  })

  it('reads a bounded part of a huge file whose moov claims to be huge, and stops walking an endless run of small boxes', async () => {
    const huge = cat(FTYP, w32be(0xffffffff), ascii('moov'))
    const source = countingSource(virtualSource(2 ** 32 + 100, huge))
    expect(await readMp4Chapters(source)).toEqual([])
    expect(source.bytes).toBeLessThan(2 * 1024 * 1024)

    // ten thousand empty boxes after the file type and no moov among them: the walk has to give up, not read them all
    const flood = countingSource(bytesSource(cat(FTYP, ...Array.from({ length: 10_000 }, () => cat(w32be(8), ascii('free'))))))
    const started = clock()
    expect(await readMp4Chapters(flood)).toEqual([])
    expect(flood.reads).toBeLessThan(5000)
    expect(since(started)).toBeLessThan(1500)
  })

  it('does a bounded amount of work for sample tables that count billions of samples and chunks', async () => {
    const started = clock()
    for (const count of [0xffffffff, 0x7fffffff, 2 ** 24]) {
      const file = Uint8Array.from(MP4S[2] ?? [])
      // every four-byte count that follows a sample-table tag becomes the extreme
      for (const tag of ['stts', 'stsz', 'stsc', 'stco', 'co64']) {
        for (let i = 0; i + 16 < file.length; i++) {
          if (String.fromCharCode(...file.subarray(i, i + 4)) === tag) file.set(w32be(count), i + (tag === 'stsz' ? 12 : 8))
        }
      }
      rawSanely(await readMp4Chapters(bytesSource(file)), 2000)
    }
    expect(since(started)).toBeLessThan(3000)
  })
})

describe('the Vorbis comment chapter readers under fuzzing', { timeout: FUZZ_TIMEOUT }, () => {
  it('reads damaged Ogg, Opus and FLAC files without throwing', async () => {
    await eachSeed(500, async (random) => {
      await readSanely(readOggChapters, mutateBytes(random, mutateBytes(random, pick(random, OGGS))), 2000)
      await readSanely(readFlacChapters, mutateBytes(random, mutateBytes(random, FLAC)), 2000)
    })
  })

  it('reads random bytes, and bytes that begin like either', async () => {
    await eachSeed(200, async (random) => {
      await readSanely(readOggChapters, randomBytes(random, int(random, 500)), 2000)
      await readSanely(readFlacChapters, randomBytes(random, int(random, 500)), 2000)
      await readSanely(readOggChapters, cat(ascii('OggS'), [0, 2], randomBytes(random, int(random, 200))), 2000)
      await readSanely(readFlacChapters, cat(ascii('fLaC'), [0x84], randomBytes(random, int(random, 200))), 2000)
    })
  })

  it('takes a time only in the form of a time, and never throws for any text', async () => {
    await eachSeed(2000, (random) => {
      const text = random() < 0.5 ? mutateText(random, pick(random, ['00:00:00.000', '1:02:03', '12:34.5', '00:00:07,25'])) : randomText(random, int(random, 40))
      const seconds = parseChapterTime(text)
      if (seconds === null) return
      expect(Number.isFinite(seconds), JSON.stringify(text)).toBe(true)
      expect(seconds).toBeGreaterThanOrEqual(0)
      expect(text.length).toBeLessThanOrEqual(32)
    })
  })

  it('builds chapters from any comment fields, bounded and finite', async () => {
    await eachSeed(500, (random) => {
      const fields: [string, string][] = Array.from({ length: int(random, 60) }, () => {
        const number = String(int(random, 12_000)).padStart(random() < 0.5 ? 3 : 0, '0')
        const name = pick(random, [`CHAPTER${number}`, `CHAPTER${number}NAME`, `chapter${number}`, `CHAPTER${number}URL`, randomText(random, 8), `CHAPTER${number}NAME${randomText(random, 3)}`])
        return [name, random() < 0.6 ? pick(random, ['00:00:00.000', '00:12:34.567', '1:00:00']) : randomText(random, int(random, 50))]
      })
      rawSanely(chaptersFromComments(fields), 2000)
    })
  })
})

/** A raw chapter whose start and title may be anything at all. */
function wildChapter(random: Random, duration: number): RawChapter {
  const start = pick(random, [
    random() * (duration > 0 ? duration * 1.2 : 100_000),
    -random() * 100,
    0,
    Number.NaN,
    Number.POSITIVE_INFINITY,
    Number.NEGATIVE_INFINITY,
    1e300,
    Math.round(random() * 1000) / 1000,
    duration,
  ])
  const title = pick<unknown>(random, [
    randomText(random, int(random, 200)),
    mutateText(random, 'The Fall of Rome'),
    '',
    '   ',
    '‮evil‬',
    '\ud83d',
    '😀'.repeat(int(random, 90)),
    null,
    undefined,
    42,
    { toString: () => 'object' },
  ])
  return { start, title } as RawChapter
}

describe('normalising chapters under fuzzing', { timeout: FUZZ_TIMEOUT }, () => {
  it('turns any list into one that is ordered, bounded, clean and tiles the file', async () => {
    await eachSeed(1000, (random) => {
      const duration = pick(random, [0, 0, Number.NaN, -5, 30, 3600, 36_000, Number.POSITIVE_INFINITY])
      const raw = Array.from({ length: int(random, random() < 0.05 ? 3000 : 40) }, () => wildChapter(random, duration))
      const before = JSON.stringify(raw)
      const chapters = normalizeChapters(raw, duration)
      normalisedSanely(chapters, Number.isFinite(duration) && duration > 0 ? duration : 0)
      expect(JSON.stringify(raw), 'what it was given is left alone').toBe(before)
      // what it hands over is its own fixed point: normalising it again changes nothing
      const known = Number.isFinite(duration) && duration > 0 ? duration : 0
      expect(normalizeChapters(chapters, known)).toEqual(chapters)
    })
  })

  it('cleans any title to something that can be shown, and cleaning twice is cleaning once', async () => {
    await eachSeed(1500, (random) => {
      const title = cleanTitle(random() < 0.5 ? mutateText(random, 'Chapter 2: ​The‮ End\r\n') : randomText(random, int(random, 300)))
      titleSanely(title)
      expect(cleanTitle(title)).toBe(title)
    })
  })

  it('finds a chapter and the next and the previous start for any time in any list, and never a start that is not in the list', async () => {
    await eachSeed(800, (random) => {
      const raw = Array.from({ length: int(random, 30) }, () => ({ start: random() * 1000, title: 't' }))
      const chapters = normalizeChapters(raw, 1000)
      const times = [Number.NaN, Number.POSITIVE_INFINITY, -1, 0, 1000, 1e9, random() * 1000, random() * 1000]
      const starts = new Set([0, ...chapters.map((c) => c.start)])
      for (const time of times) {
        const index = chapterIndexAt(chapters, time)
        expect(index).toBeGreaterThanOrEqual(-1)
        expect(index).toBeLessThan(chapters.length)
        const after = nextChapterStart(chapters, time)
        const back = previousChapterStart(chapters, time)
        if (after !== null) expect(starts.has(after), `next ${after}`).toBe(true)
        if (back !== null) expect(starts.has(back), `previous ${back}`).toBe(true)
        if (after !== null && Number.isFinite(time)) expect(after).toBeGreaterThan(time - 0.1) // never backwards
      }
    })
  })
})

describe('the chapter cache under fuzzing', { timeout: FUZZ_TIMEOUT }, () => {
  const GOOD = { v: 1, chapters: [{ start: 0, end: 30, title: 'One' }, { start: 30, end: 90, title: 'Two' }, { start: 90, end: 90, title: 'Three' }] }

  /** `value` with one of its parts replaced by something of the wrong kind or an extreme. */
  function damage(random: Random, value: unknown): unknown {
    const wrong = () => pick<unknown>(random, [null, undefined, 'x', -1, Number.NaN, Number.POSITIVE_INFINITY, 1e300, [], {}, true, () => 1, 2 ** 53, '\u0000'.repeat(200)])
    if (Array.isArray(value)) {
      if (random() < 0.3) return wrong()
      const copy = [...value]
      if (copy.length) copy[int(random, copy.length)] = damage(random, copy[int(random, copy.length)])
      if (random() < 0.2) copy.push(damage(random, copy[0]))
      return copy
    }
    if (typeof value === 'object' && value !== null) {
      const entries = Object.entries(value)
      if (random() < 0.2) return wrong()
      const [key] = entries.length ? [pick(random, entries.map(([k]) => k))] : ['v']
      return { ...value, [key as string]: damage(random, (value as Record<string, unknown>)[key as string]) }
    }
    return wrong()
  }

  it('believes a record only if it is exactly what the app writes, and then gives back valid chapters', async () => {
    await eachSeed(2000, (random) => {
      const record = damage(random, damage(random, GOOD))
      const read = readChaptersRecord(record)
      if (read === null) return
      expect(read.length).toBeLessThanOrEqual(MAX_CHAPTERS)
      let before = -1
      for (const chapter of read) {
        expect(Object.keys(chapter).sort()).toEqual(['end', 'start', 'title'])
        expect(Number.isFinite(chapter.start) && Number.isFinite(chapter.end)).toBe(true)
        expect(chapter.start).toBeGreaterThan(before)
        expect(chapter.end).toBeGreaterThanOrEqual(chapter.start)
        expect([...chapter.title].length).toBeLessThanOrEqual(MAX_TITLE)
        before = chapter.start
      }
    })
  })

  it('copies the fields it knows and nothing else, so a "__proto__" key in a stored record changes nothing', () => {
    const polluted = JSON.parse('{"v":1,"chapters":[{"start":0,"end":1,"title":"x","__proto__":{"polluted":true}}]}') as unknown
    expect(readChaptersRecord(polluted)?.[0]).toEqual({ start: 0, end: 1, title: 'x' })
    expect(({} as { polluted?: boolean }).polluted).toBeUndefined()
  })
})
