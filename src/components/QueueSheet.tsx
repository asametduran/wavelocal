import { useRef } from 'react'
import { X } from 'lucide-react'
import Playlist from './Playlist'
import { useSwipe } from '../hooks/useSwipe'
import { useDialog } from '../hooks/useA11y'
import type { BrowseMode } from '../lib/browse'
import type { PlayerApi } from '../types'

/** The queue is a list of what plays: tracks or folders, not the album and artist pages of the main library panel. */
const QUEUE_MODES: readonly BrowseMode[] = ['list', 'folders']

/** Phone bottom-sheet queue. Drag the handle down (or tap the backdrop) to dismiss. */
interface QueueSheetProps {
  p: PlayerApi
  open: boolean
  onClose: () => void
  onPickFiles: () => void
  onPickFolder: () => void
}

export default function QueueSheet({ p, open, onClose, onPickFiles, onPickFolder }: QueueSheetProps) {
  const swipe = useSwipe({ onDown: onClose, trackDown: true, threshold: 100 })
  const dialog = useRef<HTMLDivElement>(null)
  useDialog(dialog, open)

  return (
    <div className="md:hidden">
      <div
        onClick={onClose}
        aria-hidden="true"
        className={`fixed inset-0 z-[45] bg-black/60 transition-opacity duration-300 ${open ? 'opacity-100' : 'pointer-events-none opacity-0'}`}
      />
      <div
        ref={dialog}
        inert={!open}
        data-modal={open}
        aria-hidden={!open}
        role="dialog"
        aria-modal="true"
        aria-label="Queue"
        className="fixed inset-x-0 bottom-0 z-50 flex h-[78dvh] flex-col overflow-hidden rounded-t-2xl bg-panel pb-safe shadow-2xl"
        style={{
          transform: open ? `translateY(${swipe.dy}px)` : 'translateY(100%)',
          transition: swipe.dy ? 'none' : 'transform .3s cubic-bezier(.2,.8,.2,1)',
        }}
      >
        <div className="flex items-center justify-between px-4 pt-2" {...swipe.handlers}>
          <div className="w-11" />
          <div className="h-1.5 w-10 rounded-full bg-white/20" />
          <button onClick={onClose} className="grid h-11 w-11 place-items-center rounded-full text-zinc-400 active:bg-white/10" aria-label="Close queue">
            <X size={20} />
          </button>
        </div>
        <Playlist p={p} label="Queue" modes={QUEUE_MODES} onPickFiles={onPickFiles} onPickFolder={onPickFolder} className="min-h-0 flex-1 !border-0" />
      </div>
    </div>
  )
}
