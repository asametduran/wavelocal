import { DESKTOP_COMMANDS } from './ipc'
import type { DesktopCommand, HotkeyError, HotkeyResult, HotkeyState, HotkeyStatus } from './ipc'

/**
 * Global hotkeys: parsing and normalising Electron accelerators, the policy for which ones we accept, and a manager that
 * registers them with the system. The manager talks to Electron's `globalShortcut` only through the small `ShortcutApi`
 * interface, so all of this is unit tested without Electron.
 */

export type Platform = NodeJS.Platform

export type HotkeyBindings = Readonly<Record<DesktopCommand, string | null>>

export const DEFAULT_HOTKEYS: HotkeyBindings = Object.freeze({
  toggle: 'MediaPlayPause',
  next: 'MediaNextTrack',
  prev: 'MediaPreviousTrack',
  volumeUp: null,
  volumeDown: null,
  mute: null,
})

// ---- accelerator syntax ----

const MODIFIER_ORDER = ['Ctrl', 'Cmd', 'Alt', 'AltGr', 'Shift', 'Super'] as const
type Modifier = (typeof MODIFIER_ORDER)[number]

/** Without one of these a key would hijack ordinary typing system-wide (Shift alone does not count). */
const TYPING_MODIFIERS: ReadonlySet<Modifier> = new Set<Modifier>(['Ctrl', 'Cmd', 'Alt', 'AltGr', 'Super'])

const NAMED_KEYS = [
  'Space', 'Tab', 'Capslock', 'Numlock', 'Scrolllock', 'Backspace', 'Delete', 'Insert', 'Return', 'Up', 'Down', 'Left', 'Right', 'Home', 'End',
  'PageUp', 'PageDown', 'Escape', 'PrintScreen', 'Plus', 'VolumeUp', 'VolumeDown', 'VolumeMute', 'MediaNextTrack', 'MediaPreviousTrack', 'MediaStop',
  'MediaPlayPause', 'numdec', 'numadd', 'numsub', 'nummult', 'numdiv',
] as const
const KEY_ALIASES: Readonly<Record<string, string>> = { enter: 'Return', esc: 'Escape', pgup: 'PageUp', pgdn: 'PageDown', del: 'Delete', ins: 'Insert' }
const NAMED_BY_LOWER = new Map<string, string>([...NAMED_KEYS.map((k) => [k.toLowerCase(), k] as const), ...Object.entries(KEY_ALIASES)])
const PUNCTUATION = new Set(')!@#$%^&*(:;<,_-.>/?~`{[]}\\|\'"=')

/** Keys that are safe to bind without a modifier: function keys and the dedicated media/volume keys. */
const STANDALONE = /^(F([1-9]|1\d|2[0-4])|Media(NextTrack|PreviousTrack|Stop|PlayPause)|Volume(Up|Down|Mute))$/

/** Combinations that belong to the system or to every text field; refused even though they are valid accelerators. */
const RESERVED = new Set([
  'Ctrl+C', 'Ctrl+V', 'Ctrl+X', 'Ctrl+Z', 'Ctrl+Y', 'Ctrl+A', 'Ctrl+S', 'Ctrl+Alt+Delete', 'Ctrl+Shift+Escape', 'Alt+F4', 'Alt+Tab', 'Alt+Escape', 'Super+L',
  'Super+D', 'Super+Tab', 'Cmd+C', 'Cmd+V', 'Cmd+X', 'Cmd+Z', 'Cmd+A', 'Cmd+S', 'Cmd+Q', 'Cmd+W', 'Cmd+Tab', 'Cmd+Space', 'Cmd+Alt+Escape',
])

export type Normalized = { readonly ok: true; readonly accelerator: string } | { readonly ok: false; readonly error: 'invalid' | 'reserved'; readonly message: string }

const invalid = (message: string): Normalized => ({ ok: false, error: 'invalid', message })

function modifierOf(token: string, platform: Platform): Modifier | 'unsupported' | null {
  switch (token.toLowerCase()) {
    case 'ctrl':
    case 'control':
      return 'Ctrl'
    case 'commandorcontrol':
    case 'cmdorctrl':
      return platform === 'darwin' ? 'Cmd' : 'Ctrl'
    case 'command':
    case 'cmd':
      return platform === 'darwin' ? 'Cmd' : 'unsupported'
    case 'alt':
    case 'option':
      return 'Alt'
    case 'altgr':
      return 'AltGr'
    case 'shift':
      return 'Shift'
    case 'super':
    case 'meta':
      return 'Super'
    default:
      return null
  }
}

