import { formatBadge, isHiRes, spokenFormat } from '../lib/format'
import type { AudioFormat } from '../lib/audio/probe/types'

/** What the playing file is, in a few words ("FLAC · 96 kHz · 24-bit"), with a Hi-Res mark for lossless above CD quality. Nothing when the format is unknown. */
export default function FormatBadge({ audio, className = '' }: { audio: AudioFormat | null | undefined; className?: string }) {
  const text = formatBadge(audio)
  if (!text) return null
  const hires = isHiRes(audio)
  return (
    <p className={`inline-flex items-center gap-2 text-xs text-zinc-400 ${className}`} data-testid="format-badge">
      <span className="sr-only">
        Audio format: {spokenFormat(audio)}
        {hires ? ', high resolution' : ''}
      </span>
      <span aria-hidden="true">{text}</span>
      {hires && (
        <span aria-hidden="true" className="rounded bg-accent/20 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-accent">
          Hi-Res
        </span>
      )}
    </p>
  )
}
