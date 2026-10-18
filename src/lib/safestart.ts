/**
 * "Start fresh" on the recovery screen reloads the page once with a flag set in `sessionStorage` (it belongs to this tab and goes with
 * it). The start-up code then leaves out what the last session left behind that could be what crashed it: where playback was and what
 * was queued. The music, the playlists and the other things kept in the database are never touched. The flag is read once, when the
 * page loads, and taken away, so it applies to one start only.
 */

const FLAG = 'wl.safe'
/** Settings and small choices live in `localStorage` under `wl-` and `wl.` names; the error log is the one thing to keep for the report. */
const MINE = /^wl[-.]/
const KEPT = 'wl.diagnostics'

function take(): boolean {
  try {
    const on = sessionStorage.getItem(FLAG) === '1'
    if (on) sessionStorage.removeItem(FLAG)
    return on
  } catch {
    return false
  }
}

/** Whether this page was started by "Start fresh". */
export const safeStart: boolean = take()

/** Ask for the next start to be a fresh one. */
export function requestSafeStart(): void {
  try {
    sessionStorage.setItem(FLAG, '1')
  } catch {
    // a browser that keeps nothing keeps no flag either; the reload still gives defaults, for the settings are gone
  }
}

/** Forget every setting and small choice Wavelocal keeps in this browser, except the error log. Says how many there were. */
export function forgetSettings(storage: Pick<Storage, 'key' | 'length' | 'removeItem'> = localStorage): number {
  const doomed: string[] = []
  for (let i = 0; i < storage.length; i++) {
    const key = storage.key(i)
    if (key !== null && MINE.test(key) && key !== KEPT) doomed.push(key)
  }
  doomed.forEach((key) => storage.removeItem(key))
  return doomed.length
}

/**
 * What "Start fresh" does, in an order that cannot get stuck: forget the settings, ask for the next start to be a fresh one, reload.
 * A browser that refuses storage altogether has nothing to forget (reaching it throws), and the reload still gives the defaults.
 */
export function startFresh(reload: () => void, storage?: Pick<Storage, 'key' | 'length' | 'removeItem'>): void {
  try {
    forgetSettings(storage)
  } catch {
    // a browser that keeps nothing keeps no settings either
  }
  requestSafeStart()
  reload()
}
