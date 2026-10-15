import { X } from 'lucide-react'

const SHORTCUTS = [
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
  ['T', 'Toggle TV mode'],
  ['?', 'Show this help'],
  ['Esc', 'Close the top panel'],
]

export default function ShortcutsModal({ open, onClose }) {
  if (!open) return null
  return (
    <div className="fixed inset-0 z-[80] grid place-items-center bg-base/80 p-4 backdrop-blur-sm" onClick={onClose}>
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Keyboard shortcuts"
        className="w-full max-w-md rounded-2xl bg-raised p-5 shadow-xl ring-1 ring-white/10"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mb-3 flex items-center justify-between">
          <h2 className="text-lg font-semibold">Keyboard shortcuts</h2>
          <button onClick={onClose} aria-label="Close" className="rounded-full p-1.5 text-zinc-400 hover:text-white">
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
