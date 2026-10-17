import { useEffect, useState, useSyncExternalStore } from 'react'
import { Deferred, lazyRetry, preloadWhenIdle } from './lazy'
import '../lib/backlayer' // makes the page's Back listener now, ahead of every sheet's and page's own (see the module)
import { overlays } from '../lib/overlays'

const loadOverlays = () => import('./Overlays')
const Overlays = lazyRetry(loadOverlays)

/** Input types that hold text, and so have an undo of their own (a slider, a checkbox or a button has none). */
const TEXT_INPUTS = /^(text|search|url|tel|email|password|number|date|datetime-local|month|time|week)$/

/** Whether Ctrl+Z belongs to the element that has focus: a text field undoes its typing. A list, slider or button leaves it to the toast. */
const hasOwnUndo = (el: EventTarget | null): boolean => el instanceof HTMLElement && (el.isContentEditable || el instanceof HTMLTextAreaElement || (el instanceof HTMLInputElement && TEXT_INPUTS.test(el.type)))

/**
 * Brings in the code that shows dialogs and toasts the first time there is something to show (it is fetched when the app
 * is idle, so that is rarely a wait), and keeps it. If it cannot be fetched, whatever was asked is answered "no" rather
 * than left hanging.
 */
export default function OverlayGate() {
  const { dialog, toasts } = useSyncExternalStore(overlays.subscribe, overlays.snapshot)
  const busy = dialog !== null || toasts.length > 0
  const [wanted, setWanted] = useState(busy)
  useEffect(() => {
    if (busy) setWanted(true)
  }, [busy])
  // Ctrl+Z (Cmd+Z) takes back the latest thing that can be taken back, unless a text field wants its own undo. It is here,
  // not in the host that shows the toasts, so it works from the moment there is something to undo.
  const undoable = toasts.some((t) => t.action !== null)
  useEffect(() => {
    if (!undoable) return undefined
    const onKey = (e: KeyboardEvent) => {
      if (!(e.ctrlKey || e.metaKey) || e.shiftKey || e.altKey || e.key.toLowerCase() !== 'z') return
      if (hasOwnUndo(e.target)) return
      const toast = overlays.latestAction()
      if (!toast) return
      e.preventDefault()
      overlays.runToastAction(toast.id)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [undoable])
  useEffect(() => preloadWhenIdle([loadOverlays]), [])
  if (!wanted) return null
  return (
    <Deferred
      label="the dialogs"
      onDismiss={() => {
        Overlays.reset()
        overlays.cancelAll()
        setWanted(false)
      }}
    >
      <Overlays />
    </Deferred>
  )
}
