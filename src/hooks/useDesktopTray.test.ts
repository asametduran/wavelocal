import { describe, expect, it, vi } from 'vitest'
import { getDesktopBridge } from '../desktop-bridge'
import { runTrayCommand } from './useDesktopTray'

const base = { isDesktop: true, platform: 'win32', versions: { app: '1.0.0', electron: '39.0.0', chrome: '142.0.0.0' } }

describe('runTrayCommand', () => {
  it('maps each tray command to the matching player action', () => {
    const player = { toggle: vi.fn(), next: vi.fn(), prev: vi.fn() }
    runTrayCommand(player, 'toggle')
    runTrayCommand(player, 'next')
    runTrayCommand(player, 'prev')
    expect(player.toggle).toHaveBeenCalledOnce()
    expect(player.next).toHaveBeenCalledOnce()
    expect(player.prev).toHaveBeenCalledOnce()
  })

  it('does not call anything else', () => {
    const player = { toggle: vi.fn(), next: vi.fn(), prev: vi.fn() }
    runTrayCommand(player, 'next')
    expect(player.toggle).not.toHaveBeenCalled()
    expect(player.prev).not.toHaveBeenCalled()
  })
})

describe('getDesktopBridge tray capability', () => {
  it('is absent unless both functions are provided', () => {
    expect(getDesktopBridge({ wavelocalDesktop: base })?.tray).toBeUndefined()
    for (const tray of [null, 'x', {}, { setNowPlaying: () => undefined }, { onCommand: () => () => undefined }, { setNowPlaying: 1, onCommand: 2 }]) {
      expect(getDesktopBridge({ wavelocalDesktop: { ...base, tray } })?.tray).toBeUndefined()
    }
  })

  it('wraps the shell functions so the page gets only the two methods', () => {
    const setNowPlaying = vi.fn()
    const unsubscribe = vi.fn()
    const onCommand = vi.fn(() => unsubscribe)
    const bridge = getDesktopBridge({ wavelocalDesktop: { ...base, tray: { setNowPlaying, onCommand, extra: () => 'x' } } })
    expect(Object.keys(bridge?.tray ?? {}).sort()).toEqual(['onCommand', 'setNowPlaying'])

    bridge?.tray?.setNowPlaying({ title: 'a', artist: 'b', playing: true })
    expect(setNowPlaying).toHaveBeenCalledWith({ title: 'a', artist: 'b', playing: true })

    const listener = vi.fn()
    const off = bridge?.tray?.onCommand(listener)
    expect(onCommand).toHaveBeenCalledWith(listener)
    off?.()
    expect(unsubscribe).toHaveBeenCalledOnce()
  })
})
