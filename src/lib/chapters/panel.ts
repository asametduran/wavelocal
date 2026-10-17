/**
 * Whether the list of chapters is open. What opens it (a button under each of the two seek bars, the C key) is not where the
 * dialog is drawn, so they share this instead of passing a callback down through the player bar.
 */
export class OpenSwitch {
  private open = false
  private readonly listeners = new Set<() => void>()

  get = (): boolean => this.open

  set = (open: boolean): void => {
    if (open === this.open) return
    this.open = open
    for (const listener of [...this.listeners]) listener()
  }

  toggle = (): void => this.set(!this.open)

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }
}

/** The page's one chapters dialog. */
export const chaptersPanel = new OpenSwitch()
