import { useEffect, useRef } from 'react'
import type { KeyboardEvent } from 'react'
import { useRovingKeys } from '../hooks/useA11y'
import type { Playlist } from '../types'

interface PlaylistMenuProps {
  /** The playlists to offer. */
  playlists: readonly Playlist[]
  /** Accessible name, e.g. "Add Song to a playlist". */
  label: string
  /** The playlist chosen, or null for "New playlist…". */
  onChoose: (playlistId: string | null) => void
  /** Close the menu; keyboard users get focus back on the button that opened it. */
  onClose: (restoreFocus: boolean) => void
  /** Where the menu sits relative to the element that holds it. */
  className?: string
}

/** The "add to a playlist" menu: the existing playlists and a way to make a new one. Arrow keys move, Escape closes. */
export default function PlaylistMenu({ playlists, label, onChoose, onClose, className = 'absolute right-2 top-full z-20 mt-1 w-52' }: PlaylistMenuProps) {
  const menu = useRef<HTMLDivElement>(null)
  const navigate = useRovingKeys({ items: '[role="menuitem"]', orientation: 'vertical' })

  // the menu opens with its first item focused
  useEffect(() => {
    menu.current?.querySelector<HTMLElement>('[role="menuitem"]')?.focus()
  }, [])

  const onKeyDown = (e: KeyboardEvent<HTMLElement>) => {
    if (e.key === 'Escape') {
      e.preventDefault()
      e.stopPropagation()
      onClose(true)
    } else if (e.key === 'Tab') onClose(false)
    else navigate(e)
  }

  return (
    <>
      <div className="fixed inset-0 z-10" onClick={() => onClose(false)} aria-hidden="true" />
      <div ref={menu} role="menu" aria-label={label} onKeyDown={onKeyDown} className={`${className} overflow-hidden rounded-xl bg-raised py-1 shadow-xl ring-1 ring-white/10`}>
        {playlists.map((pl) => (
          <button key={pl.id} type="button" role="menuitem" tabIndex={-1} onClick={() => onChoose(pl.id)} className="block w-full truncate px-3 py-2 text-left text-sm hover:bg-white/10">
            {pl.name}
          </button>
        ))}
        <button type="button" role="menuitem" tabIndex={-1} onClick={() => onChoose(null)} className="block w-full px-3 py-2 text-left text-sm text-accent hover:bg-white/10">
          ＋ New playlist…
        </button>
      </div>
    </>
  )
}
