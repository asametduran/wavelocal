const TS = /\[(\d{1,3}):(\d{1,2})(?:[.:](\d{1,3}))?\]/g
const META = /^\[(ti|ar|al|by|au|length|re|ve|id|la):/i

/**
 * Parse LRC text (or plain lyrics) into { synced, lines: [{ t, text }] }.
 * Supports multiple timestamps per line, [offset:], and strips enhanced <mm:ss.xx> word tags.
 */
export function parseLrc(text) {
  if (!text || typeof text !== 'string') return null
  const out = []
  const plain = []
  let offset = 0
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim()
    if (!line) continue
    const off = line.match(/^\[offset:\s*(-?\d+)\s*\]/i)
    if (off) {
      offset = parseInt(off[1], 10) / 1000
      continue
    }
    if (META.test(line)) continue
    const stamps = [...line.matchAll(TS)]
    const body = line.replace(TS, '').replace(/<\d+:\d+(?:[.:]\d+)?>/g, '').trim()
    if (stamps.length) {
      for (const m of stamps) {
        const frac = m[3] ? parseInt(m[3], 10) / 10 ** m[3].length : 0
        out.push({ t: parseInt(m[1], 10) * 60 + parseInt(m[2], 10) + frac, text: body })
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

/** Index of the last line whose timestamp is <= time (binary search), or -1. */
export function activeIndex(lines, time) {
  let lo = 0
  let hi = lines.length - 1
  let ans = -1
  while (lo <= hi) {
    const mid = (lo + hi) >> 1
    if (lines[mid].t <= time) {
      ans = mid
      lo = mid + 1
    } else hi = mid - 1
  }
  return ans
}
