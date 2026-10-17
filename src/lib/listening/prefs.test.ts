// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { TOOLS_ROW_KEY, createToolsRowPref, parseToolsRow } from './prefs'
import type { StorageLike } from '../choicepref'

function fakeStorage(initial: Record<string, string> = {}) {
  const data = new Map(Object.entries(initial))
  const storage: StorageLike & { data: Map<string, string> } = { data, getItem: (key) => data.get(key) ?? null, setItem: (key, value) => void data.set(key, value) }
  return storage
}

describe('parseToolsRow', () => {
  it('is "auto" (the buttons appear when they are of use) unless the person chose "always"', () => {
    expect(parseToolsRow('always')).toBe('always')
    expect(parseToolsRow('auto')).toBe('auto')
    for (const value of [null, undefined, '', 'ALWAYS', 'yes', 1, true, {}]) expect(parseToolsRow(value)).toBe('auto')
  })
})

describe('createToolsRowPref', () => {
  it('keeps the choice on this device under its own key, apart from the seek bar style', () => {
    const storage = fakeStorage()
    const pref = createToolsRowPref(() => storage)
    expect(pref.get()).toBe('auto')
    pref.set('always')
    expect(storage.data.get(TOOLS_ROW_KEY)).toBe('always')
    expect(TOOLS_ROW_KEY).toBe('wl.seektools')
    expect(createToolsRowPref(() => storage).get()).toBe('always') // a later visit reads it back
  })
})
