// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { LONG_FORM_KEY, TOOLS_ROW_KEY, createLongFormPref, createToolsRowPref, parseToolsRow } from './prefs'
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

describe('createLongFormPref', () => {
  it('is twenty minutes until the person chooses another length, and keeps the choice under its own key', () => {
    const storage = fakeStorage()
    const pref = createLongFormPref(() => storage)
    expect(pref.get()).toBe('20')
    pref.set('never')
    expect(storage.data.get(LONG_FORM_KEY)).toBe('never')
    expect(LONG_FORM_KEY).toBe('wl.longform')
    expect(createLongFormPref(() => storage).get()).toBe('never')
  })

  it('reads a stored value that is not one of the choices as the default, so a damaged value never turns remembering off', () => {
    for (const stored of ['', '15', 'ALL', '{}', 'null']) expect(createLongFormPref(() => fakeStorage({ [LONG_FORM_KEY]: stored })).get(), stored).toBe('20')
  })
})
