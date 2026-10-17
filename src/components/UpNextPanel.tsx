import { useEffect, useRef, useState } from 'react'
import type { KeyboardEvent } from 'react'
import { ArrowDown, ArrowUp, GripVertical, ListMusic, X } from 'lucide-react'
import Cover from './Cover'
import { announce, moveAnnouncement } from '../lib/a11y'
import { formatTime, listSummary } from '../lib/format'
import { toast } from '../lib/overlays'
import { clearQueue } from '../lib/queueactions'
import type { PlayerApi } from '../types'

const iconBtn =
  'grid h-8 w-8 shrink-0 place-items-center rounded-full text-zinc-400 hover:bg-white/10 hover:text-white disabled:opacity-30 disabled:hover:bg-transparent disabled:hover:text-zinc-400'

/** Which button of which row gets focus once the list has been re-drawn after a move or a removal. */
interface Refocus {
  index: number
  button: 'play' | 'up' | 'down'
}

/**
 * The tracks queued by hand, in the order they play. A track is played at once by choosing it, moved with the arrow
 * buttons, with Alt+Arrow or by dragging, and taken out (with an undo). The rest of the list carries on after the last one.
 */
export default function UpNextPanel({ p }: { p: PlayerApi }) {
  const { upNext } = p
  const [dragFrom, setDragFrom] = useState<number | null>(null)
  const [dragOver, setDragOver] = useState<number | null>(null)
  const list = useRef<HTMLOListElement>(null)
  const heading = useRef<HTMLHeadingElement>(null)
  const refocus = useRef<Refocus | null>(null)

  // moving or removing re-draws the rows: focus is put back on the button that was used, wherever its row went
  useEffect(() => {
    const target = refocus.current
    if (!target) return
    refocus.current = null
    const row = list.current?.querySelector<HTMLElement>(`li[data-index="${target.index}"]`)
    const button = row?.querySelector<HTMLButtonElement>(`button[data-button="${target.button}"]`)
    // a first row cannot move up and a last row cannot move down: the other arrow is the next best place
    const other = row?.querySelector<HTMLButtonElement>(`button[data-button="${target.button === 'up' ? 'down' : 'up'}"]`)
    const focus = button && !button.disabled ? button : other && !other.disabled ? other : (row?.querySelector<HTMLElement>('button[data-button="play"]') ?? heading.current)
    focus?.focus()
  })

  const move = (from: number, to: number, button: Refocus['button'] = 'play') => {
    const t = upNext[from]
    if (!t || to < 0 || to >= upNext.length || from === to) return
    refocus.current = { index: to, button }
    p.moveInUpNext(from, to)
    announce(moveAnnouncement(t.title, to + 1, upNext.length))
  }

  const remove = (index: number) => {
    const t = upNext[index]
    if (!t) return
    refocus.current = { index: Math.min(index, upNext.length - 2), button: 'play' }
    const undo = p.removeFromUpNext(index)
    toast(`Removed from the queue: ${t.title}`, { action: { label: 'Undo', run: undo } })
  }

  const onRowKey = (e: KeyboardEvent<HTMLButtonElement>, index: number) => {
    if (!e.altKey || (e.key !== 'ArrowUp' && e.key !== 'ArrowDown')) return
    e.preventDefault()
    move(index, e.key === 'ArrowUp' ? index - 1 : index + 1)
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex items-center justify-between gap-3 px-2 pb-2">
        <div className="min-w-0">
          <h3 ref={heading} tabIndex={-1} className="text-sm font-semibold outline-none">
            Up Next
          </h3>
          <p className="truncate text-xs tabular-nums text-zinc-400" data-testid="upnext-summary">
            {upNext.length ? listSummary(upNext) : 'Nothing queued'}
          </p>
        </div>
        <button
          type="button"
          onClick={() => (clearQueue(p), heading.current?.focus())}
          disabled={!upNext.length}
          className="shrink-0 rounded-full bg-white/10 px-4 py-1.5 text-sm font-semibold transition hover:bg-white/15 disabled:opacity-30 disabled:hover:bg-white/10"
        >
          Clear
        </button>
      </div>

      {upNext.length === 0 ? (
        <div className="flex flex-1 flex-col items-center justify-center gap-3 px-6 text-center text-sm text-zinc-400">
          <ListMusic size={32} strokeWidth={1.5} aria-hidden="true" />
          <p>
            Nothing is queued. Choose <strong className="font-semibold text-zinc-300">Play next</strong> or <strong className="font-semibold text-zinc-300">Add to queue</strong> on a track, an album or an artist, and it plays before the list carries on.
          </p>
        </div>
      ) : (
        <ol ref={list} aria-label="Up Next" className="min-h-0 flex-1 overflow-y-auto px-1 pb-2">
          {upNext.map((t, i) => {
            // the same track may be queued twice: its place among the copies keeps each row's key apart
            const copy = upNext.slice(0, i).filter((x) => x.id === t.id).length
            return (
              <li
                key={`${t.id}#${copy}`}
                data-index={i}
                draggable
                onDragStart={(e) => {
                  setDragFrom(i)
                  e.dataTransfer.effectAllowed = 'move'
                  e.dataTransfer.setData('text/plain', t.id)
                }}
                onDragOver={(e) => {
                  if (dragFrom === null) return
                  e.preventDefault()
                  setDragOver(i)
                }}
                onDrop={(e) => {
                  if (dragFrom === null) return
                  e.preventDefault()
                  move(dragFrom, i)
                }}
                onDragEnd={() => (setDragFrom(null), setDragOver(null))}
                className={`group flex items-center gap-2 rounded-lg px-1 py-1 [contain-intrinsic-size:auto_52px] [content-visibility:auto] hover:bg-white/5 ${dragOver === i && dragFrom !== i ? 'ring-1 ring-accent' : ''} ${dragFrom === i ? 'opacity-40' : ''}`}
              >
                <GripVertical size={14} aria-hidden="true" className="shrink-0 cursor-grab text-zinc-400 group-hover:text-zinc-300" />
                <button
                  type="button"
                  data-button="play"
                  onClick={() => p.playUpNext(i)}
                  onKeyDown={(e) => onRowKey(e, i)}
                  aria-label={`Play ${t.title} now`}
                  aria-keyshortcuts="Alt+ArrowUp Alt+ArrowDown"
                  className="flex min-w-0 flex-1 items-center gap-3 text-left"
                >
                  <div className="h-10 w-10 shrink-0 overflow-hidden rounded">
                    <Cover track={t} className="h-full w-full" iconSize={14} />
                  </div>
                  <div className="min-w-0">
                    <div className="truncate text-sm">{t.title}</div>
                    <div className="truncate text-xs text-zinc-400">{t.artist}</div>
                  </div>
                </button>
                <span className="shrink-0 text-xs tabular-nums text-zinc-400">{t.duration ? formatTime(t.duration) : ''}</span>
                <button type="button" data-button="up" disabled={i === 0} onClick={() => move(i, i - 1, 'up')} className={iconBtn} aria-label={`Move ${t.title} up`}>
                  <ArrowUp size={15} aria-hidden="true" />
                </button>
                <button type="button" data-button="down" disabled={i === upNext.length - 1} onClick={() => move(i, i + 1, 'down')} className={iconBtn} aria-label={`Move ${t.title} down`}>
                  <ArrowDown size={15} aria-hidden="true" />
                </button>
                <button type="button" onClick={() => remove(i)} className={`${iconBtn} hover:!text-red-400`} aria-label={`Remove ${t.title} from the queue`}>
                  <X size={15} aria-hidden="true" />
                </button>
              </li>
            )
          })}
        </ol>
      )}
    </div>
  )
}
