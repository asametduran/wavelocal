import { useEffect, useMemo, useRef, useState } from 'react'
import type { ChangeEvent, KeyboardEvent as ReactKeyboardEvent, RefObject, UIEvent } from 'react'
import { FolderOpen, FolderTree as FolderTreeIcon, GripVertical, List, ListPlus, Pencil, Plus, Search, Trash2, Tv, X } from 'lucide-react'
import Cover from './Cover'
import { Deferred, lazyRetry, preloadWhenIdle } from './lazy'
import { useRovingKeys } from '../hooks/useA11y'
import { announce, matchAnnouncement, moveAnnouncement } from '../lib/a11y'
import { formatTime } from '../lib/format'
import type { PlayerApi } from '../types'

// Code for the folder tree and the tag editor is only fetched when a folder view or an edit is first asked for.
const loadFolderTree = () => import('./FolderTree')
const loadTagEditor = () => import('./TagEditor')
const FolderTree = lazyRetry(loadFolderTree)
const TagEditor = lazyRetry(loadTagEditor)

function Bars() {
  return (
    <span className="flex h-3 items-end gap-0.5" role="img" aria-label="Playing">
      {[0, 1, 2].map((i) => (
        <span key={i} className="w-0.5 origin-bottom animate-pulse rounded-full bg-accent" style={{ height: `${60 + i * 20}%`, animationDelay: `${i * 0.2}s` }} />
      ))}
    </span>
  )
}

const ROW_H = 52
const OVERSCAN = 8

type LibraryMode = 'list' | 'folders'
const MODE_KEY = 'wl-library-view'

function loadMode(): LibraryMode {
  try {
    return localStorage.getItem(MODE_KEY) === 'folders' ? 'folders' : 'list'
  } catch {
    return 'list'
  }
}

const headBtn = 'grid h-8 w-8 place-items-center rounded-full text-zinc-400 hover:bg-white/10 hover:text-white'

interface PlaylistProps {
  p: PlayerApi
  /** Element id for the skip link; only one mounted library may own it. */
  id?: string
  /** Landmark name; the phone queue sheet shows a second copy, which must be distinguishable. */
  label?: string
  searchRef?: RefObject<HTMLInputElement | null>
  onPickFiles: () => void
  onPickFolder: () => void
  tv?: boolean
  onToggleTv?: () => void
  className?: string
}

