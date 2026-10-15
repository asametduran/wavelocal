import { Pause, Play, Repeat, Repeat1, Shuffle, SkipBack, SkipForward, SlidersHorizontal, Volume1, Volume2, VolumeX } from 'lucide-react'
import Cover from './Cover'
import Slider from './Slider'
import { formatTime } from '../lib/format'
import { useSwipe } from '../hooks/useSwipe'
import type { PlayerApi } from '../types'

const iconBtn =
  'grid h-9 w-9 place-items-center rounded-full text-zinc-400 transition hover:text-white active:scale-95 disabled:opacity-30 disabled:hover:text-zinc-400'

/** Shuffle / prev / play / next / repeat + seek bar. `big` = thumb-sized for the phone sheet. */
export function Transport({ p, big = false }: { p: PlayerApi; big?: boolean }) {
  const { current, playing, time, duration, repeat, shuffle } = p
  const empty = !current
  const RepeatIcon = repeat === 'one' ? Repeat1 : Repeat
  const btn = big ? 'h-12 w-12' : 'h-9 w-9'
  const playBtn = big ? 'h-16 w-16' : 'h-11 w-11'

  return (
    <div className={`flex w-full items-center gap-1 ${big ? 'flex-col' : 'flex-col-reverse'}`}>
      <div className={`flex w-full items-center gap-3 tabular-nums text-zinc-400 ${big ? 'mb-3 text-xs' : 'max-w-2xl text-[11px]'}`}>
        <span className="w-10 text-right">{formatTime(time)}</span>
        <Slider value={time} max={duration} step={0.1} onChange={p.seek} label="Seek" />
        <span className="w-10">{formatTime(duration)}</span>
      </div>
      <div className={`flex items-center ${big ? 'w-full justify-between' : 'gap-1 sm:gap-2'}`}>
        <button className={`${iconBtn} ${btn} ${shuffle ? '!text-accent' : ''}`} onClick={p.toggleShuffle} aria-pressed={shuffle} aria-label="Shuffle (S)" title="Shuffle (S)">
          <Shuffle size={big ? 22 : 18} />
        </button>
        <button className={`${iconBtn} ${btn}`} onClick={p.prev} disabled={empty} aria-label="Previous (P)" title="Previous (P)">
          <SkipBack size={big ? 28 : 20} fill="currentColor" />
        </button>
        <button
          className={`grid ${playBtn} place-items-center rounded-full bg-white text-black transition hover:scale-105 active:scale-95 disabled:opacity-40 disabled:hover:scale-100`}
          onClick={p.toggle}
          disabled={empty}
          data-autofocus
          aria-label={playing ? 'Pause (Space)' : 'Play (Space)'}
          title={playing ? 'Pause (Space)' : 'Play (Space)'}
        >
          {playing ? <Pause size={big ? 28 : 20} fill="currentColor" /> : <Play size={big ? 28 : 20} fill="currentColor" className="translate-x-px" />}
        </button>
        <button className={`${iconBtn} ${btn}`} onClick={p.next} disabled={empty} aria-label="Next (N)" title="Next (N)">
          <SkipForward size={big ? 28 : 20} fill="currentColor" />
        </button>
        <button
          className={`${iconBtn} ${btn} ${repeat !== 'off' ? '!text-accent' : ''}`}
          onClick={p.cycleRepeat}
          aria-label={`Repeat: ${repeat} (R)`}
          title={`Repeat: ${repeat} (R)`}
        >
          <RepeatIcon size={big ? 22 : 18} />
        </button>
      </div>
    </div>
  )
}

/** Compact phone player pinned to the bottom. Tap or swipe up to expand. */
export function MiniBar({ p, onOpen }: { p: PlayerApi; onOpen: () => void }) {
  const { current, playing, time, duration } = p
  const { handlers } = useSwipe({ onUp: onOpen, threshold: 40 })
  if (!current) return null
  const pct = duration > 0 ? Math.min(100, (time / duration) * 100) : 0

  return (
    <div className="border-t border-white/5 bg-panel pb-safe md:hidden" {...handlers}>
      <div className="h-0.5 bg-white/10">
        <div className="h-full bg-accent" style={{ width: `${pct}%` }} />
      </div>
      <div className="flex items-center gap-2 px-3 py-2">
        <button onClick={onOpen} className="flex min-w-0 flex-1 items-center gap-3 rounded-lg text-left" aria-label="Open now playing">
          <Cover track={current} className="h-12 w-12 shrink-0 rounded-md" iconSize={18} />
          <div className="min-w-0">
            <div className="truncate text-sm font-medium">{current.title}</div>
            <div className="truncate text-xs text-zinc-400">{current.artist}</div>
          </div>
        </button>
        <button onClick={p.toggle} className="grid h-12 w-12 shrink-0 place-items-center rounded-full bg-white text-black active:scale-95" aria-label={playing ? 'Pause' : 'Play'}>
          {playing ? <Pause size={22} fill="currentColor" /> : <Play size={22} fill="currentColor" className="translate-x-px" />}
        </button>
        <button onClick={p.next} className="grid h-12 w-12 shrink-0 place-items-center rounded-full text-zinc-300 active:bg-white/10" aria-label="Next">
          <SkipForward size={22} fill="currentColor" />
        </button>
      </div>
    </div>
  )
}

/** Tablet / desktop / TV footer. */
export default function PlayerBar({ p, onOpenTools }: { p: PlayerApi; onOpenTools: () => void }) {
  const { current, volume, muted, sleepLeft } = p
  const effective = muted ? 0 : volume
  const VolIcon = effective === 0 ? VolumeX : effective < 0.5 ? Volume1 : Volume2

  return (
    <footer className="hidden items-center gap-6 border-t border-white/5 bg-panel/90 px-4 py-3 backdrop-blur md:grid md:grid-cols-[1fr_minmax(320px,2fr)_1fr]">
      <div className="flex min-w-0 items-center gap-3">
        <Cover track={current} className="h-12 w-12 shrink-0 rounded-md" iconSize={18} />
        <div className="min-w-0">
          <div className="truncate text-sm font-medium">{current?.title ?? 'Nothing playing'}</div>
          <div className="truncate text-xs text-zinc-400">{current?.artist ?? 'Add some music to begin'}</div>
        </div>
      </div>

      <Transport p={p} />

      <div className="flex items-center justify-end gap-2">
        <button className={`${iconBtn} !w-auto gap-1 px-2 ${sleepLeft !== null ? '!text-accent' : ''}`} onClick={onOpenTools} aria-label="Equalizer, sleep timer and transitions (E)" title="Equalizer, sleep timer, transitions (E)">
          <SlidersHorizontal size={19} />
          {sleepLeft !== null && <span className="text-xs tabular-nums">{Math.floor(sleepLeft / 60)}:{String(sleepLeft % 60).padStart(2, '0')}</span>}
        </button>
        <button className={iconBtn} onClick={p.toggleMute} aria-label={muted ? 'Unmute (M)' : 'Mute (M)'} title={muted ? 'Unmute (M)' : 'Mute (M)'}>
          <VolIcon size={20} />
        </button>
        <div className="w-28">
          <Slider value={effective} max={1} step={0.01} onChange={p.setVolume} label="Volume" />
        </div>
      </div>
    </footer>
  )
}
