import type { NowPlaying, TrayCommand } from '../../src/desktop-bridge.js' with { 'resolution-mode': 'import' }

/**
 * The IPC channels between the page and the shell. The sandboxed preload cannot load this file at run time, so it
 * repeats the strings and lets the compiler check them against these types.
 */
export const CHANNEL = {
  nowPlaying: 'wavelocal:now-playing',
  command: 'wavelocal:command',
} as const

export const TRAY_COMMANDS: readonly TrayCommand[] = ['toggle', 'next', 'prev']

export type { NowPlaying, TrayCommand }
