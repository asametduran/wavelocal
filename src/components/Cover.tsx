import { Music2 } from 'lucide-react'
import { fallbackGradient } from '../lib/format'
import type { Track } from '../types'

/** Embedded album art, or a deterministic procedural gradient when none exists. */
interface CoverProps {
  track?: Pick<Track, 'cover' | 'title' | 'artist'> | null
  className?: string
  iconSize?: number
}

export default function Cover({ track, className = '', iconSize = 24 }: CoverProps) {
  if (track?.cover) {
    return <img src={track.cover} alt="" draggable={false} className={`object-cover ${className}`} />
  }
  return (
    <div
      className={`grid place-items-center text-white/80 ${className}`}
      style={{ background: fallbackGradient(track ? `${track.title}${track.artist}` : 'empty') }}
      aria-hidden="true"
    >
      <Music2 size={iconSize} strokeWidth={1.5} />
    </div>
  )
}
