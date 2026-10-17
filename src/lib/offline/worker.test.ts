// @vitest-environment node
import { describe, expect, it, vi } from 'vitest'
import { createWorker } from './worker'
import type { OfflineWorker, WorkerEnv } from './worker'
import { LEGACY_CACHE, MARKER_PATH, precacheName } from './precache'
import type { PrecacheEntry } from './precache'
import { parseMessage, parseStatus } from './protocol'

// ---- an in-memory Cache Storage and a scripted network ----

class FakeCache {
  readonly files = new Map<string, { body: ArrayBuffer; type: string; status: number }>()
  async put(request: RequestInfo | URL, response: Response): Promise<void> {
    this.files.set(urlOf(request), { body: await response.clone().arrayBuffer(), type: response.headers.get('content-type') ?? '', status: response.status })
  }
  async match(request: RequestInfo | URL): Promise<Response | undefined> {
    const stored = this.files.get(urlOf(request))
    return stored ? new Response(stored.body.slice(0), { status: stored.status, headers: { 'content-type': stored.type } }) : undefined
  }
  async keys(): Promise<Request[]> {
    return [...this.files.keys()].map((url) => new Request(url))
  }
  async delete(request: RequestInfo | URL): Promise<boolean> {
    return this.files.delete(urlOf(request))
  }
}

const urlOf = (request: RequestInfo | URL): string => (typeof request === 'string' ? new URL(request).href : request instanceof URL ? request.href : request.url)

class FakeCaches {
  readonly stores = new Map<string, FakeCache>()
  async open(name: string): Promise<FakeCache> {
    let cache = this.stores.get(name)
    if (!cache) this.stores.set(name, (cache = new FakeCache()))
    return cache
  }
  async has(name: string): Promise<boolean> {
    return this.stores.has(name)
  }
  async keys(): Promise<string[]> {
    return [...this.stores.keys()]
  }
  async delete(name: string): Promise<boolean> {
    return this.stores.delete(name)
  }
  async match(request: RequestInfo | URL, options?: { cacheName?: string }): Promise<Response | undefined> {
    if (options?.cacheName) return this.stores.get(options.cacheName)?.match(request)
    for (const cache of this.stores.values()) {
      const hit = await cache.match(request)
      if (hit) return hit
    }
    return undefined
  }
}

const SCOPE = 'https://music.example/app/'
const text = (s: string) => new TextEncoder().encode(s)
const sha = async (bytes: Uint8Array<ArrayBuffer>) => Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)), (b) => b.toString(16).padStart(2, '0')).join('').slice(0, 32)

interface Site {
  /** Files by scope-relative path. */
  files: Record<string, string>
  types?: Record<string, string>
}

/** A manifest the way the build writes it, for the files of a fake site. */
const manifestOf = async (site: Site): Promise<PrecacheEntry[]> =>
  (
    await Promise.all(
      Object.entries(site.files).map(async ([url, body]) => ({
        url,
        size: text(body).length,
        hash: await sha(text(body)),
        type: site.types?.[url] ?? (url.endsWith('.html') ? 'text/html; charset=utf-8' : 'text/javascript; charset=utf-8'),
      })),
    )
  ).sort((a, b) => a.url.localeCompare(b.url))

const V1: Site = { files: { 'index.html': '<html>v1</html>', 'assets/app-1.js': 'console.log(1)', 'assets/lazy-1.js': 'export default 1', 'icons/icon.png': 'png-bytes' }, types: { 'icons/icon.png': 'image/png' } }
// the next release: a new shell, the main script replaced by a new one, everything else untouched
const V2: Site = { files: { 'index.html': '<html>v2</html>', 'assets/app-2.js': 'console.log(2)', 'assets/lazy-1.js': V1.files['assets/lazy-1.js'] ?? '', 'icons/icon.png': V1.files['icons/icon.png'] ?? '' }, types: V1.types }
const M1 = await manifestOf(V1)

interface Rig {
  worker: OfflineWorker
  caches: FakeCaches
  network: { served: string[]; requests: Request[]; offline: boolean; replace: Record<string, Response | (() => Response)>; inFlight: number; peak: number; delayMs: number }
  skipWaiting: ReturnType<typeof vi.fn>
  claim: ReturnType<typeof vi.fn>
  extended: Promise<unknown>[]
  env: WorkerEnv
}

