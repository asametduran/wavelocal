/**
 * The pure decisions behind the offline copy of the app: how a build is named in Cache Storage, which request is answered
 * from which file, and what an install still has to download. No I/O here, so all of it is tested without a browser;
 * `worker.ts` does the I/O and `sw/sw.ts` runs it inside the service worker.
 *
 * Every build gets its own cache (`wavelocal-precache-<version>`), filled completely before it is used and marked complete
 * by a record written last. Old versions are deleted when a new one takes over.
 */

/** One file of the build, as the service worker's manifest lists it. */
export interface PrecacheEntry {
  /** Path relative to the worker's scope: `index.html`, `assets/index-4f2a.js`. */
  url: string
  /** Size in bytes. */
  size: number
  /** SHA-256 of the bytes, first 32 hex digits. */
  hash: string
  /** The Content-Type the file is answered with. */
  type: string
}

/** What a complete cache records about itself. It is written last, so its presence means every file is stored. */
export interface PrecacheMarker {
  version: string
  manifest: readonly PrecacheEntry[]
}

export const CACHE_PREFIX = 'wavelocal-'
const PRECACHE_PREFIX = `${CACHE_PREFIX}precache-`
/** The cache of the first, static service worker. Nothing writes it any more; it is deleted. */
export const LEGACY_CACHE = 'wavelocal-v1'
/** The document every page-like navigation is answered with. */
export const SHELL = 'index.html'
/** Where a cache keeps its marker. Not a file of the build and not reachable by any request. */
export const MARKER_PATH = '__wavelocal-precache__'

const VERSION = /^[\w.-]{1,64}$/
const HASH = /^[0-9a-f]{32}$/
const CONTENT_TYPE = /^[a-z]+\/[a-z0-9.+-]+(?:; charset=[a-z0-9-]+)?$/i
const MAX_ENTRY_BYTES = 2 ** 31 - 1

export function precacheName(version: string): string {
  if (!VERSION.test(version)) throw new Error(`Not a usable build id: ${JSON.stringify(version)}`)
  return `${PRECACHE_PREFIX}${version}`
}

export const isOwnCache = (name: string): boolean => name.startsWith(CACHE_PREFIX)
export const isPrecacheCache = (name: string): boolean => name.startsWith(PRECACHE_PREFIX)

/** The caches to delete once `current` takes over: all other caches of this app (older builds, the retired v1), nobody else's. */
export function staleCaches(names: readonly string[], current: string): string[] {
  return names.filter((name) => isOwnCache(name) && name !== current)
}

/** A relative path of the build that cannot point anywhere else: no scheme, no dot segments, no query. */
export function isSafeEntryUrl(url: string): boolean {
  if (!url || url.length > 512 || url.startsWith('/') || url.endsWith('/')) return false
  if (/[\\?#:\u0000-\u001f]/.test(url)) return false
  return url.split('/').every((part) => part !== '' && part !== '.' && part !== '..')
}

export interface RouteInput {
  url: string
  method: string
  /** `Request.mode`: `navigate` for a page load. */
  mode: string
  /** The request carries a `Range` header. */
  range?: boolean
}

/**
 * Which file of the build answers a request: its `key` (an entry's `url`), or null to leave the request to the network.
 * Only plain GETs inside the worker's scope are answered. A page-like navigation (no file extension) gets the app shell,
 * so the app opens from any address offline.
 */
export function routeRequest(request: RouteInput, scope: string, keys: ReadonlySet<string>): { key: string } | null {
  if (request.method !== 'GET' || request.range) return null
  let url: URL
  let base: URL
  try {
    url = new URL(request.url)
    base = new URL(scope)
  } catch {
    return null
  }
  if (url.origin !== base.origin || !url.pathname.startsWith(base.pathname)) return null
  let path: string
  try {
    path = decodeURIComponent(url.pathname.slice(base.pathname.length))
  } catch {
    return null
  }
  if (path === '') return { key: SHELL }
  if (keys.has(path)) return { key: path }
  const name = path.slice(path.lastIndexOf('/') + 1)
  if (request.mode === 'navigate' && !name.includes('.')) return { key: SHELL }
  return null
}

/** An older build's cache and the files it holds. */
export interface PreviousVersion {
  name: string
  manifest: readonly PrecacheEntry[]
}

export interface InstallPlan {
  /** Already stored by an earlier, interrupted attempt of this very build. */
  keep: string[]
  /** Identical bytes in an older build's cache: copied, not downloaded. */
  reuse: { entry: PrecacheEntry; from: string }[]
  /** Everything else is downloaded. */
  fetch: PrecacheEntry[]
}

/** What an install has to do for each file, so a release that changes three files downloads three files. */
export function planInstall(manifest: readonly PrecacheEntry[], previous: readonly PreviousVersion[], have: ReadonlySet<string>): InstallPlan {
  const plan: InstallPlan = { keep: [], reuse: [], fetch: [] }
  const older = previous.map((version) => ({ name: version.name, files: new Map(version.manifest.map((entry) => [entry.url, entry])) }))
  for (const entry of manifest) {
    if (have.has(entry.url)) {
      plan.keep.push(entry.url)
      continue
    }
    const source = older.find((version) => {
      const stored = version.files.get(entry.url)
      return stored !== undefined && stored.hash === entry.hash && stored.size === entry.size
    })
    if (source) plan.reuse.push({ entry, from: source.name })
    else plan.fetch.push(entry)
  }
  return plan
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value)

function asEntry(value: unknown): PrecacheEntry | null {
  if (!isRecord(value)) return null
  const { url, size, hash, type } = value
  if (typeof url !== 'string' || !isSafeEntryUrl(url)) return null
  if (typeof size !== 'number' || !Number.isInteger(size) || size < 0 || size > MAX_ENTRY_BYTES) return null
  if (typeof hash !== 'string' || !HASH.test(hash)) return null
  if (typeof type !== 'string' || !CONTENT_TYPE.test(type)) return null
  return { url, size, hash, type }
}

/** Read a stored marker. Anything that is not exactly what the worker writes is null, so a damaged cache is never trusted. */
export function parseMarker(text: string): PrecacheMarker | null {
  let data: unknown
  try {
    data = JSON.parse(text)
  } catch {
    return null
  }
  if (!isRecord(data) || typeof data.version !== 'string' || !VERSION.test(data.version) || !Array.isArray(data.manifest)) return null
  const seen = new Set<string>()
  const manifest: PrecacheEntry[] = []
  for (const raw of data.manifest as unknown[]) {
    const entry = asEntry(raw)
    if (!entry || seen.has(entry.url)) return null
    seen.add(entry.url)
    manifest.push(entry)
  }
  return { version: data.version, manifest }
}
