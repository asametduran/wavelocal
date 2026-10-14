import { useCallback, useEffect, useState } from 'react'

const TV_UA = /smart-?tv|tizen|web0s|webos|netcast|hbbtv|appletv|crkey|aft[a-z]|android tv|bravia|viera|roku|playstation|xbox|vidaa/i
const KEY = 'wl-tv'

function detect() {
  try {
    const q = new URLSearchParams(location.search).get('tv')
    if (q === '1') return true
    if (q === '0') return false
    const saved = localStorage.getItem(KEY)
    if (saved === '1') return true
    if (saved === '0') return false
  } catch {
    /* storage unavailable */
  }
  return TV_UA.test(navigator.userAgent)
}

const visible = (el) => {
  const r = el.getBoundingClientRect()
  if (r.width === 0 || r.height === 0) return false
  const s = getComputedStyle(el)
  return s.visibility !== 'hidden' && s.display !== 'none'
}

function focusables() {
  const modals = document.querySelectorAll('[data-modal="true"]')
  const root = modals.length ? modals[modals.length - 1] : document
  return Array.from(root.querySelectorAll('button:not([disabled]), input:not([hidden]):not([type=hidden]), a[href], [tabindex="0"]')).filter(visible)
}

/** Directional (D-pad) focus: moves focus to the nearest focusable element in the pressed direction. */
function move(dir) {
  const cur = document.activeElement
  const list = focusables()
  if (!list.length) return false
  if (!cur || cur === document.body || !list.includes(cur)) {
    list[0].focus()
    return true
  }
  const o = cur.getBoundingClientRect()
  const ox = o.left + o.width / 2
  const oy = o.top + o.height / 2
  let best = null
  let bestScore = Infinity
  for (const el of list) {
    if (el === cur) continue
    const r = el.getBoundingClientRect()
    const dx = r.left + r.width / 2 - ox
    const dy = r.top + r.height / 2 - oy
    const primary = dir === 'left' ? -dx : dir === 'right' ? dx : dir === 'up' ? -dy : dy
    if (primary <= 1) continue
    const ortho = dir === 'left' || dir === 'right' ? Math.abs(dy) : Math.abs(dx)
    const score = primary + ortho * 2.5
    if (score < bestScore) {
      bestScore = score
      best = el
    }
  }
  if (!best) return false
  best.focus()
  best.scrollIntoView?.({ block: 'nearest', inline: 'nearest' })
  return true
}

export function useTvMode() {
  const [tv, setTvState] = useState(detect)

  useEffect(() => {
    document.documentElement.classList.toggle('tv', tv)
  }, [tv])

  const setTv = useCallback((v) => {
    setTvState((prev) => {
      const nv = typeof v === 'function' ? v(prev) : v
      try {
        localStorage.setItem(KEY, nv ? '1' : '0')
      } catch {
        /* ignore */
      }
      return nv
    })
  }, [])

  // D-pad navigation while in TV mode
  useEffect(() => {
    if (!tv) return
    const dirs = { ArrowLeft: 'left', ArrowRight: 'right', ArrowUp: 'up', ArrowDown: 'down' }
    const onKey = (e) => {
      const dir = dirs[e.key]
      if (!dir || e.ctrlKey || e.metaKey || e.altKey) return
      const el = document.activeElement
      const horizontal = dir === 'left' || dir === 'right'
      // sliders and text fields keep native left/right (scrub value / move caret)
      if (horizontal && el instanceof HTMLInputElement) return
      if (move(dir)) e.preventDefault()
    }
    window.addEventListener('keydown', onKey)
    const t = setTimeout(() => {
      if (document.activeElement === document.body || !document.activeElement) focusables()[0]?.focus()
    }, 150)
    return () => {
      window.removeEventListener('keydown', onKey)
      clearTimeout(t)
    }
  }, [tv])

  return [tv, setTv]
}
