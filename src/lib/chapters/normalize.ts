import type { Chapter, RawChapter } from './types'

/**
 * The one place every source of chapters (ID3 frames, MP4 atoms, Vorbis comments) goes through. What a tag says is untrusted
 * input: starts can be negative or beyond the file, a title can hold control characters, direction overrides that make it
 * read differently from how it is written, or half of a surrogate pair. What comes out is ordered, bounded, clean, and
 * tiles the file from the first chapter's start.
 */

export const MAX_CHAPTERS = 1000
export const MAX_TITLE = 120
/** When the length of the file is not known, a chapter this far in (seven days) is nonsense. */
const MAX_UNKNOWN_START = 7 * 86_400

// zero-width characters, the marks that switch the direction of text, and the byte order mark: removed
const INVISIBLE = /[​-‏‪-‮⁠-⁤⁦-⁩﻿]/g
// control characters (also the C1 ones) and line breaks: a space
const CONTROL = /[\u0000-\u001f\u007f-\u009f]/g
// half of a surrogate pair: nothing can draw it
const LONE_SURROGATE = /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/g

/**
 * `value` as one line fit to show: text only, no look-alike tricks, at most `max` characters (never half of a character that takes
 * two code units). Anything that is not text is empty. Chapter titles and bookmark names both go through this.
 */
export function cleanLine(value: unknown, max: number): string {
  if (typeof value !== 'string') return ''
  const text = value.replace(LONE_SURROGATE, '�').replace(INVISIBLE, '').replace(CONTROL, ' ').replace(/\s+/g, ' ').trim()
  return [...text].slice(0, max).join('').trim()
}

/** A chapter title fit to show: one clean line of at most `MAX_TITLE` characters. */
export const cleanTitle = (value: unknown): string => cleanLine(value, MAX_TITLE)

/**
 * Order the chapters by start, drop those that cannot be reached (before the file, at or after its end, not a time), keep one
 * per start (the one with a title), give each an end (the next one's start; the last ends with the file), clean the titles,
 * name the untitled ones by their place, and keep at most `MAX_CHAPTERS`. `duration` is 0 when the length is not known.
 */
export function normalizeChapters(raw: readonly RawChapter[], duration: number): Chapter[] {
  const known = Number.isFinite(duration) && duration > 0
  const byStart = new Map<number, { start: number; title: string }>()
  for (const entry of raw) {
    const { start, title } = (entry ?? {}) as Partial<RawChapter>
    if (typeof start !== 'number' || !Number.isFinite(start) || start < 0) continue
    if (known ? start >= duration : start > MAX_UNKNOWN_START) continue
    const key = Math.round(start * 1000) // starts within a millisecond of each other are one start
    const clean = cleanTitle(title)
    const seen = byStart.get(key)
    if (!seen) byStart.set(key, { start, title: clean })
    else if (!seen.title && clean) seen.title = clean
  }
  const ordered = [...byStart.values()].sort((a, b) => a.start - b.start).slice(0, MAX_CHAPTERS)
  return ordered.map((chapter, i) => ({
    start: chapter.start,
    end: ordered[i + 1]?.start ?? (known ? duration : chapter.start),
    title: chapter.title || `Chapter ${i + 1}`,
  }))
}
