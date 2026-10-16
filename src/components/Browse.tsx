import { useEffect, useMemo, useRef, useState } from 'react'
import type { MutableRefObject, ReactNode } from 'react'
import { LocateFixed, Play } from 'lucide-react'
import Cover from './Cover'
import GroupPage from './GroupPage'
import SortMenu from './SortMenu'
import { Bars } from './TrackList'
import VirtualGrid from './VirtualGrid'
import type { GridRestore } from './VirtualGrid'
import { useRemScale } from '../hooks/useRemScale'
import { useStored } from '../hooks/useStored'
import type { BrowseApi } from '../hooks/useBrowse'
import { announce, matchAnnouncement, sortAnnouncement } from '../lib/a11y'
import { countLabel, dotted } from '../lib/format'
import { gridMetrics } from '../lib/grid'
import { ALBUM_SORTS, describeAlbumSort, filterGroups, getGroups, groupOf, parseAlbumSort, sortAlbums } from '../lib/groups'
import type { Album, AlbumSortKey, Artist, Groups } from '../lib/groups'
import { artistLine, cardSubtitle } from '../lib/pages'
import type { Query } from '../lib/search'
import { directionWords } from '../lib/sort'
import type { PlayerApi, Track } from '../types'

type Mode = 'albums' | 'artists'

/** What a grid needs to remember while a page is open on top of it. */
interface Memory {
  saved: Partial<Record<Mode, GridRestore>>
  scrollTop: number
}

interface ViewProps {
  p: PlayerApi
  groups: Groups<Track>
  query: Query
  /** The trimmed search text, for announcements. */
  text: string
  browse: BrowseApi
  memory: MutableRefObject<Memory>
  onPickFiles: () => void
  onPickFolder: () => void
}

const locateBtn = 'grid h-7 w-7 place-items-center rounded-full text-zinc-300 hover:bg-white/10 hover:text-white disabled:opacity-30'

function Empty({ p, noun, onPickFiles, onPickFolder }: { p: PlayerApi; noun: string; onPickFiles: () => void; onPickFolder: () => void }): ReactNode {
  if (p.queue.length) return <p className="px-2 py-10 text-center text-sm text-zinc-400">No {noun}s match your search.</p>
  return (
    <div className="flex flex-col items-center gap-4 px-4 py-10 text-center text-sm text-zinc-400">
      {p.viewId === 'all' ? `Your ${noun}s show up here once you add some music.` : `Nothing here yet, so there are no ${noun}s to browse.`}
      {p.viewId === 'all' && (
        <div className="flex gap-2">
          <button onClick={onPickFiles} className="rounded-full bg-white px-4 py-2 text-sm font-semibold text-black">Add files</button>
          <button onClick={onPickFolder} className="rounded-full bg-white/10 px-4 py-2 text-sm font-semibold text-white">Add folder</button>
        </div>
      )}
    </div>
  )
}

// ---- albums --------------------------------------------------------------------------------------------------------

interface AlbumCardProps {
  album: Album<Track>
  active: boolean
  playing: boolean
  tabIndex: 0 | -1
  /** Height of the text under the cover, in px, which the play button must stay clear of. */
  labelHeight: number
  onOpen: () => void
  onPlay: () => void
}

function AlbumCard({ album, active, playing, tabIndex, labelHeight, onOpen, onPlay }: AlbumCardProps) {
  const subtitle = cardSubtitle(album)
  return (
    <div className="group relative h-full">
      <button type="button" data-main tabIndex={tabIndex} onClick={onOpen} aria-label={`${album.title}, ${subtitle}`} aria-current={active ? 'true' : undefined} className="block h-full w-full rounded-xl text-left">
        <div className="relative aspect-square w-full overflow-hidden rounded-xl bg-raised shadow-lg shadow-black/40 ring-1 ring-white/10 transition duration-200 group-hover:ring-white/30">
          <Cover track={{ cover: album.cover?.cover ?? null, title: album.title, artist: album.artist }} className="h-full w-full" iconSize={36} />
          {active && playing && (
            <div className="absolute inset-0 grid place-items-center bg-black/40">
              <Bars />
            </div>
          )}
        </div>
        <div className="px-0.5 pt-2">
          <div className={`truncate text-sm font-medium ${active ? 'text-accent' : ''}`}>{album.title}</div>
          <div className="truncate text-xs text-zinc-400">{subtitle}</div>
        </div>
      </button>
      <button
        type="button"
        tabIndex={tabIndex}
        onClick={onPlay}
        aria-label={`Play ${album.title}`}
        title="Play"
        style={{ bottom: labelHeight + 8 }}
        className="absolute right-2 grid h-10 w-10 place-items-center rounded-full bg-accent text-on-accent opacity-0 shadow-lg shadow-black/40 transition hover:scale-105 focus-visible:opacity-100 group-focus-within:opacity-100 group-hover:opacity-100 [@media(hover:none)]:opacity-100"
      >
        <Play size={16} fill="currentColor" className="translate-x-px" aria-hidden="true" />
      </button>
    </div>
  )
}

