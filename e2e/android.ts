import type { Page } from '@playwright/test'

// A fake Android device for the page. It gives the page what Capacitor's injected `native-bridge.js` gives a real WebView (read from
// its source): `window.androidBridge` (which `@capacitor/core` takes to mean Android), `window.Capacitor` with `isNativePlatform`,
// `PluginHeaders` (the methods the native side lists for each plugin) and `nativePromise` / `nativeCallback`, which carry every call
// of a plugin. The app's own code and the real `@capacitor/core` run unchanged on top of it; only the native side is scripted: an
// in-memory cache directory, a share sheet and the `App` plugin's Back button.

export interface AndroidCall {
  plugin: string
  method: string
  options: Record<string, unknown>
}

/** How the device answers. Changed from a test with `setAndroid`. */
export interface AndroidBehaviour {
  /** Every write (`writeFile` and `appendFile`) from the n-th on fails (0: all of them); null: none fails. */
  failWritesFrom: number | null
  /** What a failing write says. */
  failMessage: string
  /** How the share sheet ends. `hold`: it stays open until `releaseShareSheet`. */
  share: 'shared' | 'cancel' | 'busy' | 'error' | 'hold'
}

/** What the device saw, as plain data. */
export interface AndroidSeen {
  calls: AndroidCall[]
  /** path inside the cache directory -> the base64 slices written to it, in order */
  files: Record<string, string[]>
  /** every request the share sheet was asked for */
  shared: { title?: string; files?: string[]; dialogTitle?: string }[]
  /** how many times the app asked to be minimized, and to exit */
  minimized: number
  exits: number
}

interface AndroidDevice extends AndroidSeen {
  behaviour: AndroidBehaviour
  writes: number
  dirs: string[]
  held: (() => void) | null
  listeners: Record<string, (event: unknown) => void>
}

declare global {
  interface Window {
    __android: AndroidDevice
  }
}

const DEFAULTS: AndroidBehaviour = { failWritesFrom: null, failMessage: 'No space left on device', share: 'shared' }

export interface FakeAndroidOptions {
  /** False plays a build that lacks `@capacitor/app`: the native side lists no `App` plugin. */
  app?: boolean
}

/** Make the page an Android app. Call before the page loads (before `PlayerPage.open()`). */
export async function installFakeAndroid(page: Page, { app = true }: FakeAndroidOptions = {}): Promise<void> {
  await page.addInitScript(({ defaults, withApp }) => {
    const device: AndroidDevice = { calls: [], files: {}, shared: [], minimized: 0, exits: 0, behaviour: { ...defaults }, writes: 0, dirs: [], held: null, listeners: {} }
    window.__android = device
    const CACHE = 'file:///data/user/0/com.wavelocal.player/cache/'

    const failing = (): void => {
      const from = device.behaviour.failWritesFrom
      const n = device.writes++
      if (from !== null && n >= from) throw new Error(device.behaviour.failMessage)
    }

    const answer = (plugin: string, method: string, options: Record<string, unknown>): unknown => {
      const path = String(options.path ?? '')
      switch (`${plugin}.${method}`) {
        case 'Filesystem.writeFile': {
          failing()
          device.files[path] = [String(options.data)]
          if (options.recursive) device.dirs.push(path.split('/').slice(0, -1).join('/'))
          return { uri: `${CACHE}${path}` }
        }
        case 'Filesystem.appendFile': {
          failing()
          if (!device.files[path]) throw new Error('File does not exist')
          device.files[path].push(String(options.data))
          return undefined
        }
        case 'Filesystem.readdir': {
          if (!device.dirs.includes(path)) throw new Error('Directory does not exist')
          const prefix = `${path}/`
          const names = Object.keys(device.files).filter((name) => name.startsWith(prefix) && !name.slice(prefix.length).includes('/'))
          return { files: names.map((name) => ({ name: name.slice(prefix.length), type: 'file', size: 0, mtime: 0, uri: `${CACHE}${name}` })) }
        }
        case 'Filesystem.deleteFile': {
          if (!device.files[path]) throw new Error('File does not exist')
          delete device.files[path]
          return undefined
        }
        case 'Share.share': {
          device.shared.push(options as AndroidSeen['shared'][number])
          switch (device.behaviour.share) {
            case 'cancel':
              throw new Error('Share canceled')
            case 'busy':
              throw new Error("Can't share while sharing is in progress")
            case 'error':
              throw new Error('only file urls are supported')
            case 'hold':
              return new Promise((resolve) => {
                device.held = () => resolve({ activityType: '' })
              })
            default:
              return { activityType: 'com.google.android.apps.docs' }
          }
        }
        case 'App.minimizeApp':
          device.minimized++
          return undefined
        case 'App.exitApp':
          device.exits++
          return undefined
        default:
          return undefined
      }
    }

    const promise = (name: string) => ({ name, rtype: 'promise' })
    Object.assign(window, {
      androidBridge: { postMessage: () => undefined },
      Capacitor: {
        isNativePlatform: () => true,
        PluginHeaders: [
          { name: 'Filesystem', methods: ['writeFile', 'appendFile', 'readdir', 'deleteFile'].map(promise) },
          { name: 'Share', methods: [promise('share'), promise('canShare')] },
          ...(withApp ? [{ name: 'App', methods: [{ name: 'addListener', rtype: 'callback' }, promise('removeListener'), promise('exitApp'), promise('minimizeApp')] }] : []),
        ],
        // an answer comes from the native side a moment later, never in the same breath as the call
        nativePromise: (plugin: string, method: string, options: Record<string, unknown> = {}) => {
          device.calls.push({ plugin, method, options })
          return new Promise((resolve, reject) => {
            setTimeout(() => {
              try {
                resolve(answer(plugin, method, options))
              } catch (error) {
                reject(error)
              }
            }, 0)
          })
        },
        nativeCallback: (plugin: string, method: string, options: Record<string, unknown> = {}, callback?: (event: unknown) => void) => {
          device.calls.push({ plugin, method, options })
          if (method === 'addListener' && callback) device.listeners[String(options.eventName)] = callback
          return `callback-${device.calls.length}`
        },
      },
    })
  }, { defaults: DEFAULTS, withApp: app })
}

