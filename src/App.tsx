import { useCallback, useEffect, useRef, useState } from 'react'
import type { ChangeEvent } from 'react'
import { Loader2, Upload } from 'lucide-react'
import { usePlayer } from './hooks/usePlayer'
import { useBrowse } from './hooks/useBrowse'
import { useDesktopTray } from './hooks/useDesktopTray'
import { useHotkeys } from './hooks/useHotkeys'
import { useTrackAnnouncements } from './hooks/useA11y'
import { useTvMode } from './hooks/useTvMode'
import { useTheme } from './hooks/useTheme'
import { filesFromDrop } from './lib/dropped'
import { isPlaylistFile } from './lib/metadata'
import { attachPlayer, useShare } from './lib/share/store'
import Playlist from './components/Playlist'
import NowPlaying from './components/NowPlaying'
import NowPlayingSheet from './components/NowPlayingSheet'
import QueueSheet from './components/QueueSheet'
import ImportStatus from './components/ImportStatus'
import OverlayGate from './components/OverlayGate'
import LiveRegion, { SkipLinks } from './components/LiveRegion'
import { lazyPanel, preloadWhenIdle } from './components/lazy'
import PlayerBar, { MiniBar } from './components/PlayerBar'

// Rarely opened panels are separate chunks: the sound tools alone pull in the EQ, dynamics, spatial and reverb editors.
const loadTools = () => import('./components/ToolsModal')
const loadShortcuts = () => import('./components/ShortcutsModal')
const ToolsModal = lazyPanel('the sound tools', loadTools)
const ShortcutsModal = lazyPanel('the shortcut list', loadShortcuts)

