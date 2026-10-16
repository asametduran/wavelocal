import { useEffect, useMemo, useRef, useState } from 'react'
import { ChevronLeft, ListPlus, Play, Shuffle } from 'lucide-react'
import Cover from './Cover'
import PlaylistMenu from './PlaylistMenu'
import TrackList from './TrackList'
import type { ListRow } from './TrackList'
import type { BrowseApi } from '../hooks/useBrowse'
import { announce } from '../lib/a11y'
import { countLabel } from '../lib/format'
import { groupOf } from '../lib/groups'
import type { Groups } from '../lib/groups'
import { albumMeta, albumRows, artistMeta, artistRows } from '../lib/pages'
import { fold } from '../lib/search'
import type { Query } from '../lib/search'
import type { PlayerApi, Track } from '../types'

interface GroupPageProps {
  p: PlayerApi
  groups: Groups<Track>
  /** The page: `album:…` or `artist:…`. */
  page: string
  query: Query
  browse: BrowseApi
  /** What Back returns to from the first page ("Albums", "Artists"). */
  home: string
  onEdit: (trackId: string) => void
}

const pill = 'flex items-center gap-1.5 rounded-full px-4 py-2 text-sm font-semibold transition active:scale-95'

/**
 * An album or an artist as a page: cover, title and totals, what to do with all of it (play, shuffle, add to a playlist),
 * and its tracks in disc and track order. Playing from here keeps playing from here, whatever is browsed afterwards.
 */
export default function GroupPage({ p, groups, page, query, browse, home, onEdit }: GroupPageProps) {
  const ref = useMemo(() => groupOf(groups, page), [groups, page])
  const heading = useRef<HTMLHeadingElement>(null)
  const addButton = useRef<HTMLButtonElement>(null)
  const [adding, setAdding] = useState(false)

  // a page that opens takes the reader's place: screen readers hear its title, the keyboard starts at its top
  useEffect(() => heading.current?.focus({ preventScroll: true }), [page])

  const tracks = useMemo<readonly Track[]>(() => (ref ? (ref.kind === 'album' ? ref.album.tracks : ref.artist.tracks) : []), [ref])
  const ids = useMemo(() => tracks.map((t) => t.id), [tracks])
  const rows = useMemo<ListRow[]>(() => (!ref ? [] : ref.kind === 'album' ? albumRows(ref.album, query) : artistRows(ref.artist, query)), [ref, query])
  if (!ref) return null

  const album = ref.kind === 'album' ? ref.album : null
  const title = album ? album.title : ref.kind === 'artist' ? ref.artist.name : ''
  const meta = album ? albumMeta(album) : ref.kind === 'artist' ? artistMeta(ref.artist) : ''
  const art = album ? album.cover : ref.kind === 'artist' ? ref.artist.cover : null
  // an album links to its artist's page when there is one (not for compilations or albums with no album tag)
  const ownerId = album && !album.unknown && !album.compilation ? fold(album.artist) : ''
  const ownerPage = ownerId && groups.artistById.has(ownerId) ? `artist:${ownerId}` : null

  const before = groupOf(groups, browse.trail.at(-2) ?? '')
  const backName = before ? (before.kind === 'album' ? before.album.title : before.artist.name) : home
  const shown = rows.filter((r) => r.kind === 'track').length

  const closeMenu = (restoreFocus: boolean) => {
    setAdding(false)
    if (restoreFocus) requestAnimationFrame(() => addButton.current?.focus())
  }
  const addAll = (playlistId: string | null) => {
    if (playlistId === null) {
      const name = window.prompt('Name your new playlist')
      if (name === null) return
      p.createPlaylist(name, ids)
      announce(`Created playlist ${name.trim() || 'New playlist'} with ${countLabel(ids.length, 'track')}`)
    } else {
      const added = p.addTracksToPlaylist(playlistId, ids)
      const name = p.playlists.find((pl) => pl.id === playlistId)?.name ?? 'the playlist'
      announce(added ? `Added ${countLabel(added, 'track')} to ${name}` : `${name} already has ${ids.length === 1 ? 'this track' : 'all of these tracks'}`)
    }
    closeMenu(true)
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="px-4 pb-3">
        <button type="button" onClick={browse.back} className="-ml-1 mb-2 flex max-w-full items-center gap-1 rounded-full py-1 pl-1 pr-3 text-xs font-medium text-zinc-400 hover:bg-white/10 hover:text-white">
          <ChevronLeft size={15} className="shrink-0" aria-hidden="true" />
          <span className="truncate">Back to {backName}</span>
        </button>
        <div className="flex gap-4">
          <div className={`h-24 w-24 shrink-0 overflow-hidden bg-raised shadow-xl shadow-black/50 ring-1 ring-white/10 ${album ? 'rounded-xl' : 'rounded-full'}`}>
            <Cover track={{ cover: art?.cover ?? null, title, artist: album?.artist ?? '' }} className="h-full w-full" iconSize={36} />
          </div>
          <div className="min-w-0 flex-1 self-center">
            <h2 ref={heading} tabIndex={-1} className="line-clamp-2 text-lg font-bold leading-tight tracking-tight outline-none">
              {title}
            </h2>
            {album && album.artist && (
              <p className="mt-0.5 truncate text-sm text-zinc-300">
                {ownerPage ? (
                  <button type="button" onClick={() => browse.open(ownerPage)} className="rounded text-left hover:text-white hover:underline">
                    {album.artist}
                  </button>
                ) : (
                  album.artist
                )}
              </p>
            )}
            <p className="mt-1 text-xs tabular-nums text-zinc-400" data-testid="page-meta">
              {meta}
            </p>
          </div>
        </div>
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <button type="button" onClick={() => p.playFrom(ids)} aria-label={`Play ${title}`} className={`${pill} bg-accent text-on-accent hover:scale-105`}>
            <Play size={14} fill="currentColor" aria-hidden="true" /> Play
          </button>
          <button type="button" onClick={() => p.playFrom(ids, { shuffle: true })} aria-label={`Shuffle ${title}`} className={`${pill} bg-white/10 text-white hover:bg-white/15`}>
            <Shuffle size={14} aria-hidden="true" /> Shuffle
          </button>
          <div className="relative">
            <button ref={addButton} type="button" onClick={() => setAdding((a) => !a)} aria-haspopup="menu" aria-expanded={adding} aria-label={`Add to playlist: ${title}`} className={`${pill} bg-white/10 text-white hover:bg-white/15`}>
              <ListPlus size={15} aria-hidden="true" /> Add to playlist
            </button>
            {adding && <PlaylistMenu playlists={p.playlists} label={`Add ${title} to a playlist`} onChoose={addAll} onClose={closeMenu} className="absolute left-0 top-full z-20 mt-1 w-56" />}
          </div>
        </div>
      </div>
      {!query.empty && (
        <p className="px-4 pb-1 text-xs tabular-nums text-zinc-400" data-testid="library-summary">
          {shown} of {countLabel(ids.length, 'track')}
        </p>
      )}
      <TrackList
        p={p}
        rows={rows}
        label={album ? `Tracks on ${title}` : `Tracks by ${title}`}
        lead="number"
        onPlay={(t) => p.playFrom(ids, { startId: t.id })}
        onEdit={onEdit}
        onOpenHeading={browse.open}
        onPlayHeading={(list) => p.playFrom(list.map((t) => t.id))}
        empty={<li className="px-4 py-10 text-center text-sm text-zinc-400">No tracks match your search.</li>}
      />
    </div>
  )
}
