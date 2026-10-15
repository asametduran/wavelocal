import { describe, expect, it, vi } from 'vitest'
import { DEFAULT_HOTKEYS, HotkeyManager, normalizeAccelerator, parseHotkeys } from './hotkeys'
import type { ShortcutApi } from './hotkeys'
import { DESKTOP_COMMANDS } from './ipc'
import { DEFAULT_SETTINGS, parseDesktopSettings } from './settings'

const accel = (input: unknown, platform: NodeJS.Platform = 'win32') => {
  const n = normalizeAccelerator(input, platform)
  return n.ok ? n.accelerator : n.error
}

describe('command lists', () => {
  it('the shell and the renderer agree', async () => {
    // the renderer's module is ESM and the shell is CommonJS, so it can only be loaded dynamically
    const renderer = await import('../../src/desktop-bridge.js')
    expect([...DESKTOP_COMMANDS]).toEqual([...renderer.DESKTOP_COMMANDS])
  })
})

describe('normalizeAccelerator', () => {
  it('writes modifiers in a fixed order and normalises case and aliases', () => {
    expect(accel('ctrl+alt+right')).toBe('Ctrl+Alt+Right')
    expect(accel('Alt+Control+Right')).toBe('Ctrl+Alt+Right')
    expect(accel('Shift+Ctrl+f5')).toBe('Ctrl+Shift+F5')
    expect(accel(' ctrl + k ')).toBe('Ctrl+K')
    expect(accel('Ctrl+enter')).toBe('Ctrl+Return')
    expect(accel('Ctrl+Alt+num5')).toBe('Ctrl+Alt+num5')
    expect(accel('Ctrl+,')).toBe('Ctrl+,')
  })

  it('maps CommandOrControl to the platform modifier and rejects Command where it does not exist', () => {
    expect(accel('CommandOrControl+Alt+P', 'win32')).toBe('Ctrl+Alt+P')
    expect(accel('CmdOrCtrl+Alt+P', 'darwin')).toBe('Cmd+Alt+P')
    expect(accel('Cmd+Alt+P', 'darwin')).toBe('Cmd+Alt+P')
    expect(accel('Cmd+Alt+P', 'win32')).toBe('invalid')
  })

  it('accepts the media keys and function keys on their own', () => {
    for (const key of ['MediaPlayPause', 'mediaplaypause', 'MediaNextTrack', 'MediaPreviousTrack', 'MediaStop', 'VolumeUp', 'VolumeMute', 'F9', 'f24']) {
      expect(normalizeAccelerator(key).ok).toBe(true)
    }
    expect(accel('mediaplaypause')).toBe('MediaPlayPause')
  })

  it('refuses a plain typing key or Shift alone, which would break typing everywhere', () => {
    for (const bad of ['A', 'Space', 'Shift+A', 'Right', '5', 'Shift+Space']) expect(accel(bad)).toBe('invalid')
  })

  it('refuses system and editing combinations', () => {
    for (const bad of ['Ctrl+C', 'ctrl+v', 'Alt+F4', 'Ctrl+Alt+Delete', 'Super+L']) expect(accel(bad)).toBe('reserved')
    expect(accel('Cmd+Q', 'darwin')).toBe('reserved')
  })

  it.each([
    ['', 'empty'],
    ['   ', 'blank'],
    ['Ctrl+', 'trailing plus'],
    ['+K', 'leading plus'],
    ['Ctrl++', 'literal plus'],
    ['Ctrl', 'no key'],
    ['Ctrl+Alt', 'only modifiers'],
    ['K+Ctrl', 'key before modifier'],
    ['Ctrl+Ctrl+K', 'duplicate modifier'],
    ['Control+Ctrl+K', 'duplicate by alias'],
    ['Ctrl+K+L', 'two keys'],
    ['Ctrl+F25', 'function key out of range'],
    ['Ctrl+Banana', 'unknown key'],
    ['AltGr+Ctrl+K', 'AltGr with Ctrl'],
    ['a'.repeat(100), 'too long'],
  ])('rejects %j (%s)', (input) => {
    expect(accel(input)).toBe('invalid')
  })

  it('accepts the spelled-out plus key', () => {
    expect(accel('Ctrl+Plus')).toBe('Ctrl+Plus')
  })

  it('rejects non-strings', () => {
    for (const bad of [null, undefined, 5, {}, ['Ctrl+K']]) expect(accel(bad)).toBe('invalid')
  })

  it('gives readable messages', () => {
    const n = normalizeAccelerator('Ctrl+Banana')
    expect(n.ok ? '' : n.message).toContain('Banana')
  })
})

