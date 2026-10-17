import type { StorageLike } from '../choicepref'
import { cleanSpeed } from './progress'

/**
 * The speed a person listens to music at, kept apart from the speed the player is set to now. A long recording can be played faster
 * than songs; when the app is opened on such a recording the player's own saved speed is the recording's, and without this the next
 * song would be played at it.
 */

export const USUAL_SPEED_KEY = 'wl.usualspeed'

/** The usual speed kept on the device, or null when there is none (or storage is blocked). */
export function readUsualSpeed(storage: StorageLike | null): number | null {
  try {
    const raw = storage?.getItem(USUAL_SPEED_KEY)
    return raw ? cleanSpeed(Number(raw)) : null
  } catch {
    return null
  }
}

export function writeUsualSpeed(storage: StorageLike | null, speed: number): void {
  const clean = cleanSpeed(speed)
  if (clean === null) return
  try {
    storage?.setItem(USUAL_SPEED_KEY, String(clean))
  } catch {
    // storage blocked: the speed lasts for this visit
  }
}
