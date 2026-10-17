import type { Peaks } from './types'

/**
 * The geometry of the waveform bar, apart from the canvas: which slice of the track each bar shows and where its rectangles
 * go. The component only has to give these a real canvas and the colours of the page, so the shape of what is drawn is
 * tested here with a recording stand-in (jsdom has no canvas).
 */

export const BAR_WIDTH = 2
export const BAR_GAP = 1
/** The height of a bar with nothing to show: a thin line, so the bar never looks broken. */
const MIN_BAR = 2
/** The height of the placeholder drawn while the waveform is being measured, as a fraction of the bar. */
const PLACEHOLDER = 0.08

/** One bar: its left edge in pixels, and how loud the slice under it is (0 to 1). */
export interface Bar {
  x: number
  peak: number
  rms: number
}

/** How many bars fit in `width` pixels (no gap after the last). */
export function barCount(width: number, barWidth: number = BAR_WIDTH, gap: number = BAR_GAP): number {
  return Number.isFinite(width) && width > 0 ? Math.max(0, Math.floor((width + gap) / (barWidth + gap))) : 0
}

/**
 * The bars for a track: each takes the loudest of the slices that fall under it (so a short loud sound is not smoothed away),
 * and a slice wider than a bar is repeated across the bars it covers. With no waveform yet the bars are a quiet, even placeholder.
 */
export function barsFor(peaks: Peaks | null, width: number, barWidth: number = BAR_WIDTH, gap: number = BAR_GAP): Bar[] {
  const n = barCount(width, barWidth, gap)
  return Array.from({ length: n }, (_, i): Bar => {
    const x = i * (barWidth + gap)
    if (!peaks) return { x, peak: PLACEHOLDER, rms: PLACEHOLDER / 2 }
    const from = Math.floor((i * peaks.length) / n)
    const to = Math.max(from + 1, Math.ceil(((i + 1) * peaks.length) / n))
    let peak = 0
    let rms = 0
    for (let j = from; j < to && j < peaks.length; j++) {
      peak = Math.max(peak, (peaks.peak[j] ?? 0) / 255)
      rms = Math.max(rms, (peaks.rms[j] ?? 0) / 255)
    }
    return { x, peak, rms }
  })
}

/** The part of a canvas context that painting needs. */
export interface PaintTarget {
  fillStyle: string | CanvasGradient | CanvasPattern
  clearRect(x: number, y: number, width: number, height: number): void
  fillRect(x: number, y: number, width: number, height: number): void
}

export interface Palette {
  /** The outline: the loudest sample of each slice. */
  peak: string
  /** The body inside it: the RMS level. */
  body: string
}

/** An even number of pixels for a fraction of the height, so a bar is symmetrical about the middle line. */
const evenHeight = (fraction: number, height: number): number => Math.min(height, Math.max(MIN_BAR, 2 * Math.round((Math.max(0, Math.min(1, fraction)) * height) / 2)))

/** Paint `bars` mirrored about the middle of a canvas of `width` x `height` pixels (clearing it first). */
export function paintBars(ctx: PaintTarget, bars: readonly Bar[], width: number, height: number, palette: Palette, barWidth: number = BAR_WIDTH): void {
  ctx.clearRect(0, 0, width, height)
  for (const bar of bars) {
    const outer = evenHeight(bar.peak, height)
    const inner = Math.min(outer, evenHeight(bar.rms, height))
    ctx.fillStyle = palette.peak
    ctx.fillRect(bar.x, (height - outer) / 2, barWidth, outer)
    ctx.fillStyle = palette.body
    ctx.fillRect(bar.x, (height - inner) / 2, barWidth, inner)
  }
}
