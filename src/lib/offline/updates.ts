import { isOwnCache } from './precache'
import { parseStatus } from './protocol'
import type { WorkerStatus } from './protocol'

/**
 * The page's side of the offline copy: register the service worker, notice when a new version of the app has been
 * downloaded in the background, ask the user before switching to it, and report what the worker has stored. A new
 * version never replaces the one a person is listening with: it waits until they choose to reload.
 *
 * Everything the browser provides is passed in (`OfflineEnv`), so the behaviour is tested with fake workers.
 */

/** Why there is, or is not, a service worker in this window. */
export type OfflineReason =
  /** `start` has not run yet. */
  | 'pending'
  | 'active'
  /** Not a production build: the dev server must never be cached. */
  | 'development'
  /** The app already runs from files on the device (desktop shell, Android app), so a second copy would only go stale. */
  | 'managed'
  /** The browser has no service workers here (an insecure address, some private windows). */
  | 'unsupported'
  /** The browser refused to register the worker. */
  | 'blocked'

/** What a new version is doing. */
export type UpdateStage = 'idle' | 'checking' | 'downloading' | 'ready'

export interface OfflineSnapshot {
  reason: OfflineReason
  stage: UpdateStage
  /** The waiting version was applied by another window: this page still runs the old code. */
  updatedElsewhere: boolean
  /** What the worker in control reports about its offline copy; null until it has been asked, or when none controls the page. */
  status: WorkerStatus | null
  /** When the last update check ended (ms since the epoch), or null. */
  checkedAt: number | null
}

/** `update`: a newer version is downloading or ready. `current`: this is the latest. `offline`: could not reach the server. */
export type CheckResult = 'update' | 'current' | 'offline' | 'unavailable'

export type OfflinePlan = 'register' | 'remove' | 'none'

export interface OfflineDecision {
  plan: OfflinePlan
  reason: OfflineReason
}

/**
 * Whether this window should have a service worker. Desktop and the Android app already ship the app on disk; for the
 * Android app, workers registered by earlier versions are removed so that none can serve an old copy of the app.
 */
export function chooseOfflinePlan(where: { production: boolean; hasWorkers: boolean; desktop: boolean; native: boolean }): OfflineDecision {
  if (!where.production) return { plan: 'none', reason: 'development' }
  if (where.desktop) return { plan: 'none', reason: 'managed' }
  if (where.native) return { plan: where.hasWorkers ? 'remove' : 'none', reason: 'managed' }
  return where.hasWorkers ? { plan: 'register', reason: 'active' } : { plan: 'none', reason: 'unsupported' }
}

export interface OfflineEnv {
  container: ServiceWorkerContainer | undefined
  caches: CacheStorage | undefined
  /** Where the worker script is. */
  scriptUrl: string
  reload: () => void
  now: () => number
  /** Tell the user something and offer one action; it stays until they dismiss it. */
  prompt: (text: string, action: { label: string; run: () => void }) => void
  /** Call `listener` whenever the page comes back to the foreground. */
  onForeground: (listener: () => void) => void
  /** Call `listener` every `ms` while the page is open. */
  every: (ms: number, listener: () => void) => void
  /** How long to wait for a worker to take over before reloading anyway. */
  takeOverMs?: number
  /** How long a freshly installed worker gets to take over by itself before the page asks anyone to reload. */
  settleMs?: number
  /** How long to wait for the worker to report its status. */
  statusTimeoutMs?: number
}

const sameStatus = (a: WorkerStatus | null, b: WorkerStatus | null): boolean =>
  a === b || (a !== null && b !== null && a.version === b.version && a.entries === b.entries && a.bytes === b.bytes && a.complete === b.complete)

const CHECK_EVERY_MS = 6 * 60 * 60 * 1000
const MIN_CHECK_GAP_MS = 15 * 60 * 1000
const DEFAULT_TAKE_OVER_MS = 4000
const DEFAULT_SETTLE_MS = 300
const DEFAULT_STATUS_TIMEOUT_MS = 3000

