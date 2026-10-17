import { useEffect, useId, useRef, useState, useSyncExternalStore } from 'react'
import type { KeyboardEvent } from 'react'
import { createPortal } from 'react-dom'
import { X } from 'lucide-react'
import { useDialog } from '../hooks/useA11y'
import { isBackKey } from '../hooks/useHotkeys'
import { useInertPage } from '../hooks/useInertPage'
import { openBackLayer } from '../lib/backlayer'
import { overlays } from '../lib/overlays'
import type { DialogView, Toast } from '../lib/overlays'

const button = 'rounded-full px-4 py-2 text-sm font-semibold transition'

/** One question. Tab stays inside, Escape cancels, Enter confirms, and focus goes back to where the question came from. */
function DialogBox({ dialog }: { dialog: DialogView }) {
  const root = useRef<HTMLDivElement>(null)
  const input = useRef<HTMLInputElement>(null)
  const [text, setText] = useState(dialog.field?.value ?? '')
  const titleId = useId()
  const messageId = useId()
  // declared before the dialog hook: on closing, the page is let back in before focus is returned to it
  useInertPage(true)
  useDialog(root, true, { initialFocus: dialog.field ? 'input' : dialog.danger ? '[data-dialog-cancel]' : '[data-dialog-confirm]' })
  // a prompt that starts with text has it selected, so typing replaces it
  useEffect(() => input.current?.select(), [])
  // a phone's Back button or the browser's Back cancels the question, as Escape does; the sheet under it stays open
  useEffect(() => openBackLayer(() => overlays.answer(dialog.id, { ok: false })), [dialog.id])

  const answer = (ok: boolean) => overlays.answer(dialog.id, { ok, text })
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (isBackKey(e)) {
      // Escape and a remote's Back key: neither may reach the player behind (where Back would close a sheet under this)
      e.preventDefault()
      e.stopPropagation()
      answer(false)
    } else if (e.key.length === 1 || e.key.startsWith('Arrow')) {
      e.stopPropagation() // letters and arrows are for the dialog, not for the player behind it (media keys still work)
    }
  }

  return (
    <div
      className="fixed inset-0 z-[120] grid place-items-center bg-base/80 p-4 backdrop-blur-sm"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) answer(false)
      }}
    >
      <div
        ref={root}
        role={dialog.cancelLabel !== null && !dialog.field ? 'alertdialog' : 'dialog'}
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={dialog.message ? messageId : undefined}
        data-modal="true"
        data-testid="dialog"
        onKeyDown={onKeyDown}
        className="w-full max-w-sm animate-fadeIn rounded-2xl bg-raised p-5 shadow-2xl ring-1 ring-white/10"
      >
        <form
          onSubmit={(e) => {
            e.preventDefault()
            answer(true)
          }}
        >
          <h2 id={titleId} className="text-lg font-semibold">
            {dialog.title}
          </h2>
          {dialog.message && (
            <p id={messageId} className="mt-2 text-sm text-zinc-300">
              {dialog.message}
            </p>
          )}
          {dialog.field && (
            <label className="mt-4 block text-xs font-semibold uppercase tracking-wider text-zinc-400">
              {dialog.field.label}
              <input
                ref={input}
                value={text}
                onChange={(e) => setText(e.target.value)}
                placeholder={dialog.field.placeholder}
                maxLength={dialog.field.maxLength}
                autoComplete="off"
                spellCheck={false}
                className="mt-1 w-full rounded-lg bg-base px-3 py-2 text-sm normal-case tracking-normal text-white outline-none ring-1 ring-white/10 placeholder:text-zinc-400 focus:ring-accent"
              />
            </label>
          )}
          {dialog.details.length > 0 && (
            <ul tabIndex={0} aria-label="Details" className="mt-3 max-h-48 overflow-y-auto rounded-lg bg-black/30 p-2 text-xs text-zinc-300">
              {dialog.details.map((line, i) => (
                <li key={`${i}:${line}`} className="truncate py-0.5">
                  {line}
                </li>
              ))}
            </ul>
          )}
          <div className="mt-5 flex justify-end gap-2">
            {dialog.cancelLabel !== null && (
              <button type="button" data-dialog-cancel data-testid="dialog-cancel" onClick={() => answer(false)} className={`${button} bg-white/10 hover:bg-white/15`}>
                {dialog.cancelLabel}
              </button>
            )}
            <button type="submit" data-dialog-confirm data-testid="dialog-confirm" className={`${button} ${dialog.danger ? 'bg-red-600 text-white hover:bg-red-500' : 'bg-accent text-on-accent hover:brightness-110'}`}>
              {dialog.confirmLabel}
            </button>
          </div>
        </form>
      </div>
    </div>
  )
}

/** One message. It goes by itself after a few seconds, stays while the pointer or focus is on it, and may offer an undo. */
function ToastItem({ toast }: { toast: Toast }) {
  const [paused, setPaused] = useState(false)
  const left = useRef(toast.ms)
  const since = useRef(0)
  useEffect(() => {
    if (toast.ms === 0 || paused) return undefined
    since.current = performance.now()
    const timer = window.setTimeout(() => overlays.dismissToast(toast.id), Math.max(0, left.current))
    return () => {
      window.clearTimeout(timer)
      left.current -= performance.now() - since.current
    }
  }, [paused, toast.id, toast.ms])

  return (
    <div
      role="status"
      onMouseEnter={() => setPaused(true)}
      onMouseLeave={() => setPaused(false)}
      onFocus={() => setPaused(true)}
      onBlur={() => setPaused(false)}
      className="pointer-events-auto flex max-w-[90vw] animate-fadeIn items-center gap-2 rounded-full bg-raised py-1.5 pl-5 pr-1.5 text-sm shadow-lg ring-1 ring-white/10"
    >
      <span className="min-w-0 break-words">{toast.text}</span>
      {toast.action && (
        <button type="button" onClick={() => overlays.runToastAction(toast.id)} className="shrink-0 rounded-full px-3 py-1 font-semibold text-accent hover:bg-white/10">
          {toast.action.label}
        </button>
      )}
      <button type="button" aria-label="Dismiss" onClick={() => overlays.dismissToast(toast.id)} className="grid h-7 w-7 shrink-0 place-items-center rounded-full text-zinc-400 hover:bg-white/10 hover:text-white">
        <X size={14} aria-hidden="true" />
      </button>
    </div>
  )
}

function ToastStack({ toasts }: { toasts: readonly Toast[] }) {
  return (
    <div className="pointer-events-none fixed inset-x-0 bottom-24 z-[110] flex flex-col items-center gap-2 px-4">
      {toasts.map((toast) => (
        <ToastItem key={toast.id} toast={toast} />
      ))}
    </div>
  )
}

/** Shows what the overlay store holds: the dialog that is up and the toasts. Both live outside the app's own root. */
export default function Overlays() {
  const { dialog, toasts } = useSyncExternalStore(overlays.subscribe, overlays.snapshot)
  return (
    <>
      {dialog && createPortal(<DialogBox key={dialog.id} dialog={dialog} />, document.body)}
      {toasts.length > 0 && createPortal(<ToastStack toasts={toasts} />, document.body)}
    </>
  )
}
