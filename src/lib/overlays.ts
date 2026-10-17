/**
 * Dialogs and toasts as plain data. Anything (a component, the player hook, a lazy module) can ask a question
 * (`confirmDialog`, `promptDialog`, `noticeDialog`) or say something (`toast`) without knowing how it is shown: a host
 * component subscribes to the store and renders it, and the questions are promises that resolve when it is answered.
 * Nothing here touches the DOM, so the logic is tested without a browser, and it is small enough for the first load.
 */

export interface DialogOptions {
  title: string
  message?: string
  /** Lines listed under the message, for a long result (what could not be found). */
  details?: readonly string[]
  confirmLabel?: string
  /** `null` leaves out the Cancel button (a notice). */
  cancelLabel?: string | null
  /** The confirming action destroys something: the dialog starts on Cancel and the button looks the part. */
  danger?: boolean
}

export interface PromptOptions extends DialogOptions {
  /** The text field's accessible name. */
  label: string
  value?: string
  placeholder?: string
  maxLength?: number
}

/** A dialog as the host shows it. */
export interface DialogView {
  id: number
  title: string
  message: string
  details: readonly string[]
  confirmLabel: string
  cancelLabel: string | null
  danger: boolean
  /** The text field of a prompt, or null. */
  field: { label: string; value: string; placeholder: string; maxLength: number } | null
}

export interface ToastAction {
  label: string
  run: () => void
}

export interface ToastOptions {
  action?: ToastAction
  /** How long it stays, in ms; 0 until dismissed. A toast with an action stays longer, so there is time to use it. */
  ms?: number
}

export interface Toast {
  id: number
  text: string
  action: ToastAction | null
  ms: number
}

export interface OverlaySnapshot {
  /** The dialog on screen: the others wait their turn. */
  dialog: DialogView | null
  toasts: readonly Toast[]
}

interface Answer {
  ok: boolean
  text: string
}

const MAX_TOASTS = 3
const MAX_TOAST_TEXT = 300
const DEFAULT_FIELD_LENGTH = 200

export class OverlayStore {
  private nextId = 1
  private queue: { view: DialogView; settle: (answer: Answer) => void }[] = []
  private toasts: Toast[] = []
  private state: OverlaySnapshot = { dialog: null, toasts: [] }
  private readonly listeners = new Set<() => void>()

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  /** The same object until something changes, as `useSyncExternalStore` requires. */
  snapshot = (): OverlaySnapshot => this.state

  private publish(): void {
    this.state = { dialog: this.queue[0]?.view ?? null, toasts: [...this.toasts] }
    this.listeners.forEach((listener) => listener())
  }

  private enqueue(options: DialogOptions, field: DialogView['field'], settle: (answer: Answer) => void): void {
    const view: DialogView = {
      id: this.nextId++,
      title: options.title,
      message: options.message ?? '',
      details: options.details ?? [],
      confirmLabel: options.confirmLabel ?? 'OK',
      cancelLabel: options.cancelLabel === undefined ? 'Cancel' : options.cancelLabel,
      danger: options.danger ?? false,
      field,
    }
    this.queue.push({ view, settle })
    this.publish()
  }

  /** Ask a yes/no question. Resolves true when confirmed, false when cancelled or dismissed. */
  confirm(options: DialogOptions): Promise<boolean> {
    return new Promise((resolve) => this.enqueue(options, null, (answer) => resolve(answer.ok)))
  }

  /** Ask for a line of text. Resolves with it, or null when cancelled or dismissed. */
  prompt(options: PromptOptions): Promise<string | null> {
    const maxLength = options.maxLength ?? DEFAULT_FIELD_LENGTH
    const field = { label: options.label, value: options.value ?? '', placeholder: options.placeholder ?? '', maxLength }
    return new Promise((resolve) => this.enqueue(options, field, (answer) => resolve(answer.ok ? answer.text.slice(0, maxLength) : null)))
  }

  /** Tell the listener something that needs reading and an OK. Resolves when it is closed. */
  notice(options: DialogOptions): Promise<void> {
    return new Promise((resolve) => this.enqueue({ ...options, cancelLabel: null }, null, () => resolve()))
  }

  /** The host's answer to the dialog with this id. Answers for dialogs that are gone are ignored. */
  answer(id: number, result: { ok: boolean; text?: string }): void {
    const at = this.queue.findIndex((item) => item.view.id === id)
    const [item] = at < 0 ? [] : this.queue.splice(at, 1)
    if (!item) return
    item.settle({ ok: result.ok, text: result.text ?? '' })
    this.publish()
  }

  /** Cancel every dialog that is waiting, for when they cannot be shown at all. */
  cancelAll(): void {
    const waiting = this.queue
    this.queue = []
    for (const item of waiting) item.settle({ ok: false, text: '' })
    this.publish()
  }

  /** Show a message for a few seconds. Returns its id, or -1 when there was nothing to say. */
  toast(text: string, { action, ms }: ToastOptions = {}): number {
    const clean = text.trim().slice(0, MAX_TOAST_TEXT).trim()
    if (!clean) return -1
    const id = this.nextId++
    this.toasts = [...this.toasts.filter((t) => t.text !== clean), { id, text: clean, action: action ?? null, ms: ms ?? (action ? 9000 : 4500) }].slice(-MAX_TOASTS)
    this.publish()
    return id
  }

  dismissToast(id: number): void {
    const next = this.toasts.filter((t) => t.id !== id)
    if (next.length === this.toasts.length) return
    this.toasts = next
    this.publish()
  }

  /** Run a toast's action (once: the toast is gone before it runs) and close it. */
  runToastAction(id: number): void {
    const toast = this.toasts.find((t) => t.id === id)
    this.dismissToast(id)
    if (!toast?.action) return
    try {
      toast.action.run()
    } catch {
      // an undo that cannot be done is not worth breaking the page over
    }
  }

  /** The newest toast that can be acted on (the one Ctrl+Z undoes). */
  latestAction(): Toast | null {
    for (let i = this.toasts.length - 1; i >= 0; i--) {
      const toast = this.toasts[i]
      if (toast?.action) return toast
    }
    return null
  }
}

/** The one store the page uses. */
export const overlays = new OverlayStore()

export const confirmDialog = (options: DialogOptions): Promise<boolean> => overlays.confirm(options)
export const promptDialog = (options: PromptOptions): Promise<string | null> => overlays.prompt(options)
export const noticeDialog = (options: DialogOptions): Promise<void> => overlays.notice(options)
export const toast = (text: string, options?: ToastOptions): number => overlays.toast(text, options)
