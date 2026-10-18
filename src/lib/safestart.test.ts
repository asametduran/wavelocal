import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { forgetSettings, startFresh } from './safestart'

class FakeStorage {
  readonly items = new Map<string, string>()
  get length(): number {
    return this.items.size
  }
  key(index: number): string | null {
    return [...this.items.keys()][index] ?? null
  }
  removeItem(key: string): void {
    this.items.delete(key)
  }
}

const storage = (...keys: string[]): FakeStorage => {
  const fake = new FakeStorage()
  for (const key of keys) fake.items.set(key, '1')
  return fake
}

describe('forgetSettings', () => {
  it('forgets every setting and small choice, and says how many', () => {
    const fake = storage('wl-settings', 'wl-tv', 'wl-accent', 'wl.seekbar', 'wl.longform', 'wl.usualspeed')
    expect(forgetSettings(fake)).toBe(6)
    expect(fake.items.size).toBe(0)
  })

  it('keeps the error log, and whatever is not Wavelocal’s', () => {
    const fake = storage('wl-settings', 'wl.diagnostics', 'other-app', 'wlfoo', 'wl', 'WL-tv', 'twl-x')
    expect(forgetSettings(fake)).toBe(1)
    expect([...fake.items.keys()].sort()).toEqual(['WL-tv', 'other-app', 'twl-x', 'wl', 'wl.diagnostics', 'wlfoo'])
  })

  it('does not skip a key because another was removed while it looked', () => {
    const fake = storage(...Array.from({ length: 40 }, (_, i) => `wl.choice${i}`))
    expect(forgetSettings(fake)).toBe(40)
    expect(fake.items.size).toBe(0)
  })

  it('has nothing to do for an empty store', () => {
    expect(forgetSettings(storage())).toBe(0)
  })

  it('works on the real localStorage by default', () => {
    localStorage.setItem('wl-test-a', '1')
    localStorage.setItem('wl.diagnostics', '{}')
    localStorage.setItem('other', '1')
    expect(forgetSettings()).toBeGreaterThanOrEqual(1)
    expect(localStorage.getItem('wl-test-a')).toBeNull()
    expect(localStorage.getItem('wl.diagnostics')).toBe('{}')
    expect(localStorage.getItem('other')).toBe('1')
    localStorage.clear()
  })
})

describe('startFresh', () => {
  afterEach(() => {
    sessionStorage.clear()
    vi.restoreAllMocks()
  })

  it('has forgotten the settings and asked for a fresh start by the time it reloads', () => {
    const fake = storage('wl-settings', 'wl-tv', 'wl.diagnostics')
    let seen: { left: string[]; flag: string | null } | null = null
    startFresh(() => {
      seen = { left: [...fake.items.keys()], flag: sessionStorage.getItem('wl.safe') }
    }, fake)
    expect(seen).toEqual({ left: ['wl.diagnostics'], flag: '1' })
  })

  it('reloads once, and only once', () => {
    const reload = vi.fn()
    startFresh(reload, storage('wl-settings'))
    expect(reload).toHaveBeenCalledTimes(1)
  })

  it('still asks for a fresh start and reloads when the settings cannot be reached', () => {
    const blocked = {
      get length(): number {
        throw new DOMException('denied', 'SecurityError')
      },
      key: () => null,
      removeItem: () => {},
    }
    const reload = vi.fn()
    startFresh(reload, blocked)
    expect(sessionStorage.getItem('wl.safe')).toBe('1')
    expect(reload).toHaveBeenCalledTimes(1)
  })

  it('reloads even when nothing can be kept at all', () => {
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new DOMException('denied', 'SecurityError')
    })
    const reload = vi.fn()
    expect(() => startFresh(reload, storage())).not.toThrow()
    expect(reload).toHaveBeenCalledTimes(1)
  })
})

describe('the flag for one fresh start', () => {
  beforeEach(() => {
    vi.resetModules()
    sessionStorage.clear()
  })
  afterEach(() => {
    sessionStorage.clear()
    vi.restoreAllMocks()
  })

  it('is off for a page that nobody asked to start fresh', async () => {
    const { safeStart } = await import('./safestart')
    expect(safeStart).toBe(false)
  })

  it('is on for the one page that follows the request, and taken away so that the next page is not fresh too', async () => {
    const first = await import('./safestart')
    first.requestSafeStart()
    expect(sessionStorage.getItem('wl.safe')).toBe('1')
    vi.resetModules()
    const second = await import('./safestart')
    expect(second.safeStart).toBe(true)
    expect(sessionStorage.getItem('wl.safe')).toBeNull()
    vi.resetModules()
    const third = await import('./safestart')
    expect(third.safeStart).toBe(false)
  })

  it('ignores any other value of the flag', async () => {
    sessionStorage.setItem('wl.safe', 'yes')
    const { safeStart } = await import('./safestart')
    expect(safeStart).toBe(false)
  })

  it('is off when the browser will not say, and a request that cannot be kept does not throw', async () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new DOMException('denied', 'SecurityError')
    })
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new DOMException('denied', 'SecurityError')
    })
    const { safeStart, requestSafeStart } = await import('./safestart')
    expect(safeStart).toBe(false)
    expect(() => requestSafeStart()).not.toThrow()
  })
})
