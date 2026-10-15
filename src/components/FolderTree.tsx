import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { KeyboardEvent, UIEvent } from 'react'
import { ChevronRight, Folder, FolderOpen, ListPlus, LocateFixed, Pencil, Play, X } from 'lucide-react'
import Cover from './Cover'
import { formatTime } from '../lib/format'
import { ancestorsOf, buildTree, collectTrackIds, defaultOpen, flattenTree, pruneOpen } from '../lib/folders'
import type { FolderNode, FolderRow } from '../lib/folders'
import type { PlayerApi } from '../types'

const ROW_H = 44
const OVERSCAN = 8
const STORE_KEY = 'wl-folders-open'

/** Folders the user has expanded; `null` until they touch the tree, so the first view uses the default. */
function loadOpen(): Set<string> | null {
  try {
    const raw = localStorage.getItem(STORE_KEY)
    const v: unknown = raw ? JSON.parse(raw) : null
    return Array.isArray(v) ? new Set(v.filter((x): x is string => typeof x === 'string')) : null
  } catch {
    return null
  }
}

function saveOpen(open: ReadonlySet<string>): void {
  try {
    localStorage.setItem(STORE_KEY, JSON.stringify([...open]))
  } catch {
    // private mode / blocked storage: the tree just starts from its default next time
  }
}

const countFolders = (node: FolderNode): number => node.folders.reduce((n, f) => n + 1 + countFolders(f), 0)

function allFolderPaths(node: FolderNode, out = new Set<string>()): Set<string> {
  for (const f of node.folders) {
    out.add(f.path)
    allFolderPaths(f, out)
  }
  return out
}

const actionBtn =
  'grid h-7 w-7 shrink-0 place-items-center rounded-full text-zinc-400 opacity-0 transition hover:bg-white/10 hover:text-white focus-visible:opacity-100 group-hover:opacity-100 group-focus-within:opacity-100 [@media(hover:none)]:opacity-100'

interface FolderTreeProps {
  p: PlayerApi
  /** The library search text; while it is non-empty only matching tracks are shown, with their folders opened. */
  query: string
  onEdit: (trackId: string) => void
}