async function rig(site: Site, version: string, caches = new FakeCaches(), options: Partial<WorkerEnv> = {}): Promise<Rig> {
  const network: Rig['network'] = { served: [], requests: [], offline: false, replace: {}, inFlight: 0, peak: 0, delayMs: 0 }
  const skipWaiting = vi.fn(async () => {})
  const claim = vi.fn(async () => {})
  const env: WorkerEnv = {
    version,
    manifest: await manifestOf(site),
    scope: SCOPE,
    caches: caches as unknown as CacheStorage,
    fetch: async (req) => {
      network.requests.push(req)
      const path = decodeURIComponent(new URL(req.url).pathname.slice(new URL(SCOPE).pathname.length))
      network.served.push(path)
      network.inFlight++
      network.peak = Math.max(network.peak, network.inFlight)
      try {
        if (network.delayMs) await new Promise((r) => setTimeout(r, network.delayMs))
        if (network.offline) throw new TypeError('Failed to fetch')
        const forced = network.replace[path]
        if (forced) return typeof forced === 'function' ? forced() : forced.clone()
        const body = site.files[path]
        return body === undefined ? new Response('not found', { status: 404 }) : new Response(body, { status: 200, headers: { 'content-type': 'application/octet-stream' } })
      } finally {
        network.inFlight--
      }
    },
    skipWaiting,
    claim,
    ...options,
  }
  return { worker: createWorker(env), caches, network, skipWaiting, claim, extended: [], env }
}

/** A request for a page of the fake site; `navigate` makes it look like a page load, which `new Request` cannot be. */
const request = (path: string, init: RequestInit = {}, mode?: RequestMode) => {
  const r = new Request(`https://music.example${path}`, init)
  return mode === 'navigate' ? Object.defineProperty(r, 'mode', { value: 'navigate' }) : r
}
const answer = (r: Rig, req: Request) => r.worker.respond(req, (work) => r.extended.push(work))
const bodyOf = async (res: Response | null | undefined) => (res ? res.text() : null)

// files with names outside ASCII (a public/ folder can hold anything): the browser asks for them percent-encoded
const TR: Site = {
  files: { 'index.html': '<html>tr</html>', 'icons/ışık ŞŞ.png': 'png-bytes', 'assets/İstanbul-Yarısı.js': 'export default 1' },
  types: { 'icons/ışık ŞŞ.png': 'image/png' },
}

describe('files with names that are not ASCII', () => {
  it('are downloaded by their real names, stored, and answered from the cache for the percent-encoded request', async () => {
    const r = await rig(TR, 'cccccccccccc')
    await r.worker.install()
    expect(r.network.served.sort()).toEqual(Object.keys(TR.files).sort())
    const served = r.network.served.length
    const icon = await answer(r, request('/app/icons/%C4%B1%C5%9F%C4%B1k%20%C5%9E%C5%9E.png'))
    expect(icon?.headers.get('content-type')).toBe('image/png')
    expect(await bodyOf(icon)).toBe('png-bytes')
    expect(await bodyOf(await answer(r, request('/app/assets/%C4%B0stanbul-Yar%C4%B1s%C4%B1.js')))).toBe('export default 1')
    expect(r.network.served.length).toBe(served) // answered offline: nothing more was fetched
  })

  it('are recognised as already stored when an interrupted install is run again, so they are not downloaded twice', async () => {
    const first = await rig(TR, 'cccccccccccc')
    await first.worker.install()
    const again = await rig(TR, 'cccccccccccc', first.caches)
    await again.worker.install()
    expect(again.network.served).toEqual([])
  })
})

