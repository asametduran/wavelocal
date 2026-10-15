import { afterEach, describe, expect, it, vi } from 'vitest'
import { MOTION_KEY, MotionStore, REDUCED_CLASS, isMotionPref, resolveReducedMotion } from './motion'
import type { MotionEnv } from './motion'

/** A controllable stand-in for matchMedia('(prefers-reduced-motion: reduce)'). */
function fakeQuery(matches: boolean) {
  const handlers = new Set<() => void>()
  return {
    matches,
    addEventListener: (_: 'change', h: () => void) => void handlers.add(h),
    removeEventListener: (_: 'change', h: () => void) => void handlers.delete(h),
    flip(next: boolean) {
      this.matches = next
      handlers.forEach((h) => h())
    },
    handlerCount: () => handlers.size,
  }
}

function fakeStorage(initial: Record<string, string> = {}) {
  const data = new Map(Object.entries(initial))
  return { getItem: (k: string) => data.get(k) ?? null, setItem: (k: string, v: string) => void data.set(k, v), data }
}

const root = () => document.createElement('html')

const stores: MotionStore[] = []
const make = (env: Partial<MotionEnv> & { query?: ReturnType<typeof fakeQuery> | null }): MotionStore => {
  const s = new MotionStore({ storage: null, query: null, root: root(), ...env })
  stores.push(s)
  return s
}
afterEach(() => {
  stores.splice(0).forEach((s) => s.dispose())
})

describe('resolveReducedMotion', () => {
  it('follows the system only in system mode', () => {
    expect(resolveReducedMotion('system', true)).toBe(true)
    expect(resolveReducedMotion('system', false)).toBe(false)
  })
  it('lets the app override the system either way', () => {
    expect(resolveReducedMotion('reduce', false)).toBe(true)
    expect(resolveReducedMotion('full', true)).toBe(false)
  })
})

describe('isMotionPref', () => {
  it('accepts only the three known values', () => {
    for (const v of ['system', 'reduce', 'full']) expect(isMotionPref(v)).toBe(true)
    for (const v of ['', 'on', null, undefined, 1, 'REDUCE']) expect(isMotionPref(v)).toBe(false)
  })
})

describe('MotionStore', () => {
  it('starts on "system" and mirrors the system setting onto the root class', () => {
    const el = root()
    const s = make({ query: fakeQuery(true), root: el })
    expect(s.pref).toBe('system')
    expect(s.reduced).toBe(true)
    expect(el.classList.contains(REDUCED_CLASS)).toBe(true)
  })

  it('does not reduce motion when the system does not ask for it', () => {
    const el = root()
    const s = make({ query: fakeQuery(false), root: el })
    expect(s.reduced).toBe(false)
    expect(el.classList.contains(REDUCED_CLASS)).toBe(false)
  })

  it('restores a saved choice and ignores a corrupted one', () => {
    expect(make({ storage: fakeStorage({ [MOTION_KEY]: 'reduce' }) }).pref).toBe('reduce')
    expect(make({ storage: fakeStorage({ [MOTION_KEY]: 'banana' }) }).pref).toBe('system')
  })

  it('persists a choice, applies it and notifies subscribers', () => {
    const storage = fakeStorage()
    const el = root()
    const s = make({ storage, root: el, query: fakeQuery(false) })
    const seen = vi.fn()
    s.subscribe(seen)
    s.set('reduce')
    expect(storage.data.get(MOTION_KEY)).toBe('reduce')
    expect(s.reduced).toBe(true)
    expect(el.classList.contains(REDUCED_CLASS)).toBe(true)
    expect(seen).toHaveBeenCalledTimes(1)
    s.set('full')
    expect(s.reduced).toBe(false)
    expect(el.classList.contains(REDUCED_CLASS)).toBe(false)
  })

  it('rejects invalid values', () => {
    const s = make({})
    s.set('sometimes' as never)
    expect(s.pref).toBe('system')
  })

  it('reacts live to the operating system changing', () => {
    const q = fakeQuery(false)
    const s = make({ query: q })
    const seen = vi.fn()
    s.subscribe(seen)
    q.flip(true)
    expect(s.reduced).toBe(true)
    expect(seen).toHaveBeenCalled()
    q.flip(false)
    expect(s.reduced).toBe(false)
  })

  it('ignores system changes while the user has chosen explicitly', () => {
    const q = fakeQuery(false)
    const s = make({ query: q })
    s.set('full')
    q.flip(true)
    expect(s.reduced).toBe(false)
    s.set('reduce')
    q.flip(false)
    expect(s.reduced).toBe(true)
  })

  it('stops notifying after unsubscribe and releases the media query on dispose', () => {
    const q = fakeQuery(false)
    const s = make({ query: q })
    const seen = vi.fn()
    const off = s.subscribe(seen)
    off()
    s.set('reduce')
    expect(seen).not.toHaveBeenCalled()
    expect(q.handlerCount()).toBe(1)
    s.dispose()
    expect(q.handlerCount()).toBe(0)
  })

  it('survives storage that throws', () => {
    const broken = {
      getItem: () => {
        throw new Error('blocked')
      },
      setItem: () => {
        throw new Error('blocked')
      },
    }
    const s = make({ storage: broken })
    expect(s.pref).toBe('system')
    expect(() => s.set('reduce')).not.toThrow()
    expect(s.reduced).toBe(true)
  })

  it('works without a media query or root element', () => {
    const s = make({ root: null, query: null })
    expect(s.reduced).toBe(false)
    s.set('reduce')
    expect(s.reduced).toBe(true)
  })
})
