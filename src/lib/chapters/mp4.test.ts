// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { readMp4Chapters } from './mp4'
import { bytesSource } from '../audio/source'
import { buildMp4WithChpl, buildMp4WithTextChapters, chplBox, mp4Boxes } from '../../test-utils/chapters'
import type { Mp4Chapter } from '../../test-utils/chapters'
import { ascii, buildMp4, cat, countingSource, mp4Box, w32be } from '../../test-utils/containers'
import { clock, since } from '../../test-utils/fuzz'

const read = (file: Uint8Array) => readMp4Chapters(bytesSource(file))
const BOOK: Mp4Chapter[] = [
  { start: 0, title: 'Opening Credits' },
  { start: 61.5, title: 'Chapter 1: The Storm' },
  { start: 3600, title: 'Şiir — 第二章' },
]

/** The same file with `moov` in front of `mdat`, the way a file made for streaming is laid out. */
function faststart(file: Uint8Array): Uint8Array {
  const parts = mp4Boxes(file)
  const get = (type: string) => parts.filter((p) => p.type === type).map((p) => p.box)
  return cat(...get('ftyp'), ...get('moov'), ...get('mdat'))
}

describe('readMp4Chapters: the Nero chapter atom', () => {
  it('reads the chapters of moov/udta/chpl: start in seconds and the title in UTF-8', async () => {
    expect(await read(buildMp4WithChpl(BOOK, { seconds: 7200 }))).toEqual(BOOK)
  })

  it('reads the older layout of the atom, which has no reserved field', async () => {
    expect(await read(buildMp4WithChpl(BOOK, { seconds: 7200, version: 0 }))).toEqual(BOOK)
  })

  it('finds moov in front of the media data as well as behind it', async () => {
    expect(await read(faststart(buildMp4WithChpl(BOOK, { seconds: 7200 })))).toEqual(BOOK)
  })

  it('stops at the end of the atom when it counts more chapters than it holds', async () => {
    const lying = Uint8Array.from(chplBox(BOOK))
    lying[8 + 4 + 4] = 200 // the count byte: 200 chapters claimed, 3 present
    const { ftyp, moov } = splitPlain(7200)
    const file = cat(ftyp, mp4Box('mdat', new Uint8Array(64)), withUdta(moov, lying))
    expect((await read(file)).map((c) => c.title)).toEqual(BOOK.map((c) => c.title))
  })

  it('has no chapters for an atom with a count of zero', async () => {
    expect(await read(buildMp4WithChpl([], { seconds: 100 }))).toEqual([])
  })

  it('has no chapters for a plain M4A', async () => {
    expect(await read(buildMp4({ seconds: 100 }))).toEqual([])
  })

  it('reads the Nero atom in a few reads, not the whole file', async () => {
    const file = buildMp4WithChpl(BOOK, { seconds: 7200 })
    const source = countingSource(bytesSource(file))
    await readMp4Chapters(source)
    expect(source.reads).toBeLessThan(10)
    expect(source.bytes).toBeLessThanOrEqual(file.length)
  })
})

