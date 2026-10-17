import { describe, expect, it } from 'vitest'
import { DEFAULT_HOTKEYS, normalizeAccelerator, parseHotkeys } from './hotkeys'
import { DESKTOP_COMMANDS } from './ipc'

// A small seeded generator of its own: the desktop shell is a separate project and does not reach into the web app's sources.
function mulberry32(seed: number): () => number {
  let a = seed
  return () => {
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}
const int = (random: () => number, below: number) => Math.floor(random() * below)
const pick = <T>(random: () => number, items: readonly T[]): T => items[int(random, items.length)] as T
const SCALE = Math.min(1000, Math.max(1, Number(process.env.FUZZ_RUNS) || 1))
const seeds = (count: number) => Array.from({ length: count * SCALE }, (_, i) => i + 1)
const PLATFORMS = ['win32', 'darwin', 'linux'] as const

const TOKENS = ['Ctrl', 'Control', 'CommandOrControl', 'CmdOrCtrl', 'Command', 'Cmd', 'Alt', 'Option', 'AltGr', 'Shift', 'Super', 'Meta', 'MediaPlayPause', 'MediaNextTrack', 'VolumeUp', 'F1', 'F24', 'F25', 'a', 'Z', '9', 'Space', 'Plus', 'Return', 'num5', 'Left', 'PageDown', '-', '=', '', ' ', '+', 'x'.repeat(70), '\u0000', 'ü', 'Esc', 'Delete', 'Tab']
const accelerator = (random: () => number) => Array.from({ length: 1 + int(random, 5) }, () => pick(random, TOKENS)).join(pick(random, ['+', '+', '+', ' + ', '-', '']))

/** What the shell hands to the operating system: modifiers in a fixed order, then one key. */
const CANONICAL = /^(?:(?:Ctrl|Cmd|Alt|AltGr|Shift|Super)\+)*[^+]+$|^.*\+Plus$/

describe('global shortcuts under fuzzing', () => {
  it('accept an accelerator only in its one canonical spelling, and say why when they refuse', () => {
    for (const seed of seeds(3000)) {
      const random = mulberry32(seed)
      const platform = pick(random, PLATFORMS)
      const result = normalizeAccelerator(accelerator(random), platform)
      if (result.ok) {
        expect(result.accelerator.length).toBeLessThanOrEqual(64)
        expect(result.accelerator).toMatch(CANONICAL)
        // writing it down canonically again changes nothing
        expect(normalizeAccelerator(result.accelerator, platform)).toEqual(result)
      } else {
        expect(['invalid', 'reserved']).toContain(result.error)
        expect(result.message.length).toBeGreaterThan(0)
      }
    }
  })

  it('refuse everything that is not text', () => {
    for (const input of [undefined, null, 0, 1, true, {}, [], ['Ctrl+A'], () => 'Ctrl+A', Symbol('x'), 10n, { toString: () => 'Ctrl+Alt+A' }]) {
      const result = normalizeAccelerator(input, 'win32')
      expect(result.ok).toBe(false)
    }
  })

  it('treat different spellings of one binding as the same binding', () => {
    expect(normalizeAccelerator('ctrl+alt+right', 'win32')).toEqual(normalizeAccelerator('Alt+Control+Right', 'win32'))
    expect(normalizeAccelerator('CommandOrControl+Shift+M', 'darwin')).toEqual({ ok: true, accelerator: 'Cmd+Shift+M' })
    expect(normalizeAccelerator('CommandOrControl+Shift+M', 'linux')).toEqual({ ok: true, accelerator: 'Ctrl+Shift+M' })
  })

  it('read any stored settings into exactly the six commands, each unbound or validly bound, no two alike', () => {
    for (const seed of seeds(3000)) {
      const random = mulberry32(seed)
      const platform = pick(random, PLATFORMS)
      const saved: Record<string, unknown> = {}
      for (const command of [...DESKTOP_COMMANDS, 'toggle', 'extra', '__proto__', 'constructor']) {
        if (random() < 0.7) saved[command] = random() < 0.5 ? accelerator(random) : pick(random, [null, undefined, 0, true, {}, [], 'Ctrl+Alt+A', 'Ctrl+Alt+A', 'MediaPlayPause'])
      }
      const bindings = parseHotkeys(random() < 0.9 ? saved : pick(random, [null, undefined, 0, 'text', [], [saved]]), platform)
      expect(Object.keys(bindings).sort()).toEqual([...DESKTOP_COMMANDS].sort())
      const used = new Set<string>()
      for (const command of DESKTOP_COMMANDS) {
        const value = bindings[command]
        if (value === null) continue
        expect(normalizeAccelerator(value, platform), `${command}: ${value}`).toEqual({ ok: true, accelerator: value })
        expect(used.has(value), `${value} is bound twice`).toBe(false)
        used.add(value)
      }
    }
  })

  it('cannot be polluted through stored settings', () => {
    const attacks = ['{"__proto__":{"toggle":"Ctrl+Alt+A","polluted":"yes"}}', '{"constructor":{"prototype":{"polluted":"yes"}}}', '{"toggle":{"__proto__":{"polluted":"yes"}}}']
    for (const attack of attacks) parseHotkeys(JSON.parse(attack), 'win32')
    expect(({} as Record<string, unknown>).polluted).toBeUndefined()
    expect(parseHotkeys(JSON.parse(attacks[0] as string), 'win32')).toEqual(DEFAULT_HOTKEYS)
  })
})