function keyOf(token: string): string | null {
  if (token.length === 1) {
    if (/[a-z]/i.test(token)) return token.toUpperCase()
    if (/[0-9]/.test(token) || PUNCTUATION.has(token)) return token
    return null
  }
  const fn = /^f(\d{1,2})$/i.exec(token)
  if (fn) {
    const n = Number(fn[1])
    return n >= 1 && n <= 24 ? `F${n}` : null
  }
  const numpad = /^num([0-9])$/i.exec(token)
  if (numpad) return `num${numpad[1]}`
  return NAMED_BY_LOWER.get(token.toLowerCase()) ?? null
}

/**
 * Parse an accelerator and return its canonical spelling (so "ctrl+alt+right" and "Alt+Control+Right" are the same
 * binding), or say why it is not acceptable. Modifier aliases follow the platform: CommandOrControl is Cmd on macOS and
 * Ctrl elsewhere, and Command is refused where it does not exist.
 */
export function normalizeAccelerator(input: unknown, platform: Platform = process.platform): Normalized {
  if (typeof input !== 'string') return invalid('The shortcut must be text.')
  const text = input.trim()
  if (!text || text.length > 64) return invalid('The shortcut is empty or too long.')
  const tokens = text.split('+').map((t) => t.trim())
  if (tokens.some((t) => t === '')) return invalid('Write the plus key as "Plus" and separate keys with "+".')

  const modifiers = new Set<Modifier>()
  let key: string | null = null
  for (const [index, token] of tokens.entries()) {
    const modifier = modifierOf(token, platform)
    if (modifier === 'unsupported') return invalid(`"${token}" does not exist on this system.`)
    if (modifier) {
      if (modifiers.has(modifier)) return invalid(`"${modifier}" appears twice.`)
      modifiers.add(modifier)
      continue
    }
    if (index !== tokens.length - 1) return invalid('The key must come last, after any modifiers.')
    key = keyOf(token)
    if (!key) return invalid(`"${token}" is not a key that can be used.`)
  }
  if (!key) return invalid('Add a key after the modifiers.')
  if (modifiers.has('AltGr') && (modifiers.has('Ctrl') || modifiers.has('Alt'))) return invalid('AltGr already includes Ctrl and Alt.')

  const canonical = [...MODIFIER_ORDER.filter((m) => modifiers.has(m)), key].join('+')
  const typing = [...modifiers].some((m) => TYPING_MODIFIERS.has(m))
  if (!STANDALONE.test(key) && !typing) return invalid('Add Ctrl, Alt or another modifier so the shortcut does not interfere with typing.')
  if (RESERVED.has(canonical)) return { ok: false, error: 'reserved', message: `${canonical} is reserved by the system or by text editing.` }
  return { ok: true, accelerator: canonical }
}

// ---- stored settings ----

/**
 * Read saved bindings. Missing entries get their default; a saved value that no longer parses falls back to the default
 * too; and if two commands end up with the same accelerator the later one is disabled rather than fighting for it.
 */
export function parseHotkeys(raw: unknown, platform: Platform = process.platform): HotkeyBindings {
  const saved = typeof raw === 'object' && raw !== null ? (raw as Record<string, unknown>) : {}
  const result = {} as Record<DesktopCommand, string | null>
  const used = new Set<string>()
  for (const command of DESKTOP_COMMANDS) {
    const value = saved[command]
    let accelerator: string | null
    if (value === null) accelerator = null
    else if (value === undefined) accelerator = DEFAULT_HOTKEYS[command]
    else {
      const n = normalizeAccelerator(value, platform)
      accelerator = n.ok ? n.accelerator : DEFAULT_HOTKEYS[command]
    }
    if (accelerator !== null && used.has(accelerator)) accelerator = null
    if (accelerator !== null) used.add(accelerator)
    result[command] = accelerator
  }
  return result
}

// ---- registration ----

/** The slice of Electron's `globalShortcut` that we use. */
export interface ShortcutApi {
  register(accelerator: string, callback: () => void): boolean
  unregister(accelerator: string): void
  isRegistered(accelerator: string): boolean
}

