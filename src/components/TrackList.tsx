import { useEffect, useRef, useState } from 'react'
import type { KeyboardEvent as ReactKeyboardEvent, ReactNode, UIEvent } from 'react'
import { GripVertical, ListPlus, Pencil, Play, X } from 'lucide-react'
import Cover from './Cover'
import PlaylistMenu from './PlaylistMenu'
import { useRemScale } from '../hooks/useRemScale'
import { announce, moveAnnouncement } from '../lib/a11y'
import { formatTime } from '../lib/format'
import type { PageRow } from '../lib/pages'
import type { PlayerApi, Track } from '../types'

/** A row of the list: a track, or a heading that sets the tracks after it apart (a disc, an album on an artist's page). */
export type ListRow = PageRow<Track>

/** The little animated bars that mark what is playing. */
export function Bars() {
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

const rowBtn =
  'grid h-7 w-7 shrink-0 place-items-center rounded-full text-zinc-400 opacity-0 transition hover:bg-white/10 hover:text-white focus-visible:opacity-100 group-hover:opacity-100 [@media(hover:none)]:opacity-100'

export interface TrackListProps {
  p: PlayerApi
  rows: readonly ListRow[]
  /** The list's accessible name. */
  label: string
  /** What leads a row: its artwork (library, playlists) or its track number (album pages). */
  lead?: 'cover' | 'number'
  /** Rows can be dragged, and moved with Alt+Arrow: only the stored order of a library or playlist, unfiltered. */
  reorderable?: boolean
  /** Rows can be taken out of the library or playlist. */
  removable?: boolean
  /** Extra text after the artist: why a row is where it is in a smart list or a sort. */
  detail?: (t: Track) => string | null
  /** A row's track was chosen. */
  onPlay: (t: Track) => void
  onEdit: (id: string) => void
  /** A heading that names a page was chosen. */
  onOpenHeading?: (ref: string) => void
  /** The play button of a heading was pressed. */
  onPlayHeading?: (tracks: Track[]) => void
  /** The playlist these tracks belong to, which its own "add to playlist" menu leaves out. */
  playlistId?: string
  /** Shown inside the list when there are no rows. */
  empty: ReactNode
}

/**
 * The windowed list of tracks: only the rows in view are in the page, so a library of tens of thousands scrolls
 * smoothly. Rows play, edit, add to a playlist and (where it makes sense) remove or move by dragging or Alt+Arrow.
 */
export default function TrackList({ p, rows, label, lead = 'cover', reorderable = false, removable = false, detail, onPlay, onEdit, onOpenHeading, onPlayHeading, playlistId, empty }: TrackListProps) {
  const [dragFrom, setDragFrom] = useState<number | null>(null)
  const [dragOver, setDragOver] = useState<number | null>(null)
  const [menuFor, setMenuFor] = useState<string | null>(null)
  const listRef = useRef<HTMLUListElement>(null)
  /** Track whose play button must get focus after a keyboard reorder moved its row. */
  const refocus = useRef<string | null>(null)
  const [scrollTop, setScrollTop] = useState(0)
  const [viewH, setViewH] = useState(600)
  const scale = useRemScale()
  const rowH = Math.round(ROW_H * scale)

  useEffect(() => {
    const el = listRef.current
    if (!el) return undefined
    const measure = () => el.clientHeight > 0 && setViewH(el.clientHeight) // a hidden list reports 0: keep the default
    measure()
    const ro = new ResizeObserver(measure)
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  // after Alt+Arrow moved a row, scroll it into the window and put focus back on it (the move re-keys the DOM)
  useEffect(() => {
    const id = refocus.current
    const list = listRef.current
    if (!id || !list) return
    refocus.current = null
    const at = rows.findIndex((r) => r.kind === 'track' && r.t.id === id)
    if (at < 0) return
    const top = at * rowH
    if (top < list.scrollTop) list.scrollTop = top
    else if (top + rowH > list.scrollTop + list.clientHeight) list.scrollTop = top + rowH - list.clientHeight
    requestAnimationFrame(() => list.querySelector<HTMLElement>(`button[data-track="${CSS.escape(id)}"]`)?.focus())
  }, [rows, rowH])

  const start = Math.max(0, Math.floor(scrollTop / rowH) - OVERSCAN)
  const end = Math.min(rows.length, Math.ceil((scrollTop + viewH) / rowH) + OVERSCAN)
  const visible = rows.slice(start, end)
  const others = p.playlists.filter((pl) => pl.id !== playlistId)

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

  /** Alt+Up / Alt+Down on a track moves it in the queue: the keyboard alternative to dragging. */
  const onRowKey = (e: ReactKeyboardEvent<HTMLButtonElement>, index: number, title: string, id: string) => {
    if (!e.altKey || !reorderable || (e.key !== 'ArrowUp' && e.key !== 'ArrowDown')) return
    e.preventDefault()
    const to = e.key === 'ArrowUp' ? index - 1 : index + 1
    if (to < 0 || to >= rows.length) return
    refocus.current = id
    p.reorder(index, to)
    announce(moveAnnouncement(title, to + 1, rows.length))
  }

  return (
    <ul
      ref={listRef}
      aria-label={label}
      onScroll={(e: UIEvent<HTMLUListElement>) => {
        setScrollTop(e.currentTarget.scrollTop)
        if (e.currentTarget.clientHeight > 0) setViewH(e.currentTarget.clientHeight)
      }}
      className="min-h-0 flex-1 overflow-y-auto px-2 pb-2"
    >
      {start > 0 && <li aria-hidden="true" style={{ height: start * rowH }} />}
      {visible.map((row, i) => {
        const at = start + i
        if (row.kind === 'heading') {
          const open = row.open
          return (
            <li key={row.key} style={{ height: rowH }} aria-setsize={rows.length} aria-posinset={at + 1} className="flex items-center gap-2 px-2">
              {open && onOpenHeading ? (
                <>
                  <h3 className="min-w-0 flex-1">
                    <button type="button" onClick={() => onOpenHeading(open)} className="flex w-full min-w-0 items-center gap-3 rounded-lg py-1 text-left hover:bg-white/5">
                      <div className="h-9 w-9 shrink-0 overflow-hidden rounded">
                        <Cover track={{ cover: row.art?.cover ?? null, title: row.label, artist: '' }} className="h-full w-full" iconSize={13} />
                      </div>
                      <div className="min-w-0">
                        <div className="truncate text-sm font-semibold">{row.label}</div>
                        {row.detail && <div className="truncate text-xs text-zinc-400">{row.detail}</div>}
                      </div>
                    </button>
                  </h3>
                  {onPlayHeading && row.tracks.length > 0 && (
                    <button type="button" onClick={() => onPlayHeading(row.tracks)} className="grid h-8 w-8 shrink-0 place-items-center rounded-full text-zinc-300 hover:bg-white/10 hover:text-white" aria-label={`Play ${row.label}`} title="Play">
                      <Play size={14} fill="currentColor" />
                    </button>
                  )}
                </>
              ) : (
                <h3 className="truncate text-xs font-semibold uppercase tracking-wider text-zinc-400">{row.label}</h3>
              )}
            </li>
          )
        }
        const { t, index } = row
        const active = t.id === p.currentId
        const extra = detail?.(t)
        return (
          <li
            key={t.id}
            style={{ height: rowH }}
            aria-setsize={rows.length}
            aria-posinset={at + 1}
            draggable={reorderable}
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
            {reorderable && <GripVertical size={14} aria-hidden="true" className="shrink-0 cursor-grab text-zinc-400 group-hover:text-zinc-300" />}
            <button
              onClick={() => onPlay(t)}
              onKeyDown={(e) => onRowKey(e, index, t.title, t.id)}
              data-track={t.id}
              className="flex min-w-0 flex-1 items-center gap-3 text-left"
              aria-current={active}
              aria-keyshortcuts={reorderable ? 'Alt+ArrowUp Alt+ArrowDown' : undefined}
            >
              {lead === 'number' ? (
                <div className="grid h-10 w-8 shrink-0 place-items-center text-sm tabular-nums text-zinc-400">
                  {active && p.playing ? <Bars /> : <span className={active ? 'font-semibold text-accent' : ''}>{t.trackNo || '·'}</span>}
                </div>
              ) : (
                <div className="relative h-10 w-10 shrink-0 overflow-hidden rounded">
                  <Cover track={t} className="h-full w-full" iconSize={14} />
                  {active && p.playing && (
                    <div className="absolute inset-0 grid place-items-center bg-black/50">
                      <Bars />
                    </div>
                  )}
                </div>
              )}
              <div className="min-w-0">
                <div className={`truncate text-sm ${active ? 'font-semibold text-accent' : ''}`}>{t.title}</div>
                <div className="truncate text-xs text-zinc-400">
                  {t.artist}
                  {extra ? ` · ${extra}` : ''}
                </div>
              </div>
            </button>
            <span className="shrink-0 text-xs tabular-nums text-zinc-400">{t.duration ? formatTime(t.duration) : ''}</span>
            <button onClick={() => (setMenuFor(null), onEdit(t.id))} className={rowBtn} aria-label={`Edit tags of ${t.title}`} aria-haspopup="dialog">
              <Pencil size={14} />
            </button>
            <button onClick={() => setMenuFor(menuFor === t.id ? null : t.id)} data-menu-trigger={t.id} className={rowBtn} aria-label={`Add ${t.title} to playlist`} aria-haspopup="menu" aria-expanded={menuFor === t.id}>
              <ListPlus size={15} />
            </button>
            {removable && (
              <button onClick={() => p.remove(t.id)} className={`${rowBtn} hover:!text-red-400`} aria-label={`Remove ${t.title}`}>
                <X size={14} />
              </button>
            )}
            {menuFor === t.id && <PlaylistMenu playlists={others} label={`Add ${t.title} to a playlist`} onChoose={(plId) => (plId ? addTo(plId, t.id) : addToNew(t.id))} onClose={closeMenu} />}
          </li>
        )
      })}
      {end < rows.length && <li aria-hidden="true" style={{ height: (rows.length - end) * rowH }} />}
      {!rows.length && empty}
    </ul>
  )
}
