import { useEffect, useRef, useSyncExternalStore } from 'react'
import type { KeyboardEvent, RefObject } from 'react'
import { announce, announcer, dialogs, rovingTarget, tabbables, trackAnnouncement, trapTarget } from '../lib/a11y'
import type { Announcement, Orientation } from '../lib/a11y'
import { motionStore } from '../lib/motion'
import type { MotionPref } from '../lib/motion'

/** True when animation should be minimised, from the OS setting or the in-app override. */
export function useReducedMotion(): boolean {
  const s = motionStore()
  return useSyncExternalStore(s.subscribe, () => s.reduced)
}

export function useMotionPref(): [pref: MotionPref, setPref: (pref: MotionPref) => void] {
  const s = motionStore()
  const pref = useSyncExternalStore(s.subscribe, () => s.pref)
  return [pref, (next) => s.set(next)]
}

/** The current live-region message (see `LiveRegion`). */
export function useAnnouncement(): Announcement {
  return useSyncExternalStore(announcer.subscribe, announcer.snapshot)
}

/**
 * The last element that had focus. When a dialog opens, the page behind it becomes inert and the browser moves focus
 * to the body, so by the time the dialog's effect runs `document.activeElement` can no longer tell what to go back to.
 */
let lastFocused: HTMLElement | null = null
if (typeof document !== 'undefined') {
  document.addEventListener(
    'focusin',
    (e) => {
      if (e.target instanceof HTMLElement && e.target !== document.body) lastFocused = e.target
    },
    true,
  )
}

interface DialogOptions {
  /** CSS selector of the element that should get focus first (default: `[data-autofocus]`, else the first control). */
  initialFocus?: string
}

/**
 * Modal behaviour for a dialog or sheet while `active`: focus moves into it, Tab and Shift+Tab stay inside, and focus
 * returns to the control that opened it when it closes. When dialogs stack only the topmost one traps focus.
 */
export function useDialog(ref: RefObject<HTMLElement | null>, active: boolean, { initialFocus }: DialogOptions = {}): void {
  useEffect(() => {
    const root = ref.current
    if (!active || !root) return undefined
    const token = dialogs.push()
    const current = document.activeElement
    const opener = current instanceof HTMLElement && current !== document.body ? current : lastFocused && !root.contains(lastFocused) ? lastFocused : null

    const first = (initialFocus ? root.querySelector<HTMLElement>(initialFocus) : null) ?? root.querySelector<HTMLElement>('[data-autofocus]') ?? tabbables(root)[0] ?? root
    if (first === root && !root.hasAttribute('tabindex')) root.tabIndex = -1
    first.focus({ preventScroll: true })

    const onKeyDown = (e: globalThis.KeyboardEvent) => {
      if (e.key !== 'Tab' || e.defaultPrevented || !dialogs.isTop(token)) return
      const target = trapTarget(root, document.activeElement, e.shiftKey)
      if (!target) return
      e.preventDefault()
      target.focus({ preventScroll: true })
    }
    // focus that lands outside (a stray element behind the backdrop) is pulled back in
    const onFocusIn = (e: FocusEvent) => {
      if (!dialogs.isTop(token) || !(e.target instanceof Element) || root.contains(e.target)) return
      if (e.target.closest('[data-modal="true"]')) return // another dialog (e.g. the tag editor) owns focus now
      ;(tabbables(root)[0] ?? root).focus({ preventScroll: true })
    }
    document.addEventListener('keydown', onKeyDown, true)
    document.addEventListener('focusin', onFocusIn)
    return () => {
      document.removeEventListener('keydown', onKeyDown, true)
      document.removeEventListener('focusin', onFocusIn)
      dialogs.remove(token)
      // restore focus only if it was left inside the dialog (or lost): never steal it from where the user went
      const a = document.activeElement
      if (opener?.isConnected && (!a || a === document.body || root.contains(a))) opener.focus({ preventScroll: true })
    }
  }, [active])
}

interface RovingOptions {
  /** Selector of the group's items, evaluated inside the element that receives the key. */
  items: string
  orientation?: Orientation
  /** Click the newly focused item, so selection follows focus (tabs, radios). */
  activate?: boolean
}

/** Arrow / Home / End navigation for a tab list, radio group or menu: `<div onKeyDown={useRovingKeys(...)}>`. */
export function useRovingKeys({ items, orientation = 'horizontal', activate = false }: RovingOptions): (e: KeyboardEvent<HTMLElement>) => void {
  const options = useRef({ items, orientation, activate })
  options.current = { items, orientation, activate }
  return (e) => {
    if (e.altKey || e.ctrlKey || e.metaKey) return
    const { items: selector, orientation: o, activate: click } = options.current
    const list = Array.from(e.currentTarget.querySelectorAll<HTMLElement>(selector)).filter((el) => !el.hasAttribute('disabled'))
    const at = list.indexOf(e.target as HTMLElement)
    if (at < 0) return
    const to = rovingTarget(e.key, at, list.length, o)
    if (to === null) return
    e.preventDefault()
    e.stopPropagation()
    const target = list[to]
    target?.focus()
    if (click && to !== at) target?.click()
  }
}

/**
 * Speak track changes and play/pause for screen reader users, whose focus is usually on a button (or elsewhere) and
 * who would otherwise get no feedback that the next song started. The very first state after load is not announced.
 */
export function useTrackAnnouncements(track: { id: string; title: string; artist: string } | null | undefined, playing: boolean): void {
  const last = useRef<{ id: string | null; playing: boolean } | null>(null)
  const changed = useRef(false)
  /** Track last spoken as playing, so resuming it says "Playing" while the first play of another one names it. */
  const named = useRef<string | null>(null)
  const id = track?.id ?? null
  useEffect(() => {
    const prev = last.current
    last.current = { id, playing }
    if (!prev) return undefined
    if (prev.id !== id) {
      // the first track of an empty library being selected by an import is not news
      if (prev.id === null && !playing) return undefined
      changed.current = true
    } else if (prev.playing === playing) return undefined
    // a skip flips track and play state within a few frames: speak once, with the settled state. A new track that is not
    // playing yet (the audio graph is still starting) waits longer, so it is heard as "Now playing" and not "Selected".
    const timer = window.setTimeout(() => {
      announce(trackAnnouncement(track, playing, changed.current || (playing && named.current !== id)))
      if (playing) named.current = id
      changed.current = false
    }, changed.current && !playing ? 1200 : 250)
    return () => window.clearTimeout(timer)
  }, [id, playing])
}
