import { note } from '../diagnostics/capture'
import { downloadBlob } from '../download'
import { isNativeApp } from '../platform'
import type { SaveFailure, SaveOutcome } from './types'

export type { SaveFailure, SaveOutcome } from './types'

/**
 * Save a file for the person: a download on the web and in the desktop shell (the browser decides where it goes), and in the Android
 * app, whose WebView ignores a download link, a file written to the app's cache and handed to the system share sheet. Never throws:
 * what happened is the answer, and `saveWords` says it. Everything that failed for a reason of the device or the app is in the error log.
 */
export async function saveFile(blob: Blob, fileName: string): Promise<SaveOutcome> {
  if (!isNativeApp()) {
    try {
      downloadBlob(blob, fileName)
      return { kind: 'downloaded' }
    } catch (error) {
      note('save')(error)
      return { kind: 'failed', why: 'other', error }
    }
  }
  try {
    // a chunk of its own, with `@capacitor/core` in it: the web never fetches it
    const { saveNative } = await import('./plugins')
    const outcome = await saveNative(blob, fileName)
    if (outcome.kind === 'failed' && outcome.why !== 'busy') note('save')(outcome.error)
    return outcome
  } catch (error) {
    note('save')(error) // the chunk could not be fetched, or a plugin is not in this build
    return { kind: 'failed', why: 'unavailable', error }
  }
}

const REASON: Readonly<Record<SaveFailure, string>> = {
  full: 'this device has no room left',
  busy: 'another save is still open',
  unavailable: 'this app cannot save files here',
  other: 'something went wrong, and the details are in Sound & tools → Diagnostics',
}

/**
 * What to tell the person, or null for a download: each caller has its own words for that one (*Exported 12 tracks*), because a
 * download is all that is known of it, and nothing here claims more than happened.
 */
export function saveWords(outcome: SaveOutcome, fileName: string): string | null {
  switch (outcome.kind) {
    case 'downloaded':
      return null
    case 'shared':
      return `Shared ${fileName}.`
    case 'cancelled':
      return 'Not saved: the share sheet was closed.'
    case 'failed':
      return `Could not save ${fileName}: ${REASON[outcome.why]}.`
  }
}
