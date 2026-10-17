import type { LyricLine, Lyrics } from '../types'

const TS = /\[(\d{1,3}):(\d{1,2})(?:[.:](\d{1,3}))?\]/g
const META = /^\[(ti|ar|al|by|au|length|re|ve|id|la):/i

/** No song has more lines than this; a file that does is not lyrics, and must not become millions of objects. */
export const MAX_LINES = 20_000
/** An offset of more than a day is nonsense (and a number of 400 digits parses to Infinity). */
const MAX_OFFSET_SECONDS = 86_400

/**
 * Parse LRC text (or plain lyrics) into { synced, lines: [{ t, text }] }.
 * Supports multiple timestamps per line, [offset:], and strips enhanced <mm:ss.xx> word tags.
 */
export function parseLrc(text: unknown): Lyrics | null {
  if (!text || typeof text !== 'string') return null
  const out: { t: number; text: string }[] = []
  const plain: LyricLine[] = []
  let offset = 0
  for (const raw of text.split(/\r?\n/)) {
    if (out.length >= MAX_LINES || plain.length >= MAX_LINES) break
    const line = raw.trim()
    if (!line) continue
    const off = line.match(/^\[offset:\s*(-?\d+)\s*\]/i)
    if (off) {
      offset = Math.max(-MAX_OFFSET_SECONDS, Math.min(MAX_OFFSET_SECONDS, parseInt(off[1] ?? '0', 10) / 1000))
      continue
    }
    if (META.test(line)) continue
    const stamps = [...line.matchAll(TS)]
    const body = line.replace(TS, '').replace(/<\d+:\d+(?:[.:]\d+)?>/g, '').trim()
    if (stamps.length) {
      for (const m of stamps) {
        if (out.length >= MAX_LINES) break
        const fraction = m[3]
        const frac = fraction ? parseInt(fraction, 10) / 10 ** fraction.length : 0
        out.push({ t: parseInt(m[1] ?? '0', 10) * 60 + parseInt(m[2] ?? '0', 10) + frac, text: body })
      }
    } else {
      plain.push({ t: null, text: line })
    }
  }
  if (out.length) {
    out.sort((a, b) => a.t - b.t)
    return { synced: true, lines: out.map((l) => ({ ...l, t: Math.max(0, l.t - offset) })) }
  }
  return plain.length ? { synced: false, lines: plain } : null
}

/** Index of the last line whose timestamp is <= time (binary search), or -1. Untimed lines never match. */
export function activeIndex(lines: readonly LyricLine[], time: number): number {
  let lo = 0
  let hi = lines.length - 1
  let ans = -1
  while (lo <= hi) {
    const mid = (lo + hi) >> 1
    const t = lines[mid]?.t
    if (t != null && t <= time) {
      ans = mid
      lo = mid + 1
    } else hi = mid - 1
  }
  return ans
}
