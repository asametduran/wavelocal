import type { MenuItemConstructorOptions } from 'electron'
import { DESKTOP_COMMANDS } from './ipc'
import type { NowPlaying, DesktopCommand } from './ipc'

/** The pure part of the tray: what to show for a given state. Everything here is unit tested without Electron. */

export const IDLE: NowPlaying = Object.freeze({ title: '', artist: '', playing: false })

/** Windows truncates tooltips at 127 UTF-16 units (including the terminator). */
export const TOOLTIP_LIMIT = 127
const FIELD_LIMIT = 200
const APP_NAME = 'Wavelocal'

// C0/C1 controls, line/paragraph separators and bidi overrides, by code point so no invisible characters live in this file
const isControl = (cp: number): boolean =>
  cp <= 0x1f || (cp >= 0x7f && cp <= 0x9f) || cp === 0x2028 || cp === 0x2029 || (cp >= 0x202a && cp <= 0x202e) || (cp >= 0x2066 && cp <= 0x2069)

function stripControls(text: string): string {
  let out = ''
  let gap = false
  for (const ch of text) {
    if (isControl(ch.codePointAt(0) ?? 0)) {
      gap = true
      continue
    }
    out += gap && out ? ' ' + ch : ch
    gap = false
  }
  return out
}

/** Collapse control characters and bidi overrides (untrusted file tags) to single spaces, trim and clip. */
export function cleanText(value: unknown, limit = FIELD_LIMIT): string {
  if (typeof value !== 'string') return ''
  const text = stripControls(value).trim()
  return text.length > limit ? `${text.slice(0, limit - 1).trimEnd()}…` : text
}

/** Validate what arrived over IPC; anything malformed means "nothing is playing". */
export function parseNowPlaying(raw: unknown): NowPlaying {
  if (typeof raw !== 'object' || raw === null) return IDLE
  const r = raw as Record<string, unknown>
  const title = cleanText(r.title)
  if (!title) return IDLE
  return { title, artist: cleanText(r.artist), playing: r.playing === true }
}

export function parseCommand(raw: unknown): DesktopCommand | null {
  return DESKTOP_COMMANDS.find((c) => c === raw) ?? null
}

const clip = (text: string, limit: number): string => (text.length <= limit ? text : `${text.slice(0, limit - 1).trimEnd()}…`)

/** "Title — Artist" with a pause mark when paused, kept within the platform limit; the artist is dropped before the title. */
export function tooltipFor(state: NowPlaying): string {
  if (!state.title) return APP_NAME
  const prefix = state.playing ? '' : '⏸ '
  const full = `${prefix}${state.title}${state.artist ? ` — ${state.artist}` : ''}`
  if (full.length < TOOLTIP_LIMIT) return full
  return clip(`${prefix}${state.title}`, TOOLTIP_LIMIT - 1)
}

export interface TrayView {
  state: NowPlaying
  windowVisible: boolean
  closeToTray: boolean
}

export interface TrayActions {
  command(command: DesktopCommand): void
  toggleWindow(): void
  setCloseToTray(value: boolean): void
  quit(): void
}

/** The context menu: a disabled now-playing line, transport, window visibility, the close behaviour and quit. */
export function buildTrayMenu(view: TrayView, actions: TrayActions): MenuItemConstructorOptions[] {
  const idle = !view.state.title
  const header = idle ? 'Nothing playing' : clip(view.state.artist ? `${view.state.title} — ${view.state.artist}` : view.state.title, 60)
  return [
    { label: header, enabled: false },
    { type: 'separator' },
    { label: view.state.playing ? 'Pause' : 'Play', enabled: !idle, click: () => actions.command('toggle') },
    { label: 'Next', enabled: !idle, click: () => actions.command('next') },
    { label: 'Previous', enabled: !idle, click: () => actions.command('prev') },
    { type: 'separator' },
    { label: view.windowVisible ? `Hide ${APP_NAME}` : `Show ${APP_NAME}`, click: () => actions.toggleWindow() },
    { label: 'Close to tray', type: 'checkbox', checked: view.closeToTray, click: (item) => actions.setCloseToTray(item.checked) },
    { type: 'separator' },
    { label: `Quit ${APP_NAME}`, click: () => actions.quit() },
  ]
}
