import { ascii, buildMp4, cat, mp4Box, syncsafe, w16be, w32be, w64be } from './containers'

/**
 * Builds ID3v2.3 and v2.4 tags with chapters (CHAP) and a table of contents (CTOC), so the chapter reader is tested against
 * real bytes: both versions, all four text encodings, artwork inside a chapter that a reader has to hop over, frames that are
 * unsynchronised or carry a data length indicator, and padding. See "ID3v2 chapter frame addendum" for the layouts.
 */

type Bytes = readonly number[] | Uint8Array

export interface ChapterSpec {
  /** The element id; `chp<n>` by default. */
  id?: string
  startMs: number
  endMs?: number
  title?: string
  subtitle?: string
  /** An APIC frame of this many bytes inside the chapter, before its title, so a reader has to hop over it. */
  imageBytes?: number
}

export interface ChapterTagOptions {
  version?: 3 | 4
  /** Text encoding of the titles: 0 ISO-8859-1, 1 UTF-16 with a BOM, 2 UTF-16BE (v2.4 only), 3 UTF-8 (v2.4 only). */
  encoding?: 0 | 1 | 2 | 3
  /** Write a top-level CTOC that lists the chapters. */
  toc?: boolean
  /** Other frames before the chapters (a title, a cover, anything), already encoded. */
  before?: readonly Bytes[]
  /** Zero bytes after the last frame. */
  padding?: number
  /** Flags byte of the tag header (0x80: the whole tag is unsynchronised, 0x40: an extended header follows). */
  flags?: number
  /** v2.4 format flags put on every CHAP frame: 0x01 a data length indicator, 0x02 unsynchronisation. */
  chapFlags?: number
}

/** Text as it goes into a frame body in the given encoding (without the encoding byte). */
export function encodeText(text: string, encoding: 0 | 1 | 2 | 3): number[] {
  switch (encoding) {
    case 0:
      return Array.from(text, (c) => c.charCodeAt(0) & 0xff)
    case 1:
      return [0xff, 0xfe, ...Array.from({ length: text.length }, (_, i) => [text.charCodeAt(i) & 0xff, text.charCodeAt(i) >> 8]).flat()]
    case 2:
      return Array.from({ length: text.length }, (_, i) => [text.charCodeAt(i) >> 8, text.charCodeAt(i) & 0xff]).flat()
    default:
      return [...new TextEncoder().encode(text)]
  }
}

/** One frame: its id, size, flags and body, with the size written the way the version writes it. */
export function frameBytes(id: string, body: Bytes, version: 3 | 4, formatFlags = 0): Uint8Array<ArrayBuffer> {
  return cat(ascii(id), version === 4 ? syncsafe(body.length) : w32be(body.length), [0, formatFlags], body)
}

/** A text frame (TIT2 and the like). */
export const textFrame = (id: string, text: string, encoding: 0 | 1 | 2 | 3, version: 3 | 4): Uint8Array<ArrayBuffer> => frameBytes(id, cat([encoding], encodeText(text, encoding)), version)

/** Unsynchronisation: a 0x00 after every 0xFF that a reader could take for the start of an MPEG frame, and after a final 0xFF. */
export function unsynchronise(bytes: Bytes): Uint8Array<ArrayBuffer> {
  const out: number[] = []
  for (let i = 0; i < bytes.length; i++) {
    const b = bytes[i] ?? 0
    out.push(b)
    if (b === 0xff && (i === bytes.length - 1 || (bytes[i + 1] ?? 0) >= 0xe0 || bytes[i + 1] === 0)) out.push(0)
  }
  return Uint8Array.from(out)
}

function chapFrame(spec: ChapterSpec, index: number, options: ChapterTagOptions): Uint8Array<ArrayBuffer> {
  const version = options.version ?? 3
  const encoding = options.encoding ?? 0
  const subframes: Bytes[] = []
  if (spec.imageBytes) subframes.push(frameBytes('APIC', cat([0], ascii('image/jpeg'), [0, 3, 0], new Uint8Array(spec.imageBytes).fill(0x55)), version))
  if (spec.title !== undefined) subframes.push(textFrame('TIT2', spec.title, encoding, version))
  if (spec.subtitle !== undefined) subframes.push(textFrame('TIT3', spec.subtitle, encoding, version))
  const body = cat(ascii(spec.id ?? chapterId(index)), [0], w32be(spec.startMs), w32be(spec.endMs ?? spec.startMs), w32be(0xffffffff), w32be(0xffffffff), ...subframes)
  const flags = options.chapFlags ?? 0
  if (version !== 4 || flags === 0) return frameBytes('CHAP', body, version)
  // v2.4: the data length indicator holds the size of the data before unsynchronisation; the data is unsynchronised after it
  let data: Uint8Array<ArrayBuffer> = body
  if (flags & 0x02) data = unsynchronise(data)
  return frameBytes('CHAP', flags & 0x01 ? cat(syncsafe(body.length), data) : data, version, flags & 0x03)
}

export const chapterId = (index: number): string => `chp${index}`

