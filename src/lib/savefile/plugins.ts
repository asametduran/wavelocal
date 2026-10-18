import { registerPlugin } from '@capacitor/core'
import { createNativeSaver } from './native'
import type { FilesPort, SharePort } from './native'

/**
 * The only file that loads `@capacitor/core`, and a lazy chunk that only the Android app ever fetches (see `index.ts`), so nothing of
 * Capacitor is in what the web app, the PWA or the desktop shell loads. The ports are our own descriptions of the two plugins, so no
 * plugin code or enum comes along; `@capacitor/filesystem` and `@capacitor/share` are dependencies so that `cap sync` wires their
 * native halves, which `registerPlugin` reaches through the bridge.
 */
export const saveNative = createNativeSaver({
  files: registerPlugin<FilesPort>('Filesystem'),
  share: registerPlugin<SharePort>('Share'),
})
