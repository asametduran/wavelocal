import { useRef, useState } from 'react'
import type { TouchEvent } from 'react'

export interface SwipeOptions {
  onLeft?: () => void
  onRight?: () => void
  onUp?: () => void
  onDown?: () => void
  /** Minimum travel in px before a gesture counts as a swipe. */
  threshold?: number
  /** Make `dy` follow the finger downward (for drag-to-close sheets). */
  trackDown?: boolean
}

export interface SwipeHandlers {
  onTouchStart: (e: TouchEvent) => void
  onTouchMove: (e: TouchEvent) => void
  onTouchEnd: (e: TouchEvent) => void
  onTouchCancel: () => void
}

interface Point {
  x: number
  y: number
}

/**
 * Touch swipe detection. `dy` follows the finger downward when trackDown is set,
 * so sheets can be dragged closed. Swipes starting on a range slider are ignored.
 */
export function useSwipe({ onLeft, onRight, onUp, onDown, threshold = 70, trackDown = false }: SwipeOptions = {}): {
  dy: number
  handlers: SwipeHandlers
} {
  const start = useRef<Point | null>(null)
  const [dy, setDy] = useState(0)

  const handlers: SwipeHandlers = {
    onTouchStart: (e) => {
      const t0 = e.target
      const t = e.touches[0]
      if ((t0 instanceof HTMLInputElement && t0.type === 'range') || (t0 instanceof Element && t0.closest('[data-noswipe]')) || !t) {
        start.current = null
        return
      }
      start.current = { x: t.clientX, y: t.clientY }
    },
    onTouchMove: (e) => {
      const s = start.current
      const t = e.touches[0]
      if (!trackDown || !s || !t) return
      const d = t.clientY - s.y
      if (d > 0 && d > Math.abs(t.clientX - s.x)) setDy(d)
    },
    onTouchEnd: (e) => {
      const s = start.current
      start.current = null
      setDy(0)
      const t = e.changedTouches[0]
      if (!s || !t) return
      const x = t.clientX - s.x
      const y = t.clientY - s.y
      if (Math.abs(y) > Math.abs(x)) {
        if (y > threshold) onDown?.()
        else if (y < -threshold) onUp?.()
      } else if (x > threshold) onRight?.()
      else if (x < -threshold) onLeft?.()
    },
    onTouchCancel: () => {
      start.current = null
      setDy(0)
    },
  }
  return { dy, handlers }
}