function AlbumsView({ p, groups, query, text, browse, memory, onPickFiles, onPickFolder }: ViewProps) {
  const scale = useRemScale()
  const [sort, setSort] = useStored('wl-album-sort', parseAlbumSort)
  const shown = useMemo(() => sortAlbums(filterGroups(groups.albums, query), sort.key, sort.dir), [groups, query, sort])
  const trackCount = useMemo(() => shown.reduce((n, a) => n + a.tracks.length, 0), [shown])
  const [reveal, setReveal] = useState<{ key: string; nonce: number } | null>(null)
  const [restore] = useState(() => memory.current.saved.albums)
  useEffect(() => {
    delete memory.current.saved.albums // used once: the next visit starts at the top again
  }, [memory])
  const playing = p.currentId ? groups.albumOfTrack.get(p.currentId) : undefined

  // say how many albums match, once typing pauses
  useEffect(() => {
    if (!text) return undefined
    const timer = window.setTimeout(() => announce(matchAnnouncement(shown.length, text, 'album')), 500)
    return () => window.clearTimeout(timer)
  }, [text, shown.length])

  const gap = Math.round(12 * scale)
  const labelHeight = Math.round(44 * scale)
  const min = Math.round(120 * scale)

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex items-center justify-between gap-2 px-4 pb-1">
        <p className="text-xs tabular-nums text-zinc-400" data-testid="library-summary">
          {dotted(countLabel(shown.length, 'album'), countLabel(trackCount, 'track'))}
        </p>
        <span className="flex min-w-0 items-center gap-1">
          <button type="button" disabled={!playing} onClick={() => playing && setReveal({ key: playing, nonce: (reveal?.nonce ?? 0) + 1 })} className={locateBtn} aria-label="Show playing album" title="Show playing album">
            <LocateFixed size={14} />
          </button>
          <SortMenu<AlbumSortKey>
            noun="albums"
            options={ALBUM_SORTS}
            value={sort}
            onChange={(next) => {
              setSort(next)
              announce(sortAnnouncement(describeAlbumSort(next), false))
            }}
            describe={describeAlbumSort}
            words={directionWords}
          />
        </span>
      </div>
      <VirtualGrid
        items={shown}
        itemKey={(album) => album.id}
        layout={(width) => gridMetrics(width, { min, gap, label: labelHeight })}
        gap={gap}
        label="Albums"
        restore={restore}
        reveal={reveal}
        onScroll={(top) => {
          memory.current.scrollTop = top
        }}
        empty={<Empty p={p} noun="album" onPickFiles={onPickFiles} onPickFolder={onPickFolder} />}
        renderItem={(album, { tabIndex }) => (
          <AlbumCard
            album={album}
            active={album.id === playing}
            playing={p.playing}
            tabIndex={tabIndex}
            labelHeight={labelHeight}
            onOpen={() => {
              memory.current.saved.albums = { scrollTop: memory.current.scrollTop, focusKey: album.id }
              browse.open(`album:${album.id}`)
            }}
            onPlay={() => p.playFrom(album.tracks.map((t) => t.id))}
          />
        )}
      />
    </div>
  )
}

// ---- artists -------------------------------------------------------------------------------------------------------

const ARTIST_ROW = 64

