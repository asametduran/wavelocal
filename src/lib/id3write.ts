/**
 * ID3v2 tag rewriting for MP3 files.
 *
 * Reads the existing ID3v2 tag (v2.2, v2.3 or v2.4, with unsynchronisation, extended header and padding),
 * replaces only the title / artist / album / cover frames and keeps every other frame byte for byte
 * (ReplayGain, lyrics, track numbers, ...). The audio payload after the tag is never touched.
 */

export interface TagPicture {
  mime: string
  data: Uint8Array
}

/** `undefined` keeps a field as it is; an empty string removes the frame. For `picture`, `null` removes the cover. */
export interface TagChanges {
  title?: string
  artist?: string
  album?: string
  picture?: TagPicture | null
}

export interface ParsedFrame {
  id: string
  /** The two frame-flag bytes (zero for v2.2 frames). */
  flags: number
  body: Uint8Array
}

export interface ParsedTag {
  /** Major version (2, 3 or 4). */
  version: 2 | 3 | 4
  frames: ParsedFrame[]
  /** Bytes the tag occupies at the start of the file, including header, padding and any footer. */
  length: number
}

const MAX_TAG_BYTES = 256 * 1024 * 1024

const ascii = (bytes: Uint8Array, start: number, end: number): string => {
  let s = ''
  for (let i = start; i < end; i++) s += String.fromCharCode(bytes[i] ?? 0)
  return s
}
const latin1 = (s: string): number[] => [...s].map((c) => c.charCodeAt(0) & 0xff)
const syncsafeAt = (b: Uint8Array, o: number): number => ((b[o] ?? 0) << 21) | ((b[o + 1] ?? 0) << 14) | ((b[o + 2] ?? 0) << 7) | (b[o + 3] ?? 0)
const u32At = (b: Uint8Array, o: number): number => (((b[o] ?? 0) << 24) | ((b[o + 1] ?? 0) << 16) | ((b[o + 2] ?? 0) << 8) | (b[o + 3] ?? 0)) >>> 0
const u24At = (b: Uint8Array, o: number): number => ((b[o] ?? 0) << 16) | ((b[o + 1] ?? 0) << 8) | (b[o + 2] ?? 0)
const toSyncsafe = (n: number): number[] => [(n >> 21) & 0x7f, (n >> 14) & 0x7f, (n >> 7) & 0x7f, n & 0x7f]
const toU32 = (n: number): number[] => [(n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff]

/** ID3v2.2 three-character frame ids that map onto the four-character ids used from v2.3 on. */
const V22_IDS: Readonly<Record<string, string>> = {
  TT2: 'TIT2', TP1: 'TPE1', TP2: 'TPE2', TAL: 'TALB', TRK: 'TRCK', TYE: 'TYER', TCO: 'TCON', TPA: 'TPOS', TCM: 'TCOM',
  TEN: 'TENC', TXX: 'TXXX', ULT: 'USLT', COM: 'COMM', TCR: 'TCOP', TPB: 'TPUB', TLE: 'TLEN', TBP: 'TBPM', TDA: 'TDAT',
  TFT: 'TFLT', TKE: 'TKEY', TLA: 'TLAN', TOA: 'TOPE', TOT: 'TOAL', TSS: 'TSSE', WXX: 'WXXX',
}

/** Undo unsynchronisation: every 0xFF 0x00 pair becomes 0xFF. */
export function removeUnsynchronisation(bytes: Uint8Array): Uint8Array {
  const out = new Uint8Array(bytes.length)
  let n = 0
  for (let i = 0; i < bytes.length; i++) {
    const b = bytes[i] ?? 0
    out[n++] = b
    if (b === 0xff && bytes[i + 1] === 0x00) i++
  }
  return out.subarray(0, n)
}

/** Parse the ID3v2 tag at the start of `bytes`, or null when there is none (or its header is invalid). */
export function parseId3v2(bytes: Uint8Array): ParsedTag | null {
  if (bytes.length < 10 || ascii(bytes, 0, 3) !== 'ID3') return null
  const version = bytes[3]
  if (version !== 2 && version !== 3 && version !== 4) return null
  const flags = bytes[5] ?? 0
  if (((bytes[6] ?? 0) | (bytes[7] ?? 0) | (bytes[8] ?? 0) | (bytes[9] ?? 0)) & 0x80) return null
  const size = syncsafeAt(bytes, 6)
  if (size > MAX_TAG_BYTES) return null
  const hasFooter = version === 4 && (flags & 0x10) !== 0
  const length = 10 + size + (hasFooter ? 10 : 0)
  const end = Math.min(10 + size, bytes.length)

  let body = bytes.subarray(10, end)
  // v2.2/2.3 unsynchronise the whole tag; v2.4 does it per frame (handled below).
  if (version !== 4 && flags & 0x80) body = removeUnsynchronisation(body)

  let pos = 0
  if (version === 3 && flags & 0x40 && body.length >= 4) pos = 4 + u32At(body, 0)
  if (version === 4 && flags & 0x40 && body.length >= 4) pos = syncsafeAt(body, 0)

  const frames: ParsedFrame[] = []
  const headerLen = version === 2 ? 6 : 10
  while (pos + headerLen <= body.length) {
    if ((body[pos] ?? 0) === 0) break // padding
    const rawId = ascii(body, pos, pos + (version === 2 ? 3 : 4))
    if (!/^[A-Z0-9]+$/.test(rawId)) break
    let frameSize: number
    let frameFlags = 0
    if (version === 2) frameSize = u24At(body, pos + 3)
    else {
      frameSize = version === 4 ? syncsafeAt(body, pos + 4) : u32At(body, pos + 4)
      frameFlags = ((body[pos + 8] ?? 0) << 8) | (body[pos + 9] ?? 0)
    }
    const start = pos + headerLen
    if (start + frameSize > body.length) break
    let frameBody = body.subarray(start, start + frameSize)
    // v2.4 per-frame data-length indicator (flag bit 0) and unsynchronisation (bit 1) are normalised away.
    if (version === 4) {
      if (frameFlags & 0x0001) frameBody = frameBody.subarray(4)
      if (frameFlags & 0x0002) frameBody = removeUnsynchronisation(frameBody)
      frameFlags &= ~0x0003
    }
    // v2.2 has no equivalent for unknown ids: those frames are dropped; PIC is kept for conversion to APIC.
    const id = version === 2 ? (rawId === 'PIC' ? 'PIC' : (V22_IDS[rawId] ?? '')) : rawId
    if (id) frames.push({ id, flags: frameFlags, body: frameBody.slice() })
    pos = start + frameSize
  }
  return { version, frames, length }
}

// ---- frames ----

/**
 * Text as a tag can hold it. A NUL ends a value in every ID3 version, so it would cut the text short for any other player,
 * a leading U+FEFF is read as a byte order mark and vanishes, and half of a surrogate pair has no UTF-16 form another
 * player could read: it becomes the replacement character.
 */
export const storableText = (text: string): string =>
  text
    .replace(/\0/g, '')
    .replace(/^﻿+/, '')
    .replace(/[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/g, '�')

function encodeTextBody(raw: string): number[] {
  const text = storableText(raw)
  if ([...text].every((c) => c.charCodeAt(0) < 256)) return [0, ...latin1(text)]
  const out = [1, 0xff, 0xfe]
  for (let i = 0; i < text.length; i++) {
    const u = text.charCodeAt(i)
    out.push(u & 0xff, u >> 8)
  }
  return out
}

/** Decode the text of a text frame body (encoding byte first). */
export function decodeTextBody(body: Uint8Array): string {
  const enc = body[0] ?? 0
  const data = body.subarray(1)
  const trim = (s: string) => s.replace(/\0+$/, '')
  if (enc === 0) return trim(ascii(data, 0, data.length))
  if (enc === 3) return trim(new TextDecoder('utf-8').decode(data))
  const big = enc === 2 || (enc === 1 && data[0] === 0xfe && data[1] === 0xff)
  const bom = enc === 1 && (big || (data[0] === 0xff && data[1] === 0xfe))
  return trim(new TextDecoder(big ? 'utf-16be' : 'utf-16le').decode(bom ? data.subarray(2) : data))
}

const textFrame = (id: string, text: string): ParsedFrame => ({ id, flags: 0, body: Uint8Array.from(encodeTextBody(text)) })

function pictureFrame(pic: TagPicture): ParsedFrame {
  // encoding 0, mime, 0, picture type 3 (front cover), empty description, 0, data
  const head = [0, ...latin1(pic.mime), 0, 3, 0]
  const body = new Uint8Array(head.length + pic.data.length)
  body.set(head, 0)
  body.set(pic.data, head.length)
  return { id: 'APIC', flags: 0, body }
}

/** Convert a v2.2 `PIC` frame (3-letter image format) to an `APIC` frame. */
function picToApic(body: Uint8Array): ParsedFrame | null {
  if (body.length < 6) return null
  const fmt = ascii(body, 1, 4).toUpperCase()
  const mime = fmt === 'PNG' ? 'image/png' : fmt === 'JPG' ? 'image/jpeg' : fmt === 'GIF' ? 'image/gif' : fmt.toLowerCase()
  const rest = body.subarray(4)
  const out = new Uint8Array(1 + mime.length + 1 + rest.length)
  out[0] = body[0] ?? 0
  out.set(latin1(mime), 1)
  out.set(rest, 2 + mime.length)
  return { id: 'APIC', flags: 0, body: out }
}

function serializeFrame(f: ParsedFrame, version: 3 | 4): number[] {
  const size = version === 4 ? toSyncsafe(f.body.length) : toU32(f.body.length)
  return [...latin1(f.id), ...size, (f.flags >> 8) & 0xff, f.flags & 0xff, ...f.body]
}

/** Where the audio starts: the length of the leading ID3v2 tag, or 0. */
export const audioOffset = (bytes: Uint8Array): number => parseId3v2(bytes)?.length ?? 0

/** True when the data is MPEG audio (Layer I-III) after an optional ID3v2 tag. */
export function isMp3(bytes: Uint8Array): boolean {
  const start = audioOffset(bytes)
  const stop = Math.min(bytes.length - 1, start + 8192)
  for (let i = start; i < stop; i++) {
    const b1 = bytes[i + 1] ?? 0
    // frame sync: 11 set bits, version not "reserved" (01), layer not "reserved" (00)
    if (bytes[i] === 0xff && (b1 & 0xe0) === 0xe0 && (b1 & 0x18) !== 0x08 && (b1 & 0x06) !== 0) return true
  }
  return false
}

const FIELD_FRAME = { title: 'TIT2', artist: 'TPE1', album: 'TALB' } as const

/**
 * Build the file bytes with the changed fields written into an ID3v2 tag at the start.
 * The tag keeps its major version (v2.4 stays v2.4; v2.2 and "no tag" become v2.3).
 * Frames that cannot be re-serialised verbatim (compressed, encrypted, grouped) are dropped rather than corrupted.
 */
export function rewriteId3(bytes: Uint8Array, changes: TagChanges): Uint8Array<ArrayBuffer> {
  const existing = parseId3v2(bytes)
  const version: 3 | 4 = existing?.version === 4 ? 4 : 3
  const kept: ParsedFrame[] = []
  for (const f of existing?.frames ?? []) {
    const frame = f.id === 'PIC' ? picToApic(f.body) : f
    if (!frame) continue
    if (frame.id === 'TIT2' && changes.title !== undefined) continue
    if (frame.id === 'TPE1' && changes.artist !== undefined) continue
    if (frame.id === 'TALB' && changes.album !== undefined) continue
    if (frame.id === 'APIC' && changes.picture !== undefined) continue
    if (version === 3 && frame.flags & 0x00e0) continue
    if (version === 4 && frame.flags & 0x004c) continue
    kept.push(frame)
  }

  const added: ParsedFrame[] = []
  for (const key of ['title', 'artist', 'album'] as const) {
    const value = changes[key]
    if (value) added.push(textFrame(FIELD_FRAME[key], value))
  }
  if (changes.picture) added.push(pictureFrame(changes.picture))

  const frames = [...added, ...kept].flatMap((f) => serializeFrame(f, version))
  const header = [...latin1('ID3'), version, 0, 0, ...toSyncsafe(frames.length)]
  const audio = bytes.subarray(existing?.length ?? 0)
  const out = new Uint8Array(header.length + frames.length + audio.length)
  out.set(header, 0)
  out.set(frames, header.length)
  out.set(audio, header.length + frames.length)
  return out
}
