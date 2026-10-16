import { useCallback, useEffect, useRef, useState } from 'react'
import { BROWSE_MODES, closePage, openPage, parseMode, parseTrail, pruneTrail } from '../lib/browse'
import type { BrowseMode, Trail } from '../lib/browse'

const MODE_KEY = 'wl-library-view'
const ALL: readonly BrowseMode[] = BROWSE_MODES.map((m) => m.mode)

function readMode(): string | null {
  try {
    return localStorage.getItem(MODE_KEY)
  } catch {
    return null
  }
}

const sameTrail = (a: Trail, b: Trail): boolean => a.length === b.length && a.every((ref, i) => ref === b[i])

export interface BrowseApi {
  /** How the list on screen is shown (the chosen mode, or the track list where that mode is not offered). */
  mode: BrowseMode
  /** Switch mode (remembered); the open pages are closed. */
  setMode: (mode: BrowseMode) => void
  /** The album and artist pages open one from another, newest last. */
  trail: Trail
  /** The page on screen (`album:…` or `artist:…`), or null. */
  page: string | null
  open: (ref: string) => void
  /** One page back. With history on, this is the browser's Back, so the Back button of a phone does the same. */
  back: () => void
  /** Close every page. */
  reset: () => void
  /** Close the pages that no longer exist (their tracks were removed or retagged). */
  prune: (exists: (ref: string) => boolean) => void
}

interface BrowseOptions {
  /** Modes this panel offers; a stored mode outside them is shown as the track list. */
  modes?: readonly BrowseMode[]
  /**
   * Mirror the pages in the browser history: opening one adds an entry, so Back (a phone's Back button, a TV remote, the
   * browser) closes the page instead of leaving the app. Only one panel on screen should do this.
   */
  history?: boolean
}

/** The state of a library panel's browsing: which mode it is in, and the album and artist pages opened from it. */
export function useBrowse({ modes = ALL, history: sync = false }: BrowseOptions = {}): BrowseApi {
  const modesRef = useRef(modes)
  modesRef.current = modes
  const [stored, setStored] = useState<BrowseMode>(() => parseMode(readMode(), modes))
  const [trail, setTrail] = useState<Trail>([])
  const trailRef = useRef<Trail>(trail)

  const apply = useCallback((next: Trail) => {
    if (sameTrail(trailRef.current, next)) return
    trailRef.current = next
    setTrail(next)
  }, [])

  // Pages only exist in the albums and artists modes: a history entry that remembers one must not bring it back elsewhere
  const mode = parseMode(stored, modes)
  const pagesShown = useRef(false)
  pagesShown.current = mode === 'albums' || mode === 'artists'

  // Back and Forward land on the history entry that remembers which pages were open then
  useEffect(() => {
    if (!sync) return undefined
    const onPop = (e: PopStateEvent) => apply(pagesShown.current ? parseTrail((e.state as { wlTrail?: unknown } | null)?.wlTrail) : [])
    window.addEventListener('popstate', onPop)
    return () => window.removeEventListener('popstate', onPop)
  }, [sync, apply])

  const open = useCallback(
    (ref: string) => {
      const next = openPage(trailRef.current, ref)
      if (next === trailRef.current) return
      if (sync) window.history.pushState({ wlTrail: next }, '')
      apply(next)
    },
    [sync, apply],
  )

  const back = useCallback(() => {
    if (!trailRef.current.length) return
    // the popstate that follows closes the page, so the history and the screen cannot disagree
    if (sync && (window.history.state as { wlTrail?: unknown } | null)?.wlTrail) window.history.back()
    else apply(closePage(trailRef.current))
  }, [sync, apply])

  const settle = useCallback(
    (next: Trail) => {
      if (sameTrail(trailRef.current, next)) return
      if (sync && (window.history.state as { wlTrail?: unknown } | null)?.wlTrail) window.history.replaceState({ wlTrail: next }, '')
      apply(next)
    },
    [sync, apply],
  )
  const reset = useCallback(() => settle([]), [settle])
  const prune = useCallback((exists: (ref: string) => boolean) => settle(pruneTrail(trailRef.current, exists)), [settle])

  const setMode = useCallback(
    (next: BrowseMode) => {
      const mode = parseMode(next, modesRef.current)
      setStored(mode)
      try {
        localStorage.setItem(MODE_KEY, mode)
      } catch {
        // blocked storage: the choice lasts for this visit
      }
      reset()
    },
    [reset],
  )

  return { mode, setMode, trail, page: trail.at(-1) ?? null, open, back, reset, prune }
}
