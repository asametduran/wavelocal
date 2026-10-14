import { Music2 } from 'lucide-react'
import { fallbackGradient } from '../lib/format'

/** Embedded album art, or a deterministic procedural gradient when none exists. */
export default function Cover({ track, className = '', iconSize = 24 }) {
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
