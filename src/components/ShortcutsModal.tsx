import { useRef } from 'react'
import { X } from 'lucide-react'
import { useDialog } from '../hooks/useA11y'

const SHORTCUTS: readonly (readonly [keys: string, description: string])[] = [
  ['Space', 'Play / pause'],
  ['← / →', 'Seek 5 seconds'],
  ['Shift + ← / →', 'Previous / next track'],
  ['↑ / ↓', 'Volume up / down'],
  ['N / P', 'Next / previous track'],
  ['M', 'Mute'],
  ['S', 'Shuffle'],
  ['R', 'Cycle repeat'],
  ['/', 'Focus search'],
  ['E', 'Open sound tools'],
  ['C', 'Chapters of this track'],
  [', / .', 'Previous / next chapter'],
  ['T', 'Toggle TV mode'],
  ['?', 'Show this help'],
  ['Alt + ↑ / ↓', 'Move the focused track up / down the queue'],
  ['Ctrl + Z', 'Undo the last playlist or queue change'],
  ['Arrows, Home, End', 'Move between albums or artists'],
  ['Enter', 'Open the focused album or artist'],
  ['Esc', 'Close the top panel or question, or go back a page'],
]

interface ShortcutsModalProps {
  open: boolean
  onClose: () => void
}

export default function ShortcutsModal({ open, onClose }: ShortcutsModalProps) {
  const dialog = useRef<HTMLDivElement>(null)
  useDialog(dialog, open)
  if (!open) return null
  return (
    <div className="fixed inset-0 z-[80] grid place-items-center bg-base/80 p-4 backdrop-blur-sm" onClick={onClose}>
      <div
        ref={dialog}
        role="dialog"
        aria-modal="true"
        aria-labelledby="shortcuts-title"
        className="w-full max-w-md rounded-2xl bg-raised p-5 shadow-xl ring-1 ring-white/10"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mb-3 flex items-center justify-between">
          <h2 id="shortcuts-title" className="text-lg font-semibold">Keyboard shortcuts</h2>
          <button onClick={onClose} aria-label="Close" className="grid h-9 w-9 place-items-center rounded-full text-zinc-400 hover:text-white">
            <X size={18} />
          </button>
        </div>
        <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-2 text-sm">
          {SHORTCUTS.map(([keys, desc]) => (
            <div key={keys} className="contents">
              <dt>
                <kbd className="rounded bg-white/10 px-2 py-0.5 font-mono text-xs">{keys}</kbd>
              </dt>
              <dd className="text-zinc-300">{desc}</dd>
            </div>
          ))}
        </dl>
      </div>
    </div>
  )
}