/** What the device has seen so far. */
export function androidSeen(page: Page): Promise<AndroidSeen> {
  return page.evaluate(() => {
    const { calls, files, shared, minimized, exits } = window.__android
    return { calls, files, shared, minimized, exits }
  })
}

/** Change how the device answers from now on. */
export async function setAndroid(page: Page, patch: Partial<AndroidBehaviour>): Promise<void> {
  await page.evaluate((change) => void Object.assign(window.__android.behaviour, change), patch)
}

/** Close a share sheet that was held open (`share: 'hold'`). */
export async function releaseShareSheet(page: Page): Promise<void> {
  await page.evaluate(() => {
    window.__android.held?.()
    window.__android.held = null
  })
}

/** The bytes of a file written to the cache folder, from its base64 slices. */
export function savedBytes(seen: AndroidSeen, path: string): Buffer {
  return Buffer.concat((seen.files[path] ?? []).map((slice) => Buffer.from(slice, 'base64')))
}

/** The names of the plugin methods called, in order (`Filesystem.writeFile`, `Share.share`, ...), without the listeners' bookkeeping. */
export const methodsCalled = (seen: AndroidSeen, plugin?: string): string[] =>
  seen.calls.filter((call) => (plugin ? call.plugin === plugin : true) && call.method !== 'addListener' && call.method !== 'removeListener').map((call) => `${call.plugin}.${call.method}`)

/** Whether the app has asked the `App` plugin to tell it about the hardware Back button. */
export function hasBackListener(page: Page): Promise<boolean> {
  return page.evaluate(() => window.__android.listeners.backButton !== undefined)
}

/**
 * Press the hardware Back button: the `App` plugin tells the page's listener whether the WebView can go back, and the page does the
 * rest. `canGoBack` is what a WebView answers (whether the current history entry has one before it, which the Navigation API
 * knows); a test can force it. False if nothing listens.
 */
export function pressBack(page: Page, canGoBack?: boolean): Promise<boolean> {
  return page.evaluate((forced) => {
    const listener = window.__android.listeners.backButton
    const can = forced ?? (window as unknown as { navigation: { canGoBack: boolean } }).navigation.canGoBack
    listener?.({ canGoBack: can })
    return listener !== undefined
  }, canGoBack)
}
