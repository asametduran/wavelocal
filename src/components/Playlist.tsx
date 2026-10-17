import { useEffect, useId, useMemo, useRef, useState } from 'react'
import type { ChangeEvent, RefObject } from 'react'
import { Ellipsis, FolderOpen, Plus, Trash2, Tv } from 'lucide-react'
import ModeTabs from './ModeTabs'
import SearchBox from './SearchBox'
import SortMenu from './SortMenu'
import TrackList from './TrackList'
import type { ListRow } from './TrackList'
import { Deferred, lazyRetry, preloadWhenIdle } from './lazy'
import type { FocusTarget } from './ActionsMenu'
import { useBrowse } from '../hooks/useBrowse'
import type { BrowseApi } from '../hooks/useBrowse'
import { announce, matchAnnouncement, sortAnnouncement } from '../lib/a11y'
import { BROWSE_MODES } from '../lib/browse'
import type { BrowseMode } from '../lib/browse'
import { listSummary } from '../lib/format'
import { confirmDialog, promptDialog } from '../lib/overlays'
import { matches, parseQuery, searchEntry } from '../lib/search'
import { SMART_LISTS, smartCounts, smartDetail, smartList } from '../lib/smart'
import { SORT_KEYS, describeSort, directionWords } from '../lib/sort'
import type { SortKey, SortSpec } from '../lib/sort'
import { sortDetail } from '../lib/view'
import type { PlayerApi, Track } from '../types'

// Code for the folder tree, the tag editor, the album and artist views and the playlist menu is only fetched when first asked for.
const loadFolderTree = () => import('./FolderTree')
const loadTagEditor = () => import('./TagEditor')
const loadBrowse = () => import('./Browse')
const loadActions = () => import('./ActionsMenu')
const FolderTree = lazyRetry(loadFolderTree)
const TagEditor = lazyRetry(loadTagEditor)
const Browse = lazyRetry(loadBrowse)
const ActionsMenu = lazyRetry(loadActions)

const ALL_MODES: readonly BrowseMode[] = BROWSE_MODES.map((m) => m.mode)

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
  /** The browsing state (mode and open album/artist pages) when the parent needs to reach it, e.g. for the Back key. */
  browse?: BrowseApi
  /** The browse modes this panel offers (the phone queue sheet is only a list of tracks). */
  modes?: readonly BrowseMode[]
}

