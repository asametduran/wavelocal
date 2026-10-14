import { Pause, Play, Repeat, Repeat1, Shuffle, SkipBack, SkipForward, Volume1, Volume2, VolumeX } from 'lucide-react'
import Cover from './Cover'
import Slider from './Slider'
import { formatTime } from '../lib/format'

const iconBtn =
  'grid h-9 w-9 place-items-center rounded-full text-zinc-400 transition hover:text-white focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent disabled:opacity-30 disabled:hover:text-zinc-400'

export default function PlayerBar({ p }) {
  const { current, playing, time, duration, volume, muted, repeat, shuffle } = p
  const empty = !current
  const effective = muted ? 0 : volume
  const VolIcon = effective === 0 ? VolumeX : effective < 0.5 ? Volume1 : Volume2
  const RepeatIcon = repeat === 'one' ? Repeat1 : Repeat

  return (
    <footer className="grid grid-cols-1 items-center gap-2 border-t border-white/5 bg-panel/90 px-4 py-3 backdrop-blur md:grid-cols-[1fr_minmax(320px,2fr)_1fr] md:gap-6">
      <div className="hidden min-w-0 items-center gap-3 md:flex">
        <Cover track={current} className="h-12 w-12 shrink-0 rounded-md" iconSize={18} />
        <div className="min-w-0">
          <div className="truncate text-sm font-medium">{current?.title ?? 'Nothing playing'}</div>
          <div className="truncate text-xs text-zinc-400">{current?.artist ?? 'Add some music to begin'}</div>
        </div>
      </div>

      <div className="flex flex-col items-center gap-1">
        <div className="flex items-center gap-1 sm:gap-2">
          <button className={`${iconBtn} ${shuffle ? '!text-accent' : ''}`} onClick={p.toggleShuffle} aria-pressed={shuffle} aria-label="Shuffle (S)" title="Shuffle (S)">
            <Shuffle size={18} />
          </button>
          <button className={iconBtn} onClick={p.prev} disabled={empty} aria-label="Previous (Shift+←)" title="Previous (P)">
            <SkipBack size={20} fill="currentColor" />
          </button>
          <button
            className="grid h-11 w-11 place-items-center rounded-full bg-white text-black transition hover:scale-105 focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent disabled:opacity-40 disabled:hover:scale-100"
            onClick={p.toggle}
            disabled={empty}
            aria-label={playing ? 'Pause (Space)' : 'Play (Space)'}
            title={playing ? 'Pause (Space)' : 'Play (Space)'}
          >
            {playing ? <Pause size={20} fill="currentColor" /> : <Play size={20} fill="currentColor" className="translate-x-px" />}
          </button>
          <button className={iconBtn} onClick={p.next} disabled={empty} aria-label="Next (Shift+→)" title="Next (N)">
            <SkipForward size={20} fill="currentColor" />
          </button>
          <button
            className={`${iconBtn} ${repeat !== 'off' ? '!text-accent' : ''}`}
            onClick={p.cycleRepeat}
            aria-label={`Repeat: ${repeat} (R)`}
            title={`Repeat: ${repeat} (R)`}
          >
            <RepeatIcon size={18} />
          </button>
        </div>
        <div className="flex w-full max-w-2xl items-center gap-3 text-[11px] tabular-nums text-zinc-400">
          <span className="w-10 text-right">{formatTime(time)}</span>
          <Slider value={time} max={duration} step={0.1} onChange={p.seek} label="Seek" />
          <span className="w-10">{formatTime(duration)}</span>
        </div>
      </div>

      <div className="hidden items-center justify-end gap-2 md:flex">
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
