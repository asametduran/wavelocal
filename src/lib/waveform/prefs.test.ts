// @vitest-environment node
import { describe, expect, it, vi } from 'vitest'
import { SEEK_STYLE_KEY, createSeekStylePref, parseSeekStyle } from './prefs'
import type { StorageLike } from './prefs'

function fakeStorage(initial: Record<string, string> = {}) {
  const data = new Map(Object.entries(initial))
  const storage: StorageLike & { data: Map<string, string> } = { data, getItem: (key) => data.get(key) ?? null, setItem: (key, value) => void data.set(key, value) }
  return storage
}

describe('parseSeekStyle', () => {
  it('is the waveform unless the person chose the plain bar, so an unknown or damaged value never hides it', () => {
    expect(parseSeekStyle('plain')).toBe('plain')
    expect(parseSeekStyle('waveform')).toBe('waveform')
    for (const value of [null, undefined, '', 'PLAIN', 'wave', 42, {}]) expect(parseSeekStyle(value)).toBe('waveform')
  })
})

describe('createSeekStylePref', () => {
  it('reads the stored choice, once, and keeps the answer', () => {
    const storage = fakeStorage({ [SEEK_STYLE_KEY]: 'plain' })
    const getItem = vi.spyOn(storage, 'getItem')
    const pref = createSeekStylePref(() => storage)
    expect(pref.get()).toBe('plain')
    expect(pref.get()).toBe('plain')
    expect(getItem).toHaveBeenCalledTimes(1)
  })

  it('is the waveform when nothing is stored', () => {
    expect(createSeekStylePref(() => fakeStorage()).get()).toBe('waveform')
  })

  it('remembers a change on the device and tells everyone who listens, so both seek bars follow a switch in settings', () => {
    const storage = fakeStorage()
    const pref = createSeekStylePref(() => storage)
    const first = vi.fn()
    const second = vi.fn()
    pref.subscribe(first)
    pref.subscribe(second)
    pref.set('plain')
    expect(pref.get()).toBe('plain')
    expect(storage.data.get(SEEK_STYLE_KEY)).toBe('plain')
    expect(first).toHaveBeenCalledTimes(1)
    expect(second).toHaveBeenCalledTimes(1)
  })

  it('does not wake anyone for a choice that did not change, nor anyone who stopped listening', () => {
    const pref = createSeekStylePref(() => fakeStorage())
    const heard = vi.fn()
    const stop = pref.subscribe(heard)
    pref.set('waveform')
    expect(heard).not.toHaveBeenCalled()
    stop()
    pref.set('plain')
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
    const pref = createSeekStylePref(() => blocked)
    expect(pref.get()).toBe('waveform')
    const heard = vi.fn()
    pref.subscribe(heard)
    expect(() => pref.set('plain')).not.toThrow()
    expect(pref.get()).toBe('plain')
    expect(heard).toHaveBeenCalledTimes(1)
  })

  it('works with no storage at all', () => {
    const pref = createSeekStylePref(() => null)
    expect(pref.get()).toBe('waveform')
    pref.set('plain')
    expect(pref.get()).toBe('plain')
  })

  it('reads the storage again when another window changed it, and says so', () => {
    const storage = fakeStorage()
    const pref = createSeekStylePref(() => storage)
    expect(pref.get()).toBe('waveform')
    const heard = vi.fn()
    pref.subscribe(heard)
    storage.data.set(SEEK_STYLE_KEY, 'plain')
    pref.refresh()
    expect(pref.get()).toBe('plain')
    expect(heard).toHaveBeenCalledTimes(1)
    pref.refresh() // nothing changed this time
    expect(heard).toHaveBeenCalledTimes(1)
  })
})
