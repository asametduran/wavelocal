import { describe, expect, it } from 'vitest'
import { captureAccelerator, displayAccelerator, keyFromCode } from './hotkey-capture'
import type { KeyPress } from './hotkey-capture'

const press = (code: string, mods: Partial<Omit<KeyPress, 'code'>> = {}): KeyPress => ({ code, ctrlKey: false, altKey: false, shiftKey: false, metaKey: false, ...mods })
const accel = (p: KeyPress, platform = 'win32') => {
  const c = captureAccelerator(p, platform)
  return c.kind === 'accelerator' ? c.accelerator : c.kind
}

describe('keyFromCode', () => {
  it('maps letters, digits, function keys and the numpad', () => {
    expect(keyFromCode('KeyQ')).toBe('Q')
    expect(keyFromCode('Digit7')).toBe('7')
    expect(keyFromCode('Numpad3')).toBe('num3')
    expect(keyFromCode('F1')).toBe('F1')
    expect(keyFromCode('F24')).toBe('F24')
    expect(keyFromCode('F25')).toBeNull()
    expect(keyFromCode('F0')).toBeNull()
  })

  it('maps navigation, media and punctuation keys', () => {
    expect(keyFromCode('ArrowRight')).toBe('Right')
    expect(keyFromCode('Enter')).toBe('Return')
    expect(keyFromCode('MediaTrackNext')).toBe('MediaNextTrack')
    expect(keyFromCode('AudioVolumeMute')).toBe('VolumeMute')
    expect(keyFromCode('Comma')).toBe(',')
    expect(keyFromCode('NumpadAdd')).toBe('numadd')
  })

  it('returns null for keys with no accelerator name', () => {
    for (const code of ['', 'Unidentified', 'LaunchMail', 'IntlBackslash', 'KeyAB']) expect(keyFromCode(code)).toBeNull()
  })
})

describe('captureAccelerator', () => {
  it('writes modifiers in the shell order', () => {
    expect(accel(press('ArrowRight', { shiftKey: true, altKey: true, ctrlKey: true }))).toBe('Ctrl+Alt+Shift+Right')
    expect(accel(press('KeyP', { ctrlKey: true, altKey: true }))).toBe('Ctrl+Alt+P')
  })

  it('maps the meta key by platform', () => {
    expect(accel(press('KeyP', { metaKey: true }), 'darwin')).toBe('Cmd+P')
    expect(accel(press('KeyP', { metaKey: true }), 'win32')).toBe('Super+P')
  })

  it('waits while only modifiers are down', () => {
    for (const code of ['ControlLeft', 'ShiftRight', 'AltLeft', 'MetaLeft', 'OSRight']) expect(captureAccelerator(press(code, { ctrlKey: true }), 'win32').kind).toBe('pending')
  })

  it('cancels on a bare Escape but records Escape with a modifier', () => {
    expect(captureAccelerator(press('Escape'), 'win32').kind).toBe('cancel')
    expect(accel(press('Escape', { ctrlKey: true }))).toBe('Ctrl+Escape')
  })

  it('reports keys it cannot express', () => {
    expect(captureAccelerator(press('LaunchMail'), 'win32')).toEqual({ kind: 'unsupported', code: 'LaunchMail' })
  })

  it('passes a lone media key through', () => {
    expect(accel(press('MediaPlayPause'))).toBe('MediaPlayPause')
  })
})

describe('displayAccelerator', () => {
  it('spells media keys and the Windows key readably', () => {
    expect(displayAccelerator('MediaPlayPause', 'win32')).toBe('Play Pause')
    expect(displayAccelerator('MediaNextTrack', 'win32')).toBe('Next Track')
    expect(displayAccelerator('Ctrl+Alt+Right', 'win32')).toBe('Ctrl + Alt + Right')
    expect(displayAccelerator('Super+P', 'win32')).toBe('Win + P')
  })

  it('uses symbols on macOS', () => {
    expect(displayAccelerator('Cmd+Shift+P', 'darwin')).toBe('⌘ ⇧ P')
  })
})