/** Owns the registrations for one set of bindings and remembers whether the system accepted each one. */
export class HotkeyManager {
  private bindings: HotkeyBindings = DEFAULT_HOTKEYS
  private readonly status = new Map<DesktopCommand, HotkeyStatus>()

  constructor(
    private readonly shortcuts: ShortcutApi,
    private readonly run: (command: DesktopCommand) => void,
    private readonly platform: Platform = process.platform,
  ) {}

  /** Replace every registration with the given bindings. */
  apply(bindings: HotkeyBindings): HotkeyState {
    this.releaseAll()
    this.bindings = bindings
    this.status.clear()
    for (const command of DESKTOP_COMMANDS) this.status.set(command, this.register(command, bindings[command]))
    return this.state()
  }

  state(): HotkeyState {
    const entries = DESKTOP_COMMANDS.map((c) => [c, { accelerator: this.bindings[c], status: this.status.get(c) ?? 'disabled' }] as const)
    return Object.fromEntries(entries) as unknown as HotkeyState
  }

  get current(): HotkeyBindings {
    return this.bindings
  }

  /** Ask the system again for the bindings that were taken (the other application may have let go). */
  retryTaken(): HotkeyState {
    for (const command of DESKTOP_COMMANDS) {
      const accelerator = this.bindings[command]
      if (this.status.get(command) === 'taken' && accelerator !== null) this.status.set(command, this.register(command, accelerator))
    }
    return this.state()
  }

  /**
   * Change one binding. Nothing changes unless the whole request is acceptable: the accelerator must parse, must not be
   * reserved, must not already belong to another command here, and the system must agree to register it. A refusal
   * leaves the previous binding registered exactly as it was.
   */
  set(command: DesktopCommand, input: unknown): HotkeyResult {
    const previous = this.bindings[command]
    const previousStatus = this.status.get(command) ?? 'disabled'

    if (input === null) {
      if (previous !== null && previousStatus === 'active') this.shortcuts.unregister(previous)
      this.bindings = { ...this.bindings, [command]: null }
      this.status.set(command, 'disabled')
      return { ok: true, state: this.state() }
    }

    const n = normalizeAccelerator(input, this.platform)
    if (!n.ok) return this.refuse(n.error, n.message)
    const owner = DESKTOP_COMMANDS.find((c) => c !== command && this.bindings[c] === n.accelerator)
    if (owner) return this.refuse('conflict', `${n.accelerator} is already used by "${owner}".`)
    if (previous === n.accelerator && previousStatus === 'active') return { ok: true, state: this.state() }

    if (previous !== null && previousStatus === 'active') this.shortcuts.unregister(previous)
    const status = this.register(command, n.accelerator)
    if (status === 'taken') {
      if (previous !== null && previousStatus === 'active') this.status.set(command, this.register(command, previous))
      return this.refuse('taken', 'Another application is already using that shortcut.')
    }
    this.bindings = { ...this.bindings, [command]: n.accelerator }
    this.status.set(command, status)
    return { ok: true, state: this.state() }
  }

  reset(): HotkeyState {
    return this.apply(DEFAULT_HOTKEYS)
  }

  dispose(): void {
    this.releaseAll()
  }

  /** Run the command bound to an accelerator exactly as the system would on a key press (used by the smoke tests). */
  press(accelerator: string): boolean {
    const command = DESKTOP_COMMANDS.find((c) => this.bindings[c] === accelerator && this.status.get(c) === 'active')
    if (!command) return false
    this.run(command)
    return true
  }

  private refuse(error: HotkeyError, message: string): HotkeyResult {
    return { ok: false, error, message, state: this.state() }
  }

  private register(command: DesktopCommand, accelerator: string | null): HotkeyStatus {
    if (accelerator === null) return 'disabled'
    try {
      return this.shortcuts.register(accelerator, () => this.run(command)) && this.shortcuts.isRegistered(accelerator) ? 'active' : 'taken'
    } catch {
      return 'taken' // Electron throws for accelerators it cannot parse on this platform
    }
  }

  private releaseAll(): void {
    for (const command of DESKTOP_COMMANDS) {
      const accelerator = this.bindings[command]
      if (accelerator !== null && this.status.get(command) === 'active') this.shortcuts.unregister(accelerator)
    }
  }
}
