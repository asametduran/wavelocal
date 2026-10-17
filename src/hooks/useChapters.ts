import { useCallback, useSyncExternalStore } from 'react'
import { chaptersService } from '../lib/chapters/instance'
import type { ChaptersState } from '../lib/chapters/service'

/** What is known of a track's chapters (not yet, loading, the list, or failed): one store, read by both seek bars and the list. */
export function useChapters(trackId: string | undefined): ChaptersState {
  return useSyncExternalStore(chaptersService.subscribe, useCallback(() => chaptersService.getState(trackId ?? ''), [trackId]))
}
