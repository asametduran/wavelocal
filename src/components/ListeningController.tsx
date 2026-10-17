import { useEffect, useRef, useSyncExternalStore } from 'react'
import { isTyping } from '../hooks/useHotkeys'
import { useChapters } from '../hooks/useChapters'
import { announce } from '../lib/a11y'
import { chaptersService, pruneOnce } from '../lib/chapters/instance'
import { chapterIndexAt, nextChapterStart, previousChapterStart } from '../lib/chapters/navigate'
import { chaptersPanel } from '../lib/chapters/panel'
import { chapterAnnouncement } from '../lib/chapters/speech'
import { lazyPanel, preloadWhenIdle } from './lazy'
import type { PlayerApi } from '../types'

/**
 * The one place that acts for a long recording while it plays, so that the two seek bars (footer and phone sheet) stay plain
 * pieces of drawing: it makes sure the chapters of the playing file are looked for, answers the chapter keys, says out loud
 * (through the page's live region) when a new chapter begins, and shows the list of chapters. Loaded lazily, once a track is
 * current.
 */

const loadList = () => import('./ChaptersModal')
const ChaptersModal = lazyPanel('the chapter list', loadList)
const close = () => chaptersPanel.set(false)

/** How long a chapter must have been playing before it is announced, so a seek across many of them says only where it landed. */
const ANNOUNCE_AFTER_MS = 400

export default function ListeningController({ p }: { p: PlayerApi }) {
  const latest = useRef(p)
  latest.current = p
  const { current, hydrated } = p
  const id = current?.id
  const file = current?.file
  const duration = current?.duration ?? 0
  const format = current?.audio ?? null

  // the chapters are looked for as soon as the track is current: reading a few tags is quick and the answer is kept
  useEffect(() => {
    chaptersService.want(id && file ? { id, file, duration, format } : null)
  }, [id, file, duration, format])
  useEffect(() => {
    if (hydrated) pruneOnce(new Set(latest.current.tracks.map((t) => t.id)))
  }, [hydrated])
  useEffect(() => preloadWhenIdle([loadList]), [])
  // with nothing left to list, the list closes (and does not pop up again by itself with the next track)
  useEffect(() => close, [])

  // C opens (or closes) the list, "," and "." go to the previous and next chapter; typing in a field is left alone
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented || e.ctrlKey || e.metaKey || e.altKey || isTyping(e.target)) return
      const { current: track, time, seek } = latest.current
      if (!track) return
      const key = e.key.length === 1 ? e.key.toLowerCase() : e.key
      if (key === 'c') {
        e.preventDefault()
        chaptersPanel.toggle()
        return
      }
      if (key !== ',' && key !== '.') return
      const state = chaptersService.getState(track.id)
      if (state.status !== 'ready') return
      const to = key === '.' ? nextChapterStart(state.chapters, time) : previousChapterStart(state.chapters, time)
      if (to === null) return
      e.preventDefault()
      seek(to)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  // a new chapter begins: say so, once things have settled. Not when the chapters were only just found, nor at a new track.
  const state = useChapters(id)
  const chapters = state.status === 'ready' ? state.chapters : null
  const index = chapters ? chapterIndexAt(chapters, p.time) : -1
  const heard = useRef<{ id: string | undefined; index: number | null }>({ id, index: null })
  useEffect(() => {
    const before = heard.current
    heard.current = { id, index: chapters ? index : null }
    if (!chapters || index < 0 || before.id !== id || before.index === null || before.index === index) return undefined
    const timer = window.setTimeout(() => announce(chapterAnnouncement(chapters, index)), ANNOUNCE_AFTER_MS)
    return () => window.clearTimeout(timer)
  }, [id, chapters, index])

  const open = useSyncExternalStore(chaptersPanel.subscribe, chaptersPanel.get)
  return <ChaptersModal p={p} open={open} onClose={close} />
}
