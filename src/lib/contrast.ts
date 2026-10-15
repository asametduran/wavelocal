/** WCAG 2.x colour contrast maths, used to keep text readable on any user-chosen accent colour. */

export type Rgb = readonly [r: number, g: number, b: number]

const HEX = /^#?([0-9a-f]{6})$/i

/** Parse `#rrggbb`; null when the input is not a six-digit hex colour. */
export function parseHex(hex: string): Rgb | null {
  const m = HEX.exec(hex.trim())
  if (!m?.[1]) return null
  const n = parseInt(m[1], 16)
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255]
}

export function toHex([r, g, b]: Rgb): string {
  const part = (v: number) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, '0')
  return `#${part(r)}${part(g)}${part(b)}`
}

const linear = (channel: number): number => {
  const c = channel / 255
  return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4
}

/** Relative luminance (0 = black, 1 = white) as defined by WCAG. */
export function luminance([r, g, b]: Rgb): number {
  return 0.2126 * linear(r) + 0.7152 * linear(g) + 0.0722 * linear(b)
}

/** Contrast ratio between two colours, from 1 (identical) to 21 (black on white). */
export function contrastRatio(a: Rgb, b: Rgb): number {
  const la = luminance(a)
  const lb = luminance(b)
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05)
}

/** WCAG AA thresholds: normal text, large text and non-text user-interface parts. */
export const AA = { text: 4.5, largeText: 3, ui: 3 } as const

/** Surfaces the accent colour is drawn on (the `base`, `panel` and `raised` colours of the Tailwind theme). */
export const SURFACES: readonly Rgb[] = [
  [0x0a, 0x0a, 0x0f],
  [0x12, 0x12, 0x1a],
  [0x1b, 0x1b, 0x27],
]

const BLACK: Rgb = [0, 0, 0]
const WHITE: Rgb = [255, 255, 255]

/** Black or white, whichever reads better on the given background (used for text on accent-coloured buttons). */
export function onColor(background: Rgb): '#000000' | '#ffffff' {
  return contrastRatio(background, BLACK) >= contrastRatio(background, WHITE) ? '#000000' : '#ffffff'
}

const worstOn = (c: Rgb, surfaces: readonly Rgb[]): number => Math.min(...surfaces.map((s) => contrastRatio(c, s)))

/**
 * Lighten a colour (mixing towards white) until it reaches `target` contrast on every surface. A user may pick a
 * near-black accent; as text or a focus ring on the dark theme it would vanish, so the displayed accent is nudged
 * just far enough to be readable and keeps its hue.
 */
export function readableOn(color: Rgb, surfaces: readonly Rgb[] = SURFACES, target: number = AA.text): Rgb {
  if (worstOn(color, surfaces) >= target) return color
  // evaluated on the rounded colour, because that is what ends up on screen
  const toward = (v: number, t: number) => Math.round(v + (255 - v) * t)
  const mix = (t: number): Rgb => [toward(color[0], t), toward(color[1], t), toward(color[2], t)]
  let lo = 0
  let hi = 1
  for (let i = 0; i < 20; i++) {
    const mid = (lo + hi) / 2
    if (worstOn(mix(mid), surfaces) >= target) hi = mid
    else lo = mid
  }
  return mix(hi)
}

export interface AccentTheme {
  /** The accent as it should be drawn (text, rings, fills), guaranteed readable on the dark surfaces. */
  accent: string
  /** Text colour for content placed on a filled accent area. */
  on: string
  /** True when the chosen colour had to be lightened. */
  adjusted: boolean
}

/** Derive the displayed accent and the matching foreground colour from a user-chosen hex colour. */
export function accentTheme(hex: string): AccentTheme | null {
  const rgb = parseHex(hex)
  if (!rgb) return null
  const shown = readableOn(rgb)
  return { accent: toHex(shown), on: onColor(shown), adjusted: shown !== rgb }
}