describe('parseHotkeys', () => {
  it('uses the defaults for missing, non-object and malformed input', () => {
    for (const raw of [undefined, null, 5, 'x', [], {}]) expect(parseHotkeys(raw)).toEqual(DEFAULT_HOTKEYS)
  })

  it('keeps valid saved values (canonicalised), explicit nulls, and falls back per entry', () => {
    const result = parseHotkeys({ toggle: 'ctrl+alt+space', next: null, prev: 'Banana', volumeUp: 'Ctrl+Alt+Up', mute: 42 })
    expect(result.toggle).toBe('Ctrl+Alt+Space')
    expect(result.next).toBeNull()
    expect(result.prev).toBe(DEFAULT_HOTKEYS.prev)
    expect(result.volumeUp).toBe('Ctrl+Alt+Up')
    expect(result.mute).toBe(DEFAULT_HOTKEYS.mute)
  })

  it('disables the later of two commands that share an accelerator', () => {
    const result = parseHotkeys({ toggle: 'F8', next: 'f8', prev: 'MediaPreviousTrack' })
    expect(result.toggle).toBe('F8')
    expect(result.next).toBeNull()
    expect(result.prev).toBe('MediaPreviousTrack')
  })

  it('does not honour a reserved combination from a hand-edited file', () => {
    expect(parseHotkeys({ toggle: 'Ctrl+C' }).toggle).toBe(DEFAULT_HOTKEYS.toggle)
  })
})

describe('desktop settings', () => {
  it('include hotkeys and survive a round trip through JSON', () => {
    expect(DEFAULT_SETTINGS.hotkeys).toEqual(DEFAULT_HOTKEYS)
    const saved = { closeToTray: false, hotkeys: { ...DEFAULT_HOTKEYS, volumeUp: 'Ctrl+Alt+Up' } }
    expect(parseDesktopSettings(JSON.parse(JSON.stringify(saved)))).toEqual(saved)
  })

  it('upgrade a settings file from before hotkeys existed', () => {
    expect(parseDesktopSettings({ closeToTray: false })).toEqual({ closeToTray: false, hotkeys: DEFAULT_HOTKEYS })
  })
})

/** An in-memory stand-in for Electron's globalShortcut, with other applications that already own some accelerators. */
function fakeShortcuts(taken: string[] = []) {
  const owned = new Set(taken)
  const registered = new Map<string, () => void>()
  const api: ShortcutApi = {
    register: vi.fn((accelerator, callback) => {
      if (owned.has(accelerator) || registered.has(accelerator)) return false
      registered.set(accelerator, callback)
      return true
    }),
    unregister: vi.fn((accelerator) => void registered.delete(accelerator)),
    isRegistered: (accelerator) => registered.has(accelerator),
  }
  return { api, registered, release: (accelerator: string) => owned.delete(accelerator), take: (accelerator: string) => owned.add(accelerator) }
}

function setup(taken: string[] = [], platform: NodeJS.Platform = 'win32') {
  const fake = fakeShortcuts(taken)
  const run = vi.fn()
  const manager = new HotkeyManager(fake.api, run, platform)
  return { ...fake, run, manager }
}

