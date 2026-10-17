// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { OfflineController, chooseOfflinePlan } from './updates'
import type { OfflineDecision, OfflineEnv } from './updates'
import type { WorkerStatus } from './protocol'

// ---- fake workers, registration and container ----

class FakeWorker extends EventTarget {
  state: ServiceWorkerState = 'installing'
  readonly posted: unknown[] = []
  /** What this worker answers to a `status` request, or null to stay silent. */
  statusReply: WorkerStatus | null = null
  postMessage(message: unknown, transfer?: Transferable[]): void {
    this.posted.push(message)
    const port = transfer?.[0] as MessagePort | undefined
    if ((message as { type?: string }).type === 'status' && port && this.statusReply) port.postMessage(this.statusReply)
  }
  become(state: ServiceWorkerState): void {
    this.state = state
    this.dispatchEvent(new Event('statechange'))
  }
}

class FakeRegistration extends EventTarget {
  installing: FakeWorker | null = null
  waiting: FakeWorker | null = null
  active: FakeWorker | null = null
  updates = 0
  /** What `update()` does: by default nothing is found. */
  onUpdate: () => Promise<void> | void = () => {}
  unregistered = false
  async update(): Promise<FakeRegistration> {
    this.updates++
    await this.onUpdate()
    return this
  }
  async unregister(): Promise<boolean> {
    this.unregistered = true
    return true
  }
  /** A new version starts installing. */
  found(worker: FakeWorker): void {
    this.installing = worker
    this.dispatchEvent(new Event('updatefound'))
  }
}

class FakeContainer extends EventTarget {
  controller: FakeWorker | null = null
  readonly registration = new FakeRegistration()
  readonly registered: { url: string; options?: RegistrationOptions }[] = []
  failWith: Error | null = null
  async register(url: string, options?: RegistrationOptions): Promise<FakeRegistration> {
    this.registered.push({ url, options })
    if (this.failWith) throw this.failWith
    return this.registration
  }
  async getRegistrations(): Promise<FakeRegistration[]> {
    return [this.registration]
  }
  /** Another worker takes control of this page. */
  take(worker: FakeWorker): void {
    this.controller = worker
    this.dispatchEvent(new Event('controllerchange'))
  }
}

const STATUS: WorkerStatus = { version: 'aaaaaaaaaaaa', entries: 3, bytes: 1000, complete: true }

interface Rig {
  controller: OfflineController
  container: FakeContainer
  reload: ReturnType<typeof vi.fn>
  prompt: ReturnType<typeof vi.fn>
  foreground: (() => void)[]
  timers: { ms: number; run: () => void }[]
  clock: { now: number }
  caches: Map<string, true>
}

function rig(options: Partial<OfflineEnv> = {}): Rig {
  const container = new FakeContainer()
  const reload = vi.fn()
  const prompt = vi.fn()
  const foreground: (() => void)[] = []
  const timers: { ms: number; run: () => void }[] = []
  const clock = { now: 1_000_000 }
  const caches = new Map<string, true>([['wavelocal-v1', true], ['wavelocal-precache-aaaaaaaaaaaa', true], ['someone-elses-cache', true]])
  const store = {
    keys: async () => [...caches.keys()],
    delete: async (name: string) => caches.delete(name),
  } as unknown as CacheStorage
  const env: OfflineEnv = {
    container: container as unknown as ServiceWorkerContainer,
    caches: store,
    scriptUrl: './sw.js',
    reload,
    now: () => clock.now,
    prompt,
    onForeground: (listener) => foreground.push(listener),
    every: (ms, run) => timers.push({ ms, run }),
    statusTimeoutMs: 50,
    settleMs: 5,
    ...options,
  }
  return { controller: new OfflineController(env), container, reload, prompt, foreground, timers, clock, caches }
}