describe('install', () => {
  it('downloads every file of the build, bypassing the browser cache, and stores them under the build id', async () => {
    const r = await rig(V1, 'aaaaaaaaaaaa')
    await r.worker.install()
    const cache = r.caches.stores.get(precacheName('aaaaaaaaaaaa'))
    expect([...(cache?.files.keys() ?? [])].filter((u) => !u.endsWith(MARKER_PATH)).sort()).toEqual(Object.keys(V1.files).map((p) => `${SCOPE}${p}`).sort())
    expect(r.network.served.sort()).toEqual(Object.keys(V1.files).sort())
    expect(r.network.requests.every((req) => req.cache === 'reload')).toBe(true)
  })

  it('answers each file with the content type the build recorded, whatever the server said', async () => {
    const r = await rig(V1, 'aaaaaaaaaaaa')
    await r.worker.install()
    const cache = r.caches.stores.get(precacheName('aaaaaaaaaaaa'))
    expect((await cache?.match(`${SCOPE}icons/icon.png`))?.headers.get('content-type')).toBe('image/png')
    expect((await cache?.match(`${SCOPE}index.html`))?.headers.get('content-type')).toBe('text/html; charset=utf-8')
  })

  it('marks the cache complete only after every file is in, and records what the build held', async () => {
    const r = await rig(V1, 'aaaaaaaaaaaa')
    await r.worker.install()
    const marker = await r.caches.stores.get(precacheName('aaaaaaaaaaaa'))?.match(`${SCOPE}${MARKER_PATH}`)
    const parsed = JSON.parse((await marker?.text()) ?? 'null') as { version: string; manifest: PrecacheEntry[] }
    expect(parsed.version).toBe('aaaaaaaaaaaa')
    expect(parsed.manifest).toEqual(M1)
    expect(await r.worker.status()).toEqual({ version: 'aaaaaaaaaaaa', entries: 4, bytes: M1.reduce((n, e) => n + e.size, 0), complete: true })
  })

  it('fails the install, and leaves no completeness marker, when a file is missing on the server', async () => {
    const r = await rig(V1, 'aaaaaaaaaaaa')
    r.network.replace['assets/lazy-1.js'] = new Response('gone', { status: 404 })
    await expect(r.worker.install()).rejects.toThrow(/lazy-1\.js/)
    expect((await r.worker.status()).complete).toBe(false)
    expect(r.skipWaiting).not.toHaveBeenCalled()
  })

  it('refuses bytes that are not the build: a captive portal answering 200 with its own page', async () => {
    const r = await rig(V1, 'aaaaaaaaaaaa')
    r.network.replace['assets/app-1.js'] = new Response('<html>Sign in to the hotel Wi-Fi</html>', { status: 200, headers: { 'content-type': 'text/html' } })
    await expect(r.worker.install()).rejects.toThrow(/app-1\.js/)
    const cache = r.caches.stores.get(precacheName('aaaaaaaaaaaa'))
    expect(await cache?.match(`${SCOPE}assets/app-1.js`)).toBeUndefined()
    expect((await r.worker.status()).complete).toBe(false)
  })

  it('names a truncated download by its size, before any checksum is worked out', async () => {
    const r = await rig(V1, 'aaaaaaaaaaaa')
    r.network.replace['assets/app-1.js'] = new Response('console', { status: 200 })
    await expect(r.worker.install()).rejects.toThrow(/assets\/app-1\.js is 7 bytes, the build says 14/)
  })

  it('refuses a file of the right size whose contents differ', async () => {
    const r = await rig(V1, 'aaaaaaaaaaaa')
    r.network.replace['assets/app-1.js'] = new Response('console.log(9)', { status: 200 })
    await expect(r.worker.install()).rejects.toThrow(/do not match/)
  })

  it('refuses a redirect, which would store a page that is not the file', async () => {
    const r = await rig(V1, 'aaaaaaaaaaaa')
    r.network.replace['index.html'] = () => {
      const res = new Response(V1.files['index.html'], { status: 200 })
      Object.defineProperty(res, 'redirected', { value: true })
      return res
    }
    await expect(r.worker.install()).rejects.toThrow(/index\.html/)
  })

  it('fails when the network is down, so a device that is offline keeps the version it has', async () => {
    const r = await rig(V1, 'aaaaaaaaaaaa')
    r.network.offline = true
    await expect(r.worker.install()).rejects.toThrow()
    expect((await r.worker.status()).complete).toBe(false)
  })

  it('resumes after a failed attempt without downloading what is already stored', async () => {
    const caches = new FakeCaches()
    const first = await rig(V1, 'aaaaaaaaaaaa', caches, { concurrency: 1 })
    first.network.replace['icons/icon.png'] = new Response('x', { status: 500 })
    await expect(first.worker.install()).rejects.toThrow()
    const stored = [...(caches.stores.get(precacheName('aaaaaaaaaaaa'))?.files.keys() ?? [])].length
    expect(stored).toBeGreaterThan(0)

    const second = await rig(V1, 'aaaaaaaaaaaa', caches)
    await second.worker.install()
    expect(second.network.served.length).toBe(Object.keys(V1.files).length - stored)
    expect((await second.worker.status()).complete).toBe(true)
  })

  it('downloads at most `concurrency` files at once', async () => {
    const many: Site = { files: Object.fromEntries([['index.html', '<html></html>'], ...Array.from({ length: 12 }, (_, i) => [`assets/f${i}.js`, `// ${i}`])]) }
    const r = await rig(many, 'aaaaaaaaaaaa', new FakeCaches(), { concurrency: 3 })
    r.network.delayMs = 5
    await r.worker.install()
    expect(r.network.peak).toBeLessThanOrEqual(3)
    expect(r.network.peak).toBeGreaterThan(1)
  })

  it('takes over at once only when it replaces the retired v1 worker', async () => {
    const fresh = await rig(V1, 'aaaaaaaaaaaa')
    await fresh.worker.install()
    expect(fresh.skipWaiting).not.toHaveBeenCalled()

    const caches = new FakeCaches()
    await caches.open(LEGACY_CACHE)
    const upgrade = await rig(V1, 'aaaaaaaaaaaa', caches)
    await upgrade.worker.install()
    expect(upgrade.skipWaiting).toHaveBeenCalledTimes(1)
  })

  describe('an update', () => {
    async function installed() {
      const caches = new FakeCaches()
      const old = await rig(V1, 'aaaaaaaaaaaa', caches)
      await old.worker.install()
      return caches
    }

    it('downloads only what changed between builds', async () => {
      const caches = await installed()
      const next = await rig(V2, 'bbbbbbbbbbbb', caches)
      await next.worker.install()
      expect(next.network.served.sort()).toEqual(['assets/app-2.js', 'index.html'])
      const cache = caches.stores.get(precacheName('bbbbbbbbbbbb'))
      expect(await bodyOf(await cache?.match(`${SCOPE}assets/lazy-1.js`))).toBe(V1.files['assets/lazy-1.js'])
      expect(await bodyOf(await cache?.match(`${SCOPE}index.html`))).toBe(V2.files['index.html'])
      expect((await next.worker.status()).complete).toBe(true)
    })

    it('does not wait for the user: the new worker waits, the old one keeps serving its own version', async () => {
      const caches = await installed()
      const next = await rig(V2, 'bbbbbbbbbbbb', caches)
      await next.worker.install()
      expect(next.skipWaiting).not.toHaveBeenCalled()
      expect(await caches.has(precacheName('aaaaaaaaaaaa'))).toBe(true)
    })

    it('does not trust an older copy whose bytes no longer match, and downloads that file instead', async () => {
      const caches = await installed()
      const damaged = caches.stores.get(precacheName('aaaaaaaaaaaa'))
      await damaged?.put(`${SCOPE}assets/lazy-1.js`, new Response('corrupted!', { headers: { 'content-type': 'text/javascript' } }))
      const next = await rig(V2, 'bbbbbbbbbbbb', caches)
      await next.worker.install()
      expect(next.network.served).toContain('assets/lazy-1.js')
      expect(await bodyOf(await caches.stores.get(precacheName('bbbbbbbbbbbb'))?.match(`${SCOPE}assets/lazy-1.js`))).toBe(V1.files['assets/lazy-1.js'])
    })

    it('ignores an older cache whose marker was not written by a worker of that build', async () => {
      const caches = await installed()
      const forged = caches.stores.get(precacheName('aaaaaaaaaaaa'))
      await forged?.put(`${SCOPE}${MARKER_PATH}`, new Response(JSON.stringify({ version: 'zzzzzzzzzzzz', manifest: M1 })))
      const next = await rig(V2, 'bbbbbbbbbbbb', caches)
      await next.worker.install()
      expect(next.network.served).toContain('assets/lazy-1.js')
    })
  })
})

