import { useEffect, useId, useRef } from 'react'
import type { KeyboardEvent } from 'react'
import { createPortal } from 'react-dom'
import { BookmarkPlus, Pencil, Trash2, X } from 'lucide-react'
import { useDialog, useRovingKeys } from '../hooks/useA11y'
import { useBookmarkState, useBookmarks } from '../hooks/useBookmarks'
import { useChapters } from '../hooks/useChapters'
import { isBackKey } from '../hooks/useHotkeys'
import { useInertPage } from '../hooks/useInertPage'
import { useIsLongForm, useProgress } from '../hooks/useProgress'
import { openBackLayer } from '../lib/backlayer'
import { chapterIndexAt } from '../lib/chapters/navigate'
import { countLabel, dotted, formatTime } from '../lib/format'
import { deleteMark, markHere, renameMark } from '../lib/listening/bookmarkcontrol'
import { listeningService, progressService } from '../lib/listening/instance'
import type { Mode } from '../lib/listening/progress'
import type { Bookmark } from '../lib/listening/types'
import type { PlayerApi } from '../types'

/**
 * The chapters and the bookmarks of the playing track as lists. Choosing a chapter or a bookmark jumps to it and closes the
 * dialog; the one playing is marked. A modal dialog like the other panels (focus stays inside, the page behind is inert, Escape
 * and the system's Back close it); the arrow keys, Home and End move through the rows, so a book of a hundred chapters is not a
 * hundred Tab stops. On a bookmark, F2 renames it and Delete removes it (with an Undo), as do the buttons beside it.
 */

interface ChaptersModalProps {
  p: PlayerApi
  open: boolean
  onClose: () => void
}

const rowButton = 'grid h-8 w-8 shrink-0 place-items-center rounded-full text-zinc-400 transition hover:text-white active:scale-95'
const MODES: readonly (readonly [id: Mode, label: string])[] = [
  ['auto', 'Automatic'],
  ['always', 'Always'],
  ['never', 'Never'],
]
const chip = (on: boolean) => `rounded-full px-4 py-2 text-sm font-semibold transition ${on ? 'bg-accent text-on-accent' : 'bg-white/10 text-zinc-200 hover:bg-white/15'}`

/** What the choice made for a track means for it now, in a sentence. */
function rememberingSaid(mode: Mode, long: boolean): string {
  if (mode === 'always') return 'Always: where you stop and the speed you choose are kept for this track.'
  if (mode === 'never') return 'Never: this track always starts from the beginning, at your usual speed.'
  return long
    ? 'Automatic: this track counts as a long recording, so where you stop and the speed you choose are kept.'
    : 'Automatic: this track is not long enough to count as a long recording (the length is chosen in Sound & tools), so it starts from the beginning.'
}