const REGISTER: OfflineDecision = { plan: 'register', reason: 'active' }
const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 0))
/** Wait out the moment a freshly installed worker is given to take over by itself (5 ms in these tests). */
const settle = async (): Promise<void> => {
  if (vi.isFakeTimers()) await vi.advanceTimersByTimeAsync(30)
  else await new Promise<void>((resolve) => setTimeout(resolve, 25))
}
/** A worker finishes installing, and the page has waited to see whether it stays waiting. */
const installed = async (worker: FakeWorker): Promise<void> => {
  worker.become('installed')
  await settle()
}

/** A page that is already controlled by a running version `aaaaaaaaaaaa`. */
async function running(options: Partial<OfflineEnv> = {}): Promise<Rig & { current: FakeWorker }> {
  const r = rig(options)
  const current = new FakeWorker()
  current.state = 'activated'
  current.statusReply = STATUS
  r.container.controller = current
  r.container.registration.active = current
  await r.controller.start(REGISTER)
  return { ...r, current }
}

describe('chooseOfflinePlan', () => {
  const where = { production: true, hasWorkers: true, desktop: false, native: false }
  it.each([
    ['a production web page registers the worker', where, 'register', 'active'],
    ['the dev server never gets one', { ...where, production: false }, 'none', 'development'],
    ['the desktop shell already has the app on disk', { ...where, desktop: true }, 'none', 'managed'],
    ['the Android app removes workers earlier versions registered', { ...where, native: true }, 'remove', 'managed'],
    ['the Android app with no worker support has nothing to remove', { ...where, native: true, hasWorkers: false }, 'none', 'managed'],
    ['a browser without service workers does without', { ...where, hasWorkers: false }, 'none', 'unsupported'],
  ])('%s', (_label, input, plan, reason) => {
    expect(chooseOfflinePlan(input)).toEqual({ plan, reason })
  })

  it('does not touch workers on the desktop even if the browser has them', () => {
    expect(chooseOfflinePlan({ ...where, desktop: true, native: true }).plan).toBe('none')
  })
})

describe('start', () => {
  it('registers the worker and always asks the server for a fresh script', async () => {
    const r = rig()
    await r.controller.start(REGISTER)
    expect(r.container.registered).toEqual([{ url: './sw.js', options: { updateViaCache: 'none' } }])
    expect(r.controller.snapshot().reason).toBe('active')
  })

  it('does nothing in a window that is not meant to have a worker', async () => {
    const r = rig()
    await r.controller.start({ plan: 'none', reason: 'managed' })
    expect(r.container.registered).toEqual([])
    expect(r.controller.snapshot().reason).toBe('managed')
  })

  it('reports an unsupported browser instead of throwing', async () => {
    const r = rig({ container: undefined })
    await r.controller.start(REGISTER)
    expect(r.controller.snapshot().reason).toBe('unsupported')
  })

  it('reports a browser that refuses the worker instead of throwing', async () => {
    const r = rig()
    r.container.failWith = new TypeError('SecurityError: blocked')
    await expect(r.controller.start(REGISTER)).resolves.toBeUndefined()
    expect(r.controller.snapshot().reason).toBe('blocked')
    expect(await r.controller.check()).toBe('unavailable')
  })

  it('asks the running worker what it has stored', async () => {
    const r = await running()
    expect(r.controller.snapshot().status).toEqual(STATUS)
    expect(r.current.posted).toEqual([{ type: 'status' }])
  })

  it('copes with a worker that never answers', async () => {
    const r = rig({ statusTimeoutMs: 20 })
    r.container.controller = new FakeWorker()
    await r.controller.start(REGISTER)
    expect(r.controller.snapshot().status).toBeNull()
  })

  it('ignores a reply that is not a status', async () => {
    const r = rig()
    const worker = new FakeWorker()
    worker.statusReply = { version: 3 } as unknown as WorkerStatus
    r.container.controller = worker
    await r.controller.start(REGISTER)
    expect(r.controller.snapshot().status).toBeNull()
  })

  it('has no status before any worker controls the page', async () => {
    const r = rig()
    await r.controller.start(REGISTER)
    expect(r.controller.snapshot().status).toBeNull()
  })
})