describe('activate', () => {
  it('deletes every other version of its own cache and the retired v1, and leaves foreign caches alone', async () => {
    const caches = new FakeCaches()
    const old = await rig(V1, 'aaaaaaaaaaaa', caches)
    await old.worker.install()
    await caches.open(LEGACY_CACHE)
    await caches.open('someone-elses-cache')
    const next = await rig(V2, 'bbbbbbbbbbbb', caches)
    await next.worker.install()
    await next.worker.activate()
    expect((await caches.keys()).sort()).toEqual([precacheName('bbbbbbbbbbbb'), 'someone-elses-cache'].sort())
  })

  it('takes control of the open pages, so they work offline without a reload', async () => {
    const r = await rig(V1, 'aaaaaaaaaaaa')
    await r.worker.install()
    await r.worker.activate()
    expect(r.claim).toHaveBeenCalledTimes(1)
  })

  it('does not need the network', async () => {
    const r = await rig(V1, 'aaaaaaaaaaaa')
    await r.worker.install()
    r.network.offline = true
    await expect(r.worker.activate()).resolves.toBeUndefined()
  })
})

describe('respond', () => {
  async function ready(site = V1, version = 'aaaaaaaaaaaa') {
    const r = await rig(site, version)
    await r.worker.install()
    await r.worker.activate()
    r.network.served.length = 0
    return r
  }

  it('answers files of the build from the cache, without the network', async () => {
    const r = await ready()
    const res = await answer(r, request('/app/assets/app-1.js'))
    expect(await bodyOf(res)).toBe(V1.files['assets/app-1.js'])
    expect(res?.headers.get('content-type')).toContain('javascript')
    expect(r.network.served).toEqual([])
  })

  it('answers the app shell for the scope root and for any page-like address', async () => {
    const r = await ready()
    expect(await bodyOf(await answer(r, request('/app/', {}, 'navigate')))).toBe(V1.files['index.html'])
    expect(await bodyOf(await answer(r, request('/app/?shared=1', {}, 'navigate')))).toBe(V1.files['index.html'])
    expect(await bodyOf(await answer(r, request('/app/some/where', {}, 'navigate')))).toBe(V1.files['index.html'])
    expect(r.network.served).toEqual([])
  })

  it('leaves requests that are not its business to the browser', async () => {
    const r = await ready()
    expect(answer(r, request('/app/assets/not-in-the-build.js'))).toBeNull()
    expect(answer(r, request('/app/assets/app-1.js', { method: 'POST', body: 'x' }))).toBeNull()
    expect(answer(r, request('/app/assets/app-1.js', { headers: { range: 'bytes=0-9' } }))).toBeNull()
    expect(answer(r, new Request('https://elsewhere.example/app/assets/app-1.js'))).toBeNull()
    expect(answer(r, request('/other/assets/app-1.js'))).toBeNull()
  })

  it('serves its own build only, never a file from an older version that happens to share the name', async () => {
    const caches = new FakeCaches()
    const old = await rig(V1, 'aaaaaaaaaaaa', caches)
    await old.worker.install()
    const next = await rig(V2, 'bbbbbbbbbbbb', caches)
    await next.worker.install()
    expect(await bodyOf(await answer(next, request('/app/', {}, 'navigate')))).toBe(V2.files['index.html'])
    expect(await bodyOf(await answer(old, request('/app/', {}, 'navigate')))).toBe(V1.files['index.html'])
  })

  it('opens with no network at all', async () => {
    const r = await ready()
    r.network.offline = true
    expect(await bodyOf(await answer(r, request('/app/', {}, 'navigate')))).toBe(V1.files['index.html'])
    expect(await bodyOf(await answer(r, request('/app/assets/lazy-1.js')))).toBe(V1.files['assets/lazy-1.js'])
  })

  it('goes to the network when its copy is gone, and quietly stores it again for next time', async () => {
    const r = await ready()
    await r.caches.delete(precacheName('aaaaaaaaaaaa'))
    const res = await answer(r, request('/app/assets/lazy-1.js'))
    expect(await bodyOf(res)).toBe(V1.files['assets/lazy-1.js'])
    await Promise.all(r.extended)
    expect((await r.worker.status()).complete).toBe(true)
    r.network.offline = true
    expect(await bodyOf(await answer(r, request('/app/assets/app-1.js')))).toBe(V1.files['assets/app-1.js'])
  })

  it('repairs once, however many requests find the copy missing', async () => {
    const r = await ready()
    await r.caches.delete(precacheName('aaaaaaaaaaaa'))
    await Promise.all([answer(r, request('/app/assets/lazy-1.js')), answer(r, request('/app/assets/app-1.js')), answer(r, request('/app/', {}, 'navigate'))])
    await Promise.all(r.extended)
    const downloads = r.network.served.filter((p) => p === 'icons/icon.png')
    expect(downloads).toHaveLength(1)
  })

  it('does not fail the page when the repair cannot download', async () => {
    const r = await ready()
    await r.caches.delete(precacheName('aaaaaaaaaaaa'))
    r.network.replace['icons/icon.png'] = new Response('', { status: 500 })
    const res = await answer(r, request('/app/assets/lazy-1.js'))
    expect(res?.status).toBe(200)
    await expect(Promise.all(r.extended)).resolves.toBeDefined()
  })
})

