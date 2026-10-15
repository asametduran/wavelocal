import type { MouseEvent } from 'react'
import { useAnnouncement } from '../hooks/useA11y'

/** The one polite live region of the page: track changes, play state, reorders and search counts are spoken through it. */
export default function LiveRegion() {
  const { text } = useAnnouncement()
  return (
    <div role="status" aria-live="polite" aria-atomic="true" className="sr-only" data-testid="announcer">
      {text}
    </div>
  )
}

const link =
  'sr-only rounded-full bg-white px-4 py-2 text-sm font-semibold text-black shadow-lg focus:not-sr-only focus:fixed focus:left-3 focus:top-3 focus:z-[100]'

/** Moves focus to the first usable control inside the first visible `#id` (a plain hash link would add history entries the sheets listen to). */
function jump(...ids: string[]) {
  return (e: MouseEvent<HTMLAnchorElement>) => {
    e.preventDefault()
    const target = ids.map((id) => document.getElementById(id)).find((el) => el && el.getClientRects().length > 0)
    if (!target) return
    const control = target.matches('button, input, select, a[href]') ? target : target.querySelector<HTMLElement>('button:not([disabled]), input, select, a[href]')
    ;(control ?? target).focus()
  }
}

/** Keyboard-only shortcuts past the repeated chrome, visible while focused. */
export function SkipLinks() {
  return (
    <nav aria-label="Skip links" className="contents">
      <a href="#library" onClick={jump('library')} className={link}>
        Skip to library
      </a>
      <a href="#player" onClick={jump('player', 'player-mini')} className={link}>
        Skip to player controls
      </a>
    </nav>
  )
}
