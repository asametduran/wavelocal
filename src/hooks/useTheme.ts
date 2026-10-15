import { useCallback, useEffect, useState } from 'react'
import { accentTheme, parseHex } from '../lib/contrast'

const KEY = 'wl-accent'
export const DEFAULT_ACCENT = '#a78bfa'
export const ACCENT_PRESETS: readonly (readonly [name: string, hex: string])[] = [
  ['Violet', '#a78bfa'],
  ['Pink', '#f472b6'],
  ['Red', '#f87171'],
  ['Orange', '#fb923c'],
  ['Amber', '#fbbf24'],
  ['Green', '#4ade80'],
  ['Teal', '#2dd4bf'],
  ['Blue', '#60a5fa'],
]

const HEX = /^#[0-9a-f]{6}$/i

function load(): string {
  try {
    const v = localStorage.getItem(KEY)
    if (v && HEX.test(v)) return v.toLowerCase()
  } catch {
    /* storage unavailable */
  }
  return DEFAULT_ACCENT
}

/** Persisted accent color, exposed to CSS as `--accent` (space-separated RGB) and `--accent-hex`. */
export function useTheme(): [accent: string, setAccent: (hex: string) => void] {
  const [accent, setAccentState] = useState(load)

  useEffect(() => {
    // a very dark pick is lightened until it is readable on the dark surfaces; text on filled accent areas flips to white when needed
    const theme = accentTheme(accent)
    const shown = parseHex(theme?.accent ?? DEFAULT_ACCENT) ?? [167, 139, 250]
    const on = parseHex(theme?.on ?? '#000000') ?? [0, 0, 0]
    const s = document.documentElement.style
    s.setProperty('--accent', shown.join(' '))
    s.setProperty('--accent-hex', theme?.accent ?? accent)
    s.setProperty('--on-accent', on.join(' '))
  }, [accent])

  const setAccent = useCallback((v: string) => {
    if (!HEX.test(v)) return
    const hex = v.toLowerCase()
    setAccentState(hex)
    try {
      localStorage.setItem(KEY, hex)
    } catch {
      /* ignore */
    }
  }, [])

  return [accent, setAccent]
}
