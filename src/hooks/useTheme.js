import { useCallback, useEffect, useState } from 'react'

const KEY = 'wl-accent'
export const DEFAULT_ACCENT = '#a78bfa'
export const ACCENT_PRESETS = [
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

function load() {
  try {
    const v = localStorage.getItem(KEY)
    if (v && HEX.test(v)) return v.toLowerCase()
  } catch {
    /* storage unavailable */
  }
  return DEFAULT_ACCENT
}

/** Persisted accent color, exposed to CSS as `--accent` (space-separated RGB) and `--accent-hex`. */
export function useTheme() {
  const [accent, setAccentState] = useState(load)

  useEffect(() => {
    const n = parseInt(accent.slice(1), 16)
    const s = document.documentElement.style
    s.setProperty('--accent', `${(n >> 16) & 255} ${(n >> 8) & 255} ${n & 255}`)
    s.setProperty('--accent-hex', accent)
  }, [accent])

  const setAccent = useCallback((v) => {
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
