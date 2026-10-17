import { getDesktopBridge } from '../../desktop-bridge'
import { toast } from '../overlays'
import { OfflineController, chooseOfflinePlan } from './updates'

/** The browser's service worker container, or undefined where there is none (an insecure address, some private windows). */
function workers(): ServiceWorkerContainer | undefined {
  try {
    return 'serviceWorker' in navigator ? navigator.serviceWorker : undefined
  } catch {
    return undefined // some browsers throw when storage is blocked
  }
}

/** The browser's Cache Storage, or undefined where there is none (an insecure address, a sandboxed frame that throws on access). */
function cacheStorage(): CacheStorage | undefined {
  try {
    return 'caches' in window ? window.caches : undefined
  } catch {
    return undefined
  }
}

/** True inside the Android app (Capacitor adds `window.Capacitor` to its WebView). */
const isNativeApp = (): boolean => (window as { Capacitor?: { isNativePlatform?: () => boolean } }).Capacitor?.isNativePlatform?.() === true

/** The one offline controller of the page: the settings read its state, and `startOffline` sets it going. */
export const offline = new OfflineController({
  container: workers(),
  caches: cacheStorage(),
  scriptUrl: `${import.meta.env.BASE_URL}sw.js`,
  reload: () => window.location.reload(),
  now: () => Date.now(),
  // 0: stays until dismissed. A person who dismisses it can still update from Sound & tools.
  prompt: (text, action) => void toast(text, { action, ms: 0 }),
  onForeground: (listener) =>
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') listener()
    }),
  every: (ms, listener) => void window.setInterval(listener, ms),
})

/** Decide, once the page has loaded, whether this window gets a service worker, and set it going. Never rejects. */
export function startOffline(): Promise<void> {
  return offline.start(
    chooseOfflinePlan({ production: import.meta.env.PROD, hasWorkers: workers() !== undefined, desktop: getDesktopBridge() !== null, native: isNativeApp() }),
  )
}
