import { ChevronLeft, ChevronRight } from 'lucide-react'
import { useChapters } from '../hooks/useChapters'
import { chapterIndexAt, nextChapterStart, previousChapterStart } from '../lib/chapters/navigate'
import { chaptersPanel } from '../lib/chapters/panel'
import { chapterPosition } from '../lib/chapters/speech'
import { countLabel } from '../lib/format'
import type { PlayerApi } from '../types'

/**
 * The row next to the seek bar for a file that has chapters: which one is playing, the buttons for the one before and the one
 * after, and the button that opens the list of them. A song has none of this (the row is not there), so the player looks as it
 * always did. Loaded lazily, and mounted in both seek bars (footer and phone sheet), which read the same chapters.
 */

const step =
  'grid shrink-0 place-items-center rounded-full text-zinc-400 transition hover:text-white active:scale-95 disabled:opacity-30 disabled:hover:text-zinc-400'

export default function SeekExtras({ p, big }: { p: PlayerApi; big: boolean }) {
  const state = useChapters(p.current?.id)
  if (state.status !== 'ready' || state.chapters.length === 0) return null
  const { chapters } = state
  const index = chapterIndexAt(chapters, p.time)
  const chapter = chapters[index]
  const before = previousChapterStart(chapters, p.time)
  const after = nextChapterStart(chapters, p.time)
  const size = big ? 'h-10 w-10' : 'h-7 w-7'
  const icon = big ? 22 : 16

  return (
    <div role="group" aria-label="Chapters" className={`flex w-full min-w-0 items-center justify-center gap-1 ${big ? 'text-sm' : 'max-w-2xl text-xs'}`}>
      <button type="button" className={`${step} ${size}`} disabled={before === null} onClick={() => before !== null && p.seek(before)} aria-label="Previous chapter (,)" title="Previous chapter (,)">
        <ChevronLeft size={icon} />
      </button>
      <button
        type="button"
        data-testid="chapter-open"
        aria-haspopup="dialog"
        onClick={() => chaptersPanel.set(true)}
        title="All chapters (C)"
        className="flex min-w-0 max-w-full items-baseline justify-center gap-2 rounded-full px-3 py-1 text-zinc-200 transition hover:bg-white/10"
      >
        {chapter ? (
          <>
            <span className="shrink-0 tabular-nums text-zinc-400">
              <span className="sr-only">Chapter </span>
              {chapterPosition(index, chapters.length)}
            </span>
            <span className="truncate" data-testid="chapter-name">
              {chapter.title}
            </span>
          </>
        ) : (
          <span>{countLabel(chapters.length, 'chapter')}</span>
        )}
      </button>
      <button type="button" className={`${step} ${size}`} disabled={after === null} onClick={() => after !== null && p.seek(after)} aria-label="Next chapter (.)" title="Next chapter (.)">
        <ChevronRight size={icon} />
      </button>
    </div>
  )
}