function ArtistsView({ p, groups, query, text, browse, memory, onPickFiles, onPickFolder }: ViewProps) {
  const scale = useRemScale()
  const shown = useMemo(() => filterGroups(groups.artists, query), [groups, query])
  const trackCount = useMemo(() => shown.reduce((n, a) => n + a.tracks.length, 0), [shown])
  const [reveal, setReveal] = useState<{ key: string; nonce: number } | null>(null)
  const [restore] = useState(() => memory.current.saved.artists)
  useEffect(() => {
    delete memory.current.saved.artists
  }, [memory])
  const playing = p.currentId ? groups.artistOfTrack.get(p.currentId) : undefined

  useEffect(() => {
    if (!text) return undefined
    const timer = window.setTimeout(() => announce(matchAnnouncement(shown.length, text, 'artist')), 500)
    return () => window.clearTimeout(timer)
  }, [text, shown.length])

  const rowHeight = Math.round(ARTIST_ROW * scale)

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex items-center justify-between gap-2 px-4 pb-1">
        <p className="text-xs tabular-nums text-zinc-400" data-testid="library-summary">
          {dotted(countLabel(shown.length, 'artist'), countLabel(trackCount, 'track'))}
        </p>
        <button type="button" disabled={!playing} onClick={() => playing && setReveal({ key: playing, nonce: (reveal?.nonce ?? 0) + 1 })} className={locateBtn} aria-label="Show playing artist" title="Show playing artist">
          <LocateFixed size={14} />
        </button>
      </div>
      <VirtualGrid
        items={shown}
        itemKey={(artist) => artist.id}
        layout={(width) => ({ columns: 1, cell: width, rowHeight })}
        gap={0}
        label="Artists"
        restore={restore}
        reveal={reveal}
        onScroll={(top) => {
          memory.current.scrollTop = top
        }}
        empty={<Empty p={p} noun="artist" onPickFiles={onPickFiles} onPickFolder={onPickFolder} />}
        renderItem={(artist, { tabIndex }) => (
          <ArtistRow
            artist={artist}
            active={artist.id === playing}
            tabIndex={tabIndex}
            onOpen={() => {
              memory.current.saved.artists = { scrollTop: memory.current.scrollTop, focusKey: artist.id }
              browse.open(`artist:${artist.id}`)
            }}
            onPlay={() => p.playFrom(artist.tracks.map((t) => t.id))}
          />
        )}
      />
    </div>
  )
}

function ArtistRow({ artist, active, tabIndex, onOpen, onPlay }: { artist: Artist<Track>; active: boolean; tabIndex: 0 | -1; onOpen: () => void; onPlay: () => void }) {
  const line = artistLine(artist)
  return (
    <div className={`group relative flex h-full items-center gap-2 rounded-xl px-2 ${active ? 'bg-white/10' : 'hover:bg-white/5'}`}>
      <button type="button" data-main tabIndex={tabIndex} onClick={onOpen} aria-label={`${artist.name}, ${line}`} aria-current={active ? 'true' : undefined} className="flex min-w-0 flex-1 items-center gap-3 rounded-lg py-1 text-left">
        <div className="h-12 w-12 shrink-0 overflow-hidden rounded-full bg-raised ring-1 ring-white/10">
          <Cover track={{ cover: artist.cover?.cover ?? null, title: artist.name, artist: '' }} className="h-full w-full" iconSize={20} />
        </div>
        <div className="min-w-0">
          <div className={`truncate text-sm font-medium ${active ? 'text-accent' : ''}`}>{artist.name}</div>
          <div className="truncate text-xs text-zinc-400">{line}</div>
        </div>
      </button>
      <button
        type="button"
        tabIndex={tabIndex}
        onClick={onPlay}
        aria-label={`Play ${artist.name}`}
        title="Play"
        className="grid h-9 w-9 shrink-0 place-items-center rounded-full text-zinc-300 opacity-0 transition hover:bg-white/10 hover:text-white focus-visible:opacity-100 group-focus-within:opacity-100 group-hover:opacity-100 [@media(hover:none)]:opacity-100"
      >
        <Play size={15} fill="currentColor" className="translate-x-px" aria-hidden="true" />
      </button>
    </div>
  )
}

// ---- the root ------------------------------------------------------------------------------------------------------

interface BrowseProps {
  p: PlayerApi
  mode: Mode
  query: Query
  /** The trimmed search text, for announcements. */
  text: string
  browse: BrowseApi
  onEdit: (trackId: string) => void
  onPickFiles: () => void
  onPickFolder: () => void
}

/**
 * The Albums and Artists views of the list on screen, and the album and artist pages opened from them. Loaded on demand:
 * a reader who only ever uses the track list never downloads it.
 */
export default function Browse({ p, mode, query, text, browse, onEdit, onPickFiles, onPickFolder }: BrowseProps) {
  // the list on screen, grouped once however often the player re-renders
  const groups = useMemo(() => getGroups(p.queue), [p.queue])
  const memory = useRef<Memory>({ saved: {}, scrollTop: 0 })

  // a page whose tracks are gone (removed, or retagged into another album) closes instead of showing nothing
  const { prune } = browse
  useEffect(() => prune((ref) => groupOf(groups, ref) !== null), [groups, prune])

  const page = browse.page
  if (page && groupOf(groups, page)) {
    return <GroupPage key={page} p={p} groups={groups} page={page} query={query} browse={browse} home={mode === 'albums' ? 'Albums' : 'Artists'} onEdit={onEdit} />
  }
  const View = mode === 'albums' ? AlbumsView : ArtistsView
  return <View key={mode} p={p} groups={groups} query={query} text={text} browse={browse} memory={memory} onPickFiles={onPickFiles} onPickFolder={onPickFolder} />
}
