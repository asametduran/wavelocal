import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { KeyboardEvent, ReactNode, UIEvent } from 'react'
import { gridTarget, visibleRows } from '../lib/grid'

export interface GridLayout {
  columns: number
  /** Width of one card, in px. */
  cell: number
  /** Height of a row including the gap below it, in px. */
  rowHeight: number
}

/** Where a grid was when a page was opened from it, so closing the page puts the reader back. */
export interface GridRestore {
  scrollTop: number
  focusKey: string | null
}

interface VirtualGridProps<T> {
  items: readonly T[]
  itemKey: (item: T) => string
  /** Columns and sizes for a list this wide, in px. */
  layout: (width: number) => GridLayout
  /** Space between the columns, in px. */
  gap: number
  /** The list's accessible name. */
  label: string
  /** One card. Its main control needs `data-main` and `tabIndex` from the slot, so keyboard navigation can find and rove it. */
  renderItem: (item: T, slot: { index: number; tabIndex: 0 | -1; cell: number }) => ReactNode
  /** Shown when there are no items. */
  empty: ReactNode
  restore?: GridRestore
  onScroll?: (scrollTop: number) => void
  /** Scroll to the item with this key and focus it; a new `nonce` asks again. */
  reveal?: { key: string; nonce: number } | null
}

/**
 * A scrolling grid of cards that renders only the rows in view, so thousands of albums stay smooth. One card at a time is
 * in the Tab order; arrow keys, Home/End and PageUp/PageDown move between cards (and keys pressed on a card's own
 * buttons stay with those buttons). A grid of one column is a plain list.
 */
export default function VirtualGrid<T>({ items, itemKey, layout, gap, label, renderItem, empty, restore, onScroll, reveal }: VirtualGridProps<T>) {
  const scroller = useRef<HTMLDivElement>(null)
  const list = useRef<HTMLUListElement>(null)
  const [size, setSize] = useState({ width: 0, height: 0 })
  const [scrollTop, setScrollTop] = useState(0)
  const restoreAt = restore?.focusKey ? items.findIndex((it) => itemKey(it) === restore.focusKey) : -1
  const [active, setActive] = useState(Math.max(0, restoreAt))
  const [wantFocus, setWantFocus] = useState(false)
  const restored = useRef(false)

  // measure before the first paint, then follow the container
  useLayoutEffect(() => {
    const sc = scroller.current
    const ul = list.current
    if (!sc || !ul) return undefined
    const measure = () =>
      setSize((s) => {
        const next = { width: ul.clientWidth, height: sc.clientHeight }
        return s.width === next.width && s.height === next.height ? s : next
      })
    measure()
    const ro = new ResizeObserver(measure)
    ro.observe(sc)
    ro.observe(ul)
    return () => ro.disconnect()
  }, [])

  const { columns, cell, rowHeight } = layout(size.width)
  const rowCount = Math.ceil(items.length / columns)
  const rows = visibleRows(scrollTop, size.height, rowHeight, rowCount, 2)
  const first = rows.start * columns
  const last = Math.min(items.length, rows.end * columns)
  const current = Math.min(active, Math.max(0, items.length - 1))
  // the card in the Tab order must be on screen, or the grid could not be entered from the keyboard
  const tabbable = current >= first && current < last ? current : first

  // come back to where the reader was, once the layout is known
  useLayoutEffect(() => {
    if (restored.current || !restore || size.width <= 0) return
    restored.current = true
    const sc = scroller.current
    if (sc) {
      sc.scrollTop = restore.scrollTop
      setScrollTop(sc.scrollTop)
    }
    if (restoreAt >= 0) setWantFocus(true)
  }, [size.width, restore, restoreAt])

  useLayoutEffect(() => {
    if (!wantFocus) return
    setWantFocus(false)
    list.current?.querySelector<HTMLElement>(`[data-index="${tabbable}"] [data-main]`)?.focus()
  }, [wantFocus, tabbable])

  const scrollIntoView = (index: number, centre: boolean) => {
    const sc = scroller.current
    const ul = list.current
    if (!sc || !ul || !(rowHeight > 0)) return
    // the list starts a little below the top of the scroll area (room for a focus ring): rows are measured from there
    const inset = ul.getBoundingClientRect().top - sc.getBoundingClientRect().top + sc.scrollTop
    const top = inset + Math.floor(index / columns) * rowHeight
    if (centre) sc.scrollTop = Math.max(0, top - sc.clientHeight / 2 + rowHeight / 2)
    else if (top < sc.scrollTop) sc.scrollTop = top
    else if (top + rowHeight > sc.scrollTop + sc.clientHeight) sc.scrollTop = top + rowHeight - sc.clientHeight
    setScrollTop(sc.scrollTop)
  }

  const moveTo = (index: number) => {
    setActive(index)
    scrollIntoView(index, false)
    setWantFocus(true)
  }

  useEffect(() => {
    if (!reveal) return
    const index = items.findIndex((it) => itemKey(it) === reveal.key)
    if (index < 0) return
    setActive(index)
    scrollIntoView(index, true)
    setWantFocus(true)
    // a new request, not a change of the items, is what moves the reader
  }, [reveal?.nonce]) // eslint-disable-line react-hooks/exhaustive-deps

  const onKeyDown = (e: KeyboardEvent<HTMLUListElement>) => {
    if (e.altKey || e.ctrlKey || e.metaKey) return
    // keys pressed on a card's own buttons belong to those buttons
    if (!(e.target as HTMLElement).hasAttribute('data-main')) return
    const page = Math.max(1, Math.floor(size.height / Math.max(1, rowHeight)) - 1)
    const to = gridTarget(e.key, current, items.length, columns, page)
    if (to === null) return
    e.preventDefault()
    e.stopPropagation() // TV mode's own D-pad handler would move focus a second time
    moveTo(to)
  }

  return (
    <div
      ref={scroller}
      onScroll={(e: UIEvent<HTMLDivElement>) => {
        setScrollTop(e.currentTarget.scrollTop)
        onScroll?.(e.currentTarget.scrollTop)
      }}
      className="min-h-0 flex-1 overflow-y-auto px-4 pb-3 pt-2 [.tv_&]:pt-4"
    >
      <ul
        ref={list}
        aria-label={label}
        onKeyDown={onKeyDown}
        className="grid"
        style={{ gridTemplateColumns: `repeat(${columns}, minmax(0, 1fr))`, columnGap: gap, paddingTop: rows.start * rowHeight, paddingBottom: Math.max(0, rowCount - rows.end) * rowHeight }}
      >
        {items.slice(first, last).map((item, k) => {
          const index = first + k
          return (
            <li key={itemKey(item)} data-index={index} aria-setsize={items.length} aria-posinset={index + 1} style={{ height: rowHeight, paddingBottom: gap }}>
              {renderItem(item, { index, tabIndex: index === tabbable ? 0 : -1, cell })}
            </li>
          )
        })}
      </ul>
      {!items.length && empty}
    </div>
  )
}
