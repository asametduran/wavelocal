import { useEffect } from 'react'

const BACK_KEYS = new Set(['Escape', 'GoBack', 'BrowserBack', 'XF86Back'])
const BACK_CODES = new Set([10009, 461]) // Tizen / webOS remotes

/**
 * Global hotkeys. Dedicated media keys always work (TV remotes, keyboards);
 * letter / arrow shortcuts are ignored while typing. In TV mode arrows are left to
 * the D-pad navigator instead of seeking.
 */
export function useHotkeys(p, { focusSearch, onBack, tv, toggleTv, openTools } = {}) {
  useEffect(() => {
    const onKey = (e) => {
      const k = e.key
      const media = {
        MediaPlayPause: () => p.toggle(),
        MediaPlay: () => p.toggle(),
        MediaPause: () => p.toggle(),
        MediaTrackNext: () => p.next(),
        MediaTrackPrevious: () => p.prev(),
        MediaFastForward: () => p.seekBy(10),
        MediaRewind: () => p.seekBy(-10),
        MediaStop: () => p.toggle(),
      }[k]
      if (media) {
        e.preventDefault()
        media()
        return
      }
      if ((BACK_KEYS.has(k) || BACK_CODES.has(e.keyCode)) && onBack?.()) {
        e.preventDefault()
        return
      }

      const el = e.target
      const typing =
        el instanceof HTMLElement &&
        (el.isContentEditable || /^(TEXTAREA|SELECT)$/.test(el.tagName) || (el.tagName === 'INPUT' && el.type !== 'range'))
      if (typing || e.ctrlKey || e.metaKey || e.altKey) return

      const arrows = tv
        ? {}
        : {
            ArrowLeft: () => (e.shiftKey ? p.prev() : p.seekBy(-5)),
            ArrowRight: () => (e.shiftKey ? p.next() : p.seekBy(5)),
            ArrowUp: () => p.volumeBy(0.05),
            ArrowDown: () => p.volumeBy(-0.05),
          }
      const actions = {
        ...arrows,
        ' ': () => p.toggle(),
        m: () => p.toggleMute(),
        s: () => p.toggleShuffle(),
        r: () => p.cycleRepeat(),
        n: () => p.next(),
        p: () => p.prev(),
        '/': () => focusSearch?.(),
        t: () => toggleTv?.(),
        e: () => openTools?.(),
      }
      const fn = actions[k.length === 1 ? k.toLowerCase() : k]
      if (!fn) return
      if (k === ' ' && el instanceof HTMLButtonElement) return // buttons handle their own space
      e.preventDefault()
      fn()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  })
}
