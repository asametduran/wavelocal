import type { LogEntry } from './types'

/**
 * The text a person can copy from Diagnostics to send with a bug report. It holds the log as it is kept (every message already cleaned
 * by `redact.ts`) and where it was made: the build and the browser. It holds nothing else: no settings, no counts, no names.
 */

export interface ReportContext {
  /** The build, as `appBuild` finds it. */
  build: string
  /** The browser and system, as `describeBrowser` says it. */
  browser: string
  /** When the report is made, in milliseconds since 1970. */
  now: number
}

const stamp = (ms: number): string => (Number.isFinite(ms) && Math.abs(ms) <= 8.64e15 ? `${new Date(ms).toISOString().slice(0, 19)}Z` : 'unknown time')

export function buildReport(entries: readonly LogEntry[], { build, browser, now }: ReportContext): string {
  const lines = ['Wavelocal error report', `Build ${build} · ${browser}`, `Made ${stamp(now)}`, '']
  if (!entries.length) {
    lines.push('No errors have been recorded.', '')
  } else {
    lines.push(`${entries.length} ${entries.length === 1 ? 'entry' : 'entries'}, newest first:`, '')
    for (const entry of [...entries].reverse()) {
      lines.push(`${stamp(entry.at)} · ${entry.kind} · ${entry.name}${entry.count > 1 ? ` (×${entry.count})` : ''}`)
      if (entry.message) lines.push(`  ${entry.message}`)
      for (const frame of entry.frames) lines.push(`  at ${frame}`)
      lines.push('')
    }
  }
  lines.push('File names, tags and settings are left out. This text was made on this device when you asked for it; nothing was sent anywhere.')
  return lines.join('\n')
}

/** "Chrome 141 on Windows": the browser and system and nothing that tells one device from another. */
export function describeBrowser(userAgent: string): string {
  const system = /Windows/.test(userAgent)
    ? 'Windows'
    : /Android/.test(userAgent)
      ? 'Android'
      : /iPhone|iPad|iPod/.test(userAgent)
        ? 'iOS'
        : /Mac OS X|Macintosh/.test(userAgent)
          ? 'macOS'
          : /CrOS/.test(userAgent)
            ? 'ChromeOS'
            : /Linux/.test(userAgent)
              ? 'Linux'
              : ''
  const version = (pattern: RegExp, name: string): string | null => {
    const found = pattern.exec(userAgent)
    return found ? `${name} ${found[1]}` : null
  }
  const browser =
    version(/Electron\/(\d+)/, 'Electron') ??
    version(/Edg\/(\d+)/, 'Edge') ??
    version(/OPR\/(\d+)/, 'Opera') ??
    (/; wv\)/.test(userAgent) ? version(/Chrome\/(\d+)/, 'Android WebView') : null) ??
    version(/Firefox\/(\d+)/, 'Firefox') ??
    version(/Chrome\/(\d+)/, 'Chrome') ??
    version(/Version\/(\d+).*Safari/, 'Safari') ??
    'an unknown browser'
  return system ? `${browser} on ${system}` : browser
}

/** The build this page runs: the hash in the name of the entry script (every build has another), or `development`. */
export function appBuild(scripts: Iterable<{ src: string }> = document.scripts): string {
  for (const { src } of scripts) {
    const found = /\/assets\/index-([\w-]{4,})\.js(?:\?|$)/.exec(src)
    if (found) return found[1] as string
  }
  return 'development'
}