describe('status', () => {
  it('is incomplete before the first install, and does not create the cache just to look', async () => {
    const r = await rig(V1, 'aaaaaaaaaaaa')
    expect(await r.worker.status()).toMatchObject({ version: 'aaaaaaaaaaaa', entries: 4, complete: false })
    expect(await r.caches.has(precacheName('aaaaaaaaaaaa'))).toBe(false)
  })
})

describe('message', () => {
  it('skips waiting when asked to, which is how the page applies an update', async () => {
    const r = await rig(V1, 'aaaaaaaaaaaa')
    expect(await r.worker.message({ type: 'skip-waiting' })).toBeUndefined()
    expect(r.skipWaiting).toHaveBeenCalledTimes(1)
  })

  it('reports its status', async () => {
    const r = await rig(V1, 'aaaaaaaaaaaa')
    await r.worker.install()
    expect(await r.worker.message({ type: 'status' })).toMatchObject({ version: 'aaaaaaaaaaaa', complete: true })
  })

  it.each([[null], [undefined], ['skip-waiting'], [42], [{}], [{ type: 'format-disk' }], [{ type: ['skip-waiting'] }]])('ignores %j', async (data) => {
    const r = await rig(V1, 'aaaaaaaaaaaa')
    expect(await r.worker.message(data)).toBeUndefined()
    expect(r.skipWaiting).not.toHaveBeenCalled()
  })
})

