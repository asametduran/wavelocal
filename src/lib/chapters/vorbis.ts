import { readFlacComments } from '../audio/probe/flac'
import { readOggComments } from '../audio/probe/ogg'
import type { ByteSource } from '../audio/source'
import type { RawChapter } from './types'

/**
 * Chapters from Vorbis comments, the tag format of Ogg Vorbis, Opus and FLAC: `CHAPTER001=00:00:00.000` is a chapter's start
 * and `CHAPTER001NAME=Introduction` its title (podcast tools and ffmpeg write them; `CHAPTER001URL` and the like are ignored).
 * The comments are untrusted input: a time is checked against a strict pattern and the number of chapters is capped.
 */

const MAX_CHAPTERS = 2000
const MAX_TIME_TEXT = 32
const FIELD = /^CHAPTER(\d{1,4})(NAME)?$/

/** `HH:MM:SS.mmm` in seconds; the hours may be left out, and a comma may stand for the point. Null for anything that is not a time. */
export function parseChapterTime(text: string): number | null {
  if (text.length > MAX_TIME_TEXT) return null
  const match = /^(?:(\d{1,3}):)?(\d{1,2}):(\d{1,2})(?:[.,](\d{1,9}))?$/.exec(text.trim())
  if (!match) return null
  const [, hours, minutes, seconds, fraction] = match
  if (Number(minutes) > 59 || Number(seconds) > 59) return null
  return Number(hours ?? 0) * 3600 + Number(minutes) * 60 + Number(seconds) + (fraction ? Number(`0.${fraction}`) : 0)
}

/** The chapters named by comment fields (`[NAME, value]` pairs, in the order the file has them). */
export function chaptersFromComments(fields: readonly (readonly [string, string])[]): RawChapter[] {
  const starts = new Map<number, number>()
  const titles = new Map<number, string>()
  for (const [field, value] of fields) {
    const match = FIELD.exec(field.toUpperCase())
    if (!match) continue
    const number = Number(match[1])
    if (match[2]) {
      if (!titles.has(number)) titles.set(number, value)
    } else if (!starts.has(number)) {
      const start = parseChapterTime(value)
      if (start !== null) starts.set(number, start)
    }
  }
  return [...starts].slice(0, MAX_CHAPTERS).map(([number, start]) => ({ start, title: titles.get(number) ?? '' }))
}

export async function readOggChapters(source: ByteSource): Promise<RawChapter[]> {
  return chaptersFromComments((await readOggComments(source))?.fields ?? [])
}

export async function readFlacChapters(source: ByteSource): Promise<RawChapter[]> {
  return chaptersFromComments((await readFlacComments(source))?.fields ?? [])
}
