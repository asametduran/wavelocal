import type { DescribedError } from './types'

/**
 * Making what an error says fit to be kept in the log and copied into a report that a person may send to someone. A message can carry
 * what the person owns: the name of a file the browser could not read, a path, a link to a blob, a tag. So the app writes no names into
 * its own messages, and what the browser writes is cleaned here: quoted text, links, paths, anything that ends like an audio, text or
 * picture file, e-mail addresses and long numbers or codes are replaced by a word in angle brackets, and what is left is cut short.
 *
 * It errs towards removing too much (a whole phrase up to the file name goes, not only the name). What it cannot know is a name with no
 * quotes and no extension in the middle of a sentence; no such message is written by the app, and the report is shown before it is copied.
 */

export const MAX_MESSAGE = 300
export const MAX_NAME = 60
export const MAX_FRAMES = 12
export const MAX_FRAME = 160
/** Longer text is cut before it is looked at, so that a huge message cannot make the log slow. */
const MAX_INPUT = 2000

const EXTENSIONS = 'mp3|m4a|m4b|aac|flac|ogg|oga|opus|wav|wave|aif|aiff|wma|mp4|webm|mka|mkv|avi|mov|lrc|m3u8?|pls|cue|txt|json|jpe?g|png|gif|webp|bmp|svg|pdf|zip'

/** The quote that closes the one that opened. */
const CLOSING: Readonly<Record<string, string>> = {
  '"': '"',
  '`': '`',
  "'": "'",
  '“': '”',
  '„': '”',
  '‘': '’',
  '«': '»',
  '‹': '›',
}

const wordCharacter = /[\p{L}\p{N}]/u
const space = /\s/
const isWordChar = (ch: string | undefined): boolean => ch !== undefined && wordCharacter.test(ch)

/** A single quote opens only where a word could start ("don't" and "users'" are not quotes). */
function opens(chars: readonly string[], at: number): boolean {
  const ch = chars[at]
  if (ch !== "'" && ch !== '‘') return true
  const next = chars[at + 1]
  return !isWordChar(chars[at - 1]) && next !== undefined && !space.test(next)
}

function closes(chars: readonly string[], at: number, closing: string): boolean {
  if (closing !== "'" && closing !== '’') return true
  const before = chars[at - 1]
  return before !== undefined && !space.test(before) && !(isWordChar(before) && isWordChar(chars[at + 1]))
}

/** Everything between a quote and the one that closes it, quotes included, becomes `<text>`; a quote that never closes takes the rest with it. */
function maskQuoted(input: string): string {
  const chars = Array.from(input)
  let out = ''
  for (let i = 0; i < chars.length; i++) {
    const ch = chars[i] as string
    const closing = CLOSING[ch]
    if (closing === undefined || !opens(chars, i)) {
      out += ch
      continue
    }
    let end = -1
    for (let j = i + 1; j < chars.length; j++) {
      if (chars[j] === closing && closes(chars, j, closing)) {
        end = j
        break
      }
    }
    out += '<text>'
    if (end < 0) break
    i = end
  }
  return out
}

const URL_RE = /\b[a-z][a-z0-9+.-]{1,20}:\/\/\S*|\b(?:blob|data|file|javascript|mailto|about|view-source):\S*/gi
/** From the drive to the end of the line: a folder or file name may hold spaces and any character, so nothing short of the end can be told from it. */
const WINDOWS_PATH_RE = /\b[a-z]:[\\/][^\n]*/gi
/** From a word that holds a separator to the next colon or semicolon (or the end of the line). */
const PATH_RE = /[^\s:;]*[\\/][^\n:;]*/g
/** The characters a file name's phrase cannot run across (what a message puts before a name, such as a colon, ends it). */
const NAME_STOPS = '\\n:;<>|=\\\\/'
const FILE_RE = new RegExp(`(?:[^\\s${NAME_STOPS}][^${NAME_STOPS}]*)?\\.(?:${EXTENSIONS})\\b`, 'gi')
const EMAIL_RE = /[^\s@<>"'()]+@[^\s@<>"'()]+\.[^\s@<>"'()]+/g
/** Hashes, ids (a UUID is 36 of these with its hyphens) and encoded data: nothing in a sentence is this long without a space. */
const LONG_TOKEN_RE = /[A-Za-z0-9_+-]{24,}/g
const DIGITS_RE = /\d{6,}/g
const CONTROL_RE = /[\p{Cc}\p{Zl}\p{Zp}]+/gu

