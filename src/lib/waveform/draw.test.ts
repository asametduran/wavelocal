// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { barCount, barsFor, markPositions, MARK_GAP, paintBars, paintFlags, paintMarks, paintRegion, paintStart, regionSpan, startColumn } from './draw'
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

describe('markPositions', () => {
  it('puts a mark at the pixel column of each time', () => {
    expect(markPositions([30, 60, 90], 120, 120)).toEqual([30, 60, 90])
    expect(markPositions([25, 75], 100, 400)).toEqual([100, 300])
  })

  it('has no mark for the very start, for the end or beyond it, or for a time that is not a time', () => {
    expect(markPositions([0, 120, 500, -5, Number.NaN, Number.POSITIVE_INFINITY], 120, 120)).toEqual([])
  })

  it('has no mark where it would sit on the edge of the bar, which a mark on the start or end would be', () => {
    expect(markPositions([10], 10_000, 100)).toEqual([]) // rounds to column 0
    expect(markPositions([9_990], 10_000, 100)).toEqual([]) // rounds to column 100, past the last
    expect(markPositions([5_000], 10_000, 100)).toEqual([50])
  })

  it('drops a mark that is less than the gap from the one before it, so crowded chapters do not make a smudge', () => {
    expect(markPositions([10, 11, 12, 20], 100, 100)).toEqual([10, 20])
    expect(markPositions([10, 14], 100, 100)).toEqual([10, 14]) // exactly the gap apart is kept
    expect(markPositions([10, 13], 100, 100)).toEqual([10])
  })

  it('keeps a thousand chapters readable on a narrow bar: never closer than the gap, never more than fit', () => {
    const times = Array.from({ length: 1000 }, (_, i) => (i + 1) * 3.6)
    const xs = markPositions(times, 3700, 300)
    expect(xs.length).toBeGreaterThan(0)
    expect(xs.length).toBeLessThanOrEqual(Math.floor(300 / MARK_GAP))
    for (let i = 1; i < xs.length; i++) expect((xs[i] ?? 0) - (xs[i - 1] ?? 0)).toBeGreaterThanOrEqual(MARK_GAP)
    expect(xs.every((x) => x >= 1 && x <= 299)).toBe(true)
  })

  it('has nothing to mark on a bar without a width or a length', () => {
    expect(markPositions([5], 10, 0)).toEqual([])
    expect(markPositions([5], 10, Number.NaN)).toEqual([])
    expect(markPositions([5], 0, 100)).toEqual([])
    expect(markPositions([5], Number.NaN, 100)).toEqual([])
    expect(markPositions([], 10, 100)).toEqual([])
  })
})

describe('paintMarks', () => {
  it('clears the canvas, then draws each mark as a thin line over the whole height, in the given colour', () => {
    const { target, log } = recorder()
    paintMarks(target, [10, 40], 100, 36, 'white')
    expect(log).toEqual(['clear 0,0 100x36', 'white 10,0 1x36', 'white 40,0 1x36'])
  })

  it('leaves a canvas with no marks empty', () => {
    const { target, log } = recorder()
    paintMarks(target, [], 100, 36, 'white')
    expect(log).toEqual(['clear 0,0 100x36'])
  })
})

describe('regionSpan', () => {
  it('puts the loop at the pixel columns of its two ends', () => {
    expect(regionSpan({ a: 10, b: 20 }, 100, 200)).toEqual({ from: 20, to: 40 })
    expect(regionSpan({ a: 0, b: 50 }, 100, 300)).toEqual({ from: 0, to: 150 })
  })

  it('keeps the loop on the bar when it reaches past the end of the track or before its start', () => {
    expect(regionSpan({ a: 90, b: 150 }, 100, 200)).toEqual({ from: 180, to: 200 })
    expect(regionSpan({ a: -20, b: 10 }, 100, 200)).toEqual({ from: 0, to: 20 })
  })

  it('is at least two pixels wide, so even a very short loop on a long track can be seen, and stays on the bar', () => {
    expect(regionSpan({ a: 10, b: 10.5 }, 3600, 300)).toEqual({ from: 1, to: 3 })
    expect(regionSpan({ a: 3599, b: 3600 }, 3600, 300)).toEqual({ from: 298, to: 300 })
  })

  it('has no region for a bar or a track without a size, or a loop that is not a loop', () => {
    expect(regionSpan({ a: 10, b: 20 }, 0, 200)).toBeNull()
    expect(regionSpan({ a: 10, b: 20 }, Number.NaN, 200)).toBeNull()
    expect(regionSpan({ a: 10, b: 20 }, 100, 0)).toBeNull()
    expect(regionSpan({ a: 20, b: 10 }, 100, 200)).toBeNull()
    expect(regionSpan({ a: Number.NaN, b: 10 }, 100, 200)).toBeNull()
  })
})

describe('paintRegion', () => {
  it('fills the span and draws a two pixel edge at each end, over the whole height', () => {
    const { target, log } = recorder()
    paintRegion(target, { from: 20, to: 40 }, 36, { fill: 'fill', edge: 'edge' })
    expect(log).toEqual(['fill 20,0 20x36', 'edge 20,0 2x36', 'edge 38,0 2x36'])
  })
})

describe('paintStart', () => {
  it('draws the start of a loop that has no end yet as a line with a small flag at the top', () => {
    const { target, log } = recorder()
    paintStart(target, 50, 36, 'edge')
    expect(log).toEqual(['edge 50,0 2x36', 'edge 50,0 6x3'])
  })
})

describe('paintFlags', () => {
  it('draws a small downward-pointing flag at the top at each column, without clearing what is there', () => {
    const { target, log } = recorder()
    paintFlags(target, [10, 40], 'amber')
    expect(log).toEqual([
      'amber 7,0 7x1',
      'amber 8,1 5x1',
      'amber 9,2 3x1',
      'amber 10,3 1x1',
      'amber 37,0 7x1',
      'amber 38,1 5x1',
      'amber 39,2 3x1',
      'amber 40,3 1x1',
    ])
  })

  it('draws nothing for no flags', () => {
    const { target, log } = recorder()
    paintFlags(target, [], 'amber')
    expect(log).toEqual([])
  })
})

describe('startColumn', () => {
  it('puts the start of a loop at the pixel column of its time', () => {
    expect(startColumn(50, 100, 200)).toBe(100)
    expect(startColumn(25, 100, 300)).toBe(75)
  })

  it('shows a start at the very beginning of the track (a chapter line never is: this one is set by the person)', () => {
    expect(startColumn(0, 100, 200)).toBe(0)
  })

  it('keeps room for the two pixels of the line at the far end, and stays on the bar for a time before or after the track', () => {
    expect(startColumn(100, 100, 200)).toBe(198)
    expect(startColumn(250, 100, 200)).toBe(198)
    expect(startColumn(-5, 100, 200)).toBe(0)
  })

  it('has nothing to draw for a bar or a track without a size, or a time that is not a time', () => {
    expect(startColumn(10, 0, 200)).toBeNull()
    expect(startColumn(10, Number.NaN, 200)).toBeNull()
    expect(startColumn(10, 100, 0)).toBeNull()
    expect(startColumn(10, 100, 1)).toBeNull() // no room for two pixels
    expect(startColumn(Number.NaN, 100, 200)).toBeNull()
    expect(startColumn(Number.POSITIVE_INFINITY, 100, 200)).toBeNull()
  })
})
