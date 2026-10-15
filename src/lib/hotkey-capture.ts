import type { DesktopCommand } from '../desktop-bridge'

/** Turning a key press in the settings dialog into the accelerator text the desktop shell understands. */

export interface KeyPress {
  readonly code: string
  readonly ctrlKey: boolean
  readonly altKey: boolean
  readonly shiftKey: boolean
  readonly metaKey: boolean
}

const NAMED: Readonly<Record<string, string>> = {
  Space: 'Space', Tab: 'Tab', Enter: 'Return', NumpadEnter: 'Return', Backspace: 'Backspace', Delete: 'Delete', Insert: 'Insert',
  Home: 'Home', End: 'End', PageUp: 'PageUp', PageDown: 'PageDown', ArrowUp: 'Up', ArrowDown: 'Down', ArrowLeft: 'Left', ArrowRight: 'Right',
  PrintScreen: 'PrintScreen', CapsLock: 'Capslock', NumLock: 'Numlock', ScrollLock: 'Scrolllock', Escape: 'Escape',
  MediaPlayPause: 'MediaPlayPause', MediaTrackNext: 'MediaNextTrack', MediaTrackPrevious: 'MediaPreviousTrack', MediaStop: 'MediaStop',
  AudioVolumeUp: 'VolumeUp', AudioVolumeDown: 'VolumeDown', AudioVolumeMute: 'VolumeMute',
  NumpadDecimal: 'numdec', NumpadAdd: 'numadd', NumpadSubtract: 'numsub', NumpadMultiply: 'nummult', NumpadDivide: 'numdiv',
  Comma: ',', Period: '.', Slash: '/', Semicolon: ';', Quote: "'", BracketLeft: '[', BracketRight: ']', Backslash: '\\', Minus: '-', Equal: '=', Backquote: '`',
}

const MODIFIER_CODES = /^(Control|Alt|Shift|Meta|OS)(Left|Right)?$/

/** The accelerator key for a physical key (`KeyboardEvent.code`, so it does not depend on the keyboard layout), or null. */
export function keyFromCode(code: string): string | null {
  const letter = /^Key([A-Z])$/.exec(code)
  if (letter) return letter[1] ?? null
  const digit = /^(Digit|Numpad)([0-9])$/.exec(code)
  if (digit) return digit[1] === 'Numpad' ? `num${digit[2]}` : (digit[2] ?? null)
  if (/^F([1-9]|1\d|2[0-4])$/.test(code)) return code
  return NAMED[code] ?? null
}

export type Capture =
  | { readonly kind: 'pending' } // only modifiers so far: keep listening
  | { readonly kind: 'cancel' }
  | { readonly kind: 'accelerator'; readonly accelerator: string }
  | { readonly kind: 'unsupported'; readonly code: string }

/**
 * Interpret one key press while recording a shortcut. A bare Escape cancels; pressing only modifiers keeps waiting. The
 * shell still validates the result, so this only has to produce well-formed text.
 */
export function captureAccelerator(press: KeyPress, platform: string): Capture {
  if (MODIFIER_CODES.test(press.code)) return { kind: 'pending' }
  if (press.code === 'Escape' && !press.ctrlKey && !press.altKey && !press.shiftKey && !press.metaKey) return { kind: 'cancel' }
  const key = keyFromCode(press.code)
  if (!key) return { kind: 'unsupported', code: press.code }
  const parts: string[] = []
  if (press.ctrlKey) parts.push('Ctrl')
  if (press.metaKey) parts.push(platform === 'darwin' ? 'Cmd' : 'Super')
  if (press.altKey) parts.push('Alt')
  if (press.shiftKey) parts.push('Shift')
  return { kind: 'accelerator', accelerator: [...parts, key].join('+') }
}

export const COMMAND_LABELS: Readonly<Record<DesktopCommand, string>> = {
  toggle: 'Play / pause',
  next: 'Next track',
  prev: 'Previous track',
  volumeUp: 'Volume up',
  volumeDown: 'Volume down',
  mute: 'Mute',
}

/** Show an accelerator the way the platform writes it. */
export function displayAccelerator(accelerator: string, platform: string): string {
  const mac = platform === 'darwin'
  const glyphs: Readonly<Record<string, string>> = mac ? { Cmd: '⌘', Alt: '⌥', Ctrl: '⌃', Shift: '⇧' } : { Super: platform === 'win32' ? 'Win' : 'Super' }
  return accelerator
    .split('+')
    .map((part) => glyphs[part] ?? part.replace(/^Media/, '').replace(/([a-z])([A-Z])/g, '$1 $2'))
    .join(mac ? ' ' : ' + ')
}
