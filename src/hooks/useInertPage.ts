import { useEffect } from 'react'

/** Dialogs that hold the page inert right now. */
let holders = 0

/**
 * Make the page behind a dialog inert (no focus, no clicks, and a screen reader cannot wander off into it) and return the
 * function that lets it go. Dialogs can stack (a question over the chapter list), so the page is let back in only when the
 * last of them lets go, and letting go twice counts once.
 */
export function holdPageInert(): () => void {
  const page = document.getElementById('root')
  holders++
  page?.setAttribute('inert', '')
  let held = true
  return () => {
    if (!held) return
    held = false
    holders--
    if (holders === 0) page?.removeAttribute('inert')
  }
}

/** The page is inert while `active`. */
export function useInertPage(active: boolean): void {
  useEffect(() => (active ? holdPageInert() : undefined), [active])
}
