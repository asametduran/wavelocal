// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { DEFAULT_WINDOW, MIN_WINDOW, fitToDisplays, parseWindowState, snapshotWindowState } from './window-state'
import type { DisplayArea, WindowState } from './window-state'

const screen1080: DisplayArea = { x: 0, y: 0, width: 1920, height: 1040 }
const screen2: DisplayArea = { x: 1920, y: 0, width: 1280, height: 984 }

describe('parseWindowState', () => {
  it('accepts a complete state', () => {
    expect(parseWindowState({ x: 100, y: 50, width: 1000, height: 700, maximized: true })).toEqual({ x: 100, y: 50, width: 1000, height: 700, maximized: true })
  })

  it('treats a missing position as "let the OS decide"', () => {
    const s = parseWindowState({ width: 900, height: 600 })
    expect(s).toEqual({ width: 900, height: 600, maximized: false })
    expect(s).not.toHaveProperty('x')
  })

  it('needs both coordinates for a position to count', () => {
    expect(parseWindowState({ x: 10, width: 900, height: 600 })).not.toHaveProperty('x')
  })

  it.each([null, undefined, 5, 'x', [], true, {}, { width: 'wide', height: 500 }, { width: 500 }, { width: NaN, height: 500 }, { width: Infinity, height: 500 }])('rejects %j', (raw) => {
    expect(parseWindowState(raw)).toBeNull()
  })

  it('clamps absurd sizes and rounds fractions', () => {
    expect(parseWindowState({ width: 10, height: 10 })).toMatchObject({ width: MIN_WINDOW.width, height: MIN_WINDOW.height })
    expect(parseWindowState({ width: 1e9, height: 1e9 })).toMatchObject({ width: 16384, height: 16384 })
    expect(parseWindowState({ width: 800.6, height: 600.4 })).toMatchObject({ width: 801, height: 600 })
  })

  it('only trusts a real boolean for maximized', () => {
    expect(parseWindowState({ width: 800, height: 600, maximized: 'yes' })?.maximized).toBe(false)
    expect(parseWindowState({ width: 800, height: 600, maximized: 1 })?.maximized).toBe(false)
  })

  it('keeps the position within a sane range', () => {
    expect(parseWindowState({ x: -1e9, y: 1e9, width: 800, height: 600 })).toMatchObject({ x: -16384, y: 16384 })
  })
})

describe('fitToDisplays', () => {
  const state = (over: Partial<WindowState> = {}): WindowState => ({ x: 200, y: 100, width: 1000, height: 700, maximized: false, ...over })

  it('keeps a window that is on a screen', () => {
    expect(fitToDisplays(state(), [screen1080])).toEqual(state())
  })

  it('keeps a window on a second monitor when that monitor exists', () => {
    expect(fitToDisplays(state({ x: 2100, y: 80 }), [screen1080, screen2])).toEqual(state({ x: 2100, y: 80 }))
  })

  it('drops the position when the monitor it was on is gone', () => {
    const fitted = fitToDisplays(state({ x: 2100, y: 80 }), [screen1080])
    expect(fitted).not.toHaveProperty('x')
    expect(fitted).not.toHaveProperty('y')
    expect(fitted).toMatchObject({ width: 1000, height: 700 })
  })

  it('drops a position whose title bar is off every screen', () => {
    expect(fitToDisplays(state({ x: 5000, y: 5000 }), [screen1080])).not.toHaveProperty('x')
    expect(fitToDisplays(state({ x: 200, y: -500 }), [screen1080])).not.toHaveProperty('y')
  })

  it('keeps a window that hangs partly off the screen but can still be grabbed', () => {
    expect(fitToDisplays(state({ x: -800, y: 20 }), [screen1080])).toHaveProperty('x', -800) // its right-hand 200px is on the screen
    expect(fitToDisplays(state({ x: 1750, y: 20 }), [screen1080])).toHaveProperty('x', 1750) // its left-hand 170px is on the screen
  })

  it('drops the position when only a sliver of the title bar remains', () => {
    expect(fitToDisplays(state({ x: -950, y: 20 }), [screen1080])).not.toHaveProperty('x') // 50px visible
    expect(fitToDisplays(state({ x: 1850, y: 20 }), [screen1080])).not.toHaveProperty('x') // 70px visible
    expect(fitToDisplays(state({ x: 200, y: -30 }), [screen1080])).not.toHaveProperty('y') // title bar almost entirely above the screen
  })

  it('shrinks a window that is larger than the biggest screen', () => {
    const fitted = fitToDisplays(state({ width: 5000, height: 4000 }), [screen1080])
    expect(fitted.width).toBe(1920)
    expect(fitted.height).toBe(1040)
  })

  it('never shrinks below the minimum size', () => {
    const tiny: DisplayArea = { x: 0, y: 0, width: 200, height: 200 }
    expect(fitToDisplays(state({ x: 0, y: 0 }), [tiny])).toMatchObject({ width: MIN_WINDOW.width, height: MIN_WINDOW.height })
  })

  it('returns the state unchanged when no display information is available', () => {
    expect(fitToDisplays(state(), [])).toEqual(state())
  })

  it('does not mutate its input', () => {
    const input = state({ x: 9000, y: 9000 })
    fitToDisplays(input, [screen1080])
    expect(input).toEqual(state({ x: 9000, y: 9000 }))
  })
})

describe('snapshotWindowState', () => {
  const bounds = { x: 10, y: 20, width: 900, height: 600 }

  it('records the live bounds of a normal window', () => {
    expect(snapshotWindowState(bounds, false)).toEqual({ ...bounds, maximized: false })
  })

  it('while maximized, keeps the last normal bounds and only flags the maximize', () => {
    const previous = { x: 50, y: 60, width: 1100, height: 700, maximized: false }
    expect(snapshotWindowState({ x: 0, y: 0, width: 1920, height: 1040 }, true, previous)).toEqual({ ...previous, maximized: true })
  })

  it('falls back to the live bounds if it is maximized with nothing to remember', () => {
    expect(snapshotWindowState(bounds, true)).toEqual({ ...bounds, maximized: true })
  })
})

describe('defaults', () => {
  it('open comfortably on a 1366x768 laptop', () => {
    expect(DEFAULT_WINDOW.width).toBeLessThanOrEqual(1366)
    expect(DEFAULT_WINDOW.height).toBeLessThanOrEqual(768)
    expect(DEFAULT_WINDOW.width).toBeGreaterThanOrEqual(MIN_WINDOW.width)
  })
})
