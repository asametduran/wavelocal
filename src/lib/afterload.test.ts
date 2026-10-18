import { beforeEach, describe, expect, it, vi } from 'vitest'
import { afterLoad } from './afterload'

// What starts once the page has loaded: the offline copy everywhere, and the Android shell only in the Android app.

const mocks = vi.hoisted(() => ({
  isNative: vi.fn(),
  startOffline: vi.fn(),
  /** Runs when `./androidshell` is first imported: a web page must never get that far. */
  shellLoaded: vi.fn(),
  startShell: vi.fn(),
  note: vi.fn(),
}))
vi.mock('./platform', () => ({ isNativeApp: mocks.isNative }))
vi.mock('./offline/instance', () => ({ startOffline: mocks.startOffline }))
vi.mock('./diagnostics/capture', () => ({ note: (kind: string) => (error: unknown) => mocks.note(kind, error) }))
vi.mock('./androidshell', () => {
  mocks.shellLoaded()
  return { startAndroidShell: mocks.startShell }
})

const flush = () => new Promise((resolve) => setTimeout(resolve, 0))

beforeEach(() => {
  mocks.isNative.mockReset().mockReturnValue(false)
  mocks.startOffline.mockReset().mockResolvedValue(undefined)
  mocks.startShell.mockReset().mockResolvedValue(undefined)
  mocks.note.mockReset()
})

describe('afterLoad on the web and in the desktop shell', () => {
  it('starts the offline copy and nothing else', async () => {
    await afterLoad()
    expect(mocks.startOffline).toHaveBeenCalledTimes(1)
    await flush()
    expect(mocks.shellLoaded).not.toHaveBeenCalled() // the chunk with Capacitor in it is not even fetched
    expect(mocks.startShell).not.toHaveBeenCalled()
  })

  it('answers as the offline start does, including when it fails', async () => {
    const failure = new Error('no storage')
    mocks.startOffline.mockRejectedValue(failure)
    await expect(afterLoad()).rejects.toBe(failure)
  })
})

describe('afterLoad in the Android app', () => {
  beforeEach(() => mocks.isNative.mockReturnValue(true))

  it('starts the offline copy and the shell', async () => {
    await afterLoad()
    await flush()
    expect(mocks.startOffline).toHaveBeenCalledTimes(1)
    expect(mocks.startShell).toHaveBeenCalledTimes(1)
    expect(mocks.note).not.toHaveBeenCalled()
  })

  it('keeps a shell that cannot start in the error log, and the offline start is not held up by it', async () => {
    const failure = new Error('"App" plugin is not implemented on android')
    mocks.startShell.mockRejectedValue(failure)
    await expect(afterLoad()).resolves.toBeUndefined()
    await flush()
    expect(mocks.note).toHaveBeenCalledWith('shell', failure)
    expect(mocks.startOffline).toHaveBeenCalledTimes(1)
  })

  it('does not let a failing offline start stop the shell', async () => {
    mocks.startOffline.mockRejectedValue(new Error('x'))
    await expect(afterLoad()).rejects.toThrow('x')
    await flush()
    expect(mocks.startShell).toHaveBeenCalledTimes(1)
  })
})
