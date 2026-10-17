import type { LoopRange } from '../loop'
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

/** The least distance in pixels between two marks: closer ones are one smudge to the eye, so the later one is left out. */
export const MARK_GAP = 4

/**
 * The pixel column of each mark for `times` (seconds, ascending) on a bar `width` pixels wide that shows `duration` seconds.
 * A time that is not on the bar, or that would sit on its first or last column (where it cannot be told from the edge), has no
 * mark, and a mark less than `gap` pixels from the one before it is dropped, so a thousand chapters on a phone stay readable.
 */
export function markPositions(times: readonly number[], duration: number, width: number, gap: number = MARK_GAP): number[] {
  if (!Number.isFinite(duration) || duration <= 0 || !Number.isFinite(width) || width <= 0) return []
  const columns: number[] = []
  for (const time of times) {
    if (!Number.isFinite(time) || time <= 0 || time >= duration) continue
    const x = Math.round((time / duration) * width)
    if (x < 1 || x > width - 1) continue
    const last = columns.at(-1)
    if (last !== undefined && x - last < gap) continue
    columns.push(x)
  }
  return columns
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

export interface RegionPalette {
  /** The shading over the part that repeats. */
  fill: string
  /** The two edges of it. */
  edge: string
}

/**
 * The pixel columns a loop covers on a bar `width` pixels wide that shows `duration` seconds: kept on the bar, and at least two
 * pixels wide so a short loop on a long track can still be seen. Null when there is nothing to draw.
 */
export function regionSpan(loop: LoopRange, duration: number, width: number): { from: number; to: number } | null {
  if (!Number.isFinite(duration) || duration <= 0 || !Number.isFinite(width) || width <= 0) return null
  if (!(loop.b > loop.a) || !Number.isFinite(loop.a) || !Number.isFinite(loop.b)) return null
  const at = (time: number): number => Math.min(width, Math.max(0, Math.round((time / duration) * width)))
  const from = Math.min(at(loop.a), width - 2)
  return { from, to: Math.min(width, Math.max(at(loop.b), from + 2)) }
}

/**
 * The pixel column for the start of a loop whose end is still to come: on the bar, with room for its two pixels (so a start at
 * the very beginning of the track is drawn, where a chapter line never is). Null when there is nothing to draw.
 */
export function startColumn(time: number, duration: number, width: number): number | null {
  if (!Number.isFinite(time) || !Number.isFinite(duration) || duration <= 0 || !Number.isFinite(width) || width < 2) return null
  return Math.min(width - 2, Math.max(0, Math.round((time / duration) * width)))
}

/** Shade the part of the bar that repeats, and draw its two edges (over what is already on the canvas). */
export function paintRegion(ctx: PaintTarget, span: { from: number; to: number }, height: number, palette: RegionPalette): void {
  ctx.fillStyle = palette.fill
  ctx.fillRect(span.from, 0, span.to - span.from, height)
  ctx.fillStyle = palette.edge
  ctx.fillRect(span.from, 0, 2, height)
  ctx.fillRect(span.to - 2, 0, 2, height)
}

/** The start of a loop that has no end yet: a line, with a small flag at the top. */
export function paintStart(ctx: PaintTarget, column: number, height: number, color: string): void {
  ctx.fillStyle = color
  ctx.fillRect(column, 0, 2, height)
  ctx.fillRect(column, 0, 6, 3)
}

/** A small flag pointing down at the top of the bar at each of `columns`: where a bookmark is. Drawn over what is there. */
export function paintFlags(ctx: PaintTarget, columns: readonly number[], color: string): void {
  if (columns.length === 0) return
  ctx.fillStyle = color
  for (const x of columns) for (let row = 0; row < 4; row++) ctx.fillRect(x - 3 + row, row, 7 - 2 * row, 1)
}

/** Paint a thin line over the whole height at each of `columns` (clearing the canvas first): the marks that tell where a chapter begins. */
export function paintMarks(ctx: PaintTarget, columns: readonly number[], width: number, height: number, color: string): void {
  ctx.clearRect(0, 0, width, height)
  ctx.fillStyle = color
  for (const x of columns) ctx.fillRect(x, 0, 1, height)
}
