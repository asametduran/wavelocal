/**
 * Layout maths for the virtualized Albums grid and Artists list: how many cards fit a width, which rows are in view,
 * and where an arrow key moves focus. Pure, so it is tested without a browser.
 */

export interface GridSpec {
  /** Narrowest a card may get, in px. */
  min: number
  /** Space between cards and between rows, in px. */
  gap: number
  /** Height of the text under (or beside) a card, in px. */
  label: number
}

export interface GridMetrics {
  columns: number
  /** Width of a card (its square cover is as tall), in px. */
  cell: number
  /** Height of a row of cards including the gap below it. */
  rowHeight: number
}

const usable = (n: number): number => (Number.isFinite(n) && n > 0 ? n : 0)

/** As many columns as fit, stretched to fill the width exactly. A container that has not been measured yet is one column. */
export function gridMetrics(width: number, { min, gap, label }: GridSpec): GridMetrics {
  const w = usable(width)
  const columns = Math.max(1, Math.floor((w + gap) / (min + gap)))
  const cell = Math.max(0, (w - gap * (columns - 1)) / columns)
  return { columns, cell, rowHeight: cell + label + gap }
}

/** The rows [start, end) to render for a scroll position, with `overscan` extra rows either side. */
export function visibleRows(scrollTop: number, viewHeight: number, rowHeight: number, rowCount: number, overscan = 2): { start: number; end: number } {
  if (rowCount <= 0) return { start: 0, end: 0 }
  // nothing is measured yet: render a handful so the first paint is not empty
  if (!(rowHeight > 0)) return { start: 0, end: Math.min(rowCount, 1 + 2 * overscan) }
  const top = usable(scrollTop)
  const start = Math.max(0, Math.floor(top / rowHeight) - overscan)
  const end = Math.min(rowCount, Math.ceil((top + usable(viewHeight)) / rowHeight) + overscan)
  return { start: Math.min(start, rowCount), end: Math.max(end, start) }
}

/**
 * Where focus goes for a navigation key in a grid of `count` cards in `columns` columns, or null when the key is not
 * one. Stops at the edges (a grid does not wrap); Down from a column that is missing in the last row lands on the last
 * card. `page` is how many rows PageUp/PageDown move.
 */
export function gridTarget(key: string, index: number, count: number, columns: number, page: number): number | null {
  if (count <= 0) return null
  const last = count - 1
  const at = Math.min(Math.max(index, 0), last)
  const cols = Math.max(1, columns)
  const rows = Math.max(1, page)
  const clamp = (n: number): number => Math.min(Math.max(n, 0), last)
  switch (key) {
    case 'ArrowRight':
      return clamp(at + 1)
    case 'ArrowLeft':
      return clamp(at - 1)
    case 'ArrowDown':
      if (at + cols <= last) return at + cols
      return Math.floor(at / cols) === Math.floor(last / cols) ? at : last
    case 'ArrowUp':
      return at - cols >= 0 ? at - cols : at
    case 'PageDown':
      // whole rows, so the column is kept; a short last row lands on its last card
      return Math.min(last, Math.min(Math.floor(last / cols), Math.floor(at / cols) + rows) * cols + (at % cols))
    case 'PageUp':
      return Math.max(0, Math.floor(at / cols) - rows) * cols + (at % cols)
    case 'Home':
      return 0
    case 'End':
      return last
    default:
      return null
  }
}
