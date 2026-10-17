import { useEffect, useId, useRef } from 'react'
import type { KeyboardEvent } from 'react'
import { createPortal } from 'react-dom'
import { X } from 'lucide-react'
import { useDialog, useRovingKeys } from '../hooks/useA11y'
import { useChapters } from '../hooks/useChapters'
import { isBackKey } from '../hooks/useHotkeys'
import { useInertPage } from '../hooks/useInertPage'
import { openBackLayer } from '../lib/backlayer'
import { chapterIndexAt } from '../lib/chapters/navigate'
import { countLabel, dotted, formatTime } from '../lib/format'
import type { PlayerApi } from '../types'

/**
 * The chapters of the playing track as a list: the one playing is marked, and choosing one jumps to its start and closes the
 * list. A modal dialog like the other panels (focus stays inside, the page behind is inert, Escape and the system's Back close
 * it); the arrow keys, Home and End move through the rows, so a book of a hundred chapters is not a hundred Tab stops.
 */

interface ChaptersModalProps {
  p: PlayerApi
  open: boolean
  onClose: () => void
}

export default function ChaptersModal({ p, open, onClose }: ChaptersModalProps) {
  const dialog = useRef<HTMLDivElement>(null)
  const titleId = useId()
  const state = useChapters(p.current?.id)
  const chapters = state.status === 'ready' ? state.chapters : []
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
  const roving = useRovingKeys({ items: '[data-chapter]', orientation: 'vertical' })

  if (!open) return null

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (isBackKey(e)) {
      // Escape and a remote's Back key: neither may reach the player behind (where Back would close a sheet under this)
      e.preventDefault()
      e.stopPropagation()
      onClose()
    } else if (e.key.length === 1 || e.key.startsWith('Arrow')) {
      e.stopPropagation() // letters and arrows are for the list, not for the player behind it (media keys still work)
    }
  }
  const jump = (start: number) => {
    p.seek(start)
    onClose()
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
              Chapters
            </h2>
            <p className="truncate text-xs text-zinc-400">{dotted(p.current?.title, chapters.length > 0 && countLabel(chapters.length, 'chapter'))}</p>
          </div>
          <button type="button" onClick={onClose} aria-label="Close" className="grid h-9 w-9 shrink-0 place-items-center rounded-full text-zinc-400 hover:text-white">
            <X size={18} />
          </button>
        </div>

        {state.status === 'ready' && chapters.length > 0 ? (
          <ol aria-label="Chapters of this track" onKeyDown={roving} className="-mx-2 min-h-0 flex-1 overflow-y-auto px-2">
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
        ) : (
          <p role="status" className="py-6 text-center text-sm text-zinc-400">
            {state.status === 'ready' ? 'This file has no chapters.' : state.status === 'error' ? 'The chapters of this file could not be read.' : 'Looking for chapters…'}
          </p>
        )}
      </div>
    </div>,
    document.body,
  )
}
