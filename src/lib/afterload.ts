import { note } from './diagnostics/capture'
import { startOffline } from './offline/instance'
import { isNativeApp } from './platform'

/**
 * What waits for the page to finish loading, off the start-up path (`main.tsx` fetches this as a chunk of its own once the window has
 * loaded): the offline copy, which decides for itself whether this window gets one, and, inside the Android app only, the app's shell
 * (the hardware Back button), so that the web never fetches that code or Capacitor's. Rejects only as `startOffline` does; a shell
 * that cannot start is kept in the error log and the app goes on without it.
 */
export function afterLoad(): Promise<void> {
  if (isNativeApp()) import('./androidshell').then((shell) => shell.startAndroidShell()).catch(note('shell'))
  return startOffline()
}
