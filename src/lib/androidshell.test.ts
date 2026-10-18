import { beforeEach, describe, expect, it, vi } from 'vitest'
import { startAndroidShell } from './androidshell'
import type { AppPort } from './androidshell'

// The Android shell against a scripted `App` plugin: what it listens for, and what each press of the button makes it do.

const mocks = vi.hoisted(() => ({ register: vi.fn(), note: vi.fn() }))
vi.mock('@capacitor/core', () => ({ registerPlugin: mocks.register }))
vi.mock('./diagnostics/capture', () => ({ note: (kind: string) => (error: unknown) => mocks.note(kind, error) }))

type Listener = (event: unknown) => void

/** A scripted plugin: remembers what it was asked to listen for, and how often it was asked to minimize. */
function plugin(options: { add?: () => Promise<{ remove(): Promise<void> }>; minimize?: () => Promise<void> } = {}) {
  const added: { eventName: string; listener: Listener }[] = []
  const app: AppPort = {
    addListener: vi.fn((eventName: 'backButton', listener: Listener) => {
      added.push({ eventName, listener })
      return options.add ? options.add() : Promise.resolve({ remove: async () => undefined })
    }),
    minimizeApp: vi.fn(options.minimize ?? (async () => undefined)),
  }
  /** Press the button the way the plugin tells the page. */
  const press = (event: unknown): void => added[0]?.listener(event)
  return { app, added, press }
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0))

beforeEach(() => {
  mocks.register.mockReset()
  mocks.note.mockReset()
})

describe('startAndroidShell', () => {
  it('listens for the Back button, once', async () => {
    const { app, added } = plugin()
    await startAndroidShell(app, { back: vi.fn() })
    expect(added.map((a) => a.eventName)).toEqual(['backButton'])
    expect(app.minimizeApp).not.toHaveBeenCalled() // nothing happens until the button is pressed
  })

  it('goes back in the history when the WebView has an entry to go back to', async () => {
    const { app, press } = plugin()
    const history = { back: vi.fn() }
    await startAndroidShell(app, history)
    press({ canGoBack: true })
    expect(history.back).toHaveBeenCalledTimes(1)
    expect(app.minimizeApp).not.toHaveBeenCalled()
  })

  it('goes back once for every press', async () => {
    const { app, press } = plugin()
    const history = { back: vi.fn() }
    await startAndroidShell(app, history)
    for (let i = 0; i < 3; i++) press({ canGoBack: true })
    expect(history.back).toHaveBeenCalledTimes(3)
  })

  it('sends the app to the background at the root, and leaves the history alone', async () => {
    const { app, press } = plugin()
    const history = { back: vi.fn() }
    await startAndroidShell(app, history)
    press({ canGoBack: false })
    expect(app.minimizeApp).toHaveBeenCalledTimes(1)
    expect(history.back).not.toHaveBeenCalled()
  })

  it('keeps a minimize the plugin refused in the error log, and goes on', async () => {
    const refusal = new Error('no activity')
    const { app, press } = plugin({ minimize: () => Promise.reject(refusal) })
    await startAndroidShell(app, { back: vi.fn() })
    press({ canGoBack: false })
    await flush()
    expect(mocks.note).toHaveBeenCalledWith('shell', refusal)
    press({ canGoBack: false }) // the button still works
    expect(app.minimizeApp).toHaveBeenCalledTimes(2)
  })

  it('rejects, for the caller to keep in the error log, when the plugin cannot listen (a build without it)', async () => {
    const missing = new Error('"App" plugin is not implemented on android')
    const { app } = plugin({ add: () => Promise.reject(missing) })
    await expect(startAndroidShell(app, { back: vi.fn() })).rejects.toBe(missing)
  })

  it('takes the plugin from Capacitor and the history from the window when it is handed neither', async () => {
    const { app, press } = plugin()
    mocks.register.mockReturnValue(app)
    const back = vi.spyOn(window.history, 'back').mockImplementation(() => undefined)
    await startAndroidShell()
    expect(mocks.register).toHaveBeenCalledTimes(1)
    expect(mocks.register).toHaveBeenCalledWith('App')
    press({ canGoBack: true })
    expect(back).toHaveBeenCalledTimes(1)
  })

  it('does not register a plugin of Capacitor when it is handed one', async () => {
    await startAndroidShell(plugin().app, { back: vi.fn() })
    expect(mocks.register).not.toHaveBeenCalled()
  })
})