describe('HotkeyManager', () => {
  it('registers the defaults and runs the matching command on a key press', () => {
    const { manager, registered, run } = setup()
    const state = manager.apply(DEFAULT_HOTKEYS)
    expect([...registered.keys()].sort()).toEqual(['MediaNextTrack', 'MediaPlayPause', 'MediaPreviousTrack'])
    expect(state.toggle).toEqual({ accelerator: 'MediaPlayPause', status: 'active' })
    expect(state.volumeUp).toEqual({ accelerator: null, status: 'disabled' })
    registered.get('MediaNextTrack')?.()
    registered.get('MediaPlayPause')?.()
    expect(run.mock.calls).toEqual([['next'], ['toggle']])
  })

  it('reports an accelerator owned by another application as taken, without throwing', () => {
    const { manager, registered } = setup(['MediaPlayPause'])
    const state = manager.apply(DEFAULT_HOTKEYS)
    expect(state.toggle).toEqual({ accelerator: 'MediaPlayPause', status: 'taken' })
    expect(state.next.status).toBe('active')
    expect(registered.has('MediaPlayPause')).toBe(false)
  })

  it('treats an accelerator the system throws on as taken', () => {
    const { api } = setup()
    api.register = vi.fn(() => {
      throw new Error('bad accelerator')
    })
    const manager = new HotkeyManager(api, vi.fn())
    expect(manager.apply(DEFAULT_HOTKEYS).toggle.status).toBe('taken')
  })

  it('retries taken hotkeys once the other application lets go', () => {
    const { manager, release } = setup(['MediaPlayPause'])
    manager.apply(DEFAULT_HOTKEYS)
    expect(manager.retryTaken().toggle.status).toBe('taken')
    release('MediaPlayPause')
    expect(manager.retryTaken().toggle.status).toBe('active')
  })

  it('binds a new accelerator and releases the old one', () => {
    const { manager, registered, run } = setup()
    manager.apply(DEFAULT_HOTKEYS)
    const result = manager.set('volumeUp', 'ctrl+alt+up')
    expect(result.ok).toBe(true)
    expect(result.state.volumeUp).toEqual({ accelerator: 'Ctrl+Alt+Up', status: 'active' })
    registered.get('Ctrl+Alt+Up')?.()
    expect(run).toHaveBeenCalledWith('volumeUp')

    expect(manager.set('volumeUp', 'Ctrl+Alt+Down').ok).toBe(true)
    expect(registered.has('Ctrl+Alt+Up')).toBe(false)
    expect(registered.has('Ctrl+Alt+Down')).toBe(true)
    expect(manager.current.volumeUp).toBe('Ctrl+Alt+Down')
  })

  it('unbinds with null and leaves the others alone', () => {
    const { manager, registered } = setup()
    manager.apply(DEFAULT_HOTKEYS)
    const result = manager.set('toggle', null)
    expect(result.ok).toBe(true)
    expect(result.state.toggle).toEqual({ accelerator: null, status: 'disabled' })
    expect(registered.has('MediaPlayPause')).toBe(false)
    expect(registered.has('MediaNextTrack')).toBe(true)
  })

  it('refuses an invalid or reserved accelerator and keeps the previous binding working', () => {
    const { manager, registered } = setup()
    manager.apply(DEFAULT_HOTKEYS)
    expect(manager.set('toggle', 'Banana')).toMatchObject({ ok: false, error: 'invalid' })
    expect(manager.set('toggle', 'Ctrl+C')).toMatchObject({ ok: false, error: 'reserved' })
    expect(registered.has('MediaPlayPause')).toBe(true)
    expect(manager.current.toggle).toBe('MediaPlayPause')
  })

  it('refuses an accelerator another command already uses, even when written differently', () => {
    const { manager } = setup()
    manager.apply(DEFAULT_HOTKEYS)
    manager.set('volumeUp', 'Ctrl+Alt+Up')
    const result = manager.set('volumeDown', 'alt+control+up')
    expect(result).toMatchObject({ ok: false, error: 'conflict' })
    expect(result.ok ? '' : result.message).toContain('volumeUp')
    expect(manager.current.volumeDown).toBeNull()
  })

  it('refuses an accelerator another application owns and restores the old binding', () => {
    const { manager, registered, run, take } = setup()
    manager.apply(DEFAULT_HOTKEYS)
    take('F9')
    const result = manager.set('toggle', 'F9')
    expect(result).toMatchObject({ ok: false, error: 'taken' })
    expect(result.state.toggle).toEqual({ accelerator: 'MediaPlayPause', status: 'active' })
    expect(manager.current.toggle).toBe('MediaPlayPause')
    registered.get('MediaPlayPause')?.()
    expect(run).toHaveBeenCalledWith('toggle')
  })

  it('setting the same accelerator again is a harmless success', () => {
    const { manager, api } = setup()
    manager.apply(DEFAULT_HOTKEYS)
    const before = vi.mocked(api.register).mock.calls.length
    expect(manager.set('toggle', 'mediaplaypause').ok).toBe(true)
    expect(vi.mocked(api.register).mock.calls.length).toBe(before)
  })

  it('can swap two commands by unbinding first', () => {
    const { manager } = setup()
    manager.apply(DEFAULT_HOTKEYS)
    expect(manager.set('toggle', 'MediaNextTrack')).toMatchObject({ ok: false, error: 'conflict' })
    manager.set('next', null)
    expect(manager.set('toggle', 'MediaNextTrack').ok).toBe(true)
  })

  it('resets to the defaults and releases custom bindings', () => {
    const { manager, registered } = setup()
    manager.apply(DEFAULT_HOTKEYS)
    manager.set('volumeUp', 'Ctrl+Alt+Up')
    manager.set('toggle', null)
    const state = manager.reset()
    expect(state.toggle.status).toBe('active')
    expect(state.volumeUp.accelerator).toBeNull()
    expect(registered.has('Ctrl+Alt+Up')).toBe(false)
  })

  it('dispose releases only what it holds', () => {
    const { manager, registered } = setup(['MediaPlayPause'])
    manager.apply(DEFAULT_HOTKEYS)
    manager.dispose()
    expect(registered.size).toBe(0)
  })

  it('press runs the command of an active binding only', () => {
    const { manager, run } = setup(['MediaNextTrack'])
    manager.apply(DEFAULT_HOTKEYS)
    expect(manager.press('MediaPlayPause')).toBe(true)
    expect(manager.press('MediaNextTrack')).toBe(false)
    expect(manager.press('F1')).toBe(false)
    expect(run).toHaveBeenCalledOnce()
  })
})
