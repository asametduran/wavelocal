import { useEffect } from 'react'
import type { PlayerApi } from '../types'

const BACK_KEYS = new Set(['Escape', 'GoBack', 'BrowserBack', 'XF86Back'])
const BACK_CODES = new Set([10009, 461]) // Tizen / webOS remotes

/** Escape, and the Back keys of TV remotes and browsers: the keys that close the topmost layer. */
export const isBackKey = (e: { key: string; keyCode: number }): boolean => BACK_KEYS.has(e.key) || BACK_CODES.has(e.keyCode)

/** The slice of the player API the hotkeys drive. */
export type HotkeyPlayer = Pick<PlayerApi, 'toggle' | 'next' | 'prev' | 'seekBy' | 'volumeBy' | 'toggleMute' | 'toggleShuffle' | 'cycleRepeat'>

export interface HotkeyOptions {
  focusSearch?: () => void
  /** Return true when the back action was handled (the key press is then swallowed). */
  onBack?: () => boolean
  tv?: boolean
  toggleTv?: () => void
  openTools?: () => void
  toggleHelp?: () => void
}

type Action = () => void
type ActionMap = Record<string, Action | undefined>

/**
 * Global hotkeys. Dedicated media keys always work (TV remotes, keyboards);
 * letter / arrow shortcuts are ignored while typing. In TV mode arrows are left to
 * the D-pad navigator instead of seeking.
 */
export function useHotkeys(p: HotkeyPlayer, { focusSearch, onBack, tv, toggleTv, openTools, toggleHelp }: HotkeyOptions = {}): void {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const k = e.key
      const mediaKeys: ActionMap = {
        MediaPlayPause: () => p.toggle(),
        MediaPlay: () => p.toggle(),
        MediaPause: () => p.toggle(),
        MediaTrackNext: () => p.next(),
        MediaTrackPrevious: () => p.prev(),
        MediaFastForward: () => p.seekBy(10),
        MediaRewind: () => p.seekBy(-10),
        MediaStop: () => p.toggle(),
      }
      const media = mediaKeys[k]
      if (media) {
        e.preventDefault()
        media()
        return
      }
      if (isBackKey(e) && onBack?.()) {
        e.preventDefault()
        return
      }

      const el = e.target
      const typing =
        el instanceof HTMLElement &&
        (el.isContentEditable || /^(TEXTAREA|SELECT)$/.test(el.tagName) || (el instanceof HTMLInputElement && el.type !== 'range'))
      if (typing || e.ctrlKey || e.metaKey || e.altKey) return

      const arrows: ActionMap = tv
        ? {}
        : {
            ArrowLeft: () => (e.shiftKey ? p.prev() : p.seekBy(-5)),
            ArrowRight: () => (e.shiftKey ? p.next() : p.seekBy(5)),
            ArrowUp: () => p.volumeBy(0.05),
            ArrowDown: () => p.volumeBy(-0.05),
          }
      const actions: ActionMap = {
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
        '?': () => toggleHelp?.(),
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
