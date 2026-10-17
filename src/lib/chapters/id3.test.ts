// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { readId3Chapters } from './id3'
import { bytesSource } from '../audio/source'
import { buildChapterTag, frameBytes, tagFrom, textFrame } from '../../test-utils/chapters'
import type { ChapterSpec } from '../../test-utils/chapters'
import { ascii, cat, countingSource, w32be } from '../../test-utils/containers'
import { clock, since } from '../../test-utils/fuzz'

const read = (tag: Uint8Array) => readId3Chapters(bytesSource(tag))
const BOOK: ChapterSpec[] = [
  { startMs: 0, title: 'Intro' },
  { startMs: 65_500, title: 'Part one' },
  { startMs: 3_600_000, title: 'Finale' },
]
const EXPECTED = [
  { start: 0, title: 'Intro' },
  { start: 65.5, title: 'Part one' },
  { start: 3600, title: 'Finale' },
]

describe('readId3Chapters', () => {
  it('reads the chapters of an ID3v2.3 tag, in the order they are written: the start in seconds and the title', async () => {
    expect(await read(buildChapterTag(BOOK, { version: 3 }))).toEqual(EXPECTED)
  })

  it('reads an ID3v2.4 tag, whose frame sizes are written in seven bits per byte', async () => {
    expect(await read(buildChapterTag(BOOK, { version: 4 }))).toEqual(EXPECTED)
  })

  it('reads titles in every encoding the versions allow, including text outside Latin-1', async () => {
    const turkish = [{ startMs: 1000, title: 'Yarısı İstanbul' }]
    const want = [{ start: 1, title: 'Yarısı İstanbul' }]
    expect(await read(buildChapterTag(turkish, { version: 3, encoding: 1 }))).toEqual(want) // UTF-16 with a byte order mark
    expect(await read(buildChapterTag(turkish, { version: 4, encoding: 1 }))).toEqual(want)
    expect(await read(buildChapterTag(turkish, { version: 4, encoding: 2 }))).toEqual(want) // UTF-16, big endian
    expect(await read(buildChapterTag(turkish, { version: 4, encoding: 3 }))).toEqual(want) // UTF-8
    expect(await read(buildChapterTag([{ startMs: 0, title: 'Café' }], { encoding: 0 }))).toEqual([{ start: 0, title: 'Café' }])
  })

  it('names a chapter by its subtitle when it has no title, and prefers the title when it has both', async () => {
    const tag = buildChapterTag([{ startMs: 1000, subtitle: 'Only a subtitle' }, { startMs: 2000, title: 'Main', subtitle: 'Extra' }])
    expect(await read(tag)).toEqual([{ start: 1, title: 'Only a subtitle' }, { start: 2, title: 'Main' }])
  })

  it('gives a chapter without any name an empty title, for the normaliser to name by its place', async () => {
    expect(await read(buildChapterTag([{ startMs: 2000 }]))).toEqual([{ start: 2, title: '' }])
  })

  it('finds the chapters among other frames, which it leaves alone', async () => {
    const before = [textFrame('TIT2', 'Book title', 0, 3), textFrame('TPE1', 'Someone', 0, 3), frameBytes('APIC', new Uint8Array(20_000).fill(7), 3)]
    expect(await read(buildChapterTag(BOOK, { before, toc: true }))).toEqual(EXPECTED) // and the table of contents is not a chapter
  })

  it('hops over artwork inside a chapter to the title behind it, without reading the picture', async () => {
    const withPictures: ChapterSpec[] = BOOK.map((chapter) => ({ ...chapter, imageBytes: 150_000 }))
    const tag = buildChapterTag(withPictures)
    expect(tag.length).toBeGreaterThan(450_000)
    const source = countingSource(bytesSource(tag))
    expect(await readId3Chapters(source)).toEqual(EXPECTED)
    expect(source.bytes).toBeLessThan(60_000) // a few small pages, not the pictures
    expect(source.reads).toBeLessThan(40)
  })

  it('reads a tag of many small chapters in a few reads, not one per frame', async () => {
    const many: ChapterSpec[] = Array.from({ length: 300 }, (_, i) => ({ startMs: i * 1000, title: `Chapter ${i}` }))
    const source = countingSource(bytesSource(buildChapterTag(many)))
    expect(await readId3Chapters(source)).toHaveLength(300)
    expect(source.reads).toBeLessThan(40)
  })

  it('skips the extended header of either version', async () => {
    expect(await read(buildChapterTag(BOOK, { version: 3, flags: 0x40 }))).toEqual(EXPECTED)
    expect(await read(buildChapterTag(BOOK, { version: 4, flags: 0x40 }))).toEqual(EXPECTED)
  })

  it('stops at the padding after the last frame', async () => {
    expect(await read(buildChapterTag(BOOK, { padding: 500 }))).toEqual(EXPECTED)
  })

  it('reads chapter frames of ID3v2.4 that are unsynchronised, or start with a data length indicator', async () => {
    // 16,769,024 ms is 00 FF E0 00 in four bytes: the FF E0 must be written as FF 00 E0 and read back
    const trick = [{ startMs: 16_769_024, title: 'Needs unsynchronisation' }]
    const want = [{ start: 16_769.024, title: 'Needs unsynchronisation' }]
    expect(await read(buildChapterTag(trick, { version: 4, chapFlags: 0x02 }))).toEqual(want)
    expect(await read(buildChapterTag(trick, { version: 4, chapFlags: 0x01 }))).toEqual(want)
    expect(await read(buildChapterTag(trick, { version: 4, chapFlags: 0x03 }))).toEqual(want)
  })

  it('leaves out a chapter frame it cannot read (compressed or encrypted) and keeps the others', async () => {
    const readable = buildChapterTag([{ startMs: 5000, title: 'Readable' }], { version: 4 }).subarray(10)
    const compressed = frameBytes('CHAP', cat(ascii('chpX'), [0], w32be(1000), w32be(1000), w32be(0xffffffff), w32be(0xffffffff)), 4, 0x08)
    const encrypted = frameBytes('CHAP', cat(ascii('chpY'), [0], w32be(2000), w32be(2000), w32be(0xffffffff), w32be(0xffffffff)), 4, 0x04)
    expect(await read(tagFrom(cat(compressed, encrypted, readable), 4))).toEqual([{ start: 5, title: 'Readable' }])
  })

  it('returns no chapters for a tag without any, a file that is not tagged, an ID3v2.2 tag and a tag that is unsynchronised as a whole', async () => {
    expect(await read(buildChapterTag([]))).toEqual([])
    expect(await read(cat(ascii('RIFF'), new Uint8Array(100)))).toEqual([])
    expect(await read(new Uint8Array(0))).toEqual([])
    expect(await read(cat(ascii('ID3'), [2, 0, 0, 0, 0, 0, 20], new Uint8Array(20)))).toEqual([])
    expect(await read(buildChapterTag(BOOK, { flags: 0x80 }))).toEqual([])
  })

  it('keeps the chapters it read before a frame that claims more than the tag holds', async () => {
    const good = buildChapterTag([{ startMs: 1000, title: 'Good' }]).subarray(10)
    const liar = cat(ascii('CHAP'), w32be(5_000_000), [0, 0], ascii('lie'), [0])
    expect(await read(tagFrom(cat(good, liar), 3))).toEqual([{ start: 1, title: 'Good' }])
  })

  it('skips a chapter whose element id never ends or whose times are cut short, and reads the one after it', async () => {
    const noEnd = frameBytes('CHAP', new Uint8Array(300).fill(0x61), 3)
    const short = frameBytes('CHAP', cat(ascii('chpS'), [0], w32be(1000)), 3)
    const fine = buildChapterTag([{ startMs: 9000, title: 'Fine', id: 'ok' }]).subarray(10)
    expect(await read(tagFrom(cat(noEnd, short, fine), 3))).toEqual([{ start: 9, title: 'Fine' }])
  })

  it('does not believe a tag size larger than the file', async () => {
    const tag = buildChapterTag(BOOK)
    const lying = Uint8Array.from(tag)
    lying.set([0x7f, 0x7f, 0x7f, 0x7f], 6) // 256 MB
    expect(await read(lying)).toEqual(EXPECTED)
  })

  it('gives a start time that is not a real time as it is, for the normaliser to throw away', async () => {
    const [chapter] = await read(buildChapterTag([{ startMs: 0xffffffff, title: 'Nonsense' }]))
    expect(chapter?.start).toBeCloseTo(4_294_967.295, 3)
  })

  it('does a bounded amount of work for a tag made of thousands of chapters', async () => {
    const flood: ChapterSpec[] = Array.from({ length: 5000 }, (_, i) => ({ startMs: i, title: 'x' }))
    const tag = buildChapterTag(flood)
    const started = clock()
    const chapters = await readId3Chapters(bytesSource(tag))
    expect(chapters.length).toBeLessThanOrEqual(2000)
    expect(chapters.length).toBeGreaterThan(1000)
    expect(since(started)).toBeLessThan(2000)
  })
})
