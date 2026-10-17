import { useCallback, useSyncExternalStore } from 'react'
import { listeningService } from '../lib/listening/instance'
import { bookmarksOf } from '../lib/listening/service'
import type { BookmarksState } from '../lib/listening/service'
import type { Bookmark } from '../lib/listening/types'

/** What is known of a track's bookmarks (not yet, loading, the list, or failed), by the track's library key: one store, read by both seek bars, the waveform, the list and the keys. */
export function useBookmarkState(trackKey: string | undefined): BookmarksState {
  return useSyncExternalStore(listeningService.subscribe, useCallback(() => listeningService.getState(trackKey ?? ''), [trackKey]))
}

/** The bookmarks of a track in time order; none until they are known. The same array until they change. */
export function useBookmarks(trackKey: string | undefined): readonly Bookmark[] {
  return bookmarksOf(useBookmarkState(trackKey))
}