export class OfflineController {
  private state: OfflineSnapshot = { reason: 'pending', stage: 'idle', updatedElsewhere: false, status: null, checkedAt: null }
  private registration: ServiceWorkerRegistration | null = null
  private controlled = false
  private applying = false
  private prompted = false
  private waitingSeen = false
  private tracking: ServiceWorker | null = null
  private checking: Promise<CheckResult> | null = null
  private readonly listeners = new Set<() => void>()

  constructor(private readonly env: OfflineEnv) {}

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  /** The same object until something changes, as `useSyncExternalStore` requires. */
  snapshot = (): OfflineSnapshot => this.state

  private patch(change: Partial<OfflineSnapshot>): void {
    const next = { ...this.state, ...change }
    if ((Object.keys(next) as (keyof OfflineSnapshot)[]).every((key) => next[key] === this.state[key])) return
    this.state = next
    this.listeners.forEach((listener) => listener())
  }

  /** Apply the decision: register the worker, remove old ones, or do nothing. Never rejects. */
  async start(decision: OfflineDecision): Promise<void> {
    const { container } = this.env
    if (decision.plan === 'none') return this.patch({ reason: decision.reason })
    if (decision.plan === 'remove') {
      await this.removeAll()
      return this.patch({ reason: decision.reason })
    }
    if (!container) return this.patch({ reason: 'unsupported' })

    this.controlled = container.controller !== null
    let registration: ServiceWorkerRegistration
    try {
      // `none`: always look for a new worker script on the server, never trust a stale HTTP-cached copy
      registration = await container.register(this.env.scriptUrl, { updateViaCache: 'none' })
    } catch {
      return this.patch({ reason: 'blocked' })
    }
    this.registration = registration
    this.patch({ reason: 'active' })

    container.addEventListener('controllerchange', this.onControllerChange)
    registration.addEventListener('updatefound', () => {
      if (registration.installing) this.track(registration.installing)
    })
    if (registration.waiting && this.controlled) this.ready(false)
    else if (registration.installing) this.track(registration.installing)

    this.env.onForeground(() => this.checkIfDue())
    this.env.every(CHECK_EVERY_MS, () => this.checkIfDue())
    await this.refreshStatus()
  }

  /** Follow a worker that is installing: when it is installed and another version is running, offer it. */
  private track(worker: ServiceWorker): void {
    if (worker === this.tracking) return
    this.tracking = worker
    this.patch({ stage: 'downloading' })
    worker.addEventListener('statechange', () => {
      if (worker.state === 'installed') {
        // with no version running yet this is the first install: it activates by itself, there is nothing to ask
        if (this.controlled) this.settle(worker)
        else this.patch({ stage: 'idle' })
      } else if (worker.state === 'activated') {
        if (this.state.stage === 'downloading') this.patch({ stage: 'idle' })
        void this.refreshStatus()
      } else if (worker.state === 'redundant' && this.state.stage === 'downloading') {
        // the install failed (offline, or a file did not match): the version in use keeps working, the next check retries
        this.patch({ stage: 'idle' })
      }
    })
  }

  /**
   * A worker that is installed either waits for the person to agree, or takes over by itself (the way a worker replaces the
   * retired v1 one, whose pages were loaded from the network and need nothing). Wait a moment to see which, so that nobody
   * is asked to reload for a version that is already running.
   */
  private settle(worker: ServiceWorker): void {
    setTimeout(() => {
      if (worker.state === 'installed') this.ready(false)
      else if (this.state.stage === 'downloading') this.patch({ stage: 'idle' })
    }, this.env.settleMs ?? DEFAULT_SETTLE_MS)
  }

  private ready(elsewhere: boolean): void {
    this.waitingSeen = true
    this.patch({ stage: 'ready', updatedElsewhere: elsewhere })
    if (this.prompted) return
    this.prompted = true
    this.env.prompt(elsewhere ? 'Wavelocal was updated in another window.' : 'A new version of Wavelocal is ready.', { label: 'Reload', run: () => this.apply() })
  }