export default function Playlist({ p, id, label = 'Library', searchRef, onPickFiles, onPickFolder, tv, onToggleTv, className = '', browse: given, modes = ALL_MODES }: PlaylistProps) {
  const own = useBrowse({ modes })
  const browse = given ?? own
  const mode = browse.mode
  const idBase = useId()
  const [text, setText] = useState('')
  const [editingId, setEditingId] = useState<string | null>(null)
  const [actionsOpen, setActionsOpen] = useState(false)
  const actionsButton = useRef<HTMLButtonElement>(null)
  const chooser = useRef<HTMLSelectElement>(null)
  useEffect(() => preloadWhenIdle([loadFolderTree, loadTagEditor, loadBrowse, loadActions]), [])
  const editing = editingId ? (p.tracks.find((t) => t.id === editingId) ?? null) : null

  const query = useMemo(() => parseQuery(text), [text])
  const trimmed = text.trim()
  const noun = BROWSE_MODES.find((m) => m.mode === mode)?.noun ?? 'track'

  const smart = smartList(p.viewId)
  /** A smart list is a read-only view: it sorts itself, so its rows cannot be dragged, sorted or taken out. */
  const inPlaylist = p.viewId !== 'all' && !smart
  const smartCount = useMemo(() => smartCounts(p.tracks), [p.tracks])
  const anyPlays = useMemo(() => p.tracks.some((t) => t.plays > 0 || t.lastPlayedAt != null), [p.tracks])
  const now = Date.now()
  const playlist = p.playlists.find((x) => x.id === p.viewId)
  const stored = p.sort.key === 'library'
  const manualName = inPlaylist ? 'Playlist order' : 'Library order'

  // another list means other albums and artists: whatever page was open belongs to the old one
  const { reset: closePages } = browse
  useEffect(() => closePages(), [p.viewId, closePages])
  useEffect(() => setActionsOpen(false), [p.viewId])

  const rows = useMemo<ListRow[]>(
    () => p.queue.flatMap((t, index): ListRow[] => (query.empty || matches(query, searchEntry(t)) ? [{ kind: 'track', t, index }] : [])),
    [p.queue, query],
  )
  const summary = useMemo(() => listSummary(rows.flatMap((r) => (r.kind === 'track' ? [r.t] : []))), [rows])

  // say how many tracks match, once typing pauses
  useEffect(() => {
    if (!trimmed || (mode !== 'list' && mode !== 'folders')) return undefined
    const timer = window.setTimeout(() => announce(matchAnnouncement(rows.length, trimmed)), 500)
    return () => window.clearTimeout(timer)
  }, [trimmed, rows.length, mode])

  const sortOptions = useMemo(() => SORT_KEYS.map((k) => (k.key === 'library' ? { ...k, label: manualName } : k)), [manualName])
  const changeSort = (next: SortSpec) => {
    p.setSort(next)
    announce(sortAnnouncement(describeSort(next, manualName), next.key === 'library'))
  }

  const onView = async (e: ChangeEvent<HTMLSelectElement>) => {
    const v = e.target.value
    if (v !== '__new') return p.setViewId(v)
    const name = await promptDialog({ title: 'New playlist', label: 'Playlist name', placeholder: 'My playlist', confirmLabel: 'Create' })
    if (name !== null) p.setViewId(p.createPlaylist(name))
  }

  /** Clearing play counts and the library cannot be taken back, so they ask first (a playlist can be undone, so it does not). */
  const onClear = async () => {
    if (smart) {
      const ok = await confirmDialog({
        title: 'Start the play counts over?',
        message: 'Most played and Recently played begin again. Your music is not touched.',
        confirmLabel: 'Clear play counts',
        danger: true,
      })
      if (!ok) return
      p.resetPlays()
      announce('Play counts cleared')
    } else if (
      await confirmDialog({
        title: 'Remove every track from your library?',
        message: 'This clears the offline copy kept on this device too. The files you added from your device are not touched.',
        confirmLabel: 'Clear library',
        danger: true,
      })
    )
      p.clear()
  }

  const closeActions = (focus: FocusTarget) => {
    setActionsOpen(false)
    if (focus === 'button') actionsButton.current?.focus()
    else if (focus === 'chooser') chooser.current?.focus()
  }

  const detail = smart ? (t: Track) => smartDetail(smart.kind, t, now) : (t: Track) => sortDetail(p.sort.key, t, now)
  const wide = mode === 'albums' || mode === 'artists'

  const empty = (
    <li className="flex flex-col items-center gap-4 px-4 py-10 text-center text-sm text-zinc-400">
      {p.queue.length
        ? 'No tracks match your search.'
        : smart
          ? smart.empty
          : inPlaylist
            ? 'This playlist is empty. Use the + button on any library track to add it.'
            : 'Your library is empty. Add some music — it stays on your device and is remembered next time.'}
      {!p.queue.length && !inPlaylist && !smart && (
        <div className="flex gap-2">
          <button onClick={onPickFiles} className="rounded-full bg-white px-4 py-2 text-sm font-semibold text-black">Add files</button>
          <button onClick={onPickFolder} className="rounded-full bg-white/10 px-4 py-2 text-sm font-semibold text-white">Add folder</button>
        </div>
      )}
    </li>
  )

  return (
    <aside
      id={id}
      aria-label={label}
      className={`flex min-h-0 w-full flex-col border-white/5 bg-panel md:border-r ${wide ? 'md:w-[26rem] lg:w-[32rem] xl:w-[40rem]' : 'md:w-80 lg:w-96'} ${className}`}
    >
      <div className="flex items-center justify-between gap-2 px-4 pb-2 pt-4">
        <label className="min-w-0 flex-1">
          <span className="sr-only">Library or playlist</span>
          <select
            ref={chooser}
            value={p.viewId}
            onChange={onView}
            className="w-full truncate rounded-lg bg-transparent py-1 text-sm font-semibold uppercase tracking-wider text-zinc-300 outline-none hover:bg-white/5"
          >
            <option value="all" className="bg-panel normal-case">Library ({p.tracks.length})</option>
            <optgroup label="Smart playlists" className="bg-panel">
              {SMART_LISTS.map((l) => (
                <option key={l.id} value={l.id} className="bg-panel normal-case">
                  {l.name} ({smartCount[l.kind]})
                </option>
              ))}
            </optgroup>
            {p.playlists.map((pl) => (
              <option key={pl.id} value={pl.id} className="bg-panel normal-case">
                {pl.name} ({pl.trackIds.length})
              </option>
            ))}
            <option value="__new" className="bg-panel normal-case">＋ New playlist…</option>
          </select>
        </label>
        <div className="flex shrink-0 gap-1">
          <button onClick={onPickFiles} className={headBtn} aria-label="Add files" title="Add files or a playlist file">
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
          {inPlaylist && playlist ? (
            <div className="relative">
              <button
                ref={actionsButton}
                onClick={() => setActionsOpen((open) => !open)}
                aria-haspopup="menu"
                aria-expanded={actionsOpen}
                className={headBtn}
                aria-label="Playlist actions"
                title="Playlist actions"
              >
                <Ellipsis size={18} />
              </button>
              {actionsOpen && (
                <Deferred label="the playlist menu" onDismiss={() => (ActionsMenu.reset(), setActionsOpen(false))}>
                  <ActionsMenu p={p} playlist={playlist} onClose={closeActions} />
                </Deferred>
              )}
            </div>
          ) : (
            <button
              onClick={() => void onClear()}
              disabled={smart ? !anyPlays : !p.tracks.length}
              className={`${headBtn} hover:!text-red-400 disabled:opacity-30`}
              aria-label={smart ? 'Clear play counts' : 'Clear library'}
              title={smart ? 'Clear play counts' : 'Clear library'}
            >
              <Trash2 size={16} />
            </button>
          )}
        </div>
      </div>

      {smart && <p className="px-4 pb-2 text-xs text-zinc-400">{smart.description}</p>}

      <SearchBox
        value={text}
        onChange={setText}
        inputRef={searchRef}
        label={`Search ${noun}s`}
        landmark={`Search ${label.toLowerCase()}`}
        placeholder={`Search ${noun}s  ( / )`}
      />

      <ModeTabs mode={mode} modes={modes} onChange={browse.setMode} idBase={idBase} />

      <div role="tabpanel" id={`${idBase}-panel`} aria-labelledby={`${idBase}-${mode}`} className="flex min-h-0 flex-1 flex-col">
        {mode === 'list' && (
          <>
            <div className="flex items-center justify-between gap-2 px-4 pb-1">
              {rows.length > 0 ? (
                <p className="text-xs tabular-nums text-zinc-400" data-testid="library-summary">
                  {summary}
                </p>
              ) : (
                <span />
              )}
              {!smart && p.queue.length > 1 && (
                <SortMenu<SortKey> noun="tracks" options={sortOptions} value={p.sort} onChange={changeSort} describe={(s) => describeSort(s, manualName)} words={directionWords} stored="library" />
              )}
            </div>
            <TrackList
              p={p}
              rows={rows}
              label={smart ? `${smart.name} smart playlist` : inPlaylist ? `Tracks in ${playlist?.name ?? 'playlist'}` : 'Library tracks'}
              reorderable={query.empty && !smart && stored}
              removable={!smart}
              detail={detail}
              onPlay={(t) => p.play(t.id)}
              onEdit={(trackId) => setEditingId(trackId)}
              playlistId={p.viewId}
              empty={empty}
            />
          </>
        )}
        {mode === 'folders' && (
          <Deferred label="the folder view" onDismiss={() => (FolderTree.reset(), browse.setMode('list'))}>
            <FolderTree p={p} query={query} onEdit={(trackId) => setEditingId(trackId)} />
          </Deferred>
        )}
        {(mode === 'albums' || mode === 'artists') && (
          <Deferred label="the album and artist views" onDismiss={() => (Browse.reset(), browse.setMode('list'))}>
            <Browse p={p} mode={mode} query={query} text={trimmed} browse={browse} onEdit={(trackId) => setEditingId(trackId)} onPickFiles={onPickFiles} onPickFolder={onPickFolder} />
          </Deferred>
        )}
      </div>
      {editing && (
        <Deferred label="the tag editor" onDismiss={() => (TagEditor.reset(), setEditingId(null))}>
          <TagEditor key={editing.id} p={p} track={editing} onClose={() => setEditingId(null)} />
        </Deferred>
      )}
    </aside>
  )
}
