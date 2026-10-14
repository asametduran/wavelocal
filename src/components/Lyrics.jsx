import { useEffect, useRef } from 'react'
import { FileText } from 'lucide-react'
import { activeIndex } from '../lib/lrc'

/** Karaoke-style lyrics: the active line is highlighted and kept centered; tap a line to seek. */
export default function Lyrics({ track, time, onSeek, onLoad, className = '' }) {
  const lyr = track?.lyrics
  const lines = lyr?.lines || []
  const idx = lyr?.synced ? activeIndex(lines, time + 0.12) : -1
  const box = useRef(null)
  const refs = useRef([])

  useEffect(() => {
    box.current?.scrollTo({ top: 0 })
  }, [track?.id])

  useEffect(() => {
    const el = refs.current[idx]
    const c = box.current
    if (idx < 0 || !el || !c) return
    c.scrollTo({ top: el.offsetTop - c.clientHeight / 2 + el.clientHeight / 2, behavior: 'smooth' })
  }, [idx, track?.id])

  const loader = (
    <label className="inline-flex cursor-pointer items-center gap-2 rounded-full bg-white/10 px-4 py-2 text-sm font-semibold hover:bg-white/15 focus-within:outline focus-within:outline-2 focus-within:outline-accent">
      <FileText size={16} /> Load .lrc file
      <input
        type="file"
        accept=".lrc,.txt,text/plain"
        hidden
        onChange={(e) => {
          if (e.target.files?.[0]) onLoad?.(e.target.files[0])
          e.target.value = ''
        }}
      />
    </label>
  )

  if (!lines.length) {
    return (
      <div className={`grid place-items-center px-6 text-center ${className}`}>
        <div className="flex flex-col items-center gap-4">
          <p className="max-w-xs text-sm text-zinc-400">
            No lyrics for this track. Drop a <code className="text-zinc-300">.lrc</code> file with the same name next to your MP3, or load one now.
          </p>
          {loader}
        </div>
      </div>
    )
  }

  return (
    <div ref={box} data-noswipe className={`relative overflow-y-auto scroll-smooth px-4 text-center ${className}`} style={{ maskImage: 'linear-gradient(transparent, #000 15%, #000 85%, transparent)' }}>
      <div className="h-[40%]" />
      {lines.map((l, i) => {
        const dist = idx < 0 ? 0 : Math.abs(i - idx)
        const active = i === idx
        const cls = lyr.synced
          ? active
            ? 'scale-105 text-white opacity-100'
            : dist === 1
              ? 'opacity-60'
              : 'opacity-35'
          : 'opacity-90'
        return (
          <button
            key={i}
            ref={(el) => (refs.current[i] = el)}
            onClick={() => lyr.synced && onSeek?.(l.t)}
            disabled={!lyr.synced}
            className={`block w-full origin-center py-2 text-xl font-bold leading-snug text-zinc-200 transition-all duration-500 sm:text-2xl ${cls}`}
          >
            {l.text || '♪'}
          </button>
        )
      })}
      <div className="h-[40%]" />
      <div className="pb-4">{loader}</div>
    </div>
  )
}
