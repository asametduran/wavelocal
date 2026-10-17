/** The messages between the page and the service worker. Plain data, so the worker and the page share one definition. */

export type WorkerMessage = { type: 'skip-waiting' } | { type: 'status' }

/** What the worker reports about its offline copy. */
export interface WorkerStatus {
  /** The build id the worker was made for. */
  version: string
  /** Files in the build. */
  entries: number
  /** Their total size in bytes. */
  bytes: number
  /** Every file is stored, so the app opens with no network. */
  complete: boolean
}

/** A message sent to the worker, or null for anything else (pages of this origin can post to the worker, so it checks). */
export function parseMessage(data: unknown): WorkerMessage | null {
  if (typeof data !== 'object' || data === null) return null
  const { type } = data as { type?: unknown }
  return type === 'skip-waiting' || type === 'status' ? { type } : null
}

/** The worker's reply to `status`, or null when it is not one. */
export function parseStatus(data: unknown): WorkerStatus | null {
  if (typeof data !== 'object' || data === null) return null
  const { version, entries, bytes, complete } = data as Record<string, unknown>
  if (typeof version !== 'string' || typeof complete !== 'boolean') return null
  if (typeof entries !== 'number' || !Number.isInteger(entries) || entries < 0) return null
  if (typeof bytes !== 'number' || !Number.isFinite(bytes) || bytes < 0) return null
  return { version, entries, bytes, complete }
}
