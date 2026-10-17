import { toast } from '../overlays'
import { idbKeyValue } from '../rawdb'
import { ListeningService } from './service'

/** An id for a new bookmark; it only has to be different from the others of the same track. */
const newBookmarkId = (): string => `b${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`

/**
 * The page's one listening service. The seek bar is mounted twice (footer and phone sheet) and both read this, with the list
 * dialog, the waveform and the keys. Only lazy code imports it (it reaches the database, which the start-up code must not drag
 * along).
 */
export const listeningService = new ListeningService({
  kv: idbKeyValue,
  now: Date.now,
  newId: newBookmarkId,
  onSaveError: () => toast('Your bookmarks could not be saved on this device (the storage is full or blocked). They stay until the app is closed.'),
})
