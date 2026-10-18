/**
 * What the hardware Back button does in the Android app. Capacitor's `App` plugin tells the page when the button is pressed, and
 * whether the WebView has an entry to go back to (`canGoBack`); once a page listens, the plugin does nothing of its own.
 *
 * Every layer of this app (a sheet, a dialog, an album page) is an entry of the browser history that Back is meant to close, so with
 * an entry to go back to, Back is the browser's Back and the layers keep their one way of closing. At the root there is nothing left
 * to close, and the app is a music player: it goes to the background and the music goes on, instead of ending the activity (which is
 * what Android does when nobody handles the button, and the music with it) or doing nothing at all.
 */

/** The two things the button can do, so that the rule is tested without a device. */
export interface BackActions {
  /** One step back in the page's history: the topmost layer closes. */
  goBack(): void
  /** Send the app to the background (the Home screen shows), leaving the activity and its music alive. */
  minimize(): void
}

/**
 * Do what a press of the button means. Only a plain `true` counts as an entry to go back to: a missing or odd answer (a plugin that
 * sends something else) takes the road that cannot do harm, which only moves the app to the background.
 */
export function handleBack(event: unknown, { goBack, minimize }: BackActions): void {
  const canGoBack = typeof event === 'object' && event !== null && (event as { canGoBack?: unknown }).canGoBack === true
  if (canGoBack) goBack()
  else minimize()
}
