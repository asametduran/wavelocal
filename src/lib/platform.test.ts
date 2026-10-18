import { afterEach, describe, expect, it } from 'vitest'
import { isNativeApp } from './platform'

// Whether the page runs inside the Android app: Capacitor's native bridge puts `window.Capacitor` with an `isNativePlatform` into the
// WebView before any page script runs. The web, the PWA and the desktop shell have none of it.

const host = window as { Capacitor?: unknown }

afterEach(() => {
  delete host.Capacitor
})

describe('isNativeApp', () => {
  it('is false on the web, where there is no Capacitor at all', () => {
    expect(isNativeApp()).toBe(false)
  })

  it('is true when the native bridge says the platform is native', () => {
    host.Capacitor = { isNativePlatform: () => true }
    expect(isNativeApp()).toBe(true)
  })

  it('is false when Capacitor says the platform is the web', () => {
    host.Capacitor = { isNativePlatform: () => false }
    expect(isNativeApp()).toBe(false)
  })

  it.each<[string, unknown]>([
    ['an empty Capacitor', {}],
    ['no function to ask', { isNativePlatform: true }],
    ['null', null],
    ['a string', 'native'],
    ['an answer that is not a plain true (1)', { isNativePlatform: () => 1 }],
    ['an answer that is not a plain true ("true")', { isNativePlatform: () => 'true' }],
    ['an answer of undefined', { isNativePlatform: () => undefined }],
    [
      'a Capacitor that throws when asked',
      {
        isNativePlatform: () => {
          throw new Error('not ready')
        },
      },
    ],
  ])('is false for %s', (_name, value) => {
    host.Capacitor = value
    expect(isNativeApp()).toBe(false)
  })

  it('asks every time: the answer is not remembered', () => {
    host.Capacitor = { isNativePlatform: () => true }
    expect(isNativeApp()).toBe(true)
    delete host.Capacitor
    expect(isNativeApp()).toBe(false)
  })
})