export default function ChaptersModal({ p, open, onClose }: ChaptersModalProps) {
  const dialog = useRef<HTMLDivElement>(null)
  const titleId = useId()
  const chaptersId = useId()
  const marksId = useId()
  const key = p.current?.key
  const state = useChapters(p.current?.id)
  const chapters = state.status === 'ready' ? state.chapters : []
  const marksState = useBookmarkState(key)
  const marks = useBookmarks(key)
  const placeId = useId()
  const progress = useProgress(key)
  const mode = progress?.mode ?? 'auto'
  const long = useIsLongForm(p.current, p.duration || p.current?.duration || 0)
  const playing = chapterIndexAt(chapters, p.time)
  // declared before the dialog hook: on closing, the page is let back in before focus is returned to it
  useInertPage(open)
  useDialog(dialog, open, { initialFocus: '[data-current]' })
  // the system's Back (a phone's button, a remote's, the browser's) closes the list, as Escape does
  useEffect(() => (open ? openBackLayer(onClose) : undefined), [open]) // eslint-disable-line react-hooks/exhaustive-deps
  // the list opens at the chapter that is playing, not at the top of a long book
  useEffect(() => {
    if (open) dialog.current?.querySelector('[data-current]')?.scrollIntoView({ block: 'center' })
  }, [open, chapters.length]) // eslint-disable-line react-hooks/exhaustive-deps
  const chapterKeys = useRovingKeys({ items: '[data-chapter]', orientation: 'vertical' })
  const bookmarkKeys = useRovingKeys({ items: '[data-bookmark]', orientation: 'vertical' })
  const modeKeys = useRovingKeys({ items: '[role="radio"]', activate: true })

  // a bookmark that is deleted takes the focus with it: it goes to the one that took its place, or to the button that adds one
  const refocus = useRef<number | null>(null)
  useEffect(() => {
    const at = refocus.current
    if (at === null) return
    refocus.current = null
    const rows = dialog.current?.querySelectorAll<HTMLElement>('[data-bookmark]')
    ;(rows?.[Math.min(at, (rows?.length ?? 1) - 1)] ?? dialog.current?.querySelector<HTMLElement>('[data-add-bookmark]'))?.focus()
  }, [marks])

  if (!open) return null

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (isBackKey(e)) {
      // Escape and a remote's Back key: neither may reach the player behind (where Back would close a sheet under this)
      e.preventDefault()
      e.stopPropagation()
      onClose()
    } else if ((e.key.length === 1 && !e.ctrlKey && !e.metaKey) || e.key.startsWith('Arrow')) {
      // letters and arrows are for the list, not for the player behind it (media keys still work). Ctrl+Z is not a letter: it takes
      // back the delete of a bookmark, and no hotkey of the player takes a modified key.
      e.stopPropagation()
    }
  }
  const jump = (start: number) => {
    p.seek(start)
    onClose()
  }
  const remove = (mark: Bookmark, index: number) => {
    if (!key) return
    refocus.current = index
    deleteMark(listeningService, key, mark)
  }
  const rename = (mark: Bookmark) => {
    if (key) void renameMark(listeningService, key, mark)
  }
  // "never" is a request to forget: the place and the speed kept for this track go with the choice
  const chooseMode = (next: Mode) => {
    if (key) progressService.save(key, next === 'never' ? { mode: next, t: null, speed: null } : { mode: next })
  }
  const onMarkKey = (e: KeyboardEvent<HTMLElement>, mark: Bookmark, index: number) => {
    if (e.key === 'F2') rename(mark)
    else if (e.key === 'Delete') remove(mark, index)
    else return
    e.preventDefault()
    e.stopPropagation()
  }

  return createPortal(
    <div
      className="fixed inset-0 z-[80] grid place-items-center bg-base/80 p-4 backdrop-blur-sm"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose()
      }}
    >
      <div
        ref={dialog}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        data-modal="true"
        data-testid="chapters"
        onKeyDown={onKeyDown}
        className="flex max-h-[85dvh] w-full max-w-md animate-fadeIn flex-col rounded-2xl bg-raised p-5 shadow-xl ring-1 ring-white/10"
      >
        <div className="mb-3 flex items-start justify-between gap-3">
          <div className="min-w-0">
            <h2 id={titleId} className="text-lg font-semibold">
              Chapters and bookmarks
            </h2>
            <p className="truncate text-xs text-zinc-400">
              {dotted(p.current?.title, chapters.length > 0 && countLabel(chapters.length, 'chapter'), marks.length > 0 && countLabel(marks.length, 'bookmark'))}
            </p>
          </div>
          <button type="button" onClick={onClose} aria-label="Close" className="grid h-9 w-9 shrink-0 place-items-center rounded-full text-zinc-400 hover:text-white">
            <X size={18} />
          </button>
        </div>

        <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto">
          {state.status === 'ready' && chapters.length > 0 ? (
            <section aria-labelledby={chaptersId}>
              <h3 id={chaptersId} className="mb-1 text-xs font-semibold uppercase tracking-wider text-zinc-400">
                Chapters
              </h3>
              <ol aria-label="Chapters of this track" onKeyDown={chapterKeys} className="-mx-2 max-h-[38dvh] overflow-y-auto px-2">
                {chapters.map((chapter, i) => {
                  const current = i === playing
                  return (
                    <li key={chapter.start}>
                      <button
                        type="button"
                        data-chapter
                        data-current={current ? '' : undefined}
                        aria-current={current ? 'true' : undefined}
                        tabIndex={current || (playing < 0 && i === 0) ? 0 : -1}
                        onClick={() => jump(chapter.start)}
                        className={`flex w-full items-baseline gap-3 rounded-lg border-l-2 px-3 py-2 text-left text-sm transition ${current ? 'border-accent bg-white/10 font-semibold text-white' : 'border-transparent text-zinc-200 hover:bg-white/5'}`}
                      >
                        <span className="w-7 shrink-0 text-right tabular-nums text-zinc-400">{i + 1}</span>
                        <span className="min-w-0 flex-1 break-words">{chapter.title}</span>
                        <span className="shrink-0 text-xs tabular-nums text-zinc-400">{formatTime(chapter.start)}</span>
                      </button>
                    </li>
                  )
                })}
              </ol>
            </section>
          ) : (
            <p role="status" className="py-2 text-center text-sm text-zinc-400">
              {state.status === 'ready' ? 'This file has no chapters.' : state.status === 'error' ? 'The chapters of this file could not be read.' : 'Looking for chapters…'}
            </p>
          )}

          <section aria-labelledby={marksId}>
            <div className="mb-1 flex items-center justify-between gap-3">
              <h3 id={marksId} className="text-xs font-semibold uppercase tracking-wider text-zinc-400">
                Bookmarks
              </h3>
              <button
                type="button"
                data-testid="bookmark-here"
                data-add-bookmark
                data-autofocus
                onClick={() => markHere(listeningService, p)}
                className="inline-flex items-center gap-1.5 rounded-full bg-white/10 px-3 py-1.5 text-xs font-semibold text-zinc-200 transition hover:bg-white/15 active:scale-95"
              >
                <BookmarkPlus size={14} /> Add bookmark here
              </button>
            </div>
            {marks.length > 0 ? (
              <>
                <ol aria-label="Bookmarks of this track" onKeyDown={bookmarkKeys} className="-mx-2 max-h-[32dvh] overflow-y-auto px-2">
                  {marks.map((mark, i) => (
                    <li key={mark.id} className="flex items-center gap-1">
                      <button
                        type="button"
                        data-bookmark
                        tabIndex={i === 0 ? 0 : -1}
                        onClick={() => jump(mark.t)}
                        onKeyDown={(e) => onMarkKey(e, mark, i)}
                        className="flex min-w-0 flex-1 items-baseline gap-3 rounded-lg px-3 py-2 text-left text-sm text-zinc-200 transition hover:bg-white/5"
                      >
                        <span className="w-14 shrink-0 text-right tabular-nums text-zinc-400">{formatTime(mark.t)}</span>
                        <span className="min-w-0 flex-1 break-words">{mark.label}</span>
                      </button>
                      <button type="button" tabIndex={-1} className={rowButton} onClick={() => rename(mark)} aria-label={`Rename bookmark ${mark.label}`} title="Rename (F2)">
                        <Pencil size={15} />
                      </button>
                      <button type="button" tabIndex={-1} className={rowButton} onClick={() => remove(mark, i)} aria-label={`Delete bookmark ${mark.label}`} title="Delete (Delete)">
                        <Trash2 size={15} />
                      </button>
                    </li>
                  ))}
                </ol>
                <p className="mt-2 text-xs text-zinc-400">On a bookmark, F2 renames it and Delete removes it.</p>
              </>
            ) : (
              <p className="py-2 text-sm text-zinc-400">
                {marksState.status === 'error' ? 'The bookmarks of this track could not be read.' : 'No bookmarks yet. Press B while it plays to mark a place.'}
              </p>
            )}
          </section>

          <section aria-labelledby={placeId}>
            <h3 id={placeId} className="mb-2 text-xs font-semibold uppercase tracking-wider text-zinc-400">
              Where you stopped
            </h3>
            <div role="radiogroup" aria-label="Remember where I stop in this track" onKeyDown={modeKeys} className="flex flex-wrap gap-2">
              {MODES.map(([id, label]) => (
                <button key={id} type="button" role="radio" aria-checked={mode === id} tabIndex={mode === id ? 0 : -1} onClick={() => chooseMode(id)} className={chip(mode === id)}>
                  {label}
                </button>
              ))}
            </div>
            <p className="mt-2 text-xs text-zinc-400" data-testid="remembering">
              {[rememberingSaid(mode, long), progress?.t != null && `Saved place ${formatTime(progress.t)}.`, progress?.speed != null && `Speed for this track ${progress.speed}x.`].filter(Boolean).join(' ')}
            </p>
          </section>
        </div>
      </div>
    </div>,
    document.body,
  )
}
