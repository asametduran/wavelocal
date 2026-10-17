import { ascii, be24, be32, synchsafe } from '../source'
import type { ByteSource } from '../source'

const MAX_TAGS = 4

/**
 * Where the audio starts: the offset after any ID3v2 tags (with their padding and footers) at the beginning of a file.
 * MP3, FLAC and AAC files all may be prefixed with one. Never past the end of the file.
 */
export async function skipId3v2(source: ByteSource): Promise<number> {
  let pos = 0
  for (let i = 0; i < MAX_TAGS; i++) {
    const head = await source.read(pos, 10)
    if (head.length < 10 || ascii(head, 0, 3) !== 'ID3' || (head[3] ?? 0xff) === 0xff || (head[4] ?? 0xff) === 0xff) break
    if (((head[6] ?? 0) | (head[7] ?? 0) | (head[8] ?? 0) | (head[9] ?? 0)) & 0x80) break // sizes are made of seven-bit bytes
    pos += 10 + synchsafe(head, 6) + ((head[5] ?? 0) & 0x10 ? 10 : 0)
    if (pos >= source.size) return source.size
  }
  return pos
}

// ---- raw text frames -----------------------------------------------------------------------------------------------

const MAX_FRAMES = 200
/** The beginning of the tag is read in one go: the text frames nearly always sit in front of any artwork. */
const FIRST_READ = 16 * 1024
const MAX_TEXT_BYTES = 8192

const latin1 = new TextDecoder('windows-1252')
const utf8 = new TextDecoder('utf-8')

/** The text of an ID3 text-frame body (an encoding byte, then the text); '' when it is empty. Also used by the chapter reader. */
export function decodeText(b: Uint8Array): string {
  if (b.length < 2) return ''
  const encoding = b[0]
  let data = b.subarray(1)
  let text: string
  if (encoding === 1 || encoding === 2) {
    let bigEndian = encoding === 2
    if (encoding === 1 && data.length >= 2) {
      if (data[0] === 0xfe && data[1] === 0xff) {
        bigEndian = true
        data = data.subarray(2)
      } else if (data[0] === 0xff && data[1] === 0xfe) {
        data = data.subarray(2)
      }
    }
    text = new TextDecoder(bigEndian ? 'utf-16be' : 'utf-16le').decode(data)
  } else {
    text = (encoding === 3 ? utf8 : latin1).decode(data)
  }
  const cleaned = text.replace(/\u0000+$/, '')
  return cleaned.trim() ? cleaned : ''
}

/** Undo frame-level unsynchronisation (v2.4): FF 00 stands for FF. */
export function deunsync(b: Uint8Array): Uint8Array {
  const out: number[] = []
  for (let i = 0; i < b.length; i++) {
    out.push(b[i] ?? 0)
    if (b[i] === 0xff && b[i + 1] === 0x00) i++
  }
  return Uint8Array.from(out)
}

/**
 * The raw text of the first frame of each wanted id (`TCON`, `TCO`, ...) read straight from an ID3v2 tag of version 2.2,
 * 2.3 or 2.4. jsmediatags cleans some of these on the way (it strips the numeric reference from a genre such as
 * "(13)", leaving nothing), so the library reads those itself. Only frame headers are walked: artwork is hopped over,
 * never read. Compressed and encrypted frames, and tags that are unsynchronised as a whole, are left out.
 */
export async function readId3Text(source: ByteSource, ids: readonly string[]): Promise<Map<string, string>> {
  const out = new Map<string, string>()
  const wanted = new Set(ids)
  const head = await source.read(0, FIRST_READ)
  if (head.length < 10 || ascii(head, 0, 3) !== 'ID3') return out
  const version = head[3] ?? 0
  const flags = head[5] ?? 0
  if (version < 2 || version > 4 || flags & 0x80 || ((head[6] ?? 0) | (head[7] ?? 0) | (head[8] ?? 0) | (head[9] ?? 0)) & 0x80) return out

  const tagEnd = Math.min(source.size, 10 + synchsafe(head, 6))
  let pos = 10
  if (flags & 0x40 && version >= 3) pos += version === 4 ? synchsafe(head, 10) : 4 + be32(head, 10) // extended header
  const idLength = version === 2 ? 3 : 4
  const headerLength = version === 2 ? 6 : 10
  const at = async (offset: number, length: number): Promise<Uint8Array> => (offset + length <= head.length ? head.subarray(offset, offset + length) : source.read(offset, length))

  for (let i = 0; i < MAX_FRAMES && pos + headerLength <= tagEnd && out.size < wanted.size; i++) {
    const h = await at(pos, headerLength)
    if (h.length < headerLength || (h[0] ?? 0) === 0) break // padding
    const id = ascii(h, 0, idLength)
    const size = version === 2 ? be24(h, 3) : version === 4 ? synchsafe(h, 4) : be32(h, 4)
    const body = pos + headerLength
    if (size === 0 || body + size > tagEnd) break
    if (wanted.has(id) && !out.has(id) && size <= MAX_TEXT_BYTES) {
      const format = h[9] ?? 0
      const unreadable = version === 3 ? (format & 0xc0) !== 0 : version === 4 ? (format & 0x0c) !== 0 : false // compressed or encrypted
      if (!unreadable) {
        let data = await at(body, size)
        if (version === 4 && format & 0x02) data = deunsync(data)
        if (version === 4 && format & 0x01) data = data.subarray(4) // data length indicator
        const text = decodeText(data)
        if (text) out.set(id, text)
      }
    }
    pos = body + size
  }
  return out
}
