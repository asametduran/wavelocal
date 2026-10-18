/**
 * A name a file can be given on the device and handed to any app: the characters that separate folders, the control characters and
 * the punctuation that Windows and most apps refuse become `_`, no leading or trailing dots or spaces, and at most `MAX_BYTES` of
 * UTF-8 (a component of an Android path may hold 255) cut at a whole character with a short extension kept. Never empty.
 */

export const MAX_BYTES = 200
/** An extension longer than this is a sentence with a dot in it, not an extension. */
const MAX_EXTENSION = 12
/** Separators, control and format characters, line and paragraph separators, lone surrogates, and what Windows refuses. */
const FORBIDDEN = /[\\/:*?"<>|\p{Cc}\p{Cf}\p{Cs}\p{Zl}\p{Zp}]/gu

const encoder = new TextEncoder()
const bytes = (text: string): number => encoder.encode(text).length

/** `text` cut to at most `max` bytes of UTF-8, at a whole character. */
function cutBytes(text: string, max: number): string {
  let out = ''
  let used = 0
  for (const char of text) {
    const size = bytes(char)
    if (used + size > max) break
    out += char
    used += size
  }
  return out
}

const trimEnds = (text: string): string => text.replace(/^[.\s]+/u, '').replace(/[.\s]+$/u, '')

/** `fallback` is what stands in for a name with nothing left of it (a stem: an extension that was all there was is kept after it). */
export function safeFileName(name: string, fallback = 'file'): string {
  const plain = name.replace(FORBIDDEN, '_').replace(/\s+/gu, ' ')
  const cleaned = trimEnds(plain)
  // ".m3u8" is all extension: it is kept, because the share sheet gives the file the type its extension says
  const extension = new RegExp(`\\.([^.\\s]{1,${MAX_EXTENSION}})$`, 'u').exec(plain)?.[1]
  if (extension !== undefined && !cleaned.endsWith(`.${extension}`)) return `${fallback}.${extension}`
  if (!cleaned) return fallback
  if (bytes(cleaned) <= MAX_BYTES) return cleaned
  const dot = cleaned.lastIndexOf('.')
  const tail = dot > 0 && cleaned.length - dot <= MAX_EXTENSION ? cleaned.slice(dot) : ''
  // what is cut starts with the first character of `cleaned`, which is neither a dot nor a space, so something is always left
  return `${trimEnds(cutBytes(tail ? cleaned.slice(0, dot) : cleaned, MAX_BYTES - bytes(tail)))}${tail}`
}
