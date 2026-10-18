/**
 * True inside the Android app. Capacitor's native bridge puts `window.Capacitor`, with an `isNativePlatform` that says yes, into the
 * WebView before any page script runs, so this needs none of Capacitor's own code: the web app and the desktop shell never load it.
 */
export const isNativeApp = (): boolean => {
  try {
    return (window as { Capacitor?: { isNativePlatform?: () => unknown } }).Capacitor?.isNativePlatform?.() === true
  } catch {
    return false // a Capacitor that cannot be asked (no function to call, or one that throws) is not the app: the web's way of doing things
  }
}
