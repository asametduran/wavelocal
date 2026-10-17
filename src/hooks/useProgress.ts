import { useCallback, useEffect, useState, useSyncExternalStore } from 'react'
import { progressService } from '../lib/listening/instance'
import { longFormThreshold } from '../lib/listening/prefs'
import { isLongForm } from '../lib/listening/progress'
import type { Progress } from '../lib/listening/progress'

/** Whether what is kept about the tracks has been read from the database. It stays false when it cannot be read. */
export function useProgressReady(): boolean {
  const [ready, setReady] = useState(false)
  useEffect(() => {
    let alive = true
    void progressService.ready().then((ok) => {
      if (alive) setReady(ok)
    })
    return () => {
      alive = false
    }
  }, [])
  return ready
}

/** What is kept about a track (where the person stopped, its speed, the choice made for it), by its library key; null when nothing. One store, read by the row, the list and the controller; the first reader has it read. */
export function useProgress(trackKey: string | undefined): Progress | null {
  useEffect(() => {
    void progressService.ready()
  }, [])
  return useSyncExternalStore(progressService.subscribe, useCallback(() => (trackKey ? progressService.get(trackKey) : null), [trackKey]))
}

/** Whether the track is a long recording: by its length and the length the person chose, unless they said otherwise for this track. */
export function useIsLongForm(track: { key: string; duration: number } | null | undefined, liveDuration: number): boolean {
  const threshold = useSyncExternalStore(longFormThreshold.subscribe, longFormThreshold.get)
  const progress = useProgress(track?.key)
  return track ? isLongForm({ duration: liveDuration || track.duration, threshold, mode: progress?.mode ?? 'auto' }) : false
}
