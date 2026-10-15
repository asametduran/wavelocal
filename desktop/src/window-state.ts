/**
 * Remembering where the window was. Pure functions only: the file is read and written by the main process, and
 * whatever it contains is untrusted (it may be hand-edited, corrupted, or from a monitor that is no longer attached).
 */

export interface WindowState {
  x?: number
  y?: number
  width: number
  height: number
  maximized: boolean
}

/** A display's usable area (Electron's `screen.getAllDisplays()[i].workArea`). */
export interface DisplayArea {
  x: number
  y: number
  width: number
  height: number
}

export const DEFAULT_WINDOW: WindowState = { width: 1180, height: 760, maximized: false }
export const MIN_WINDOW = { width: 360, height: 520 } as const
const MAX_SIZE = 16384

const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v)
const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v))

/** Validate parsed JSON into a window state, or null if it is unusable. */
export function parseWindowState(raw: unknown): WindowState | null {
  if (typeof raw !== 'object' || raw === null) return null
  const r = raw as Record<string, unknown>
  if (!finite(r.width) || !finite(r.height)) return null
  const state: WindowState = {
    width: Math.round(clamp(r.width, MIN_WINDOW.width, MAX_SIZE)),
    height: Math.round(clamp(r.height, MIN_WINDOW.height, MAX_SIZE)),
    maximized: r.maximized === true,
  }
  if (finite(r.x) && finite(r.y)) {
    state.x = Math.round(clamp(r.x, -MAX_SIZE, MAX_SIZE))
    state.y = Math.round(clamp(r.y, -MAX_SIZE, MAX_SIZE))
  }
  return state
}

/** How much of the title bar must be visible on some screen for the window to remain grabbable. */
const GRAB = { width: 120, height: 24, strip: 40 } as const

/** Size of the overlap between a rectangle and a display (0 when they do not touch). */
const overlap = (a: { x: number; y: number; width: number; height: number }, b: DisplayArea) => ({
  width: Math.max(0, Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x)),
  height: Math.max(0, Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y)),
})

/**
 * Make a saved state safe for the displays that exist now: the window may not be bigger than the largest screen, and
 * if its title bar is no longer on any screen (monitor unplugged, resolution changed) the position is dropped so the
 * operating system places it. Without displays information the state is returned unchanged.
 */
export function fitToDisplays(state: WindowState, displays: readonly DisplayArea[]): WindowState {
  if (displays.length === 0) return state
  const maxWidth = Math.max(...displays.map((d) => d.width))
  const maxHeight = Math.max(...displays.map((d) => d.height))
  const fitted: WindowState = {
    ...state,
    width: Math.min(state.width, Math.max(MIN_WINDOW.width, maxWidth)),
    height: Math.min(state.height, Math.max(MIN_WINDOW.height, maxHeight)),
  }
  if (state.x !== undefined && state.y !== undefined) {
    const titleBar = { x: state.x, y: state.y, width: fitted.width, height: GRAB.strip }
    const grabbable = displays.some((d) => {
      const o = overlap(titleBar, d)
      return o.width >= Math.min(GRAB.width, fitted.width) && o.height >= GRAB.height
    })
    if (grabbable) return fitted
  }
  delete fitted.x
  delete fitted.y
  return fitted
}

/** The state to persist: the normal (not maximized) bounds, plus whether to maximize on the next start. */
export function snapshotWindowState(bounds: { x: number; y: number; width: number; height: number }, maximized: boolean, previous?: WindowState): WindowState {
  // while maximized, the live bounds are the screen's: keep the last normal bounds so un-maximizing goes somewhere sensible
  if (maximized && previous) return { ...previous, maximized: true }
  return { x: bounds.x, y: bounds.y, width: bounds.width, height: bounds.height, maximized }
}
