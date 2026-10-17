import { LEGACY_CACHE, MARKER_PATH, SHELL, isPrecacheCache, isSafeEntryUrl, parseMarker, planInstall, precacheName, routeRequest, staleCaches } from './precache'
import type { PrecacheEntry, PrecacheMarker, PreviousVersion } from './precache'
import { parseMessage } from './protocol'
import type { WorkerStatus } from './protocol'

/**
 * The offline copy of the app, as a service worker uses it: a build's files are downloaded, checked against the bytes the
 * build recorded and stored under the build's own cache; requests are answered from that cache; older builds are
 * deleted when a new one takes over. Everything the browser provides (`caches`, `fetch`, `skipWaiting`, `claim`) is passed
 * in, so the whole behaviour is tested with an in-memory cache and a scripted network. `sw/sw.ts` wires it to the real thing.
 */

export interface WorkerEnv {
  /** The build id this worker was made for. */
  version: string
  /** Every file of the build. */
  manifest: readonly PrecacheEntry[]
  /** The worker's scope as an absolute URL ending in "/". */
  scope: string
  caches: CacheStorage
  fetch: (request: Request) => Promise<Response>
  skipWaiting: () => Promise<void>
  /** Take control of the pages that are already open. */
  claim: () => Promise<void>
  /** Files downloaded at the same time while installing. */
  concurrency?: number
}

export interface OfflineWorker {
  /** Download and store the build; rejects (so the install fails and the old version stays) if any file is not what the build recorded. */
  install(): Promise<void>
  /** Delete every older build's cache and take control of the open pages. */
  activate(): Promise<void>
  /**
   * The answer to a request, or null when it is not for this worker to answer (the browser then handles it as usual).
   * `extend` keeps the worker alive for work that outlives the answer.
   */
  respond(request: Request, extend: (work: Promise<unknown>) => void): Promise<Response> | null
  /** Handle a message from a page; resolves with the reply, if there is one. */
  message(data: unknown): Promise<WorkerStatus | undefined>
  status(): Promise<WorkerStatus>
}

const DEFAULT_CONCURRENCY = 4

const toHex = (bytes: Uint8Array): string => Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')

/** The first 32 hex digits of the SHA-256 of `bytes`: what the build records for each file. */
async function digest(bytes: ArrayBuffer): Promise<string> {
  return toHex(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))).slice(0, 32)
}

/** Run the tasks, `limit` at a time; after the first failure no new task starts, and that failure is thrown once the running ones end. */
async function runLimited(tasks: readonly (() => Promise<void>)[], limit: number): Promise<void> {
  let next = 0
  let failure: { error: unknown } | null = null
  const lane = async (): Promise<void> => {
    while (!failure) {
      const task = tasks[next++]
      if (!task) return
      try {
        await task()
      } catch (error) {
        failure = { error }
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(Math.max(1, limit), tasks.length) }, lane))
  if (failure) throw (failure as { error: unknown }).error
}

