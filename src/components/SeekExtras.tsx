import { useSyncExternalStore } from 'react'
import { Bookmark as BookmarkIcon, BookmarkPlus, ChevronLeft, ChevronRight, RotateCcw, RotateCw, X } from 'lucide-react'
import { useBookmarks } from '../hooks/useBookmarks'
import { useChapters } from '../hooks/useChapters'
import { useIsLongForm } from '../hooks/useProgress'
import { chapterIndexAt, nextChapterStart, previousChapterStart } from '../lib/chapters/navigate'
import { chaptersPanel } from '../lib/chapters/panel'
import { chapterPosition } from '../lib/chapters/speech'
import type { Chapter } from '../lib/chapters/types'
import { countLabel, formatTime } from '../lib/format'
import { markHere } from '../lib/listening/bookmarkcontrol'
import { showTools } from '../lib/listening/extras'
import { listeningService } from '../lib/listening/instance'
import { changeLoop, loopStart } from '../lib/listening/loopcontrol'
import { clearLoop, setLoopEnd, setLoopStart } from '../lib/listening/loopdraft'
import { toolsRow } from '../lib/listening/prefs'
import { SKIP_BACK, SKIP_FORWARD } from '../lib/listening/progress'
import type { PlayerApi } from '../types'

/**
 * The rows next to the seek bar for a recording to listen to in parts: for a file that has chapters, which one is playing, the
 * buttons for the one before and the one after, and the button that opens the list of them; and a row of loop and bookmark
 * buttons (the same things the L and B keys do), which for a long recording (a podcast, a lecture, a book: see `lib/listening/
 * progress.ts`) are flanked by buttons that go 15 seconds back and 30 forward. A song has none of this (nothing is drawn), so the
 * player looks as it always did, unless the person asked for the buttons to be there for every track. Loaded lazily, and mounted
 * in both seek bars (footer and phone sheet), which read the same stores.
 */

const step =
  'grid shrink-0 place-items-center rounded-full text-zinc-400 transition hover:text-white active:scale-95 disabled:opacity-30 disabled:hover:text-zinc-400'
const NO_CHAPTERS: readonly Chapter[] = []