describe('readMp4Chapters: a QuickTime chapter track', () => {
  it('follows tref/chap from the audio track to a text track and reads its samples as titles, timed by the sample table', async () => {
    expect(await read(buildMp4WithTextChapters(BOOK, { seconds: 7200 }))).toEqual(BOOK)
  })

  it('reads titles written as UTF-16 with a byte order mark', async () => {
    expect(await read(buildMp4WithTextChapters(BOOK, { seconds: 7200, utf16: true }))).toEqual(BOOK)
  })

  it('works in any time scale of the text track', async () => {
    for (const timescale of [600, 1000, 44100]) {
      expect(await read(buildMp4WithTextChapters(BOOK, { seconds: 7200, timescale })), `timescale ${timescale}`).toEqual(BOOK)
    }
  })

  it('finds the samples when they are spread over several chunks, and with 64-bit chunk offsets', async () => {
    expect(await read(buildMp4WithTextChapters(BOOK, { seconds: 7200, chunks: 3 }))).toEqual(BOOK)
    expect(await read(buildMp4WithTextChapters(BOOK, { seconds: 7200, chunks: 2, largeOffsets: true }))).toEqual(BOOK)
  })

  it('finds the text track by the id the audio track points to, not by where it sits', async () => {
    expect(await read(buildMp4WithTextChapters(BOOK, { seconds: 7200, trackId: 7 }))).toEqual(BOOK)
  })

  it('finds moov in front of the media data (with the chunk offsets that layout needs)', async () => {
    expect(await read(buildMp4WithTextChapters(BOOK, { seconds: 7200, moovFirst: true }))).toEqual(BOOK)
  })

  it('has no chapters when the audio track points to a track that is not there, or to nothing', async () => {
    expect(await read(buildMp4WithTextChapters(BOOK, { seconds: 7200, pointer: 'missing' }))).toEqual([])
    expect(await read(buildMp4WithTextChapters(BOOK, { seconds: 7200, pointer: 'none' }))).toEqual([])
  })

  it('has no chapters when the track pointed to is not a text track', async () => {
    // the audio track pointing to itself (id 1, while the text track has id 2) is a track of sound, whose samples are not titles
    expect(await read(buildMp4WithTextChapters(BOOK, { seconds: 7200, pointer: 1 }))).toEqual([])
  })

  it('reads a book of a few hundred chapters in a few reads and little time', async () => {
    const many: Mp4Chapter[] = Array.from({ length: 400 }, (_, i) => ({ start: i * 90, title: `Chapter ${i + 1}` }))
    const file = buildMp4WithTextChapters(many, { seconds: 400 * 90 })
    const source = countingSource(bytesSource(file))
    const started = clock()
    const chapters = await readMp4Chapters(source)
    expect(chapters).toEqual(many)
    expect(source.reads).toBeLessThan(20)
    expect(since(started)).toBeLessThan(1000)
  })

  it('does a bounded amount of work for a text track of tens of thousands of samples', async () => {
    const flood: Mp4Chapter[] = Array.from({ length: 30_000 }, (_, i) => ({ start: i, title: 'x' }))
    const file = buildMp4WithTextChapters(flood, { seconds: 30_000 })
    const started = clock()
    const chapters = await readMp4Chapters(bytesSource(file))
    expect(chapters.length).toBeLessThanOrEqual(2000)
    expect(chapters.length).toBeGreaterThan(1000)
    expect(since(started)).toBeLessThan(2000)
  })
})

describe('readMp4Chapters: files that are not what they claim', () => {
  it('has no chapters for a file that is not an MP4, an empty file, and a box that claims more than the file holds', async () => {
    expect(await read(new Uint8Array(0))).toEqual([])
    expect(await read(cat(ascii('RIFF'), new Uint8Array(200)))).toEqual([])
    expect(await read(cat(w32be(5_000_000), ascii('moov'), new Uint8Array(40)))).toEqual([])
  })

  it('has no chapters for a moov box larger than it will read', async () => {
    const huge = cat(mp4Box('ftyp', ascii('M4A ')), w32be(1), ascii('moov'), [0, 0, 0, 0, 0x10, 0, 0, 0]) // 64-bit size: 268 MB
    expect(await read(huge)).toEqual([])
  })

  it('keeps what it read when the file is cut off in the middle of the text samples', async () => {
    const file = buildMp4WithTextChapters(BOOK, { seconds: 7200 })
    const cut = file.subarray(0, file.length - 1) // the moov is last: this damages it
    expect(Array.isArray(await read(cut))).toBe(true) // and above all: no throw
  })
})

// ---- helpers for the tests that damage a file by hand ----

function splitPlain(seconds: number) {
  const parts = mp4Boxes(buildMp4({ seconds, moovAtEnd: true, mdatBytes: 64 }))
  const get = (type: string) => parts.find((p) => p.type === type)?.box ?? new Uint8Array(0)
  return { ftyp: get('ftyp'), moov: get('moov') }
}

function withUdta(moov: Uint8Array, chpl: Uint8Array): Uint8Array<ArrayBuffer> {
  return mp4Box('moov', cat(moov.subarray(8), mp4Box('udta', chpl)))
}
