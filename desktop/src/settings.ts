/** Preferences owned by the shell (the web app keeps its own settings in IndexedDB). */
export interface DesktopSettings {
  /** Closing or minimizing the window hides it to the tray instead of quitting/minimizing. */
  closeToTray: boolean
}

export const DEFAULT_SETTINGS: DesktopSettings = Object.freeze({ closeToTray: true })

export function parseDesktopSettings(raw: unknown): DesktopSettings {
  if (typeof raw !== 'object' || raw === null) return { ...DEFAULT_SETTINGS }
  const r = raw as Record<string, unknown>
  return { closeToTray: typeof r.closeToTray === 'boolean' ? r.closeToTray : DEFAULT_SETTINGS.closeToTray }
}
