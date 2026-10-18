import { registerPlugin } from '@capacitor/core'
import { handleBack } from './androidback'
import { note } from './diagnostics/capture'

/**
 * The part of `@capacitor/app` used here: our own description of it, as with the file plugins in `savefile/plugins.ts`, so that no
 * plugin code or enum comes along. The package is a dependency so that `cap sync` wires its native half, which is what makes the
 * Back button reach the page at all.
 */
export interface AppPort {
  addListener(eventName: 'backButton', listener: (event: unknown) => void): Promise<{ remove(): Promise<void> }>
  minimizeApp(): Promise<void>
}

/**
 * The Android app's own behaviour: the hardware Back button (see `androidback.ts`). Started once the page has loaded and only inside
 * the Android app (`afterload.ts`), and a chunk of its own with `@capacitor/core`, so that the web never fetches either. Resolves
 * when the listener is in place, and rejects when it cannot be (a build without the plugin). `app` and `history` are the plugin and
 * the window's history; a test hands in its own.
 */
export async function startAndroidShell(app: AppPort = registerPlugin<AppPort>('App'), history: Pick<History, 'back'> = window.history): Promise<void> {
  await app.addListener('backButton', (event) =>
    handleBack(event, {
      goBack: () => history.back(),
      minimize: () => void app.minimizeApp().catch(note('shell')),
    }),
  )
}
