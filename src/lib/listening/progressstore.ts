import type { KeyValue } from '../rawdb'
import { isEmpty, normalizeProgress } from './progress'
import type { Progress } from './progress'

/**
 * Where a person stopped in each long recording, at what speed they play it and whether it is remembered, in the app's `meta`
 * store under `heard:<track key>`. The key is the library key of the file (`name|size|modified`), so it outlives removing the file
 * and adding it again. It is kept apart from the bookmarks (`listen:`) because it is written every few seconds while a recording
 * plays, and a place must not rewrite a list of two hundred bookmarks. A record with nothing to remember is not kept at all.
 */

export const HEARD_PREFIX = 'heard:'

export const heardKey = (trackKey: string): string => HEARD_PREFIX + trackKey

/** Every record kept, by track key. Null when the database could not be read (so nobody writes over what could not be seen). */
export async function loadAllProgress(kv: KeyValue): Promise<Map<string, Progress> | null> {
  try {
    const all = new Map<string, Progress>()
    for (const stored of await kv.keys(HEARD_PREFIX)) {
      const progress = normalizeProgress(await kv.get(stored))
      if (progress) all.set(stored.slice(HEARD_PREFIX.length), progress)
    }
    return all
  } catch {
    return null
  }
}

/** Keep the record (an empty one deletes it). False when the disk is full or blocked; it never throws. */
export async function saveProgress(kv: KeyValue, trackKey: string, progress: Progress): Promise<boolean> {
  try {
    if (isEmpty(progress)) await kv.delete(heardKey(trackKey))
    else await kv.set(heardKey(trackKey), { ...progress })
    return true
  } catch {
    return false
  }
}

export async function deleteProgress(kv: KeyValue, trackKey: string): Promise<boolean> {
  try {
    await kv.delete(heardKey(trackKey))
    return true
  } catch {
    return false
  }
}