function tocFrame(count: number, version: 3 | 4): Uint8Array<ArrayBuffer> {
  const ids = Array.from({ length: count }, (_, i) => cat(ascii(chapterId(i)), [0]))
  return frameBytes('CTOC', cat(ascii('toc'), [0, 0x03, count], ...ids), version)
}

/** A tag header (with the extended header the flags ask for) and the frames, from frames built by hand. */
export function tagFrom(frames: Bytes, version: 3 | 4, flags = 0, padding = 0): Uint8Array<ArrayBuffer> {
  const extended = flags & 0x40 ? (version === 4 ? cat(syncsafe(6), [1, 0]) : cat(w32be(6), [0, 0, 0, 0, 0, 0])) : new Uint8Array(0)
  const body = cat(extended, frames, new Uint8Array(padding))
  return cat(ascii('ID3'), [version, 0, flags], syncsafe(body.length), body)
}

/** A complete ID3v2 tag holding the chapters (and whatever `before` puts in front of them). */
export function buildChapterTag(chapters: readonly ChapterSpec[], options: ChapterTagOptions = {}): Uint8Array<ArrayBuffer> {
  const version = options.version ?? 3
  const frames = cat(...(options.before ?? []), ...chapters.map((chapter, i) => chapFrame(chapter, i, options)), ...(options.toc ? [tocFrame(chapters.length, version)] : []))
  return tagFrom(frames, version, options.flags ?? 0, options.padding ?? 0)
}

// ---- MP4 ---------------------------------------------------------------------------------------------------------------
// Two ways an MP4 or M4B names its chapters: the Nero `chpl` atom in `moov/udta`, and (QuickTime, Apple's audiobooks) a text
// track that the audio track points to with `tref/chap`, whose samples are the titles. Both are spliced into a plain file.

export interface Mp4Chapter {
  /** Seconds. */
  start: number
  title: string
}

const zeros = (n: number): number[] => new Array<number>(n).fill(0)
const fullBox = (type: string, version: number, flags: number, payload: Bytes): Uint8Array<ArrayBuffer> => mp4Box(type, cat([version, (flags >> 16) & 0xff, (flags >> 8) & 0xff, flags & 0xff], payload))

/** The boxes at the top of `bytes` (32-bit sizes only), as slices. */
export function mp4Boxes(bytes: Uint8Array): { type: string; box: Uint8Array }[] {
  const out: { type: string; box: Uint8Array }[] = []
  for (let at = 0; at + 8 <= bytes.length; ) {
    const size = new DataView(bytes.buffer, bytes.byteOffset + at, 8).getUint32(0)
    out.push({ type: String.fromCharCode(...bytes.subarray(at + 4, at + 8)), box: bytes.subarray(at, at + size) })
    at += size
  }
  return out
}

/** `box` with `children` added at the end of its payload (the size is rewritten). */
function appendTo(box: Uint8Array, ...children: Bytes[]): Uint8Array<ArrayBuffer> {
  return mp4Box(String.fromCharCode(...box.subarray(4, 8)), cat(box.subarray(8), ...children))
}

/** An M4A of `seconds`, laid out `ftyp mdat moov`, taken apart so the chapters can be added to its `moov`. */
function plainMp4(seconds: number): { ftyp: Uint8Array; mdat: Uint8Array; moov: Uint8Array } {
  const parts = mp4Boxes(buildMp4({ seconds, moovAtEnd: true, mdatBytes: 64 }))
  const get = (type: string) => parts.find((p) => p.type === type)?.box ?? new Uint8Array(0)
  return { ftyp: get('ftyp'), mdat: get('mdat'), moov: get('moov') }
}

/** The Nero chapter atom: a version, a count, and for each chapter a start in 100 ns units and a title of at most 255 bytes. */
export function chplBox(chapters: readonly Mp4Chapter[], version: 0 | 1 = 1): Uint8Array<ArrayBuffer> {
  const entries = chapters.map((c) => {
    const title = new TextEncoder().encode(c.title).subarray(0, 255)
    return cat(w64be(Math.round(c.start * 10_000_000)), [title.length], title)
  })
  return mp4Box('chpl', cat([version, 0, 0, 0], version === 1 ? w32be(0) : [], [chapters.length], ...entries))
}

/** An M4A of `seconds` with the chapters in `moov/udta/chpl`. */
export function buildMp4WithChpl(chapters: readonly Mp4Chapter[], o: { seconds: number; version?: 0 | 1 }): Uint8Array<ArrayBuffer> {
  const { ftyp, mdat, moov } = plainMp4(o.seconds)
  return cat(ftyp, mdat, appendTo(moov, mp4Box('udta', chplBox(chapters, o.version ?? 1))))
}