export default function FolderTree({ p, query, onEdit }: FolderTreeProps) {
  const q = query.trim().toLowerCase()
  const trackById = useMemo(() => new Map(p.queue.map((t) => [t.id, t])), [p.queue])
  const root = useMemo(() => {
    const shown = q ? p.queue.filter((t) => `${t.title} ${t.artist} ${t.album} ${t.path}`.toLowerCase().includes(q)) : p.queue
    return buildTree(shown)
  }, [p.queue, q])

  const [stored, setStored] = useState<Set<string> | null>(loadOpen)
  const open = useMemo(() => (stored ? pruneOpen(stored, root) : defaultOpen(root)), [stored, root])
  const rows = useMemo(() => flattenTree(root, open, q !== ''), [root, open, q])

  const setOpen = useCallback((next: Set<string>) => {
    setStored(next)
    saveOpen(next)
  }, [])
  const toggle = (path: string, on?: boolean) => {
    const next = new Set(open)
    if (on ?? !next.has(path)) next.add(path)
    else next.delete(path)
    setOpen(next)
  }

  // ---- windowing ----
  const listRef = useRef<HTMLUListElement>(null)
  const [scrollTop, setScrollTop] = useState(0)
  const [viewH, setViewH] = useState(600)
  useEffect(() => {
    const el = listRef.current
    if (!el) return undefined
    const measure = () => el.clientHeight > 0 && setViewH(el.clientHeight)
    measure()
    const ro = new ResizeObserver(measure)
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  const start = Math.max(0, Math.floor(scrollTop / ROW_H) - OVERSCAN)
  const end = Math.min(rows.length, Math.ceil((scrollTop + viewH) / ROW_H) + OVERSCAN)

  const scrollToIndex = useCallback((i: number) => {
    const el = listRef.current
    if (!el) return
    const top = i * ROW_H
    if (top < el.scrollTop) el.scrollTop = top
    else if (top + ROW_H > el.scrollTop + el.clientHeight) el.scrollTop = top + ROW_H - el.clientHeight
    setScrollTop(el.scrollTop)
  }, [])

  // ---- roving keyboard focus ----
  const [focusIdx, setFocusIdx] = useState(0)
  const [wantFocus, setWantFocus] = useState(false)
  const active = Math.min(focusIdx, Math.max(0, rows.length - 1))

  useLayoutEffect(() => {
    if (!wantFocus) return
    setWantFocus(false)
    listRef.current?.querySelector<HTMLElement>(`[data-idx="${active}"] [data-main]`)?.focus()
  }, [wantFocus, active])

  const focusRow = (i: number) => {
    const next = Math.max(0, Math.min(rows.length - 1, i))
    setFocusIdx(next)
    scrollToIndex(next)
    setWantFocus(true)
  }

  const parentIndex = (i: number): number => {
    const row = rows[i]
    if (!row || row.depth === 0) return -1
    for (let j = i - 1; j >= 0; j--) if ((rows[j] as FolderRow).depth < row.depth) return j
    return -1
  }

  const onKeyDown = (e: KeyboardEvent<HTMLUListElement>) => {
    if (e.altKey || e.ctrlKey || e.metaKey) return
    const row = rows[active]
    if (!row) return
    // keys pressed on a row's action buttons belong to those buttons
    if (!(e.target as HTMLElement).hasAttribute('data-main')) return
    switch (e.key) {
      case 'ArrowDown':
        focusRow(active + 1)
        break
      case 'ArrowUp':
        focusRow(active - 1)
        break
      case 'Home':
        focusRow(0)
        break
      case 'End':
        focusRow(rows.length - 1)
        break
      case 'ArrowRight':
        if (row.kind !== 'folder') return
        if (!row.open) toggle(row.node.path, true)
        else if (rows[active + 1] && (rows[active + 1] as FolderRow).depth > row.depth) focusRow(active + 1)
        break
      case 'ArrowLeft':
        if (row.kind === 'folder' && row.open && q === '') toggle(row.node.path, false)
        else if (parentIndex(active) >= 0) focusRow(parentIndex(active))
        else return
        break
      default:
        return // Enter / Space click the focused button natively
    }
    e.preventDefault()
  }

  // ---- reveal the playing track ----
  const [reveal, setReveal] = useState<string | null>(null)
  const current = p.current
  const showPlaying = () => {
    if (!current) return
    setReveal(current.id)
    if (q === '') setOpen(new Set([...open, ...ancestorsOf(`${current.path}/x`)]))
  }
  useLayoutEffect(() => {
    if (!reveal) return
    const i = rows.findIndex((r) => r.kind === 'track' && r.id === reveal)
    if (i < 0) return
    setReveal(null)
    setFocusIdx(i)
    const el = listRef.current
    if (el) {
      el.scrollTop = Math.max(0, i * ROW_H - el.clientHeight / 2 + ROW_H / 2)
      setScrollTop(el.scrollTop)
    }
  }, [reveal, rows])

  const hasFolders = root.folders.length > 0
  const allPaths = useMemo(() => allFolderPaths(root), [root])
  const allOpen = [...allPaths].every((path) => open.has(path))
  const folderCount = countFolders(root)

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex items-center justify-between gap-2 px-4 pb-1 text-xs text-zinc-400">
        <span>
          {root.count} {root.count === 1 ? 'track' : 'tracks'}
          {hasFolders ? ` in ${folderCount} ${folderCount === 1 ? 'folder' : 'folders'}` : ''}
        </span>
        <span className="flex items-center gap-1">
          {hasFolders && q === '' && (
            <button onClick={() => setOpen(allOpen ? new Set() : allPaths)} className="rounded px-2 py-0.5 hover:bg-white/10 hover:text-white">
              {allOpen ? 'Collapse all' : 'Expand all'}
            </button>
          )}
          <button onClick={showPlaying} disabled={!current} className="grid h-6 w-6 place-items-center rounded-full hover:bg-white/10 hover:text-white disabled:opacity-30" aria-label="Show playing track" title="Show playing track">
            <LocateFixed size={14} />
          </button>
        </span>
      </div>

      <ul
        ref={listRef}
        role="tree"
        aria-label="Library folders"
        onKeyDown={onKeyDown}
        onScroll={(e: UIEvent<HTMLUListElement>) => {
          setScrollTop(e.currentTarget.scrollTop)
          if (e.currentTarget.clientHeight > 0) setViewH(e.currentTarget.clientHeight)
        }}
        className="min-h-0 flex-1 overflow-y-auto px-2 pb-2"
      >
        {start > 0 && <li role="none" aria-hidden="true" style={{ height: start * ROW_H }} />}
        {rows.slice(start, end).map((row, k) => {
          const i = start + k
          const tab = i === active ? 0 : -1
          const pad = 8 + row.depth * 16
          if (row.kind === 'folder') {
            const { node } = row
            const ids = () => collectTrackIds(node)
            return (
              <li
                key={`f:${node.path}`}
                role="treeitem"
                aria-level={row.depth + 1}
                aria-expanded={row.open}
                data-idx={i}
                data-folder={node.path}
                style={{ height: ROW_H, paddingLeft: pad }}
                className="group flex items-center gap-1 rounded-lg pr-2 hover:bg-white/5"
              >
                <button
                  data-main
                  tabIndex={tab}
                  onClick={() => {
                    setFocusIdx(i)
                    toggle(node.path)
                  }}
                  className="flex min-w-0 flex-1 items-center gap-2 text-left"
                  title={node.path}
                >
                  <ChevronRight size={14} className={`shrink-0 text-zinc-400 transition-transform ${row.open ? 'rotate-90' : ''}`} aria-hidden="true" />
                  {row.open ? <FolderOpen size={16} className="shrink-0 text-accent" aria-hidden="true" /> : <Folder size={16} className="shrink-0 text-zinc-400" aria-hidden="true" />}
                  <span className="truncate text-sm font-medium">{node.name}</span>
                  <span className="shrink-0 text-xs tabular-nums text-zinc-400">{node.count}</span>
                </button>
                <button
                  tabIndex={tab}
                  onClick={() => {
                    const first = ids()[0]
                    if (first) p.play(first)
                  }}
                  className={actionBtn}
                  aria-label={`Play folder ${node.name}`}
                  title="Play folder"
                >
                  <Play size={13} />
                </button>
                <button tabIndex={tab} onClick={() => p.createPlaylist(node.name, ids())} className={actionBtn} aria-label={`Save folder ${node.name} as playlist`} title="Save as playlist">
                  <ListPlus size={15} />
                </button>
              </li>
            )
          }
          const t = trackById.get(row.id)
          if (!t) return null
          const playing = t.id === p.currentId
          return (
            <li
              key={`t:${t.id}`}
              role="treeitem"
              aria-level={row.depth + 1}
              aria-selected={playing}
              data-idx={i}
              data-track={t.id}
              style={{ height: ROW_H, paddingLeft: pad + 20 }}
              className={`group flex items-center gap-2 rounded-lg pr-2 transition ${playing ? 'bg-white/10' : 'hover:bg-white/5'}`}
            >
              <button
                data-main
                tabIndex={tab}
                onClick={() => {
                  setFocusIdx(i)
                  p.play(t.id)
                }}
                aria-current={playing}
                className="flex min-w-0 flex-1 items-center gap-2.5 text-left"
              >
                <div className="h-8 w-8 shrink-0 overflow-hidden rounded">
                  <Cover track={t} className="h-full w-full" iconSize={12} />
                </div>
                <div className="min-w-0">
                  <div className={`truncate text-sm ${playing ? 'font-semibold text-accent' : ''}`}>{t.title}</div>
                  <div className="truncate text-xs text-zinc-400">{t.artist}</div>
                </div>
              </button>
              <span className="shrink-0 text-xs tabular-nums text-zinc-400">{t.duration ? formatTime(t.duration) : ''}</span>
              <button tabIndex={tab} onClick={() => onEdit(t.id)} className={actionBtn} aria-label={`Edit tags of ${t.title}`} aria-haspopup="dialog">
                <Pencil size={14} />
              </button>
              <button tabIndex={tab} onClick={() => p.remove(t.id)} className={`${actionBtn} hover:!text-red-400`} aria-label={`Remove ${t.title}`}>
                <X size={14} />
              </button>
            </li>
          )
        })}
        {end < rows.length && <li role="none" aria-hidden="true" style={{ height: (rows.length - end) * ROW_H }} />}
        {!rows.length && (
          <li role="none" className="px-4 py-10 text-center text-sm text-zinc-400">
            {p.queue.length ? 'No tracks match your search.' : 'Nothing here yet. Add a folder and its structure shows up here.'}
          </li>
        )}
      </ul>
    </div>
  )
}
