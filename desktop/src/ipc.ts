import type {
  DesktopCommand,
  HotkeyError,
  HotkeyResult,
  HotkeyState,
  HotkeyStatus,
  NowPlaying,
} from '../../src/desktop-bridge.js' with { 'resolution-mode': 'import' }

/**
 * The IPC channels between the page and the shell. The sandboxed preload cannot load this file at run time, so it
 * repeats the strings and lets the compiler check them against these types.
 */
export const CHANNEL = {
  nowPlaying: 'wavelocal:now-playing',
  command: 'wavelocal:command',
  hotkeysGet: 'wavelocal:hotkeys-get',
  hotkeysSet: 'wavelocal:hotkeys-set',
  hotkeysReset: 'wavelocal:hotkeys-reset',
} as const

/** Kept equal to `DESKTOP_COMMANDS` in src/desktop-bridge.ts by a unit test (the shell cannot import that file at run time). */
export const DESKTOP_COMMANDS: readonly DesktopCommand[] = ['toggle', 'next', 'prev', 'volumeUp', 'volumeDown', 'mute']

export type { DesktopCommand, HotkeyError, HotkeyResult, HotkeyState, HotkeyStatus, NowPlaying }
