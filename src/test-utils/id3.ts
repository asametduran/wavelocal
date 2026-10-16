/**
 * Builds ID3v2.3 tags so tests can exercise the real tag reader (ReplayGain, lyrics, cover art) with
 * synthetic bytes instead of mocks. Text is ISO-8859-1 when possible, otherwise UTF-16 with a BOM.
 */

export interface Id3Picture {
  mime: string
  data: Uint8Array
}

export interface Id3Fields {
  title?: string
  artist?: string
  album?: string
  /** TPE2. */
  albumArtist?: string
  /** TRCK: "3" or "3/12". */
  track?: string
  /** TPOS: "1" or "1/2". */
  disc?: string
  /** TYER. */
  year?: string
  /** TCON, in any of its spellings: "Pop", "(13)", "(13)Pop". */
  genre?: string
  /** TCMP (the iTunes compilation flag): "1". */
  compilation?: string
  /** Value for the replaygain_track_gain TXXX frame, e.g. "-6.50 dB". */
  replayGainTrack?: string
  replayGainAlbum?: string
  /** Unsynchronised lyrics (USLT). Plain text or LRC text. */
  lyrics?: string
  picture?: Id3Picture
  /** Extra TXXX frames as [description, value]. */
  txxx?: readonly (readonly [string, string])[]
}

interface Encoded {
  encoding: 0 | 1
  bytes: number[]
  /** Terminator for this encoding (1 byte for ISO-8859-1, 2 for UTF-16). */
  end: number[]
}

function encodeText(text: string): Encoded {
  if ([...text].every((c) => c.charCodeAt(0) < 256)) {
    return { encoding: 0, bytes: [...text].map((c) => c.charCodeAt(0)), end: [0] }
  }
  const bytes = [0xff, 0xfe]
  for (let i = 0; i < text.length; i++) {
    const unit = text.charCodeAt(i)
    bytes.push(unit & 0xff, unit >> 8)
  }
  return { encoding: 1, bytes, end: [0, 0] }
}

const latin1 = (text: string): number[] => [...text].map((c) => c.charCodeAt(0) & 0xff)
const u32 = (n: number): number[] => [(n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff]
const syncsafe = (n: number): number[] => [(n >> 21) & 0x7f, (n >> 14) & 0x7f, (n >> 7) & 0x7f, n & 0x7f]

function frame(id: string, body: readonly number[]): number[] {
  return [...latin1(id), ...u32(body.length), 0, 0, ...body]
}

const textFrame = (id: string, text: string): number[] => {
  const e = encodeText(text)
  return frame(id, [e.encoding, ...e.bytes])
}

const txxxFrame = (description: string, value: string): number[] => {
  const d = encodeText(description)
  const v = encodeText(value)
  // both strings must share one encoding byte: re-encode as UTF-16 if either needs it
  const enc = d.encoding === 1 || v.encoding === 1 ? encodeUtf16(description, value) : null
  if (enc) return frame('TXXX', enc)
  return frame('TXXX', [0, ...d.bytes, ...d.end, ...v.bytes])
}

function encodeUtf16(description: string, value: string): number[] {
  const utf16 = (s: string) => {
    const out = [0xff, 0xfe]
    for (let i = 0; i < s.length; i++) out.push(s.charCodeAt(i) & 0xff, s.charCodeAt(i) >> 8)
    return out
  }
  return [1, ...utf16(description), 0, 0, ...utf16(value)]
}

/** Build a complete ID3v2.3 tag (header + frames). */
export function buildId3v2(fields: Id3Fields): Uint8Array<ArrayBuffer> {
  const frames: number[] = []
  if (fields.title !== undefined) frames.push(...textFrame('TIT2', fields.title))
  if (fields.artist !== undefined) frames.push(...textFrame('TPE1', fields.artist))
  if (fields.album !== undefined) frames.push(...textFrame('TALB', fields.album))
  if (fields.albumArtist !== undefined) frames.push(...textFrame('TPE2', fields.albumArtist))
  if (fields.track !== undefined) frames.push(...textFrame('TRCK', fields.track))
  if (fields.disc !== undefined) frames.push(...textFrame('TPOS', fields.disc))
  if (fields.year !== undefined) frames.push(...textFrame('TYER', fields.year))
  if (fields.genre !== undefined) frames.push(...textFrame('TCON', fields.genre))
  if (fields.compilation !== undefined) frames.push(...textFrame('TCMP', fields.compilation))
  if (fields.replayGainTrack !== undefined) frames.push(...txxxFrame('replaygain_track_gain', fields.replayGainTrack))
  if (fields.replayGainAlbum !== undefined) frames.push(...txxxFrame('replaygain_album_gain', fields.replayGainAlbum))
  for (const [description, value] of fields.txxx ?? []) frames.push(...txxxFrame(description, value))
  if (fields.lyrics !== undefined) {
    const e = encodeText(fields.lyrics)
    frames.push(...frame('USLT', [e.encoding, ...latin1('eng'), ...e.end, ...e.bytes]))
  }
  if (fields.picture) {
    frames.push(...frame('APIC', [0, ...latin1(fields.picture.mime), 0, 3, 0, ...fields.picture.data]))
  }
  const header = [...latin1('ID3'), 3, 0, 0, ...syncsafe(frames.length)]
  return Uint8Array.from([...header, ...frames])
}

/** Prepend a tag to audio bytes, the way a tagged file is laid out on disk. */
export function withId3(tag: Uint8Array, audio: Uint8Array): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(tag.length + audio.length)
  out.set(tag, 0)
  out.set(audio, tag.length)
  return out
}