export function createWorker(env: WorkerEnv): OfflineWorker {
  const { version, manifest, scope } = env
  const current = precacheName(version)
  const keys = new Set<string>()
  for (const entry of manifest) {
    if (!isSafeEntryUrl(entry.url)) throw new Error(`The build lists a file outside its folder: ${entry.url}`)
    if (keys.has(entry.url)) throw new Error(`The build lists ${entry.url} twice`)
    keys.add(entry.url)
  }
  if (!keys.has(SHELL)) throw new Error(`The build has no ${SHELL}, so no page could be opened offline`)

  const where = (path: string): string => new URL(path, scope).href
  const markerUrl = where(MARKER_PATH)
  const byUrl = new Map(manifest.map((entry) => [where(entry.url), entry.url]))
  const bytesTotal = manifest.reduce((sum, entry) => sum + entry.size, 0)

  async function readMarker(cache: Cache): Promise<PrecacheMarker | null> {
    const stored = await cache.match(markerUrl)
    return stored ? parseMarker(await stored.text()) : null
  }

  /** The complete older builds, for copying files that did not change. A marker that does not belong to its cache is ignored. */
  async function previousVersions(): Promise<PreviousVersion[]> {
    const found: PreviousVersion[] = []
    for (const name of await env.caches.keys()) {
      if (!isPrecacheCache(name) || name === current) continue
      const marker = await readMarker(await env.caches.open(name))
      if (marker && precacheName(marker.version) === name) found.push({ name, manifest: marker.manifest })
    }
    return found
  }

  async function verify(entry: PrecacheEntry, bytes: ArrayBuffer): Promise<void> {
    if (bytes.byteLength !== entry.size) throw new Error(`${entry.url} is ${bytes.byteLength} bytes, the build says ${entry.size}`)
    if ((await digest(bytes)) !== entry.hash) throw new Error(`The contents of ${entry.url} do not match the build`)
  }

  async function download(entry: PrecacheEntry): Promise<ArrayBuffer> {
    // `reload` skips the HTTP cache: a stale copy there must not end up in a new build's cache
    const response = await env.fetch(new Request(where(entry.url), { cache: 'reload', credentials: 'same-origin' }))
    if (response.status !== 200 || response.redirected || (response.type !== 'basic' && response.type !== 'default')) {
      throw new Error(`${entry.url} could not be downloaded (status ${response.status})`)
    }
    const bytes = await response.arrayBuffer()
    await verify(entry, bytes)
    return bytes
  }

  async function copy(entry: PrecacheEntry, from: string): Promise<ArrayBuffer | null> {
    const stored = await (await env.caches.open(from)).match(where(entry.url))
    if (!stored) return null
    const bytes = await stored.arrayBuffer()
    try {
      await verify(entry, bytes)
    } catch {
      return null
    }
    return bytes
  }

  async function run(): Promise<void> {
    const cache = await env.caches.open(current)
    const have = new Set<string>()
    for (const stored of await cache.keys()) {
      const key = byUrl.get(stored.url)
      if (key) have.add(key)
    }
    const plan = planInstall(manifest, await previousVersions(), have)
    const store = (entry: PrecacheEntry, bytes: ArrayBuffer) =>
      cache.put(where(entry.url), new Response(bytes, { status: 200, headers: { 'content-type': entry.type } }))
    const tasks = [
      ...plan.reuse.map(({ entry, from }) => async () => store(entry, (await copy(entry, from)) ?? (await download(entry)))),
      ...plan.fetch.map((entry) => async () => store(entry, await download(entry))),
    ]
    await runLimited(tasks, env.concurrency ?? DEFAULT_CONCURRENCY)
    // last: its presence means every file above is stored
    const marker: PrecacheMarker = { version, manifest }
    await cache.put(markerUrl, new Response(JSON.stringify(marker), { headers: { 'content-type': 'application/json' } }))
  }

  // one run at a time: an install, and requests that find the copy missing, share the same download
  let running: Promise<void> | null = null
  const precache = (): Promise<void> => (running ??= run().finally(() => (running = null)))

  async function status(): Promise<WorkerStatus> {
    // look without creating: an empty cache named after this build would read as "installed" to the next check
    const cache = (await env.caches.has(current)) ? await env.caches.open(current) : null
    const marker = cache ? await readMarker(cache) : null
    return { version, entries: manifest.length, bytes: bytesTotal, complete: marker?.version === version }
  }

  async function answer(key: string, request: Request, extend: (work: Promise<unknown>) => void): Promise<Response> {
    const hit = await env.caches.match(where(key), { cacheName: current })
    if (hit) return hit
    // the browser dropped our copy (storage was cleared or evicted): serve this request from the network, and fill the cache again
    extend(precache().catch(() => {}))
    return env.fetch(request)
  }

  return {
    async install() {
      await precache()
      // the retired static worker kept its pages on v1 and swapped itself in at once; replacing it the same way avoids
      // asking for a reload that would show nothing new, since a page it served was loaded from the network
      if (await env.caches.has(LEGACY_CACHE)) await env.skipWaiting()
    },

    async activate() {
      const stale = staleCaches(await env.caches.keys(), current)
      await Promise.all(stale.map((name) => env.caches.delete(name)))
      await env.claim()
    },

    respond(request, extend) {
      const route = routeRequest({ url: request.url, method: request.method, mode: request.mode, range: request.headers.has('range') }, scope, keys)
      return route ? answer(route.key, request, extend) : null
    },

    async message(data) {
      const message = parseMessage(data)
      if (message?.type === 'skip-waiting') {
        await env.skipWaiting()
        return undefined
      }
      return message?.type === 'status' ? status() : undefined
    },

    status,
  }
}
