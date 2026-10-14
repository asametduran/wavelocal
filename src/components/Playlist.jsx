import { useMemo, useState } from 'react'
import { FolderOpen, GripVertical, ListPlus, Plus, Search, Trash2, Tv, X } from 'lucide-react'
import Cover from './Cover'
import { formatTime } from '../lib/format'

function Bars() {
  return (
    <span className="flex h-3 items-end gap-0.5" aria-label="Playing">
      {[0, 1, 2].map((i) => (
        <span key={i} className="w-0.5 origin-bottom animate-pulse rounded-full bg-accent" style={{ height: `${60 + i * 20}%`, animationDelay: `${i * 0.2}s` }} />
      ))}
    </span>
  )
}

const headBtn = 'grid h-8 w-8 place-items-center rounded-full text-zinc-400 hover:bg-white/10 hover:text-white'

export default function Playlist({ p, searchRef, onPickFiles, onPickFolder, tv, onToggleTv, className = '' }) {
  const [query, setQuery] = useState('')
  const [dragFrom, setDragFrom] = useState(null)
  const [dragOver, setDragOver] = useState(null)
  const [menuFor, setMenuFor] = useState(null)

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

  const onView = (e) => {
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

  const addTo = (plId, trackId) => {
    p.addToPlaylist(plId, trackId)
    setMenuFor(null)
  }
  const addToNew = (trackId) => {
    const name = window.prompt('Name your new playlist')
    if (name === null) return
    p.createPlaylist(name, [trackId])
    setMenuFor(null)
  }

  return (
    <aside className={`flex min-h-0 w-full flex-col border-white/5 bg-panel md:w-80 md:border-r lg:w-96 ${className}`}>
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

      <div className="px-4 pb-3">
        <label className="flex items-center gap-2 rounded-lg bg-raised px-3 py-2 focus-within:ring-1 focus-within:ring-accent">
          <Search size={15} className="text-zinc-500" />
          <input
            ref={searchRef}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => e.key === 'Escape' && (setQuery(''), e.currentTarget.blur())}
            placeholder="Search tracks  ( / )"
            aria-label="Search tracks"
            className="w-full bg-transparent text-sm outline-none placeholder:text-zinc-600"
          />
          {query && (
            <button onClick={() => setQuery('')} aria-label="Clear search" className="text-zinc-500 hover:text-white">
              <X size={14} />
            </button>
          )}
        </label>
      </div>

      <ul className="min-h-0 flex-1 overflow-y-auto px-2 pb-2">
        {rows.map(({ t, index }) => {
          const active = t.id === p.currentId
          const others = p.playlists.filter((pl) => pl.id !== p.viewId)
          return (
            <li
              key={t.id}
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
              className={`group relative flex items-center gap-2 rounded-lg px-2 py-1.5 transition ${active ? 'bg-white/10' : 'hover:bg-white/5'} ${dragOver === index && dragFrom !== index ? 'ring-1 ring-accent' : ''} ${dragFrom === index ? 'opacity-40' : ''}`}
            >
              {!q && <GripVertical size={14} className="shrink-0 cursor-grab text-zinc-700 group-hover:text-zinc-500" />}
              <button onClick={() => p.play(t.id)} className="flex min-w-0 flex-1 items-center gap-3 text-left" aria-current={active}>
                <div className="relative h-10 w-10 shrink-0 overflow-hidden rounded">
                  <Cover track={t} className="h-full w-full" iconSize={14} />
                  {active && p.playing && <div className="absolute inset-0 grid place-items-center bg-black/50"><Bars /></div>}
                </div>
                <div className="min-w-0">
                  <div className={`truncate text-sm ${active ? 'font-semibold text-accent' : ''}`}>{t.title}</div>
                  <div className="truncate text-xs text-zinc-500">{t.artist}</div>
                </div>
              </button>
              <span className="shrink-0 text-xs tabular-nums text-zinc-600">{t.duration ? formatTime(t.duration) : ''}</span>
              <button onClick={() => setMenuFor(menuFor === t.id ? null : t.id)} className="grid h-7 w-7 shrink-0 place-items-center rounded-full text-zinc-600 opacity-0 transition hover:bg-white/10 hover:text-white focus-visible:opacity-100 group-hover:opacity-100 [@media(hover:none)]:opacity-100" aria-label={`Add ${t.title} to playlist`} aria-haspopup="menu" aria-expanded={menuFor === t.id}>
                <ListPlus size={15} />
              </button>
              <button onClick={() => p.remove(t.id)} className="grid h-7 w-7 shrink-0 place-items-center rounded-full text-zinc-600 opacity-0 transition hover:bg-white/10 hover:text-red-400 focus-visible:opacity-100 group-hover:opacity-100 [@media(hover:none)]:opacity-100" aria-label={`Remove ${t.title}`}>
                <X size={14} />
              </button>
              {menuFor === t.id && (
                <>
                  <div className="fixed inset-0 z-10" onClick={() => setMenuFor(null)} aria-hidden="true" />
                  <div role="menu" className="absolute right-2 top-full z-20 mt-1 w-52 overflow-hidden rounded-xl bg-raised py-1 shadow-xl ring-1 ring-white/10">
                    {others.map((pl) => (
                      <button key={pl.id} role="menuitem" onClick={() => addTo(pl.id, t.id)} className="block w-full truncate px-3 py-2 text-left text-sm hover:bg-white/10">
                        {pl.name}
                      </button>
                    ))}
                    <button role="menuitem" onClick={() => addToNew(t.id)} className="block w-full px-3 py-2 text-left text-sm text-accent hover:bg-white/10">
                      ＋ New playlist…
                    </button>
                  </div>
                </>
              )}
            </li>
          )
        })}
        {!rows.length && (
          <li className="flex flex-col items-center gap-4 px-4 py-10 text-center text-sm text-zinc-500">
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
    </aside>
  )
}
