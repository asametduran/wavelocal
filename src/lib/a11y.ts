/** Pure accessibility helpers: spoken text, roving-focus maths, focus trapping and the open-dialog stack. */

const plural = (n: number, unit: string): string => `${n} ${unit}${n === 1 ? '' : 's'}`

/** "1 minute 5 seconds": screen readers say this instead of the cryptic "65" a raw range value would give. */
export function spokenTime(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return '0 seconds'
  const total = Math.floor(seconds)
  const h = Math.floor(total / 3600)
  const m = Math.floor((total % 3600) / 60)
  const s = total % 60
  const parts: string[] = []
  if (h) parts.push(plural(h, 'hour'))
  if (m) parts.push(plural(m, 'minute'))
  if (s || !parts.length) parts.push(plural(s, 'second'))
  return parts.join(' ')
}

/** Value text of the seek slider: "1 minute 5 seconds of 3 minutes 20 seconds". */
export function spokenProgress(time: number, duration: number): string {
  return duration > 0 ? `${spokenTime(time)} of ${spokenTime(duration)}` : spokenTime(time)
}

export const spokenPercent = (fraction: number): string => `${Math.round(Math.min(1, Math.max(0, fraction)) * 100)} percent`

export type Orientation = 'horizontal' | 'vertical' | 'both'

/**
 * The index to focus after an arrow/Home/End key in a roving group (tabs, radios, menus), or null when the key does
 * not navigate. Wraps around the ends, as the WAI-ARIA authoring practices describe.
 */
export function rovingTarget(key: string, current: number, count: number, orientation: Orientation = 'horizontal'): number | null {
  if (count <= 0) return null
  const h = orientation !== 'vertical'
  const v = orientation !== 'horizontal'
  const from = Math.min(Math.max(current, 0), count - 1)
  if ((h && key === 'ArrowRight') || (v && key === 'ArrowDown')) return (from + 1) % count
  if ((h && key === 'ArrowLeft') || (v && key === 'ArrowUp')) return (from - 1 + count) % count
  if (key === 'Home') return 0
  if (key === 'End') return count - 1
  return null
}

/** Elements a Tab key press can land on. */
export const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]):not([type="hidden"]), select:not([disabled]), textarea:not([disabled]), [tabindex]'

/** Enabled, tabbable descendants of `root` in DOM order (skipping anything inert, hidden or aria-hidden). */
export function tabbables(root: HTMLElement): HTMLElement[] {
  return Array.from(root.querySelectorAll<HTMLElement>(FOCUSABLE)).filter(
    (el) => el.tabIndex >= 0 && !el.hidden && !el.closest('[inert], [hidden], [aria-hidden="true"]'),
  )
}

/**
 * Where Tab (or Shift+Tab) must be sent so focus cannot leave `root`: the opposite end when leaving it, the first
 * (last) element when focus is outside, or null when the browser's own movement stays inside.
 */
export function trapTarget(root: HTMLElement, active: Element | null, shift: boolean): HTMLElement | null {
  const items = tabbables(root)
  const first = items[0]
  const last = items[items.length - 1]
  if (!first || !last) return root
  if (!active || !root.contains(active) || active === root) return shift ? last : first
  if (shift && active === first) return last
  if (!shift && active === last) return first
  return null
}

/** What to say when the playing track or the play state changes. Empty when there is nothing to announce. */
export function trackAnnouncement(track: { title: string; artist: string } | null | undefined, playing: boolean, trackChanged: boolean): string {
  if (!track) return ''
  if (trackChanged) {
    const by = track.artist && track.artist !== 'Unknown Artist' ? ` by ${track.artist}` : ''
    return `${playing ? 'Now playing' : 'Selected'}: ${track.title}${by}`
  }
  return playing ? 'Playing' : 'Paused'
}

/** Spoken result of a keyboard reorder. */
export function moveAnnouncement(title: string, position: number, total: number): string {
  return `${title} moved to position ${position} of ${total}`
}

/** Result count for a filtered list ("3 tracks match"); empty when no search is active. */
export function matchAnnouncement(count: number, query: string): string {
  if (!query.trim()) return ''
  if (count === 0) return 'No tracks match your search'
  return count === 1 ? '1 track matches' : `${count} tracks match`
}

/**
 * The stack of open dialogs. Only the topmost one traps focus, so a sheet that opens another dialog
 * (Now Playing > Sound tools) does not fight it.
 */
export class DialogStack {
  private readonly ids: symbol[] = []

  push(): symbol {
    const id = Symbol('dialog')
    this.ids.push(id)
    return id
  }

  remove(id: symbol): void {
    const i = this.ids.indexOf(id)
    if (i >= 0) this.ids.splice(i, 1)
  }

  isTop(id: symbol): boolean {
    return this.ids[this.ids.length - 1] === id
  }

  get size(): number {
    return this.ids.length
  }
}

export const dialogs = new DialogStack()

export interface Announcement {
  /** Text to speak. A counter makes repeats of the same sentence count as new content. */
  text: string
  id: number
}

/**
 * Feeds the page's single polite live region. Screen readers only speak a live region when its content changes,
 * so saying the same sentence twice alternates a trailing no-break space.
 */
export class Announcer {
  private current: Announcement = { text: '', id: 0 }
  private readonly listeners = new Set<() => void>()

  say = (text: string): void => {
    if (!text) return
    const id = this.current.id + 1
    this.current = { text: id % 2 === 0 && text === this.current.text.trimEnd() ? `${text} ` : text, id }
    this.listeners.forEach((l) => l())
  }

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  snapshot = (): Announcement => this.current
}

export const announcer = new Announcer()
export const announce = announcer.say
