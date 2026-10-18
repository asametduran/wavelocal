import type { LogKind } from './types'

/**
 * The start-up half of the error log. Only this file is in the first chunk; the log, the cleaning of what an error says and the report
 * are a chunk of their own, fetched when something has gone wrong or the Diagnostics section is opened. A failure handed over while
 * that chunk cannot be fetched (offline, before it was ever cached) waits in a short list and is kept with the next one that can be.
 */

const MAX_WAITING = 20
const waiting: [LogKind, unknown][] = []
let loading: Promise<typeof import('./log')> | null = null

/** One download of the log at a time, shared by every failure that arrives meanwhile; a download that failed is tried again by the next. */
export function loadLog(): Promise<typeof import('./log')> {
  loading ??= import('./log').catch((reason: unknown) => {
    loading = null
    throw reason
  })
  return loading
}

/** Keep a failure in the log. Never throws, and never waits for anything. */
export function keep(kind: LogKind, error: unknown): void {
  loadLog().then(
    (log) => {
      try {
        for (const [earlier, failure] of waiting.splice(0)) log.record(earlier, failure)
        log.record(kind, error)
      } catch {
        // the log never throws; if it did, an unhandled rejection here would be kept in the log, and so on for ever
      }
    },
    () => {
      if (waiting.length < MAX_WAITING) waiting.push([kind, error])
    },
  )
}

/** `.catch(note('save'))`: a failure that nobody can act on where it happens is kept in the log instead of being lost. */
export const note =
  (kind: LogKind) =>
  (error: unknown): void =>
    keep(kind, error)

/** Errors that are not the app's: scripts that browser extensions run in the page, and what the browser says about a script it hides. */
const foreign = (event: ErrorEvent): boolean => /-extension:/.test(event.filename) || (!event.error && event.message === 'Script error.')

/** The browser's own remark about an observer that took more than a frame, which is no failure of anything. */
const benign = (message: string): boolean => message.startsWith('ResizeObserver loop')

type Listening = Pick<Window, 'addEventListener' | 'removeEventListener'>

/** Keep every error nobody caught and every promise nobody handled. Returns what takes the listeners off again. */
export function installCapture(target: Listening = window): () => void {
  const onError = (event: ErrorEvent): void => {
    if (!foreign(event) && !benign(event.message)) keep('error', event.error ?? event.message)
  }
  const onRejection = (event: PromiseRejectionEvent): void => keep('rejection', event.reason)
  target.addEventListener('error', onError)
  target.addEventListener('unhandledrejection', onRejection)
  return () => {
    target.removeEventListener('error', onError)
    target.removeEventListener('unhandledrejection', onRejection)
  }
}