describe('the first install', () => {
  it('goes unnoticed: no prompt, no reload, and the status appears once the worker has taken control', async () => {
    const r = rig()
    await r.controller.start(REGISTER)
    const first = new FakeWorker()
    first.statusReply = STATUS
    r.container.registration.found(first)
    expect(r.controller.snapshot().stage).toBe('downloading')
    first.become('installed')
    expect(r.controller.snapshot().stage).toBe('idle')
    first.become('activated')
    r.container.take(first)
    await tick()
    await tick()
    expect(r.prompt).not.toHaveBeenCalled()
    expect(r.reload).not.toHaveBeenCalled()
    expect(r.controller.snapshot().stage).toBe('idle')
    expect(r.controller.snapshot().status).toEqual(STATUS)
  })
})

describe('an update', () => {
  async function download(r: Awaited<ReturnType<typeof running>>) {
    const next = new FakeWorker()
    r.container.registration.found(next)
    await installed(next)
    r.container.registration.waiting = next
    r.container.registration.installing = null
    return next
  }

  it('is offered, not forced: the running version keeps going until the person agrees', async () => {
    const r = await running()
    const next = new FakeWorker()
    r.container.registration.found(next)
    expect(r.controller.snapshot().stage).toBe('downloading')
    expect(r.prompt).not.toHaveBeenCalled()
    next.become('installed')
    expect(r.controller.snapshot().stage).toBe('downloading') // first it is given a moment to take over by itself
    expect(r.prompt).not.toHaveBeenCalled()
    await settle()
    expect(r.controller.snapshot().stage).toBe('ready')
    expect(r.prompt).toHaveBeenCalledTimes(1)
    expect(r.prompt.mock.calls[0]?.[0]).toMatch(/new version/i)
    expect(r.prompt.mock.calls[0]?.[1]).toMatchObject({ label: 'Reload' })
    expect(r.reload).not.toHaveBeenCalled()
    expect(next.posted).toEqual([])
  })

  it('switches over when the prompt is accepted: asks the waiting worker to take over, then reloads once it has', async () => {
    const r = await running()
    const next = await download(r)
    const action = (r.prompt.mock.calls[0]?.[1] as { run: () => void }).run
    action()
    expect(next.posted).toEqual([{ type: 'skip-waiting' }])
    expect(r.reload).not.toHaveBeenCalled()
    next.become('activated')
    r.container.take(next)
    expect(r.reload).toHaveBeenCalledTimes(1)
  })

  it('reloads anyway when the worker never takes over, so the button is never dead', async () => {
    vi.useFakeTimers()
    try {
      const r = await running({ takeOverMs: 1000 })
      await download(r)
      r.controller.apply()
      expect(r.reload).not.toHaveBeenCalled()
      vi.advanceTimersByTime(1001)
      expect(r.reload).toHaveBeenCalledTimes(1)
    } finally {
      vi.useRealTimers()
    }
  })

  it('does not reload twice when the worker takes over in time', async () => {
    vi.useFakeTimers()
    try {
      const r = await running({ takeOverMs: 1000 })
      const next = await download(r)
      r.controller.apply()
      r.container.take(next)
      vi.advanceTimersByTime(5000)
      expect(r.reload).toHaveBeenCalledTimes(2) // once for the takeover, once for the timer: a reload is idempotent
    } finally {
      vi.useRealTimers()
    }
  })

  it('is waiting already when a version was downloaded on an earlier visit', async () => {
    const r = rig()
    const current = new FakeWorker()
    r.container.controller = current
    r.container.registration.waiting = new FakeWorker()
    await r.controller.start(REGISTER)
    expect(r.controller.snapshot().stage).toBe('ready')
    expect(r.prompt).toHaveBeenCalledTimes(1)
  })

  it('prompts once even if another version arrives while one is waiting', async () => {
    const r = await running()
    await download(r)
    const newer = new FakeWorker()
    r.container.registration.found(newer)
    await installed(newer)
    expect(r.prompt).toHaveBeenCalledTimes(1)
    expect(r.controller.snapshot().stage).toBe('ready')
  })

  it('goes back to idle, quietly, when the download fails and the new worker is discarded', async () => {
    const r = await running()
    const next = new FakeWorker()
    r.container.registration.found(next)
    next.become('redundant')
    expect(r.controller.snapshot().stage).toBe('idle')
    expect(r.prompt).not.toHaveBeenCalled()
  })

  it('just reloads when asked to apply with nothing waiting', async () => {
    const r = await running()
    r.controller.apply()
    expect(r.reload).toHaveBeenCalledTimes(1)
  })
})

