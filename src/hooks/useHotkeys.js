import { useEffect } from 'react'

/** Global hotkeys. Ignored while typing in a text field. */
export function useHotkeys(p, focusSearch) {
  useEffect(() => {
    const onKey = (e) => {
      const el = e.target
      const typing =
        el instanceof HTMLElement &&
        (el.isContentEditable || /^(TEXTAREA|SELECT)$/.test(el.tagName) || (el.tagName === 'INPUT' && el.type !== 'range'))
      if (typing || e.ctrlKey || e.metaKey || e.altKey) return
      const k = e.key
      const actions = {
        ' ': () => p.toggle(),
        ArrowLeft: () => (e.shiftKey ? p.prev() : p.seekBy(-5)),
        ArrowRight: () => (e.shiftKey ? p.next() : p.seekBy(5)),
        ArrowUp: () => p.volumeBy(0.05),
        ArrowDown: () => p.volumeBy(-0.05),
        m: () => p.toggleMute(),
        s: () => p.toggleShuffle(),
        r: () => p.cycleRepeat(),
        n: () => p.next(),
        p: () => p.prev(),
        '/': () => focusSearch?.(),
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
