// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { barCount, barsFor, paintBars } from './draw'
import type { PaintTarget } from './draw'
import type { Peaks } from './types'

const peaks = (peak: number[], rms: number[] = peak.map(() => 0)): Peaks => ({ v: 1, duration: 10, length: peak.length, peak: Uint8Array.from(peak), rms: Uint8Array.from(rms) })

describe('barCount', () => {
  it('fits as many bars of 2 px with a 1 px gap as the width holds, with no gap after the last', () => {
    expect(barCount(100)).toBe(33) // 33 bars take 33 * 3 - 1 = 98 px
    expect(barCount(2)).toBe(1)
    expect(barCount(1)).toBe(0)
  })

  it('is zero for a width that is not a width', () => {
    expect(barCount(0)).toBe(0)
    expect(barCount(-50)).toBe(0)
    expect(barCount(Number.NaN)).toBe(0)
    expect(barCount(Number.POSITIVE_INFINITY)).toBe(0)
  })
})

describe('barsFor', () => {
  it('lays the bars out from the left edge and keeps them inside the width', () => {
    const bars = barsFor(peaks([100, 100]), 100)
    expect(bars).toHaveLength(33)
    expect(bars[0]?.x).toBe(0)
    expect(bars[1]?.x).toBe(3)
    expect((bars.at(-1)?.x ?? 0) + 2).toBeLessThanOrEqual(100)
  })

  it('takes the loudest slice under a bar when several slices share one, so a short loud sound is never smoothed away', () => {
    // 4 slices, 2 bars (width 5): the bars are slices 0-1 and slices 2-3
    const bars = barsFor(peaks([10, 255, 30, 40], [1, 2, 3, 51]), 5)
    expect(bars.map((b) => b.peak)).toEqual([1, 40 / 255])
    expect(bars.map((b) => b.rms)).toEqual([2 / 255, 51 / 255])
  })

  it('repeats a slice across the bars it covers when there are fewer slices than bars', () => {
    // 2 slices, 4 bars (width 11)
    const bars = barsFor(peaks([51, 255]), 11)
    expect(bars.map((b) => b.peak)).toEqual([51 / 255, 51 / 255, 1, 1])
  })

  it('draws a quiet, flat placeholder while there is no waveform yet, the same size for every bar', () => {
    const bars = barsFor(null, 100)
    expect(bars).toHaveLength(33)
    expect(new Set(bars.map((b) => b.peak)).size).toBe(1)
    expect(bars[0]?.peak).toBeGreaterThan(0)
    expect(bars[0]?.peak).toBeLessThan(0.15)
    expect(bars[0]?.rms).toBeLessThanOrEqual(bars[0]?.peak ?? 0)
  })

  it('has no bars for no width', () => {
    expect(barsFor(peaks([1, 2, 3]), 0)).toEqual([])
    expect(barsFor(null, 0)).toEqual([])
  })
})

/** Records the rectangles painted and the colour each was painted in. */
function recorder() {
  const log: string[] = []
  let fill: PaintTarget['fillStyle'] = ''
  const target: PaintTarget = {
    get fillStyle() {
      return fill
    },
    set fillStyle(value) {
      fill = value
    },
    clearRect: (x, y, w, h) => log.push(`clear ${x},${y} ${w}x${h}`),
    fillRect: (x, y, w, h) => log.push(`${String(fill)} ${x},${y} ${w}x${h}`),
  }
  return { target, log }
}

describe('paintBars', () => {
  const palette = { peak: 'outer', body: 'inner' }

  it('clears the canvas, then paints each bar mirrored about the middle: the peak outline, with the RMS body inside it', () => {
    const { target, log } = recorder()
    paintBars(target, [{ x: 0, peak: 1, rms: 0.5 }], 10, 40, palette)
    expect(log).toEqual(['clear 0,0 10x40', 'outer 0,0 2x40', 'inner 0,10 2x20'])
  })

  it('keeps even a silent bar visible as a thin line, so the bar never looks broken', () => {
    const { target, log } = recorder()
    paintBars(target, [{ x: 6, peak: 0, rms: 0 }], 10, 40, palette)
    expect(log).toEqual(['clear 0,0 10x40', 'outer 6,19 2x2', 'inner 6,19 2x2'])
  })

  it('never lets the body be taller than the outline, and never lets a bar be taller than the canvas', () => {
    const { target, log } = recorder()
    paintBars(target, [{ x: 0, peak: 0.25, rms: 0.9 }, { x: 3, peak: 7, rms: 7 }], 10, 40, palette)
    expect(log).toEqual(['clear 0,0 10x40', 'outer 0,15 2x10', 'inner 0,15 2x10', 'outer 3,0 2x40', 'inner 3,0 2x40'])
  })

  it('rounds every height to an even number of pixels, so the top and the bottom match', () => {
    const { target, log } = recorder()
    paintBars(target, [{ x: 0, peak: 0.51, rms: 0.3 }], 10, 40, palette)
    const heights = log.slice(1).map((entry) => Number(entry.split('x')[1]))
    expect(heights.every((h) => h % 2 === 0)).toBe(true)
  })
})
