/**
 * Whether this window may write the library to the database, and what to tell the person when it may not. The player keeps the
 * whole library in memory and writes it back as it changes; that is only safe while this window really holds what is stored.
 * Two things can break that: the saved library could not be read (an empty window that writes back would erase it), and another
 * window took over (a stale window that writes back would erase what the other saved). In both the window carries on, plays and
 * browses, and refuses to write. Start-up code on purpose: the writes that ask it live in `write.ts`, everything that reads,
 * retries or explains is in lazy chunks.
 */

export type GateMode =
  /** Reading the saved library: nothing may be written yet. */
  | 'loading'
  | 'open'
  /** The saved library could not be read (`unreadable`), or the browser keeps nothing for this page (`unavailable`). */
  | 'memory'
  /** Another window holds the library. */
  | 'taken'

export type MemoryReason = 'unreadable' | 'unavailable'

export interface GateSnapshot {
  readonly mode: GateMode
  readonly reason: MemoryReason | null
  /** How many writes were refused since the window stopped saving. */
  readonly dropped: number
  /** The writes whose latest save failed and is being tried again (see `write.ts`). */
  readonly failing: readonly string[]
  /** The newest error among them, for the words about it; null while nothing is failing. */
  readonly error: unknown
}

/** The lock the window that keeps the library holds. */
export const LOCK_NAME = 'wavelocal-library'

/** A write that was asked of a window that may not write. The message is written for the person: it is what a toast shows. */
export class NotSavingError extends Error {
  constructor(readonly mode: 'memory' | 'taken') {
    super(mode === 'taken' ? 'Another window of Wavelocal has taken over the library, so this change is not saved.' : 'Wavelocal is not saving in this window, so this change is lost when the window closes.')
    this.name = 'NotSavingError'
  }
}

export interface GateHooks {
  /** Tell the person why a change of theirs is not being saved. Called once for each way of not saving. */
  explain?: (mode: GateMode, reason: MemoryReason | null) => void
  /** Saves started failing (`failing`, with the first error), or the last failing one went through (`recovered`). */
  episode?: (event: 'failing' | 'recovered', error: unknown) => void
}

export class WriteGate {
  private state: GateSnapshot = { mode: 'loading', reason: null, dropped: 0, failing: [], error: null }
  private stolen = false
  private readonly listeners = new Set<() => void>()
  private readonly told = new Set<GateMode>()
  private resolveSettled: () => void = () => {}

  /** Resolves when the first answer is in: the library was read, or could not be. Writes that arrive earlier wait for it. */
  readonly settled: Promise<void> = new Promise((resolve) => {
    this.resolveSettled = resolve
  })

  constructor(private readonly hooks: GateHooks = {}) {}

  /** The same object until something changes, as `useSyncExternalStore` requires. */
  snapshot = (): GateSnapshot => this.state

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  get canWrite(): boolean {
    return this.state.mode === 'open'
  }

  private change(patch: Partial<GateSnapshot>): void {
    this.state = { ...this.state, ...patch }
    this.listeners.forEach((listener) => listener())
  }

  /** The saved library was read: this window keeps it, unless another window already took the lock. */
  open(): void {
    if (this.state.mode !== 'loading') return
    this.change({ mode: this.stolen ? 'taken' : 'open' })
    this.resolveSettled()
  }

  /**
   * The saved library could not be read: nothing is written, so what is stored stays as it is. An empty window needs words at once,
   * so this is explained now and not at the first refused write.
   */
  memory(reason: MemoryReason): void {
    if (this.state.mode !== 'loading') return
    this.change({ mode: 'memory', reason })
    this.resolveSettled()
    this.told.add('memory')
    this.hooks.explain?.('memory', reason)
  }

  /** Another window took the lock. */
  take(): void {
    if (this.state.mode === 'open') this.change({ mode: 'taken' })
    else if (this.state.mode === 'loading') this.stolen = true
  }

  /** A write was asked for and refused. `quiet` ones (the place being played, a play count) are counted and never explained. */
  refuse(quiet: boolean): void {
    const { mode, reason } = this.state
    if (mode !== 'memory' && mode !== 'taken') return
    this.change({ dropped: this.state.dropped + 1 })
    if (quiet || this.told.has(mode)) return
    this.told.add(mode)
    this.hooks.explain?.(mode, reason)
  }

  /** A write failed (the database said no). Several can be failing at once; the first one starts an episode, which is announced once. */
  failed(key: string, error: unknown): void {
    const starting = this.state.failing.length === 0
    this.change({ failing: this.state.failing.includes(key) ? this.state.failing : [...this.state.failing, key], error })
    if (starting) this.hooks.episode?.('failing', error)
  }

  /** A write that was failing went through. When the last one does, the episode is over. */
  saved(key: string): void {
    if (!this.state.failing.includes(key)) return
    const failing = this.state.failing.filter((k) => k !== key)
    this.change({ failing, error: failing.length ? this.state.error : null })
    if (!failing.length) this.hooks.episode?.('recovered', null)
  }
}

export const writeGate = new WriteGate({
  explain: (mode, reason) => {
    void import('./notices').then((notices) => notices.explainDropped(mode, reason)).catch(() => {})
  },
  episode: (event, error) => {
    void import('./notices').then((notices) => notices.explainFailing(event, error)).catch(() => {})
  },
})

/** The part of the Web Locks API the claim uses. */
export interface LockLike {
  request(name: string, options: { steal: true }, callback: () => Promise<never>): Promise<unknown>
}

const browserLocks = (): LockLike | undefined => (typeof navigator === 'undefined' ? undefined : (navigator.locks as LockLike | undefined))

/**
 * Become the window that keeps the library: take the lock, stealing it from whichever window held it (the newest window wins, so a
 * reload never has to wait for the page it replaces). The lock is held until the page goes. If it is stolen later the request
 * rejects, and the gate learns that another window took over. Resolves when the lock is held, or at once where there are no Web
 * Locks, or when the browser does not answer for two seconds: the library must load either way.
 */
export function claimWriter(gate: WriteGate = writeGate, locks: LockLike | undefined = browserLocks(), giveUpAfter = 2000): Promise<void> {
  if (!locks) return Promise.resolve()
  return new Promise<void>((resolve) => {
    let granted = false
    const timer = setTimeout(resolve, giveUpAfter)
    const hold = (): Promise<never> => {
      granted = true
      clearTimeout(timer)
      resolve()
      return new Promise<never>(() => {})
    }
    locks.request(LOCK_NAME, { steal: true }, hold).catch(() => {
      clearTimeout(timer)
      if (granted) gate.take()
      else resolve() // refused before it was ever given (an opaque origin, say): go on as if there were no locks
    })
  })
}

let claim: Promise<void> | null = null

/** This page's claim, made once however often the window asks for it (a second request would steal the lock from the first). */
export const claimWindow = (): Promise<void> => (claim ??= claimWriter())
