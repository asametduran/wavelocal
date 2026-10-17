import { formatTime } from '../format'
import { promptDialog, toast } from '../overlays'
import { MAX_BOOKMARKS, MAX_LABEL, cleanLabel } from './bookmarks'
import type { AddOutcome, ListeningService } from './service'
import type { Bookmark } from './types'

/**
 * Where bookmarks meet the page: the B key, the buttons and the list ask for one of these at the playhead (or at a bookmark),
 * and this makes the change in the service and says what happened (a toast, which a screen reader hears too). A change that can
 * be undone says so with an Undo action, which `Ctrl+Z` runs as well.
 */

/** The part of the player the bookmark controls use. */
export interface MarkPlayer {
  current: { key: string; duration: number } | null
  /** The exact playhead in seconds. */
  position: () => number
  /** The length the player has measured, 0 until the file has been read. */
  duration: number
}

function refusal(result: Exclude<AddOutcome, { ok: true }>): string {
  switch (result.reason) {
    case 'there':
      return `Already marked: ${result.existing.label} at ${formatTime(result.existing.t)}`
    case 'full':
      return `A track holds at most ${MAX_BOOKMARKS} bookmarks. Delete one to make room.`
    case 'unavailable':
      return 'The bookmarks of this track are not ready yet. Try again in a moment.'
    case 'bad':
      return 'That place is not in this track.'
  }
}

/** Bookmark the playing track where the playhead is now. */
export function markHere(service: ListeningService, p: MarkPlayer): void {
  const track = p.current
  if (!track) return
  const result = service.add(track.key, p.position(), p.duration || track.duration)
  if (!result.ok) {
    toast(refusal(result))
    return
  }
  const { bookmark } = result
  toast(`${bookmark.label} at ${formatTime(bookmark.t)}`, { action: { label: 'Rename', run: () => void renameMark(service, track.key, bookmark) } })
}

/** Ask for a new name for a bookmark and keep it. Nothing changes when the question is cancelled. */
export async function renameMark(service: ListeningService, key: string, bookmark: Bookmark): Promise<void> {
  const answer = await promptDialog({ title: 'Rename bookmark', label: 'Bookmark name', value: bookmark.label, confirmLabel: 'Save', maxLength: MAX_LABEL })
  if (answer === null) return
  if (!cleanLabel(answer)) toast('A bookmark needs a name.')
  else if (!service.rename(key, bookmark.id, answer)) toast('That bookmark is no longer there.')
}

/** Delete a bookmark, with an Undo that puts it back in its place. */
export function deleteMark(service: ListeningService, key: string, bookmark: Bookmark): void {
  const removed = service.remove(key, bookmark.id)
  if (!removed) return
  const undo = (): void => {
    if (!service.restore(key, removed)) toast(`Another bookmark was made at that place since, so “${removed.label}” could not come back.`)
  }
  toast(`Deleted bookmark “${removed.label}”`, { action: { label: 'Undo', run: undo } })
}