describe('createWorker', () => {
  it('refuses a manifest that could point outside the build', async () => {
    await expect(rig({ files: { 'index.html': 'x', '../escape.js': 'y' } }, 'aaaaaaaaaaaa')).rejects.toThrow(/escape\.js/)
  })

  it('refuses a manifest without the app shell, since every page load would then miss', async () => {
    await expect(rig({ files: { 'assets/a.js': 'x' } }, 'aaaaaaaaaaaa')).rejects.toThrow(/index\.html/)
  })

  it('refuses a manifest that lists a file twice', async () => {
    const { env } = await rig(V1, 'aaaaaaaaaaaa')
    expect(() => createWorker({ ...env, manifest: [...M1, ...M1.slice(0, 1)] })).toThrow(/twice/)
  })

  it('refuses a version that is not a usable cache name', async () => {
    await expect(rig(V1, 'not a version')).rejects.toThrow()
  })
})

describe('protocol', () => {
  it('accepts exactly the two messages the worker understands', () => {
    expect(parseMessage({ type: 'skip-waiting' })).toEqual({ type: 'skip-waiting' })
    expect(parseMessage({ type: 'status', extra: 1 })).toEqual({ type: 'status' })
    expect(parseMessage({ type: 'nope' })).toBeNull()
    expect(parseMessage(null)).toBeNull()
    expect(parseMessage('status')).toBeNull()
  })

  it('reads a status reply and rejects a malformed one', () => {
    const ok = { version: 'abc', entries: 3, bytes: 100, complete: true }
    expect(parseStatus(ok)).toEqual(ok)
    expect(parseStatus({ ...ok, entries: -1 })).toBeNull()
    expect(parseStatus({ ...ok, entries: 1.5 })).toBeNull()
    expect(parseStatus({ ...ok, bytes: Number.NaN })).toBeNull()
    expect(parseStatus({ ...ok, complete: 'yes' })).toBeNull()
    expect(parseStatus({ ...ok, version: 3 })).toBeNull()
    expect(parseStatus(undefined)).toBeNull()
  })
})
