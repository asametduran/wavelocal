import { CHUNK_BYTES, base64Of } from './chunks'
import { safeFileName } from './name'
import type { SaveFailure, SaveOutcome } from './types'

/**
 * Saving a file in the Android app: write it in slices to the app's cache directory, then hand it to the system share sheet, which is
 * how a person keeps it (Drive, Files, mail, a messenger) with no permission asked for. The plugins are ports, so the rules here are
 * tested without a device: `plugins.ts` is the only code that knows `@capacitor/core`.
 */

/** The folder of the cache directory the files wait in. */
export const SHARE_DIR = 'wavelocal-share'
const DIRECTORY = 'CACHE' as const

/** The part of `@capacitor/filesystem` used here (our own description of it: no plugin code or enum travels with it). */
export interface FilesPort {
  writeFile(options: { path: string; data: string; directory: typeof DIRECTORY; recursive: boolean }): Promise<{ uri: string }>
  appendFile(options: { path: string; data: string; directory: typeof DIRECTORY }): Promise<void>
  readdir(options: { path: string; directory: typeof DIRECTORY }): Promise<{ files: readonly { name: string; type?: string }[] }>
  deleteFile(options: { path: string; directory: typeof DIRECTORY }): Promise<void>
}

/** The part of `@capacitor/share` used here. */
export interface SharePort {
  share(options: { title: string; files: string[]; dialogTitle: string }): Promise<unknown>
}

export interface NativePorts {
  files: FilesPort
  share: SharePort
  /** Base64 of a slice of the file. */
  encode?: (slice: Blob) => Promise<string>
  /** Bytes in a slice; a multiple of three, so that only the last carries base64 padding. */
  chunkBytes?: number
}

/** What the bridge said, as text: a native error arrives as an `Error` with a message, and sometimes as a plain string. */
export function messageOf(error: unknown): string {
  if (typeof error === 'string') return error
  if (typeof error === 'object' && error !== null) {
    const { message } = error as { message?: unknown }
    if (typeof message === 'string') return message
  }
  return ''
}

const FULL = /no space|not enough (?:free )?(?:storage )?space|enospc|quota|disk (?:is )?full|storage (?:is )?full|out of (?:disk |storage )?space/i
const BUSY = /in progress/i
const CANCELLED = /cancel/i

/** Why a write or a share failed, from what the bridge said. */
export function classify(error: unknown): SaveFailure {
  if (typeof error === 'object' && error !== null && (error as { name?: unknown }).name === 'QuotaExceededError') return 'full'
  const text = messageOf(error)
  if (FULL.test(text)) return 'full'
  if (BUSY.test(text)) return 'busy'
  return 'other'
}

/** The saver: one save at a time (a second while the first is open answers `busy` at once and touches nothing). */
export function createNativeSaver({ files, share, encode = base64Of, chunkBytes = CHUNK_BYTES }: NativePorts): (blob: Blob, fileName: string) => Promise<SaveOutcome> {
  let open = false
  const at = (path: string) => ({ path, directory: DIRECTORY })

  /**
   * Take away what an earlier save left. A share sheet's target may still have been reading that file when its save returned, so a
   * file is removed by the next save, never by its own. Never throws: a folder that is not there yet has nothing in it.
   */
  async function clear(): Promise<void> {
    try {
      const { files: left } = await files.readdir(at(SHARE_DIR))
      await Promise.all(left.filter((file) => file.type !== 'directory').map((file) => files.deleteFile(at(`${SHARE_DIR}/${file.name}`)).catch(() => undefined)))
    } catch {
      // nothing was left
    }
  }

  /** Write `blob` to `path` in slices; the address the first write answers with is the file's. */
  async function write(blob: Blob, path: string): Promise<string> {
    let uri = ''
    for (let offset = 0, first = true; first || offset < blob.size; offset += chunkBytes, first = false) {
      const data = await encode(blob.slice(offset, offset + chunkBytes))
      if (first) {
        uri = (await files.writeFile({ ...at(path), data, recursive: true })).uri
        // the share sheet takes file addresses and nothing else
        if (typeof uri !== 'string' || !uri.startsWith('file:')) throw new Error('The file could not be prepared for sharing')
      } else {
        await files.appendFile({ ...at(path), data })
      }
    }
    return uri
  }

  return async (blob, fileName) => {
    if (open) return { kind: 'failed', why: 'busy', error: new Error('A save is already open') }
    open = true
    try {
      const name = safeFileName(fileName)
      const path = `${SHARE_DIR}/${name}`
      let uri: string
      try {
        await clear()
        uri = await write(blob, path)
      } catch (error) {
        await files.deleteFile(at(path)).catch(() => undefined) // half a file is no file
        return { kind: 'failed', why: classify(error), error }
      }
      try {
        await share.share({ title: name, files: [uri], dialogTitle: 'Save or send' })
        return { kind: 'shared' }
      } catch (error) {
        if (CANCELLED.test(messageOf(error))) return { kind: 'cancelled' }
        return { kind: 'failed', why: classify(error), error }
      }
    } finally {
      open = false
    }
  }
}
