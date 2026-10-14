import { useRef, useState } from 'react'

/**
 * Touch swipe detection. `dy` follows the finger downward when trackDown is set,
 * so sheets can be dragged closed. Swipes starting on a range slider are ignored.
 */
export function useSwipe({ onLeft, onRight, onUp, onDown, threshold = 70, trackDown = false } = {}) {
  const start = useRef(null)
  const [dy, setDy] = useState(0)

  const handlers = {
    onTouchStart: (e) => {
      const t0 = e.target
      if ((t0 instanceof HTMLInputElement && t0.type === 'range') || (t0 instanceof Element && t0.closest('[data-noswipe]'))) {
        start.current = null
        return
      }
      const t = e.touches[0]
      start.current = { x: t.clientX, y: t.clientY }
    },
    onTouchMove: (e) => {
      if (!trackDown || !start.current) return
      const t = e.touches[0]
      const d = t.clientY - start.current.y
      if (d > 0 && d > Math.abs(t.clientX - start.current.x)) setDy(d)
    },
    onTouchEnd: (e) => {
      const s = start.current
      start.current = null
      setDy(0)
      if (!s) return
      const t = e.changedTouches[0]
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