/** `text` cut to `max` characters (whole characters, with an ellipsis). */
export function clip(text: string, max: number): string {
  const chars = Array.from(text)
  return chars.length > max ? `${chars.slice(0, Math.max(0, max - 1)).join('')}…` : text
}

/** What an error said, fit to be kept and copied (see the top of this file). Never throws. */
export function redact(text: string, max = MAX_MESSAGE): string {
  const masked = maskQuoted(text.slice(0, MAX_INPUT))
    .replace(URL_RE, '<url>')
    .replace(WINDOWS_PATH_RE, '<path>')
    .replace(PATH_RE, '<path>')
    .replace(FILE_RE, '<file>')
    .replace(EMAIL_RE, '<email>')
    .replace(LONG_TOKEN_RE, '<id>')
    .replace(DIGITS_RE, '<n>')
  return clip(masked.replace(CONTROL_RE, ' ').replace(/\s+/g, ' ').trim(), max)
}

/** An error's name if it looks like one (`QuotaExceededError`, `TypeError`), otherwise plain `Error`. */
export function cleanName(name: unknown): string {
  return typeof name === 'string' && /^[A-Za-z][\w.$-]{0,59}$/.test(name) ? name : 'Error'
}

const LOCATION_RE = /([\w.-]+\.(?:m?js|tsx?))(?:\?[^\s:)]*)?:(\d+)(?::(\d+))?\)?\s*$/i
const FUNCTION_RE = /^[\w$.<>[\] -]{1,60}$/

/** One line of a stack as `function (file.js:line:column)`, or null when it is not a place in the app's own code. */
function cleanFrame(line: string): string | null {
  const text = line.trim()
  const where = LOCATION_RE.exec(text)
  if (!where || text.includes('-extension://')) return null
  const before = text.slice(0, where.index)
  // Chrome and Edge: "at name (link)" or "at link"; Firefox and Safari: "name@link"
  let name = ''
  if (/^at\s/.test(text)) name = before.replace(/^at\s+/, '').replace(/\s*\(?[^\s()]*$/, '').trim()
  else if (before.includes('@')) name = before.slice(0, before.indexOf('@')).trim()
  const location = `${where[1]}:${where[2]}:${where[3] ?? '0'}`
  return clip(FUNCTION_RE.test(name) ? `${name} (${location})` : location, MAX_FRAME)
}

/** The places in the app's code a stack passes through: names of functions and of built files, never links, at most `MAX_FRAMES`. */
export function cleanFrames(stack: unknown): string[] {
  if (typeof stack !== 'string') return []
  const frames: string[] = []
  for (const line of stack.slice(0, 20_000).split('\n')) {
    const frame = cleanFrame(line)
    if (frame) frames.push(frame)
    if (frames.length >= MAX_FRAMES) break
  }
  return frames
}

function describeValue(value: unknown): string {
  if (typeof value === 'object' && value !== null) {
    try {
      return JSON.stringify(value) ?? Object.prototype.toString.call(value)
    } catch {
      return Object.prototype.toString.call(value)
    }
  }
  return String(value)
}

/** Any thrown or rejected value as the log keeps it: a clean name, a redacted message and the places in the code. Never throws. */
export function describeError(error: unknown): DescribedError {
  try {
    if (typeof error === 'object' && error !== null) {
      const { name, message, stack } = error as { name?: unknown; message?: unknown; stack?: unknown }
      if (typeof message === 'string' || typeof stack === 'string') {
        return { name: cleanName(name), message: redact(typeof message === 'string' ? message : ''), frames: cleanFrames(stack) }
      }
    }
    return { name: 'Error', message: redact(describeValue(error)), frames: [] }
  } catch {
    return { name: 'Error', message: '', frames: [] }
  }
}
