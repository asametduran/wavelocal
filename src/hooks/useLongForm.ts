import { useEffect, useRef, useState, useSyncExternalStore } from 'react'
import { deviceStorage } from '../lib/choicepref'
import { progressService, pruneProgressOnce } from '../lib/listening/instance'
import { SKIP_BACK, SKIP_FORWARD } from '../lib/listening/progress'
import { LongFormSession } from '../lib/listening/session'
import type { SessionPort } from '../lib/listening/session'
import { readUsualSpeed, writeUsualSpeed } from '../lib/listening/usualspeed'
import { DEFAULT_SKIP, mediaSkip } from '../lib/mediaskip'
import { toast } from '../lib/overlays'
import { getShareSnapshot, subscribeShare } from '../lib/share/store'
import type { PlayerApi } from '../types'
import { useIsLongForm, useProgressReady } from './useProgress'

/**
 * Looks after a long recording (a podcast, a lecture, a book) while it plays: it is taken up where it was left, the place is
 * kept as it plays, and it has a speed of its own (the rules are in `lib/listening/session.ts`; this only tells the session
 * what the player does and lends it the player's hands). The back and forward buttons of the lock screen and the notification
 * shade move further for such a recording. Mounted once, by the lazy `ListeningController`.
 */
export function useLongForm(p: PlayerApi): void {
  const latest = useRef(p)
  latest.current = p
  const ready = useProgressReady()
  // a guest of a shared session plays what the host plays, where and how fast the host does: that is not the guest's own listening
  const following = useSyncExternalStore(subscribeShare, () => getShareSnapshot().phase === 'guest')
  const [session] = useState(() => {
    const port: SessionPort = {
      position: () => latest.current.position(),
      seek: (seconds) => latest.current.seek(seconds),
      setSpeed: (speed) => latest.current.setSpeed(speed),
      readUsualSpeed: () => readUsualSpeed(deviceStorage()),
      writeUsualSpeed: (speed) => writeUsualSpeed(deviceStorage(), speed),
      toast: (text, action) => void toast(text, { action }),
      now: () => performance.now(),
    }
    return new LongFormSession({ store: progressService, port })
  })

  const { current, playing, time, speed, hydrated } = p
  const duration = p.duration || current?.duration || 0
  const long = useIsLongForm(current, duration)
  const key = following ? null : (current?.key ?? null)

  useEffect(() => {
    if (ready) session.update({ key, long, playing, time, duration, speed })
  }, [ready, session, key, long, playing, time, duration, speed])

  // the place is kept the moment the page is going away: closed, or hidden (the last event a phone is sure to send)
  useEffect(() => {
    const flush = () => session.flush()
    const onVisibility = () => {
      if (document.visibilityState === 'hidden') flush()
    }
    window.addEventListener('pagehide', flush)
    document.addEventListener('visibilitychange', onVisibility)
    return () => {
      window.removeEventListener('pagehide', flush)
      document.removeEventListener('visibilitychange', onVisibility)
      session.close()
    }
  }, [session])

  // the lock screen and the notification shade skip further through a long recording than through a song
  useEffect(() => {
    mediaSkip.back = long ? SKIP_BACK : DEFAULT_SKIP
    mediaSkip.forward = long ? SKIP_FORWARD : DEFAULT_SKIP
    return () => {
      mediaSkip.back = DEFAULT_SKIP
      mediaSkip.forward = DEFAULT_SKIP
    }
  }, [long])

  useEffect(() => {
    if (hydrated) pruneProgressOnce()
  }, [hydrated])
}
