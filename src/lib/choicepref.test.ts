// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createChoicePref, deviceStorage, followOtherWindows } from './choicepref'
import type { StorageLike } from './choicepref'

type Size = 'small' | 'medium' | 'large'
const KEY = 'wl.test-size'
/** Medium unless the stored value is one of the others: an unknown or damaged value must give the default. */
const parse = (raw: unknown): Size => (raw === 'small' || raw === 'large' ? raw : 'medium')

function fakeStorage(initial: Record<string, string> = {}) {
  const data = new Map(Object.entries(initial))
  const storage: StorageLike & { data: Map<string, string> } = { data, getItem: (key) => data.get(key) ?? null, setItem: (key, value) => void data.set(key, value) }
  return storage
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('createChoicePref', () => {
  it('reads the stored choice once and keeps the answer', () => {
    const storage = fakeStorage({ [KEY]: 'large' })
    const getItem = vi.spyOn(storage, 'getItem')
    const pref = createChoicePref(KEY, parse, () => storage)
    expect(pref.get()).toBe('large')
    expect(pref.get()).toBe('large')
    expect(getItem).toHaveBeenCalledTimes(1)
    expect(getItem).toHaveBeenCalledWith(KEY)
  })

  it('is the default when nothing is stored, or what is stored is not one of the choices', () => {
    expect(createChoicePref(KEY, parse, () => fakeStorage()).get()).toBe('medium')
    for (const stored of ['', 'LARGE', 'huge', '{}']) expect(createChoicePref(KEY, parse, () => fakeStorage({ [KEY]: stored })).get(), stored).toBe('medium')
  })

  it('remembers a change on the device and tells everyone who listens', () => {
    const storage = fakeStorage()
    const pref = createChoicePref(KEY, parse, () => storage)
    const first = vi.fn()
    const second = vi.fn()
    pref.subscribe(first)
    pref.subscribe(second)
    pref.set('small')
    expect(pref.get()).toBe('small')
    expect(storage.data.get(KEY)).toBe('small')
    expect(first).toHaveBeenCalledTimes(1)
    expect(second).toHaveBeenCalledTimes(1)
  })

  it('does not wake anyone for a choice that did not change, nor anyone who stopped listening', () => {
    const pref = createChoicePref(KEY, parse, () => fakeStorage())
    const heard = vi.fn()
    const stop = pref.subscribe(heard)
    pref.set('medium')
    expect(heard).not.toHaveBeenCalled()
    stop()
    pref.set('large')
    expect(heard).not.toHaveBeenCalled()
  })

  it('works when storage is blocked: the choice lasts for the visit', () => {
    const blocked: StorageLike = {
      getItem: () => {
        throw new DOMException('denied', 'SecurityError')
      },
      setItem: () => {
        throw new DOMException('denied', 'SecurityError')
      },
    }
    const pref = createChoicePref(KEY, parse, () => blocked)
    expect(pref.get()).toBe('medium')
    const heard = vi.fn()
    pref.subscribe(heard)
    expect(() => pref.set('small')).not.toThrow()
    expect(pref.get()).toBe('small')
    expect(heard).toHaveBeenCalledTimes(1)
  })

  it('works with no storage at all', () => {
    const pref = createChoicePref(KEY, parse, () => null)
    expect(pref.get()).toBe('medium')
    pref.set('large')
    expect(pref.get()).toBe('large')
  })

  it('reads the storage again when another window changed it, and says so only when it differs', () => {
    const storage = fakeStorage()
    const pref = createChoicePref(KEY, parse, () => storage)
    expect(pref.get()).toBe('medium')
    const heard = vi.fn()
    pref.subscribe(heard)
    storage.data.set(KEY, 'small')
    pref.refresh()
    expect(pref.get()).toBe('small')
    expect(heard).toHaveBeenCalledTimes(1)
    pref.refresh()
    expect(heard).toHaveBeenCalledTimes(1)
  })

  it('does not tell anyone about a refresh before the choice was ever read: the first read will see the new value anyway', () => {
    const storage = fakeStorage({ [KEY]: 'small' })
    const pref = createChoicePref(KEY, parse, () => storage)
    const heard = vi.fn()
    pref.subscribe(heard)
    pref.refresh()
    expect(heard).not.toHaveBeenCalled()
    expect(pref.get()).toBe('small')
  })

  it('has plain functions, not methods, so they can be handed to React or to an event listener', () => {
    const storage = fakeStorage()
    const { get, set, subscribe, refresh } = createChoicePref(KEY, parse, () => storage)
    const heard = vi.fn()
    const stop = subscribe(heard)
    set('large')
    refresh()
    expect(get()).toBe('large')
    expect(heard).toHaveBeenCalledTimes(1)
    stop()
  })
})

describe('deviceStorage', () => {
  it('is nothing where there is no local storage', () => {
    vi.stubGlobal('localStorage', undefined)
    expect(deviceStorage()).toBeNull()
  })

  it('is nothing where touching local storage throws (some browsers do when it is blocked)', () => {
    Object.defineProperty(globalThis, 'localStorage', {
      configurable: true,
      get() {
        throw new DOMException('denied', 'SecurityError')
      },
    })
    try {
      expect(deviceStorage()).toBeNull()
    } finally {
      Reflect.deleteProperty(globalThis, 'localStorage')
    }
  })

  it('is local storage when there is some', () => {
    const storage = fakeStorage()
    vi.stubGlobal('localStorage', storage)
    expect(deviceStorage()).toBe(storage)
  })
})

describe('followOtherWindows', () => {
  it('asks for a fresh read when another window changes this key, and for no other key', () => {
    let listener: (event: { key: string | null }) => void = () => {}
    vi.stubGlobal('window', { addEventListener: (type: string, fn: typeof listener) => type === 'storage' && (listener = fn) })
    const refresh = vi.fn()
    followOtherWindows(KEY, refresh)
    listener({ key: 'something-else' })
    listener({ key: null }) // storage cleared: not this key
    expect(refresh).not.toHaveBeenCalled()
    listener({ key: KEY })
    expect(refresh).toHaveBeenCalledTimes(1)
  })

  it('does nothing where there is no window', () => {
    expect(() => followOtherWindows(KEY, vi.fn())).not.toThrow()
  })
})
