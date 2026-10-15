/**
 * The tray icon, drawn in code so the repository carries no image files: an accent-coloured disc with a white play
 * triangle, anti-aliased by sampling coverage on a sub-pixel grid. Returns a BGRA bitmap (the byte order Electron's
 * `nativeImage.createFromBitmap` expects on little-endian machines).
 */

const ACCENT = { r: 124, g: 92, b: 255 }
const SAMPLES = 4

/** Fraction (0..1) of the pixel covered by the shape, by supersampling. */
function coverage(px: number, py: number, inside: (x: number, y: number) => boolean): number {
  let hit = 0
  for (let sy = 0; sy < SAMPLES; sy++) for (let sx = 0; sx < SAMPLES; sx++) if (inside(px + (sx + 0.5) / SAMPLES, py + (sy + 0.5) / SAMPLES)) hit++
  return hit / (SAMPLES * SAMPLES)
}

export function renderTrayIcon(size: number): Buffer {
  if (!Number.isInteger(size) || size < 8 || size > 512) throw new RangeError(`unsupported tray icon size ${size}`)
  const c = size / 2
  const radius = size / 2 - size * 0.04
  // an equilateral-ish triangle pointing right, nudged right so it looks optically centred in the disc
  const ax = c - size * 0.12, ay = c - size * 0.22
  const bx = c - size * 0.12, by = c + size * 0.22
  const cx = c + size * 0.24, cy = c
  const disc = (x: number, y: number) => (x - c) ** 2 + (y - c) ** 2 <= radius ** 2
  const triangle = (x: number, y: number) => {
    const d1 = (x - bx) * (ay - by) - (ax - bx) * (y - by)
    const d2 = (x - cx) * (by - cy) - (bx - cx) * (y - cy)
    const d3 = (x - ax) * (cy - ay) - (cx - ax) * (y - ay)
    return !((d1 < 0 || d2 < 0 || d3 < 0) && (d1 > 0 || d2 > 0 || d3 > 0))
  }
  const out = Buffer.alloc(size * size * 4)
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const alpha = coverage(x, y, disc)
      const white = alpha === 0 ? 0 : Math.min(1, coverage(x, y, triangle) / alpha)
      const o = (y * size + x) * 4
      // premultiplied alpha, which is what the platform bitmap format uses
      out[o] = Math.round((ACCENT.b + (255 - ACCENT.b) * white) * alpha)
      out[o + 1] = Math.round((ACCENT.g + (255 - ACCENT.g) * white) * alpha)
      out[o + 2] = Math.round((ACCENT.r + (255 - ACCENT.r) * white) * alpha)
      out[o + 3] = Math.round(alpha * 255)
    }
  }
  return out
}
