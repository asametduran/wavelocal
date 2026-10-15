import { useState } from 'react'
import { ChevronDown, ListMusic, SlidersHorizontal } from 'lucide-react'
import Cover from './Cover'
import Lyrics from './Lyrics'
import Visualizer from './Visualizer'
import { StageTabs } from './NowPlaying'
import type { StageTab } from './NowPlaying'
import type { PlayerApi } from '../types'
import { Transport } from './PlayerBar'
import { useSwipe } from '../hooks/useSwipe'

/** Full-screen Now Playing for phones. Drag down to minimize; swipe the artwork for prev/next. */
interface NowPlayingSheetProps {
  p: PlayerApi
  open: boolean
  onClose: () => void
  onOpenQueue: () => void
  onOpenTools: () => void
}

export default function NowPlayingSheet({ p, open, onClose, onOpenQueue, onOpenTools }: NowPlayingSheetProps) {
  const { current, playing } = p
  const [tab, setTab] = useState<StageTab>('art')
  const sheet = useSwipe({ onDown: onClose, trackDown: true, threshold: 110 })
  const art = useSwipe({ onLeft: p.next, onRight: p.prev, threshold: 60 })

  return (
    <div
      inert={!open}
      data-modal={open}
      aria-hidden={!open}
      role="dialog"
      aria-label="Now playing"
      className="fixed inset-0 z-40 flex flex-col overflow-hidden bg-base pb-safe pt-safe md:hidden"
      style={{
        transform: open ? `translateY(${sheet.dy}px)` : 'translateY(100%)',
        transition: sheet.dy ? 'none' : 'transform .3s cubic-bezier(.2,.8,.2,1)',
      }}
      {...sheet.handlers}
    >
      {current?.cover && (
        <img src={current.cover} alt="" className="pointer-events-none absolute inset-0 h-full w-full scale-125 object-cover opacity-30 blur-3xl" />
      )}
      <div className="pointer-events-none absolute inset-0 bg-gradient-to-b from-base/20 via-base/60 to-base" />

      <header className="relative flex items-center justify-between px-3 py-2">
        <button onClick={onClose} className="grid h-11 w-11 place-items-center rounded-full text-zinc-300 active:bg-white/10" aria-label="Minimize player">
          <ChevronDown size={28} />
        </button>
        <StageTabs tab={tab} setTab={setTab} hasLyrics={!!current?.lyrics} />
        <div className="flex">
          <button onClick={onOpenTools} className="grid h-11 w-11 place-items-center rounded-full text-zinc-300 active:bg-white/10" aria-label="Equalizer and tools">
            <SlidersHorizontal size={20} />
          </button>
          <button onClick={onOpenQueue} className="grid h-11 w-11 place-items-center rounded-full text-zinc-300 active:bg-white/10" aria-label="Open queue">
            <ListMusic size={22} />
          </button>
        </div>
      </header>

      {tab === 'art' ? (
        <div className="relative flex min-h-0 flex-1 flex-col items-center justify-center px-8" {...art.handlers}>
          <div
            key={current?.id}
            className={`aspect-square w-full max-w-[min(100%,36dvh)] animate-fadeIn overflow-hidden rounded-2xl shadow-2xl shadow-black/60 ring-1 ring-white/10 transition-transform duration-500 ${playing ? 'scale-100' : 'scale-90'}`}
          >
            <Cover track={current} className="h-full w-full" iconSize={72} />
          </div>
          <div className="mt-5 w-full text-center">
            <h2 className="line-clamp-2 text-2xl font-bold tracking-tight">{current?.title ?? 'Nothing playing'}</h2>
            <p className="mt-1 truncate text-base text-zinc-300">{current?.artist}</p>
          </div>
          <Visualizer engine={p.engine} playing={playing} className="mt-4 h-12" />
        </div>
      ) : (
        <div className="relative flex min-h-0 flex-1 flex-col px-2">
          <div className="mb-1 text-center">
            <div className="truncate text-sm font-semibold">{current?.title}</div>
            <div className="truncate text-xs text-zinc-400">{current?.artist}</div>
          </div>
          <Lyrics track={current} time={p.time} onSeek={p.seek} onLoad={p.attachLrc} className="min-h-0 flex-1" />
        </div>
      )}

      <div className="relative px-5 pb-6 pt-2">
        <Transport p={p} big />
      </div>
    </div>
  )
}