describe('an update applied in another window', () => {
  it('tells this page its code is out of date, and does not reload it behind the listener\'s back', async () => {
    const r = await running()
    const next = new FakeWorker()
    r.container.registration.found(next)
    await installed(next)
    r.prompt.mockClear()
    // another window's click makes the waiting worker take over
    next.become('activated')
    r.container.take(next)
    expect(r.reload).not.toHaveBeenCalled()
    expect(r.controller.snapshot()).toMatchObject({ stage: 'ready', updatedElsewhere: true })
  })

  it('does not ask anyone to reload for a worker that takes over by itself, as it does when it replaces the retired v1 worker', async () => {
    const r = await running()
    const next = new FakeWorker()
    r.container.registration.found(next)
    // installed and activated in one go, never waiting: that page was loaded from the network and has nothing to update
    next.become('installed')
    next.become('activated')
    r.container.take(next)
    await settle()
    expect(r.prompt).not.toHaveBeenCalled()
    expect(r.reload).not.toHaveBeenCalled()
    expect(r.controller.snapshot()).toMatchObject({ stage: 'idle', updatedElsewhere: false })
  })

  it('stays quiet when a worker takes a page it never saw a waiting version for', async () => {
    const r = await running()
    r.container.take(new FakeWorker())
    expect(r.prompt).not.toHaveBeenCalled()
    expect(r.reload).not.toHaveBeenCalled()
    expect(r.controller.snapshot().stage).toBe('idle')
  })
})

describe('check', () => {
  it('says unavailable before a worker is registered', async () => {
    expect(await rig().controller.check()).toBe('unavailable')
  })

  it('says the app is current when nothing new is found, and records when it looked', async () => {
    const r = await running()
    expect(await r.controller.check()).toBe('current')
    expect(r.container.registration.updates).toBe(1)
    expect(r.controller.snapshot()).toMatchObject({ stage: 'idle', checkedAt: r.clock.now })
  })

  it('says there is an update when the server has a new version, and follows its download', async () => {
    const r = await running()
    const next = new FakeWorker()
    r.container.registration.onUpdate = () => r.container.registration.found(next)
    expect(await r.controller.check()).toBe('update')
    expect(r.controller.snapshot().stage).toBe('downloading')
    await installed(next)
    expect(r.controller.snapshot().stage).toBe('ready')
  })

  it('says it is offline when the server cannot be reached, without showing an error', async () => {
    const r = await running()
    r.container.registration.onUpdate = () => {
      throw new TypeError('Failed to update a ServiceWorker: Failed to fetch')
    }
    expect(await r.controller.check()).toBe('offline')
    expect(r.controller.snapshot().stage).toBe('idle')
    expect(r.prompt).not.toHaveBeenCalled()
  })

  it('does not look again while an update is already ready', async () => {
    const r = await running()
    const next = new FakeWorker()
    r.container.registration.found(next)
    await installed(next)
    expect(await r.controller.check()).toBe('update')
    expect(r.container.registration.updates).toBe(0)
  })

  it('shares one request between checks that overlap', async () => {
    const r = await running()
    let release: () => void = () => {}
    r.container.registration.onUpdate = () => new Promise<void>((resolve) => (release = resolve))
    const first = r.controller.check()
    const second = r.controller.check()
    release()
    expect(await Promise.all([first, second])).toEqual(['current', 'current'])
    expect(r.container.registration.updates).toBe(1)
  })

  it('shows that it is checking while it waits', async () => {
    const r = await running()
    let release: () => void = () => {}
    r.container.registration.onUpdate = () => new Promise<void>((resolve) => (release = resolve))
    const pending = r.controller.check()
    expect(r.controller.snapshot().stage).toBe('checking')
    release()
    await pending
    expect(r.controller.snapshot().stage).toBe('idle')
  })
})