export interface TextTrackOptions {
  seconds: number
  /** The text track's own time scale (ticks per second). Default 1000. */
  timescale?: number
  /** Titles as UTF-16 with a byte order mark instead of UTF-8. */
  utf16?: boolean
  /** Spread the samples over this many chunks. Default 1. */
  chunks?: number
  /** Write the chunk offsets as 64-bit (`co64`). */
  largeOffsets?: boolean
  /** The id of the text track the audio track points to. Default 2. */
  trackId?: number
  /** Lay the file out `ftyp moov mdat` (made for streaming) instead of `ftyp mdat moov`; the chunk offsets then count the room `moov` takes. */
  moovFirst?: boolean
  /** What the audio track points to: a track that does not exist, nothing at all (no `tref`), or the id of another track. Default: the text track. */
  pointer?: 'missing' | 'none' | number
}

/** One text sample: a 16-bit length, then the text (UTF-8, or UTF-16 with a BOM). */
function textSample(title: string, utf16: boolean): Uint8Array<ArrayBuffer> {
  const text = utf16 ? cat([0xfe, 0xff], Array.from({ length: title.length }, (_, i) => [title.charCodeAt(i) >> 8, title.charCodeAt(i) & 0xff]).flat()) : new TextEncoder().encode(title)
  return cat(w16be(text.length), text)
}

/** An M4A of `seconds` whose audio track points (`tref/chap`) to a text track holding the chapter titles. */
export function buildMp4WithTextChapters(chapters: readonly Mp4Chapter[], o: TextTrackOptions): Uint8Array<ArrayBuffer> {
  const timescale = o.timescale ?? 1000
  const trackId = o.trackId ?? 2
  const { ftyp, mdat, moov } = plainMp4(o.seconds)
  const samples = chapters.map((c) => textSample(c.title, o.utf16 ?? false))

  // each sample lasts until the next chapter starts, the last until the end
  const deltas = chapters.map((c, i) => Math.round(((chapters[i + 1]?.start ?? o.seconds) - c.start) * timescale))
  const runs: [count: number, delta: number][] = []
  for (const delta of deltas) {
    const last = runs.at(-1)
    if (last && last[1] === delta) last[0]++
    else runs.push([1, delta])
  }

  // chunks: `per` samples each, the last one with what is left
  const per = Math.max(1, Math.ceil(samples.length / (o.chunks ?? 1)))
  const chunkCount = Math.ceil(samples.length / per)
  const stsc = samples.length % per === 0 ? [[1, per, 1]] : [[1, per, 1], [chunkCount, samples.length % per, 1]]

  /** `moov` with the text track in it, for text samples that start `dataStart` bytes into the file. */
  const moovWith = (dataStart: number): Uint8Array<ArrayBuffer> => {
    const offsets: number[] = []
    for (let c = 0, at = dataStart; c < chunkCount; c++) {
      offsets.push(at)
      for (const s of samples.slice(c * per, (c + 1) * per)) at += s.length
    }
    const stbl = mp4Box(
      'stbl',
      cat(
        fullBox('stsd', 0, 0, cat(w32be(1), mp4Box('text', zeros(24)))),
        fullBox('stts', 0, 0, cat(w32be(runs.length), ...runs.map(([count, delta]) => cat(w32be(count), w32be(delta))))),
        fullBox('stsc', 0, 0, cat(w32be(stsc.length), ...stsc.map((e) => cat(...e.map((n) => w32be(n)))))),
        fullBox('stsz', 0, 0, cat(w32be(0), w32be(samples.length), ...samples.map((s) => w32be(s.length)))),
        o.largeOffsets ? fullBox('co64', 0, 0, cat(w32be(offsets.length), ...offsets.map(w64be))) : fullBox('stco', 0, 0, cat(w32be(offsets.length), ...offsets.map(w32be))),
      ),
    )
    const textTrak = mp4Box(
      'trak',
      cat(
        fullBox('tkhd', 0, 7, cat(w32be(0), w32be(0), w32be(trackId), zeros(68))),
        mp4Box('mdia', cat(fullBox('mdhd', 0, 0, cat(w32be(0), w32be(0), w32be(timescale), w32be(Math.round(o.seconds * timescale)), w16be(0x55c4), w16be(0))), fullBox('hdlr', 0, 0, cat(w32be(0), ascii('text'), zeros(12), [0])), mp4Box('minf', stbl))),
      ),
    )
    // the audio track gets the pointer to it
    const inside = mp4Boxes(moov.subarray(8))
    const audio = inside.find((b) => b.type === 'trak')?.box ?? new Uint8Array(0)
    const pointed = o.pointer === 'none' ? audio : appendTo(audio, mp4Box('tref', mp4Box('chap', w32be(o.pointer === 'missing' ? 99 : typeof o.pointer === 'number' ? o.pointer : trackId))))
    return mp4Box('moov', cat(...inside.map((b) => (b.box === audio ? pointed : b.box)), textTrak))
  }

  const textMdat = mp4Box('mdat', cat(...samples))
  if (!o.moovFirst) return cat(ftyp, mdat, textMdat, moovWith(ftyp.length + mdat.length + 8)) // the text samples follow the first mdat
  const size = moovWith(0).length // offsets are fixed-width, so the size does not depend on their values
  return cat(ftyp, moovWith(ftyp.length + size + mdat.length + 8), mdat, textMdat)
}
