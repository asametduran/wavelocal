// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { USUAL_SPEED_KEY, readUsualSpeed, writeUsualSpeed } from './usualspeed'
import type { StorageLike } from '../choicepref'

function fakeStorage(initial: Record<string, string> = {}) {
  const data = new Map(Object.entries(initial))
  const storage: StorageLike & { data: Map<string, string> } = { data, getItem: (key) => data.get(key) ?? null, setItem: (key, value) => void data.set(key, value) }
  return storage
}

const blocked: StorageLike = {
  getItem: () => {
    throw new DOMException('denied', 'SecurityError')
  },
  setItem: () => {
    throw new DOMException('denied', 'SecurityError')
  },
}

describe('the usual speed', () => {
  it('is kept on the device under its own key, and read back', () => {
    const storage = fakeStorage()
    writeUsualSpeed(storage, 1.25)
    expect(storage.data.get(USUAL_SPEED_KEY)).toBe('1.25')
    expect(USUAL_SPEED_KEY).toBe('wl.usualspeed')
    expect(readUsualSpeed(storage)).toBe(1.25)
  })

  it('is none (null) when nothing is kept, or what is kept is not a speed the player offers', () => {
    expect(readUsualSpeed(fakeStorage())).toBeNull()
    for (const stored of ['', 'fast', '0', '0.1', '2.5', 'NaN', 'Infinity', '-1', '{}']) expect(readUsualSpeed(fakeStorage({ [USUAL_SPEED_KEY]: stored })), stored).toBeNull()
  })

  it('is kept to the step the player offers', () => {
    const storage = fakeStorage()
    writeUsualSpeed(storage, 1.234)
    expect(readUsualSpeed(storage)).toBe(1.25)
  })

  it('does not keep a speed that is not one', () => {
    const storage = fakeStorage()
    writeUsualSpeed(storage, Number.NaN)
    writeUsualSpeed(storage, 9)
    expect(storage.data.size).toBe(0)
  })

  it('works where storage is blocked or missing: none kept, and no error', () => {
    expect(readUsualSpeed(blocked)).toBeNull()
    expect(() => writeUsualSpeed(blocked, 1.25)).not.toThrow()
    expect(readUsualSpeed(null)).toBeNull()
    expect(() => writeUsualSpeed(null, 1.25)).not.toThrow()
  })
})
