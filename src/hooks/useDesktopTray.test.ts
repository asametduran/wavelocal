import { describe, expect, it, vi } from 'vitest'
import { DESKTOP_COMMANDS, getDesktopBridge } from '../desktop-bridge'
import { VOLUME_STEP, runDesktopCommand } from './useDesktopTray'

const base = { isDesktop: true, platform: 'win32', versions: { app: '1.0.0', electron: '39.0.0', chrome: '142.0.0.0' } }

const makePlayer = () => ({ toggle: vi.fn(), next: vi.fn(), prev: vi.fn(), volumeBy: vi.fn(), toggleMute: vi.fn() })

describe('runDesktopCommand', () => {
  it('maps each command to the matching player action', () => {
    const player = makePlayer()
    for (const command of DESKTOP_COMMANDS) runDesktopCommand(player, command)
    expect(player.toggle).toHaveBeenCalledOnce()
    expect(player.next).toHaveBeenCalledOnce()
    expect(player.prev).toHaveBeenCalledOnce()
    expect(player.toggleMute).toHaveBeenCalledOnce()
    expect(player.volumeBy).toHaveBeenNthCalledWith(1, VOLUME_STEP)
    expect(player.volumeBy).toHaveBeenNthCalledWith(2, -VOLUME_STEP)
  })

  it('does not call anything else', () => {
    const player = makePlayer()
    runDesktopCommand(player, 'next')
    expect(player.toggle).not.toHaveBeenCalled()
    expect(player.prev).not.toHaveBeenCalled()
    expect(player.volumeBy).not.toHaveBeenCalled()
    expect(player.toggleMute).not.toHaveBeenCalled()
  })
})

describe('getDesktopBridge capabilities', () => {
  it('are absent unless every function is provided', () => {
    expect(getDesktopBridge({ wavelocalDesktop: base })?.tray).toBeUndefined()
    for (const tray of [null, 'x', {}, { setNowPlaying: 1 }]) expect(getDesktopBridge({ wavelocalDesktop: { ...base, tray } })?.tray).toBeUndefined()
    for (const commands of [null, {}, { onCommand: 'x' }]) expect(getDesktopBridge({ wavelocalDesktop: { ...base, commands } })?.commands).toBeUndefined()
    for (const hotkeys of [null, {}, { get: () => 1, set: () => 1 }, { get: 1, set: 2, reset: 3 }]) {
      expect(getDesktopBridge({ wavelocalDesktop: { ...base, hotkeys } })?.hotkeys).toBeUndefined()
    }
  })

  it('wraps the shell functions so the page gets only the declared methods', () => {
    const setNowPlaying = vi.fn()
    const unsubscribe = vi.fn()
    const onCommand = vi.fn(() => unsubscribe)
    const bridge = getDesktopBridge({ wavelocalDesktop: { ...base, tray: { setNowPlaying, extra: () => 'x' }, commands: { onCommand } } })
    expect(Object.keys(bridge?.tray ?? {})).toEqual(['setNowPlaying'])
    expect(Object.keys(bridge?.commands ?? {})).toEqual(['onCommand'])

    bridge?.tray?.setNowPlaying({ title: 'a', artist: 'b', playing: true })
    expect(setNowPlaying).toHaveBeenCalledWith({ title: 'a', artist: 'b', playing: true })

    const listener = vi.fn()
    const off = bridge?.commands?.onCommand(listener)
    expect(onCommand).toHaveBeenCalledWith(listener)
    off?.()
    expect(unsubscribe).toHaveBeenCalledOnce()
  })

  it('forwards the hotkey calls and their results', async () => {
    const get = vi.fn(async () => ({ ok: 'state' }))
    const set = vi.fn(async () => ({ ok: true }))
    const reset = vi.fn(async () => ({ ok: 'reset' }))
    const bridge = getDesktopBridge({ wavelocalDesktop: { ...base, hotkeys: { get, set, reset, secret: () => 1 } } })
    expect(Object.keys(bridge?.hotkeys ?? {}).sort()).toEqual(['get', 'reset', 'set'])
    await expect(bridge?.hotkeys?.get()).resolves.toEqual({ ok: 'state' })
    await bridge?.hotkeys?.set('next', 'Ctrl+Alt+Right')
    expect(set).toHaveBeenCalledWith('next', 'Ctrl+Alt+Right')
    await expect(bridge?.hotkeys?.reset()).resolves.toEqual({ ok: 'reset' })
  })
})