function ChapterRow({ p, chapters, big }: { p: PlayerApi; chapters: readonly Chapter[]; big: boolean }) {
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

/** A, B, clear, add a bookmark, and the list: the buttons for what the L and B keys do, with the loop's ends written on them. */
function ToolsRow({ p, big, bookmarks }: { p: PlayerApi; big: boolean; bookmarks: number }) {
  const start = useSyncExternalStore(loopStart.subscribe, loopStart.get)
  const a = p.loop?.a ?? start
  const b = p.loop?.b ?? null
  const height = big ? 'h-10' : 'h-7'
  const icon = big ? 22 : 16
  const pill = `${height} ${big ? 'min-w-10' : 'min-w-7'} shrink-0 rounded-full px-3 font-semibold tabular-nums transition hover:text-white active:scale-95`
  const round = `${step} ${big ? 'h-10 w-10' : 'h-7 w-7'}`

  return (
    <div role="group" aria-label="Loop and bookmarks" className={`flex min-w-0 items-center justify-center gap-1 ${big ? 'text-sm' : 'text-xs'}`}>
      <button
        type="button"
        data-testid="loop-start"
        onClick={() => changeLoop(p, setLoopStart)}
        aria-label={a === null ? 'A, set loop start here' : `A ${formatTime(a)}, set loop start here`}
        title="Set the start of the loop here (L)"
        className={`${pill} ${a === null ? 'text-zinc-400' : 'bg-white/10 text-accent'}`}
      >
        {a === null ? 'A' : `A ${formatTime(a)}`}
      </button>
      <button
        type="button"
        data-testid="loop-end"
        onClick={() => changeLoop(p, setLoopEnd)}
        aria-label={b === null ? 'B, set loop end here' : `B ${formatTime(b)}, set loop end here`}
        title="Set the end of the loop here (L)"
        className={`${pill} ${b === null ? 'text-zinc-400' : 'bg-white/10 text-accent'}`}
      >
        {b === null ? 'B' : `B ${formatTime(b)}`}
      </button>
      <button type="button" data-testid="loop-clear" className={round} disabled={a === null} onClick={() => changeLoop(p, clearLoop)} aria-label="Clear the loop" title="Clear the loop (L)">
        <X size={icon} />
      </button>
      <span aria-hidden="true" className="mx-1 h-4 w-px shrink-0 bg-white/15" />
      <button type="button" data-testid="bookmark-add" className={round} onClick={() => markHere(listeningService, p)} aria-label="Add a bookmark here" title="Add a bookmark here (B)">
        <BookmarkPlus size={icon} />
      </button>
      <button
        type="button"
        data-testid="bookmark-open"
        aria-haspopup="dialog"
        onClick={() => chaptersPanel.set(true)}
        aria-label={bookmarks > 0 ? `Chapters and bookmarks, ${countLabel(bookmarks, 'bookmark')}` : 'Chapters and bookmarks'}
        title="Chapters and bookmarks (C)"
        className={`${step} ${height} ${bookmarks > 0 ? 'gap-1 px-2' : big ? 'w-10' : 'w-7'}`}
      >
        <span className="flex items-center gap-1">
          <BookmarkIcon size={icon} />
          {bookmarks > 0 && <span className="tabular-nums">{bookmarks}</span>}
        </span>
      </button>
    </div>
  )
}

/** Back 15 seconds, forward 30: for a long recording, where a person goes back to hear again what was missed and on past an advert. */
function SkipButton({ p, back, big }: { p: PlayerApi; back: boolean; big: boolean }) {
  const seconds = back ? SKIP_BACK : SKIP_FORWARD
  const label = `${back ? 'Back' : 'Forward'} ${seconds} seconds`
  const Icon = back ? RotateCcw : RotateCw
  return (
    <button
      type="button"
      data-testid={back ? 'skip-back' : 'skip-forward'}
      onClick={() => p.seekBy(back ? -seconds : seconds)}
      aria-label={label}
      title={label}
      className={`inline-flex shrink-0 items-center gap-1 rounded-full font-semibold tabular-nums text-zinc-400 transition hover:text-white active:scale-95 ${big ? 'h-10 px-2.5 text-sm' : 'h-7 px-2 text-xs'}`}
    >
      <Icon size={big ? 22 : 16} />
      <span>{seconds}</span>
    </button>
  )
}

export default function SeekExtras({ p, big }: { p: PlayerApi; big: boolean }) {
  const chapterState = useChapters(p.current?.id)
  const chapters = chapterState.status === 'ready' ? chapterState.chapters : NO_CHAPTERS
  const bookmarks = useBookmarks(p.current?.key).length
  const start = useSyncExternalStore(loopStart.subscribe, loopStart.get)
  const always = useSyncExternalStore(toolsRow.subscribe, toolsRow.get) === 'always'
  const length = p.duration || p.current?.duration || 0
  const long = useIsLongForm(p.current, length)
  const tools = showTools({ always, chapters: chapters.length, looping: p.loop !== null || start !== null, bookmarks, long })
  if (chapters.length === 0 && !tools) return null

  return (
    <div className="flex w-full min-w-0 flex-col items-center gap-1">
      {chapters.length > 0 && <ChapterRow p={p} chapters={chapters} big={big} />}
      {tools && (
        <div className={`flex w-full min-w-0 flex-wrap items-center justify-center gap-x-2 gap-y-1 ${big ? '' : 'max-w-2xl'}`}>
          {long && <SkipButton p={p} back big={big} />}
          <ToolsRow p={p} big={big} bookmarks={bookmarks} />
          {long && <SkipButton p={p} back={false} big={big} />}
        </div>
      )}
    </div>
  )
}
