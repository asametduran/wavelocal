import { useEffect, useRef } from 'react'
import type { KeyboardEvent } from 'react'
import { Copy, Download, Pencil, Trash2 } from 'lucide-react'
import { useRovingKeys } from '../hooks/useA11y'
import { announce } from '../lib/a11y'
import { promptDialog, toast } from '../lib/overlays'
import { MAX_PLAYLIST_NAME, cleanName, copyName } from '../lib/playlists'
import type { PlayerApi, Playlist } from '../types'

/** Where focus goes when the menu closes: back on the button that opened it, or on the list chooser (the playlist is gone). */
export type FocusTarget = 'button' | 'chooser' | null

interface ActionsMenuProps {
  p: PlayerApi
  playlist: Playlist
  onClose: (focus: FocusTarget) => void
}

const item = 'flex w-full items-center gap-2 px-3 py-2 text-left text-sm hover:bg-white/10 disabled:opacity-40'

/** What can be done with the playlist that is open: rename, duplicate, save as a file, delete (which can be undone). */
export default function ActionsMenu({ p, playlist, onClose }: ActionsMenuProps) {
  const menu = useRef<HTMLDivElement>(null)
  const navigate = useRovingKeys({ items: '[role="menuitem"]:not(:disabled)', orientation: 'vertical' })

  // the menu opens with its first item focused
  useEffect(() => {
    menu.current?.querySelector<HTMLElement>('[role="menuitem"]')?.focus()
  }, [])

  const onKeyDown = (e: KeyboardEvent<HTMLElement>) => {
    if (e.key === 'Escape') {
      e.preventDefault()
      e.stopPropagation()
      onClose('button')
    } else if (e.key === 'Tab') onClose(null)
    else navigate(e)
  }

  // Each action closes the menu first, focus going back to its button: that is where a dialog (and then the page) finds it.
  const rename = async () => {
    onClose('button')
    const name = await promptDialog({ title: 'Rename playlist', label: 'Playlist name', value: playlist.name, confirmLabel: 'Rename', maxLength: MAX_PLAYLIST_NAME })
    if (name === null) return
    p.renamePlaylist(playlist.id, name)
    announce(`Playlist renamed to ${cleanName(name, playlist.name)}`)
  }

  const duplicate = () => {
    onClose('button')
    const copy = p.duplicatePlaylist(playlist.id)
    if (!copy) return
    const name = copyName(
      p.playlists.map((pl) => pl.name),
      playlist.name,
    )
    toast(`Duplicated as “${name}”`, { action: { label: 'Undo', run: () => void p.deletePlaylist(copy) } })
  }

  const save = async (format: 'm3u8' | 'pls') => {
    onClose('button')
    try {
      const { exportPlaylist } = await import('../lib/playlistio')
      await exportPlaylist(playlist, p.tracks, format)
    } catch {
      toast('Could not save the playlist: its code could not be loaded. Check your connection.')
    }
  }

  const remove = () => {
    onClose('chooser')
    const undo = p.deletePlaylist(playlist.id)
    if (undo) toast(`Deleted “${playlist.name}”`, { action: { label: 'Undo', run: undo } })
  }

  const empty = playlist.trackIds.length === 0

  return (
    <>
      <div className="fixed inset-0 z-10" onClick={() => onClose(null)} aria-hidden="true" />
      <div ref={menu} role="menu" aria-label={`${playlist.name} playlist actions`} onKeyDown={onKeyDown} className="absolute right-0 top-full z-20 mt-1 w-56 overflow-hidden rounded-xl bg-raised py-1 shadow-xl ring-1 ring-white/10">
        <button type="button" role="menuitem" tabIndex={-1} onClick={() => void rename()} className={item}>
          <Pencil size={14} aria-hidden="true" /> Rename…
        </button>
        <button type="button" role="menuitem" tabIndex={-1} onClick={duplicate} className={item}>
          <Copy size={14} aria-hidden="true" /> Duplicate
        </button>
        <button type="button" role="menuitem" tabIndex={-1} disabled={empty} onClick={() => void save('m3u8')} className={item}>
          <Download size={14} aria-hidden="true" /> Save as M3U8 file
        </button>
        <button type="button" role="menuitem" tabIndex={-1} disabled={empty} onClick={() => void save('pls')} className={item}>
          <Download size={14} aria-hidden="true" /> Save as PLS file
        </button>
        <div role="separator" className="my-1 h-px bg-white/10" />
        <button type="button" role="menuitem" tabIndex={-1} onClick={remove} className={`${item} text-red-400`}>
          <Trash2 size={14} aria-hidden="true" /> Delete playlist
        </button>
      </div>
    </>
  )
}
