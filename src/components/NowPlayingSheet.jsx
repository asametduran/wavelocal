import { ChevronDown, ListMusic } from 'lucide-react'
import Cover from './Cover'
import { Transport } from './PlayerBar'
import { useSwipe } from '../hooks/useSwipe'

/** Full-screen Now Playing for phones. Drag down to minimize; swipe the artwork for prev/next. */
export default function NowPlayingSheet({ p, open, onClose, onOpenQueue }) {
  const { current, playing } = p
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

      <header className="relative flex items-center justify-between px-4 py-3">
        <button onClick={onClose} className="grid h-11 w-11 place-items-center rounded-full text-zinc-300 active:bg-white/10" aria-label="Minimize player">
          <ChevronDown size={28} />
        </button>
        <span className="text-xs font-semibold uppercase tracking-widest text-zinc-400">Now playing</span>
        <button onClick={onOpenQueue} className="grid h-11 w-11 place-items-center rounded-full text-zinc-300 active:bg-white/10" aria-label="Open queue">
          <ListMusic size={22} />
        </button>
      </header>

      <div className="relative flex min-h-0 flex-1 flex-col items-center justify-center px-8" {...art.handlers}>
        <div
          key={current?.id}
          className={`aspect-square w-full max-w-[min(100%,42dvh)] animate-fadeIn overflow-hidden rounded-2xl shadow-2xl shadow-black/60 ring-1 ring-white/10 transition-transform duration-500 ${playing ? 'scale-100' : 'scale-90'}`}
        >
          <Cover track={current} className="h-full w-full" iconSize={72} />
        </div>
        <div className="mt-6 w-full text-center">
          <h2 className="line-clamp-2 text-2xl font-bold tracking-tight">{current?.title ?? 'Nothing playing'}</h2>
          <p className="mt-1 truncate text-base text-zinc-300">{current?.artist}</p>
        </div>
      </div>

      <div className="relative px-5 pb-6 pt-2">
        <Transport p={p} big />
      </div>
    </div>
  )
}
