import { useCallback, useEffect, useRef, useState } from 'react'
import { Loader2, Upload } from 'lucide-react'
import { usePlayer } from './hooks/usePlayer'
import { useHotkeys } from './hooks/useHotkeys'
import Playlist from './components/Playlist'
import NowPlaying from './components/NowPlaying'
import PlayerBar from './components/PlayerBar'

export default function App() {
  const p = usePlayer()
  const fileInput = useRef(null)
  const folderInput = useRef(null)
  const searchRef = useRef(null)
  const [dragging, setDragging] = useState(false)
  const [listOpen, setListOpen] = useState(false)

  useHotkeys(p, () => {
    setListOpen(true)
    searchRef.current?.focus()
  })

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
    <div className="flex h-full flex-col">
      <input ref={fileInput} type="file" accept="audio/*,.mp3,.m4a,.flac,.ogg,.wav" multiple hidden onChange={onInput} />
      <input ref={folderInput} type="file" webkitdirectory="" directory="" multiple hidden onChange={onInput} />

      <div className="relative flex min-h-0 flex-1">
        <Playlist
          p={p}
          searchRef={searchRef}
          onPickFiles={pickFiles}
          onPickFolder={pickFolder}
          className={`absolute inset-0 z-20 md:static ${listOpen ? 'flex' : 'hidden md:flex'}`}
        />
        <NowPlaying p={p} onPickFiles={pickFiles} onPickFolder={pickFolder} onToggleList={() => setListOpen((v) => !v)} />
        {listOpen && (
          <button onClick={() => setListOpen(false)} className="absolute right-4 top-4 z-30 rounded-full bg-black/60 px-3 py-1.5 text-xs md:hidden">
            Close
          </button>
        )}
      </div>

      <PlayerBar p={p} />

      {p.loading && (
        <div className="fixed right-4 top-4 z-50 flex items-center gap-2 rounded-full bg-raised px-4 py-2 text-sm shadow-lg" role="status">
          <Loader2 size={16} className="animate-spin text-accent" /> Reading tags…
        </div>
      )}

      {dragging && (
        <div className="pointer-events-none fixed inset-0 z-50 grid place-items-center bg-base/80 backdrop-blur-sm">
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
