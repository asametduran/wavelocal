import { useCallback, useEffect, useRef, useState } from 'react'
import { Loader2, Upload } from 'lucide-react'
import { usePlayer } from './hooks/usePlayer'
import { useHotkeys } from './hooks/useHotkeys'
import { useTvMode } from './hooks/useTvMode'
import Playlist from './components/Playlist'
import NowPlaying from './components/NowPlaying'
import NowPlayingSheet from './components/NowPlayingSheet'
import QueueSheet from './components/QueueSheet'
import PlayerBar, { MiniBar } from './components/PlayerBar'

export default function App() {
  const p = usePlayer()
  const [tv, setTv] = useTvMode()
  const fileInput = useRef(null)
  const folderInput = useRef(null)
  const searchRef = useRef(null)
  const [dragging, setDragging] = useState(false)
  const [nowOpen, setNowOpen] = useState(false)
  const [queueOpen, setQueueOpen] = useState(false)

  // Back button / remote Back / Escape: close the topmost sheet first.
  const onBack = useCallback(() => {
    if (queueOpen) return setQueueOpen(false) || true
    if (nowOpen) return setNowOpen(false) || true
    return false
  }, [queueOpen, nowOpen])

  useHotkeys(p, {
    tv,
    onBack,
    toggleTv: () => setTv((v) => !v),
    focusSearch: () => searchRef.current?.focus(),
  })

  // Hardware / browser back closes sheets instead of leaving the app.
  useEffect(() => {
    if (!nowOpen && !queueOpen) return
    history.pushState({ sheet: true }, '')
    const onPop = () => {
      setQueueOpen(false)
      setNowOpen(false)
    }
    window.addEventListener('popstate', onPop)
    return () => window.removeEventListener('popstate', onPop)
  }, [nowOpen, queueOpen])

  useEffect(() => {
    document.title = p.current ? `${p.current.title} — ${p.current.artist}` : 'Wavelocal — Private Music Player'
  }, [p.current])

  // Window-wide drag & drop for external files (internal queue reordering is ignored).
  useEffect(() => {
    let depth = 0
    const hasFiles = (e) => Array.from(e.dataTransfer?.types || []).includes('Files')
    const enter = (e) => {
      if (!hasFiles(e)) return
      e.preventDefault()
      depth++
      setDragging(true)
    }
    const over = (e) => hasFiles(e) && e.preventDefault()
    const leave = (e) => {
      if (!hasFiles(e)) return
      depth = Math.max(0, depth - 1)
      if (depth === 0) setDragging(false)
    }
    const drop = (e) => {
      if (!hasFiles(e)) return
      e.preventDefault()
      depth = 0
      setDragging(false)
      p.addFiles(e.dataTransfer.files)
    }
    window.addEventListener('dragenter', enter)
    window.addEventListener('dragover', over)
    window.addEventListener('dragleave', leave)
    window.addEventListener('drop', drop)
    return () => {
      window.removeEventListener('dragenter', enter)
      window.removeEventListener('dragover', over)
      window.removeEventListener('dragleave', leave)
      window.removeEventListener('drop', drop)
    }
  }, [p.addFiles])

  const onInput = useCallback(
    (e) => {
      if (e.target.files?.length) p.addFiles(e.target.files)
      e.target.value = ''
    },
    [p.addFiles],
  )

  const pickFiles = () => fileInput.current?.click()
  const pickFolder = () => folderInput.current?.click()

  return (
    <div className="flex h-full flex-col pt-safe">
      <input ref={fileInput} type="file" accept="audio/*,.mp3,.m4a,.flac,.ogg,.wav" multiple hidden onChange={onInput} />
      <input ref={folderInput} type="file" webkitdirectory="" directory="" multiple hidden onChange={onInput} />

      <div className="flex min-h-0 flex-1">
        <Playlist
          p={p}
          searchRef={searchRef}
          onPickFiles={pickFiles}
          onPickFolder={pickFolder}
          tv={tv}
          onToggleTv={() => setTv((v) => !v)}
          className="flex-1 md:flex-none"
        />
        <NowPlaying p={p} onPickFiles={pickFiles} onPickFolder={pickFolder} />
      </div>

      <MiniBar p={p} onOpen={() => setNowOpen(true)} />
      <PlayerBar p={p} />

      <NowPlayingSheet p={p} open={nowOpen} onClose={() => setNowOpen(false)} onOpenQueue={() => setQueueOpen(true)} />
      <QueueSheet p={p} open={queueOpen} onClose={() => setQueueOpen(false)} onPickFiles={pickFiles} onPickFolder={pickFolder} />

      {p.loading && (
        <div className="fixed right-4 top-4 z-[60] flex items-center gap-2 rounded-full bg-raised px-4 py-2 text-sm shadow-lg" role="status">
          <Loader2 size={16} className="animate-spin text-accent" /> Reading tags…
        </div>
      )}

      {dragging && (
        <div className="pointer-events-none fixed inset-0 z-[60] grid place-items-center bg-base/80 backdrop-blur-sm">
          <div className="flex flex-col items-center gap-3 rounded-3xl border-2 border-dashed border-accent px-16 py-14">
            <Upload size={44} className="text-accent" />
            <div className="text-xl font-semibold">Drop to add to your queue</div>
            <div className="text-sm text-zinc-400">Stays 100% on your device</div>
          </div>
        </div>
      )}
    </div>
  )
}
