import { describe, expect, it } from 'vitest'
import { gridMetrics, gridTarget, visibleRows } from './grid'

const spec = { min: 140, gap: 12, label: 52 }

describe('gridMetrics', () => {
  it('fits as many cards as the width allows and stretches them to fill it', () => {
    const m = gridMetrics(320, spec)
    expect(m.columns).toBe(2)
    expect(m.cell).toBe(154) // (320 - 12) / 2
    expect(m.rowHeight).toBe(154 + 52 + 12)
  })

  it('adds columns as the panel grows', () => {
    expect(gridMetrics(152, spec).columns).toBe(1)
    expect(gridMetrics(292, spec).columns).toBe(2)
    expect(gridMetrics(444, spec).columns).toBe(3)
    expect(gridMetrics(1200, spec).columns).toBe(7)
  })

  it('never lets the cards add up wider than the container', () => {
    for (const width of [152, 300, 333, 389, 640, 1023]) {
      const m = gridMetrics(width, spec)
      expect(m.columns * m.cell + (m.columns - 1) * spec.gap).toBeLessThanOrEqual(width + 1e-9)
    }
  })

  it('still answers sensibly before the container has been measured', () => {
    for (const width of [0, -5, Number.NaN, Number.POSITIVE_INFINITY]) {
      const m = gridMetrics(width, spec)
      expect(m.columns).toBe(1)
      expect(m.cell).toBeGreaterThanOrEqual(0)
      expect(Number.isFinite(m.rowHeight)).toBe(true)
      expect(m.rowHeight).toBeGreaterThan(0)
    }
  })

  it('works for a single full-width list (one column of fixed height)', () => {
    const m = gridMetrics(320, { min: 320, gap: 0, label: 0 })
    expect(m.columns).toBe(1)
    expect(m.cell).toBe(320)
  })
})

describe('visibleRows', () => {
  it('shows the rows in view plus a margin, never past the ends', () => {
    expect(visibleRows(0, 600, 100, 1000, 2)).toEqual({ start: 0, end: 8 })
    expect(visibleRows(1050, 600, 100, 1000, 2)).toEqual({ start: 8, end: 19 })
    expect(visibleRows(99_400, 600, 100, 1000, 2)).toEqual({ start: 992, end: 1000 })
  })

  it('has nothing to show for no rows', () => {
    expect(visibleRows(0, 600, 100, 0, 2)).toEqual({ start: 0, end: 0 })
  })

  it('treats a negative scroll position (rubber banding) as the top', () => {
    expect(visibleRows(-200, 600, 100, 50, 1)).toEqual({ start: 0, end: 7 })
  })

  it('renders a few rows before anything has been measured', () => {
    expect(visibleRows(0, 0, 0, 500, 3)).toEqual({ start: 0, end: 7 })
    expect(visibleRows(0, 600, Number.NaN, 4, 3)).toEqual({ start: 0, end: 4 })
  })
})

describe('gridTarget', () => {
  // 10 items in 3 columns:  0 1 2 / 3 4 5 / 6 7 8 / 9
  const at = (key: string, index: number, columns = 3, count = 10, page = 2) => gridTarget(key, index, count, columns, page)

  it('moves one card sideways and stops at the ends instead of wrapping', () => {
    expect(at('ArrowRight', 4)).toBe(5)
    expect(at('ArrowLeft', 4)).toBe(3)
    expect(at('ArrowLeft', 0)).toBe(0)
    expect(at('ArrowRight', 9)).toBe(9)
  })

  it('moves a whole row up or down', () => {
    expect(at('ArrowDown', 1)).toBe(4)
    expect(at('ArrowUp', 7)).toBe(4)
    expect(at('ArrowUp', 1)).toBe(1)
  })

  it('goes to the last card when the row below is shorter, and stays on the last row', () => {
    expect(at('ArrowDown', 7)).toBe(9)
    expect(at('ArrowDown', 8)).toBe(9)
    expect(at('ArrowDown', 9)).toBe(9)
    expect(at('ArrowDown', 6)).toBe(9)
  })

  it('jumps to the first and last card', () => {
    expect(at('Home', 6)).toBe(0)
    expect(at('End', 2)).toBe(9)
  })

  it('pages by the number of rows in view and keeps the column', () => {
    expect(at('PageDown', 1, 3, 30, 2)).toBe(7)
    expect(at('PageUp', 13, 3, 30, 2)).toBe(7)
    expect(at('PageDown', 25, 3, 30, 2)).toBe(28) // runs out of rows: the last row, same column
    expect(at('PageUp', 4, 3, 30, 2)).toBe(1) // runs out of rows: the first row, same column
    expect(at('PageDown', 28, 3, 30, 2)).toBe(28)
    expect(at('PageUp', 1, 3, 30, 2)).toBe(1)
  })

  it('pages to the very last card of a list, and a short last row ends on its last card', () => {
    expect(gridTarget('PageDown', 28, 30, 1, 5)).toBe(29)
    expect(gridTarget('PageUp', 3, 30, 1, 5)).toBe(0)
    expect(at('PageDown', 8, 3, 10, 5)).toBe(9)
  })

  it('is a plain list when there is one column', () => {
    expect(at('ArrowDown', 3, 1)).toBe(4)
    expect(at('ArrowUp', 3, 1)).toBe(2)
    expect(at('ArrowRight', 3, 1)).toBe(4)
    expect(at('ArrowLeft', 3, 1)).toBe(2)
  })

  it('ignores other keys and empty grids', () => {
    expect(at('Enter', 3)).toBeNull()
    expect(at('a', 3)).toBeNull()
    expect(gridTarget('ArrowDown', 0, 0, 3, 2)).toBeNull()
  })

  it('repairs an index that is out of range', () => {
    expect(gridTarget('ArrowRight', 99, 10, 3, 2)).toBe(9)
    expect(gridTarget('ArrowRight', -4, 10, 3, 2)).toBe(1)
  })
})
