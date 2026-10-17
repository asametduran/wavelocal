import { decodeText, deunsync } from '../audio/probe/id3'
import { ascii, be32, synchsafe } from '../audio/source'
import type { ByteSource } from '../audio/source'
import { paged } from './paged'
import type { Reader } from './paged'
import type { RawChapter } from './types'

/**
 * Chapters from an ID3v2.3 or v2.4 tag (the "ID3v2 chapter frame addendum"): a `CHAP` frame holds an element id, a start and an
 * end time in milliseconds, two byte offsets, and ordinary frames of its own, of which `TIT2` is the name. The tag is walked
 * frame by frame through a `ByteSource`, so a tag holding megabytes of artwork (in the file, or inside the chapters) is hopped
 * over, never read. The table of contents (`CTOC`) is not needed: chapters are put in order by their start times.
 * Everything is untrusted input: sizes are checked against the tag, counts and lengths are capped, a damaged frame ends the
 * walk and keeps what was read before it.
 */

const MAX_FRAMES = 20_000
const MAX_CHAPTERS = 2000
const MAX_SUBFRAMES = 16
const MAX_TEXT = 2048
const MAX_ELEMENT_ID = 255
/** An unsynchronised frame has to be read whole to be understood; one larger than this is skipped. */
const MAX_UNSYNC_FRAME = 256 * 1024

interface Frame {
  id: string
  /** The second flags byte: the format flags. */
  format: number
  /** Where the body starts, in the reader's own offsets. */
  body: number
  size: number
}

type Version = 3 | 4

/** The frames between `from` and `to`, at most `limit` of them; ends at padding, at something that is not a frame, and at a frame larger than the space left. */
async function* framesIn(read: Reader, version: Version, from: number, to: number, limit: number): AsyncGenerator<Frame> {
  let pos = from
  for (let i = 0; i < limit && pos + 10 <= to; i++) {
    const header = await read(pos, 10)
    if (header.length < 10 || (header[0] ?? 0) === 0) return
    const id = ascii(header, 0, 4)
    if (!/^[A-Z0-9]{4}$/.test(id)) return
    const size = version === 4 ? synchsafe(header, 4) : be32(header, 4)
    const body = pos + 10
    if (body + size > to) return
    yield { id, format: header[9] ?? 0, body, size }
    pos = body + size
  }
}

/** Compressed or encrypted: a frame this reader cannot open. */
const sealed = (version: Version, format: number): boolean => (version === 3 ? (format & 0xc0) !== 0 : (format & 0x0c) !== 0)

async function textOf(read: Reader, version: Version, frame: Frame): Promise<string> {
  if (sealed(version, frame.format)) return ''
  let data = await read(frame.body, Math.min(frame.size, MAX_TEXT))
  if (version === 4 && frame.format & 0x01) data = data.subarray(4) // a data length indicator
  if (version === 4 && frame.format & 0x02) data = deunsync(data)
  return decodeText(data)
}

async function chapterOf(read: Reader, version: Version, frame: Frame): Promise<RawChapter | null> {
  if (sealed(version, frame.format)) return null
  let inner = read
  let base = frame.body
  let end = frame.body + frame.size
  if (version === 4 && frame.format & 0x02) {
    // the bytes on disk are not the frame: undo the unsynchronisation in memory, then read from there
    if (frame.size > MAX_UNSYNC_FRAME) return null
    const whole = deunsync(await read(frame.body, frame.size))
    const data = frame.format & 0x01 ? whole.subarray(4) : whole
    inner = async (offset, length) => data.subarray(offset, offset + length)
    base = 0
    end = data.length
  } else if (version === 4 && frame.format & 0x01) base += 4

  const head = await inner(base, Math.min(end - base, MAX_ELEMENT_ID + 1 + 16))
  const terminator = head.indexOf(0)
  if (terminator < 0 || terminator > MAX_ELEMENT_ID || head.length < terminator + 1 + 16) return null
  const startMs = be32(head, terminator + 1)

  let title = ''
  let subtitle = ''
  for await (const sub of framesIn(inner, version, base + terminator + 1 + 16, end, MAX_SUBFRAMES)) {
    if (sub.id === 'TIT2' && !title) title = await textOf(inner, version, sub)
    else if (sub.id === 'TIT3' && !subtitle) subtitle = await textOf(inner, version, sub)
  }
  return { start: startMs / 1000, title: title || subtitle }
}

/** The chapters of the ID3 tag at the start of a file, as the tag gives them (see `normalizeChapters`); none for no tag or no chapters. */
export async function readId3Chapters(source: ByteSource): Promise<RawChapter[]> {
  const head = await source.read(0, 10)
  if (head.length < 10 || ascii(head, 0, 3) !== 'ID3') return []
  const flags = head[5] ?? 0
  const major = head[3]
  if ((major !== 3 && major !== 4) || flags & 0x80 || ((head[6] ?? 0) | (head[7] ?? 0) | (head[8] ?? 0) | (head[9] ?? 0)) & 0x80) return []
  const version: Version = major === 4 ? 4 : 3
  const tagEnd = Math.min(source.size, 10 + synchsafe(head, 6))
  const read = paged((offset, length) => source.read(offset, length), tagEnd)

  let pos = 10
  if (flags & 0x40) {
    const extended = await read(10, 4)
    pos += version === 4 ? synchsafe(extended, 0) : 4 + be32(extended, 0)
  }
  const chapters: RawChapter[] = []
  for await (const frame of framesIn(read, version, pos, tagEnd, MAX_FRAMES)) {
    if (frame.id !== 'CHAP') continue
    const chapter = await chapterOf(read, version, frame)
    if (chapter) chapters.push(chapter)
    if (chapters.length >= MAX_CHAPTERS) break
  }
  return chapters
}