export default function App() {
  const p = usePlayer()
  // the main library panel's browsing (mode, open album and artist pages); Back closes a page, on a phone too
  const browse = useBrowse({ history: true })
  useDesktopTray(p)
  // the listen-together controller reads the player through this module-level handle (it lives outside React)
  useEffect(() => attachPlayer(p))
  const session = useShare()
  useTrackAnnouncements(p.current, p.playing)
  const [tv, setTv] = useTvMode()
  const [accent, setAccent] = useTheme()
  const fileInput = useRef<HTMLInputElement>(null)
  const folderInput = useRef<HTMLInputElement>(null)
  const searchRef = useRef<HTMLInputElement>(null)
  const [dragging, setDragging] = useState(false)
  const [nowOpen, setNowOpen] = useState(false)
  const [queueOpen, setQueueOpen] = useState(false)
  const [toolsOpen, setToolsOpen] = useState(false)
  const [helpOpen, setHelpOpen] = useState(false)

  // Back button / remote Back / Escape: close the topmost sheet first.
  useEffect(() => preloadWhenIdle([loadTools, loadShortcuts]), [])

  const onBack = useCallback(() => {
    if (helpOpen) {
      setHelpOpen(false)
      return true
    }
    if (toolsOpen) {
      setToolsOpen(false)
      return true
    }
    if (queueOpen) {
      setQueueOpen(false)
      return true
    }
    if (nowOpen) {
      setNowOpen(false)
      return true
    }
    if (browse.page) {
      browse.back()
      return true
    }
    return false
  }, [helpOpen, toolsOpen, queueOpen, nowOpen, browse.page, browse.back])

  useHotkeys(p, {
    tv,
    onBack,
    toggleTv: () => setTv((v) => !v),
    openTools: () => setToolsOpen((v) => !v),
    toggleHelp: () => setHelpOpen((v) => !v),
    focusSearch: () => searchRef.current?.focus(),
  })

  // Hardware / browser back closes sheets instead of leaving the app.
  useEffect(() => {
    if (!nowOpen && !queueOpen && !toolsOpen) return
    history.pushState({ sheet: true }, '')
    const onPop = () => {
      setToolsOpen(false)
      setQueueOpen(false)
      setNowOpen(false)
    }
    window.addEventListener('popstate', onPop)
    return () => window.removeEventListener('popstate', onPop)
  }, [nowOpen, queueOpen, toolsOpen])

  useEffect(() => {
    document.title = p.current ? `${p.current.title} — ${p.current.artist}` : 'Wavelocal — Private Music Player'
  }, [p.current])

  // Files from the picker or dropped on the window: a playlist file becomes a playlist (after the music that came with
  // it is in the library), everything else is music.
  const latest = useRef(p)
  latest.current = p
  const takeFiles = useCallback(async (files: File[]): Promise<void> => {
    const lists = files.filter((f) => isPlaylistFile(f.name))
    const music = lists.length ? files.filter((f) => !isPlaylistFile(f.name)) : files
    if (music.length) await latest.current.addFiles(music)
    if (!lists.length) return
    await new Promise((resolve) => setTimeout(resolve, 0)) // let the library the import just filled reach this render
    const { importPlaylistFiles } = await import('./lib/playlistio')
    await importPlaylistFiles(latest.current, lists)
  }, [])

  // Window-wide drag & drop for external files (internal queue reordering is ignored).
  useEffect(() => {
    let depth = 0
    const hasFiles = (e: DragEvent) => Array.from(e.dataTransfer?.types || []).includes('Files')
    const enter = (e: DragEvent) => {
      if (!hasFiles(e)) return
      e.preventDefault()
      depth++
      setDragging(true)
    }
    const over = (e: DragEvent) => {
      if (hasFiles(e)) e.preventDefault()
    }
    const leave = (e: DragEvent) => {
      if (!hasFiles(e)) return
      depth = Math.max(0, depth - 1)
      if (depth === 0) setDragging(false)
    }
    const drop = (e: DragEvent) => {
      if (!hasFiles(e)) return
      e.preventDefault()
      depth = 0
      setDragging(false)
      // read synchronously: the browser empties the DataTransfer once this handler returns (folders need walking)
      void filesFromDrop(e.dataTransfer).then((files) => (files.length ? takeFiles(files) : undefined))
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
  }, [takeFiles])

  const onInput = useCallback(
    (e: ChangeEvent<HTMLInputElement>) => {
      if (e.target.files?.length) void takeFiles(Array.from(e.target.files)) // copied at once: the browser empties the list when the input is reset
      e.target.value = ''
    },
    [takeFiles],
  )

  const pickFiles = () => fileInput.current?.click()
  const pickFolder = () => folderInput.current?.click()

  return (
    <div className="flex h-full flex-col pt-safe">
      <SkipLinks />
      <LiveRegion />
      <input ref={fileInput} type="file" accept="audio/*,.mp3,.m4a,.flac,.ogg,.wav,.lrc,.m3u,.m3u8,.pls" multiple hidden onChange={onInput} />
      <input ref={folderInput} type="file" webkitdirectory="" directory="" multiple hidden onChange={onInput} />

      {/* everything behind a modal dialog is inert: no focus, no screen reader virtual cursor, no clicks */}
      <div className="contents" inert={helpOpen || toolsOpen}>
        <main className="flex min-h-0 flex-1">
          <h1 className="sr-only">Wavelocal music player</h1>
          <Playlist
            p={p}
            id="library"
            searchRef={searchRef}
            onPickFiles={pickFiles}
            onPickFolder={pickFolder}
            tv={tv}
            onToggleTv={() => setTv((v) => !v)}
            className="flex-1 md:flex-none"
            browse={browse}
          />
          <NowPlaying p={p} onPickFiles={pickFiles} onPickFolder={pickFolder} />
        </main>

        <MiniBar p={p} onOpen={() => setNowOpen(true)} />
        <PlayerBar p={p} onOpenTools={() => setToolsOpen(true)} />

        <NowPlayingSheet p={p} open={nowOpen} onClose={() => setNowOpen(false)} onOpenQueue={() => setQueueOpen(true)} onOpenTools={() => setToolsOpen(true)} />
        <QueueSheet p={p} open={queueOpen} onClose={() => setQueueOpen(false)} onPickFiles={pickFiles} onPickFolder={pickFolder} />
      </div>
      <ShortcutsModal open={helpOpen} onClose={() => setHelpOpen(false)} />
      <ToolsModal p={p} accent={accent} setAccent={setAccent} open={toolsOpen} onClose={() => setToolsOpen(false)} />

      {session.phase !== 'idle' && (
        <button
          type="button"
          onClick={() => setToolsOpen(true)}
          className="fixed left-4 top-4 z-[60] flex items-center gap-2 rounded-full bg-raised px-4 py-2 text-sm shadow-lg ring-1 ring-white/10"
          aria-label="Listening together, open details"
        >
          <span className="h-2 w-2 rounded-full bg-accent" aria-hidden="true" />
          {session.phase === 'host'
            ? `Hosting · ${session.peers.filter((x) => x.status === 'connected').length} listening`
            : session.hostName
              ? `Listening with ${session.hostName}`
              : 'Joining…'}
        </button>
      )}

      <OverlayGate />

      {p.decoding !== null && (
        <div className="fixed right-4 top-16 z-[60] flex items-center gap-2 rounded-full bg-raised px-4 py-2 text-sm shadow-lg" role="status">
          <Loader2 size={16} className="animate-spin text-accent" /> Decoding lossless audio… <span aria-hidden="true">{Math.round(p.decoding * 100)}%</span>
        </div>
      )}

      <ImportStatus p={p} />

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