export default function Playlist({ p, id, label = 'Library', searchRef, onPickFiles, onPickFolder, tv, onToggleTv, className = '' }: PlaylistProps) {
  const [query, setQuery] = useState('')
  const [dragFrom, setDragFrom] = useState<number | null>(null)
  const [dragOver, setDragOver] = useState<number | null>(null)
  const [menuFor, setMenuFor] = useState<string | null>(null)
  const [editingId, setEditingId] = useState<string | null>(null)
  const [mode, setMode] = useState<LibraryMode>(loadMode)
  useEffect(() => preloadWhenIdle([loadFolderTree, loadTagEditor]), [])
  const editing = editingId ? (p.tracks.find((t) => t.id === editingId) ?? null) : null

  const listRef = useRef<HTMLUListElement>(null)
  /** Track whose play button must get focus after a keyboard reorder moved its row. */
  const refocus = useRef<string | null>(null)
  const [scrollTop, setScrollTop] = useState(0)
  const [viewH, setViewH] = useState(600)

  useEffect(() => {
    const el = listRef.current
    if (!el) return undefined
    const measure = () => el.clientHeight > 0 && setViewH(el.clientHeight) // a hidden list reports 0: keep the default
    measure()
    const ro = new ResizeObserver(measure)
    ro.observe(el)
    return () => ro.disconnect()
  }, [mode]) // the list is unmounted in folder view, so measure again when it comes back

  const chooseMode = (next: LibraryMode) => {
    setMode(next)
    try {
      localStorage.setItem(MODE_KEY, next)
    } catch {
      // storage blocked: the choice just lasts for this session
    }
  }

  const inPlaylist = p.viewId !== 'all'
  const playlist = p.playlists.find((x) => x.id === p.viewId)
  const q = query.trim().toLowerCase()
  const rows = useMemo(
    () =>
      p.queue
        .map((t, index) => ({ t, index }))
        .filter(({ t }) => !q || `${t.title} ${t.artist} ${t.album}`.toLowerCase().includes(q)),
    [p.queue, q],
  )

  // say how many tracks match, once typing pauses
  useEffect(() => {
    if (!q) return undefined
    const timer = window.setTimeout(() => announce(matchAnnouncement(rows.length, q)), 500)
    return () => window.clearTimeout(timer)
  }, [q, rows.length])

  // after Alt+Arrow moved a row, scroll it into the window and put focus back on it (the move re-keys the DOM)
  useEffect(() => {
    const id = refocus.current
    const list = listRef.current
    if (!id || !list) return
    refocus.current = null
    const at = rows.findIndex(({ t }) => t.id === id)
    if (at < 0) return
    const top = at * ROW_H
    if (top < list.scrollTop) list.scrollTop = top
    else if (top + ROW_H > list.scrollTop + list.clientHeight) list.scrollTop = top + ROW_H - list.clientHeight
    requestAnimationFrame(() => list.querySelector<HTMLElement>(`button[data-track="${CSS.escape(id)}"]`)?.focus())
  }, [rows])

  const start = Math.max(0, Math.floor(scrollTop / ROW_H) - OVERSCAN)
  const end = Math.min(rows.length, Math.ceil((scrollTop + viewH) / ROW_H) + OVERSCAN)
  const visible = rows.slice(start, end)

  const onView = (e: ChangeEvent<HTMLSelectElement>) => {
    const v = e.target.value
    if (v === '__new') {
      const name = window.prompt('Name your new playlist')
      if (name !== null) p.setViewId(p.createPlaylist(name))
      return
    }
    p.setViewId(v)
  }

  const onDelete = () => {
    if (inPlaylist) {
      if (window.confirm(`Delete playlist "${playlist?.name}"? Your tracks stay in the library.`)) p.deletePlaylist(p.viewId)
    } else if (window.confirm('Remove every track from your library? This clears the offline copy too.')) p.clear()
  }

  /** Close the add-to-playlist menu; keyboard users get focus back on the button that opened it. */
  const closeMenu = (restoreFocus: boolean) => {
    const id = menuFor
    setMenuFor(null)
    if (restoreFocus && id) requestAnimationFrame(() => listRef.current?.querySelector<HTMLElement>(`button[data-menu-trigger="${CSS.escape(id)}"]`)?.focus())
  }
  const addTo = (plId: string, trackId: string) => {
    p.addToPlaylist(plId, trackId)
    announce('Added to playlist')
    closeMenu(true)
  }
  const addToNew = (trackId: string) => {
    const name = window.prompt('Name your new playlist')
    if (name === null) return
    p.createPlaylist(name, [trackId])
    announce('Added to new playlist')
    closeMenu(true)
  }
  const menuNav = useRovingKeys({ items: '[role="menuitem"]', orientation: 'vertical' })
  const onMenuKey = (e: ReactKeyboardEvent<HTMLElement>) => {
    if (e.key === 'Escape') {
      e.preventDefault()
      e.stopPropagation()
      closeMenu(true)
    } else if (e.key === 'Tab') closeMenu(false)
    else menuNav(e)
  }
  // the menu opens with its first item focused
  useEffect(() => {
    if (menuFor) listRef.current?.querySelector<HTMLElement>('[role="menu"] [role="menuitem"]')?.focus()
  }, [menuFor])

  /** Alt+Up / Alt+Down on a track moves it in the queue: the keyboard alternative to dragging. */
  const onRowKey = (e: ReactKeyboardEvent<HTMLButtonElement>, index: number, title: string, id: string) => {
    if (!e.altKey || q || (e.key !== 'ArrowUp' && e.key !== 'ArrowDown')) return
    e.preventDefault()
    const to = e.key === 'ArrowUp' ? index - 1 : index + 1
    if (to < 0 || to >= rows.length) return
    refocus.current = id
    p.reorder(index, to)
    announce(moveAnnouncement(title, to + 1, rows.length))
  }

  return (
    <aside id={id} aria-label={label} className={`flex min-h-0 w-full flex-col border-white/5 bg-panel md:w-80 md:border-r lg:w-96 ${className}`}>
      <div className="flex items-center justify-between gap-2 px-4 pb-2 pt-4">
        <label className="min-w-0 flex-1">
          <span className="sr-only">Library or playlist</span>
          <select
            value={p.viewId}
            onChange={onView}
            className="w-full truncate rounded-lg bg-transparent py-1 text-sm font-semibold uppercase tracking-wider text-zinc-300 outline-none hover:bg-white/5"
          >
            <option value="all" className="bg-panel normal-case">Library ({p.tracks.length})</option>
            {p.playlists.map((pl) => (
              <option key={pl.id} value={pl.id} className="bg-panel normal-case">
                {pl.name} ({pl.trackIds.length})
              </option>
            ))}
            <option value="__new" className="bg-panel normal-case">＋ New playlist…</option>
          </select>
        </label>
        <div className="flex shrink-0 gap-1">
          <button onClick={onPickFiles} className={headBtn} aria-label="Add files" title="Add files">
            <Plus size={18} />
          </button>
          <button onClick={onPickFolder} className={headBtn} aria-label="Add folder" title="Add folder">
            <FolderOpen size={17} />
          </button>
          <button
            onClick={() => chooseMode(mode === 'folders' ? 'list' : 'folders')}
            aria-pressed={mode === 'folders'}
            className={`${headBtn} ${mode === 'folders' ? '!text-accent' : ''}`}
            aria-label="Folder view"
            title={mode === 'folders' ? 'Switch to the track list' : 'Browse by folder'}
          >
            {mode === 'folders' ? <List size={16} /> : <FolderTreeIcon size={16} />}
          </button>
          {onToggleTv && (
            <button onClick={onToggleTv} aria-pressed={!!tv} className={`hidden md:grid ${headBtn} ${tv ? '!text-accent' : ''}`} aria-label="TV mode (T)" title="TV mode (T)">
              <Tv size={16} />
            </button>
          )}
          <button onClick={onDelete} disabled={!inPlaylist && !p.tracks.length} className={`${headBtn} hover:!text-red-400 disabled:opacity-30`} aria-label={inPlaylist ? 'Delete playlist' : 'Clear library'} title={inPlaylist ? 'Delete playlist' : 'Clear library'}>
            <Trash2 size={16} />
          </button>
        </div>
      </div>

      <div role="search" aria-label={`Search ${label.toLowerCase()}`} className="px-4 pb-3">
        <label className="flex items-center gap-2 rounded-lg bg-raised px-3 py-2 focus-within:ring-1 focus-within:ring-accent">
          <Search size={15} className="text-zinc-400" />
          <input
            ref={searchRef}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => e.key === 'Escape' && (setQuery(''), e.currentTarget.blur())}
            placeholder="Search tracks  ( / )"
            aria-label="Search tracks"
            className="w-full bg-transparent text-sm outline-none placeholder:text-zinc-400"
          />
          {query && (
            <button onClick={() => setQuery('')} aria-label="Clear search" className="grid h-6 w-6 place-items-center rounded-full text-zinc-400 hover:text-white">
              <X size={14} />
            </button>
          )}
        </label>
      </div>

      {mode === 'folders' ? (
        <Deferred label="the folder view" onDismiss={() => (FolderTree.reset(), setMode('list'))}>
          <FolderTree p={p} query={query} onEdit={(id) => (setMenuFor(null), setEditingId(id))} />
        </Deferred>
      ) : (
      <ul ref={listRef} aria-label={inPlaylist ? `Tracks in ${playlist?.name ?? 'playlist'}` : 'Library tracks'} onScroll={(e: UIEvent<HTMLUListElement>) => {
          setScrollTop(e.currentTarget.scrollTop)
          if (e.currentTarget.clientHeight > 0) setViewH(e.currentTarget.clientHeight)
        }} className="min-h-0 flex-1 overflow-y-auto px-2 pb-2">
        {start > 0 && <li aria-hidden="true" style={{ height: start * ROW_H }} />}
        {visible.map(({ t, index }, i) => {
          const active = t.id === p.currentId
          const others = p.playlists.filter((pl) => pl.id !== p.viewId)
          return (
            <li
              key={t.id}
              style={{ height: ROW_H }}
              aria-setsize={rows.length}
              aria-posinset={start + i + 1}
              draggable={!q}
              onDragStart={(e) => {
                setDragFrom(index)
                e.dataTransfer.effectAllowed = 'move'
                e.dataTransfer.setData('text/plain', t.id)
              }}
              onDragOver={(e) => {
                if (dragFrom === null) return
                e.preventDefault()
                setDragOver(index)
              }}
              onDrop={(e) => {
                if (dragFrom === null) return
                e.preventDefault()
                p.reorder(dragFrom, index)
              }}
              onDragEnd={() => (setDragFrom(null), setDragOver(null))}
              className={`group relative flex items-center gap-2 rounded-lg px-2 transition ${active ? 'bg-white/10' : 'hover:bg-white/5'} ${dragOver === index && dragFrom !== index ? 'ring-1 ring-accent' : ''} ${dragFrom === index ? 'opacity-40' : ''}`}
            >
              {!q && <GripVertical size={14} aria-hidden="true" className="shrink-0 cursor-grab text-zinc-400 group-hover:text-zinc-300" />}
              <button
                onClick={() => p.play(t.id)}
                onKeyDown={(e) => onRowKey(e, index, t.title, t.id)}
                data-track={t.id}
                className="flex min-w-0 flex-1 items-center gap-3 text-left"
                aria-current={active}
                aria-keyshortcuts={q ? undefined : 'Alt+ArrowUp Alt+ArrowDown'}
              >
                <div className="relative h-10 w-10 shrink-0 overflow-hidden rounded">
                  <Cover track={t} className="h-full w-full" iconSize={14} />
                  {active && p.playing && <div className="absolute inset-0 grid place-items-center bg-black/50"><Bars /></div>}
                </div>
                <div className="min-w-0">
                  <div className={`truncate text-sm ${active ? 'font-semibold text-accent' : ''}`}>{t.title}</div>
                  <div className="truncate text-xs text-zinc-400">{t.artist}</div>
                </div>
              </button>
              <span className="shrink-0 text-xs tabular-nums text-zinc-400">{t.duration ? formatTime(t.duration) : ''}</span>
              <button onClick={() => (setMenuFor(null), setEditingId(t.id))} className="grid h-7 w-7 shrink-0 place-items-center rounded-full text-zinc-400 opacity-0 transition hover:bg-white/10 hover:text-white focus-visible:opacity-100 group-hover:opacity-100 [@media(hover:none)]:opacity-100" aria-label={`Edit tags of ${t.title}`} aria-haspopup="dialog">
                <Pencil size={14} />
              </button>
              <button onClick={() => setMenuFor(menuFor === t.id ? null : t.id)} data-menu-trigger={t.id} className="grid h-7 w-7 shrink-0 place-items-center rounded-full text-zinc-400 opacity-0 transition hover:bg-white/10 hover:text-white focus-visible:opacity-100 group-hover:opacity-100 [@media(hover:none)]:opacity-100" aria-label={`Add ${t.title} to playlist`} aria-haspopup="menu" aria-expanded={menuFor === t.id}>
                <ListPlus size={15} />
              </button>
              <button onClick={() => p.remove(t.id)} className="grid h-7 w-7 shrink-0 place-items-center rounded-full text-zinc-400 opacity-0 transition hover:bg-white/10 hover:text-red-400 focus-visible:opacity-100 group-hover:opacity-100 [@media(hover:none)]:opacity-100" aria-label={`Remove ${t.title}`}>
                <X size={14} />
              </button>
              {menuFor === t.id && (
                <>
                  <div className="fixed inset-0 z-10" onClick={() => closeMenu(false)} aria-hidden="true" />
                  <div role="menu" aria-label={`Add ${t.title} to a playlist`} onKeyDown={onMenuKey} className="absolute right-2 top-full z-20 mt-1 w-52 overflow-hidden rounded-xl bg-raised py-1 shadow-xl ring-1 ring-white/10">
                    {others.map((pl) => (
                      <button key={pl.id} role="menuitem" tabIndex={-1} onClick={() => addTo(pl.id, t.id)} className="block w-full truncate px-3 py-2 text-left text-sm hover:bg-white/10">
                        {pl.name}
                      </button>
                    ))}
                    <button role="menuitem" tabIndex={-1} onClick={() => addToNew(t.id)} className="block w-full px-3 py-2 text-left text-sm text-accent hover:bg-white/10">
                      ＋ New playlist…
                    </button>
                  </div>
                </>
              )}
            </li>
          )
        })}
        {end < rows.length && <li aria-hidden="true" style={{ height: (rows.length - end) * ROW_H }} />}
        {!rows.length && (
          <li className="flex flex-col items-center gap-4 px-4 py-10 text-center text-sm text-zinc-400">
            {p.queue.length
              ? 'No tracks match your search.'
              : inPlaylist
                ? 'This playlist is empty. Use the + button on any library track to add it.'
                : 'Your library is empty. Add some music — it stays on your device and is remembered next time.'}
            {!p.queue.length && !inPlaylist && (
              <div className="flex gap-2">
                <button onClick={onPickFiles} className="rounded-full bg-white px-4 py-2 text-sm font-semibold text-black">Add files</button>
                <button onClick={onPickFolder} className="rounded-full bg-white/10 px-4 py-2 text-sm font-semibold text-white">Add folder</button>
              </div>
            )}
          </li>
        )}
      </ul>
      )}
      {editing && (
        <Deferred label="the tag editor" onDismiss={() => (TagEditor.reset(), setEditingId(null))}>
          <TagEditor key={editing.id} p={p} track={editing} onClose={() => setEditingId(null)} />
        </Deferred>
      )}
    </aside>
  )
}