  private onControllerChange = (): void => {
    if (this.applying) {
      this.env.reload()
      return
    }
    if (!this.controlled) {
      // the first worker took control of this page (it claims the open pages): nothing changed for the person
      this.controlled = true
      void this.refreshStatus()
      return
    }
    // a different version took over without being asked, and this page was told one was waiting: another window applied it,
    // so this page's code is older than the files now being served. (A worker that replaces the retired v1 one swaps in
    // by itself, without ever waiting: that page was loaded from the network, so it needs nothing.)
    if (this.waitingSeen) this.ready(true)
    void this.refreshStatus()
  }

  /** Switch to the version that is waiting, then reload. Without one, just reload. */
  apply(): void {
    const waiting = this.registration?.waiting
    if (!waiting) {
      this.env.reload()
      return
    }
    this.applying = true
    waiting.postMessage({ type: 'skip-waiting' })
    // if the worker never takes over (it was replaced in the meantime), do not leave a button that does nothing
    setTimeout(() => {
      if (this.applying) this.env.reload()
    }, this.env.takeOverMs ?? DEFAULT_TAKE_OVER_MS)
  }

  /** Look for a new version now. Concurrent calls share one check. */
  check(): Promise<CheckResult> {
    const registration = this.registration
    if (!registration) return Promise.resolve('unavailable')
    if (this.state.stage === 'ready') return Promise.resolve('update')
    this.checking ??= this.runCheck(registration).finally(() => {
      this.checking = null
    })
    return this.checking
  }

  private async runCheck(registration: ServiceWorkerRegistration): Promise<CheckResult> {
    if (this.state.stage === 'idle') this.patch({ stage: 'checking' })
    try {
      await registration.update()
    } catch {
      if (this.state.stage === 'checking') this.patch({ stage: 'idle' })
      this.patch({ checkedAt: this.env.now() })
      return 'offline'
    }
    if (registration.waiting && this.controlled) this.ready(false)
    else if (registration.installing) this.track(registration.installing)
    if (this.state.stage === 'checking') this.patch({ stage: 'idle' })
    this.patch({ checkedAt: this.env.now() })
    return this.state.stage === 'downloading' || this.state.stage === 'ready' ? 'update' : 'current'
  }

  private checkIfDue(): void {
    const { checkedAt, stage } = this.state
    if (stage !== 'idle') return
    if (checkedAt !== null && this.env.now() - checkedAt < MIN_CHECK_GAP_MS) return
    void this.check()
  }

  /** Ask the worker in control what it has stored. */
  async refreshStatus(): Promise<void> {
    const worker = this.env.container?.controller
    const status = worker ? await this.ask(worker) : null
    // each reply is a new object: keep the old one when nothing changed, so the screen does not redraw for nothing
    if (!sameStatus(status, this.state.status)) this.patch({ status })
  }

  private ask(worker: ServiceWorker): Promise<WorkerStatus | null> {
    return new Promise((resolve) => {
      const channel = new MessageChannel()
      const timer = setTimeout(() => {
        channel.port1.close()
        resolve(null)
      }, this.env.statusTimeoutMs ?? DEFAULT_STATUS_TIMEOUT_MS)
      channel.port1.onmessage = (event) => {
        clearTimeout(timer)
        channel.port1.close()
        resolve(parseStatus(event.data))
      }
      try {
        worker.postMessage({ type: 'status' }, [channel.port2])
      } catch {
        clearTimeout(timer)
        resolve(null)
      }
    })
  }

  /** Throw away the offline copy and the worker, then reload: the next load downloads everything fresh. */
  async repair(): Promise<void> {
    await this.removeAll()
    this.env.reload()
  }

  private async removeAll(): Promise<void> {
    try {
      const registrations = (await this.env.container?.getRegistrations()) ?? []
      await Promise.all(registrations.map((registration) => registration.unregister().catch(() => false)))
    } catch {
      // nothing more to do for a browser that will not list its workers
    }
    const store = this.env.caches
    if (!store) return
    try {
      await Promise.all((await store.keys()).filter(isOwnCache).map((name) => store.delete(name)))
    } catch {
      // the cache is already gone or unreachable
    }
  }
}