describe('automatic checks', () => {
  it('check when the page comes back to the foreground, but not more often than every 15 minutes', async () => {
    const r = await running()
    const comeBack = r.foreground[0] as () => void
    comeBack()
    await tick()
    expect(r.container.registration.updates).toBe(1)
    r.clock.now += 5 * 60_000
    comeBack()
    await tick()
    expect(r.container.registration.updates).toBe(1)
    r.clock.now += 11 * 60_000
    comeBack()
    await tick()
    expect(r.container.registration.updates).toBe(2)
  })

  it('also check on a timer for a page that stays open for days', async () => {
    const r = await running()
    expect(r.timers).toHaveLength(1)
    expect(r.timers[0]?.ms).toBe(6 * 60 * 60 * 1000)
    r.clock.now += 7 * 60 * 60_000
    r.timers[0]?.run()
    await tick()
    expect(r.container.registration.updates).toBe(1)
  })

  it('leave a download that is in progress alone', async () => {
    const r = await running()
    r.container.registration.found(new FakeWorker())
    r.foreground[0]?.()
    await tick()
    expect(r.container.registration.updates).toBe(0)
  })
})

describe('subscribe and snapshot', () => {
  it('hands out the same object until something changes', async () => {
    const r = await running()
    const before = r.controller.snapshot()
    expect(r.controller.snapshot()).toBe(before)
    await r.controller.refreshStatus()
    expect(r.controller.snapshot()).toBe(before)
  })

  it('tells listeners about changes only, and stops after unsubscribing', async () => {
    const r = rig()
    const seen = vi.fn()
    const stop = r.controller.subscribe(seen)
    await r.controller.start({ plan: 'none', reason: 'managed' })
    expect(seen).toHaveBeenCalledTimes(1)
    await r.controller.start({ plan: 'none', reason: 'managed' })
    expect(seen).toHaveBeenCalledTimes(1)
    stop()
    await r.controller.start({ plan: 'none', reason: 'development' })
    expect(seen).toHaveBeenCalledTimes(1)
  })
})

describe('removing the offline copy', () => {
  it('unregisters the worker and deletes this app\'s caches, and only those', async () => {
    const r = rig()
    await r.controller.start({ plan: 'remove', reason: 'managed' })
    expect(r.container.registration.unregistered).toBe(true)
    expect([...r.caches.keys()]).toEqual(['someone-elses-cache'])
    expect(r.controller.snapshot().reason).toBe('managed')
    expect(r.reload).not.toHaveBeenCalled()
  })

  it('repair does the same and then reloads, so the next load starts from nothing', async () => {
    const r = await running()
    await r.controller.repair()
    expect(r.container.registration.unregistered).toBe(true)
    expect([...r.caches.keys()]).toEqual(['someone-elses-cache'])
    expect(r.reload).toHaveBeenCalledTimes(1)
  })

  it('survives a browser that throws while listing or deleting', async () => {
    const r = rig({
      caches: {
        keys: async () => {
          throw new Error('denied')
        },
      } as unknown as CacheStorage,
    })
    r.container.getRegistrations = async () => {
      throw new Error('denied')
    }
    await expect(r.controller.start({ plan: 'remove', reason: 'managed' })).resolves.toBeUndefined()
  })
})

beforeEach(() => {
  vi.useRealTimers()
})
afterEach(() => {
  vi.useRealTimers()
})
