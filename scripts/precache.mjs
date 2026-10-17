// The build-time half of the offline copy. After `vite build` has written dist/, this lists every file the app is made of,
// records its size and checksum, derives a build id from that list, and bundles the service worker (sw/sw.ts) with the
// list compiled in. The worker then installs exactly these bytes and nothing else (see src/lib/offline/worker.ts).
// Build tooling only: the app in src/ never imports this.
import { createHash } from 'node:crypto'
import { readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

/** The worker's file name. It stays at the top of the output folder: where a worker lives is the scope it controls. */
export const WORKER_FILE = 'sw.js'
/** A readable record of the build for tools and tests. The worker has its own copy compiled in, so this is not cached. */
export const MANIFEST_FILE = 'precache-manifest.json'
/** Bump when the layout of a cache changes: it is part of the build id, so every device then starts a fresh cache. */
export const CACHE_FORMAT = 1

const ROOT = fileURLToPath(new URL('..', import.meta.url))

/** The Content-Type each kind of file is answered with offline. A kind missing here fails the build rather than being guessed. */
const TYPES = {
  html: 'text/html; charset=utf-8',
  js: 'text/javascript; charset=utf-8',
  mjs: 'text/javascript; charset=utf-8',
  css: 'text/css; charset=utf-8',
  json: 'application/json',
  webmanifest: 'application/manifest+json',
  svg: 'image/svg+xml',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  avif: 'image/avif',
  ico: 'image/x-icon',
  woff: 'font/woff',
  woff2: 'font/woff2',
  ttf: 'font/ttf',
  otf: 'font/otf',
  wasm: 'application/wasm',
  txt: 'text/plain; charset=utf-8',
}

/** @param {string} url path relative to dist/ @returns {string | null} */
export function mimeFor(url) {
  const name = url.slice(url.lastIndexOf('/') + 1)
  const dot = name.lastIndexOf('.')
  return dot < 0 ? null : (TYPES[/** @type {keyof typeof TYPES} */ (name.slice(dot + 1).toLowerCase())] ?? null)
}

/** Files of the build the worker does not store: itself, the record of the build, source maps, robots.txt and dotfiles. */
export function isExcluded(/** @type {string} */ url) {
  return url === WORKER_FILE || url === MANIFEST_FILE || url === 'robots.txt' || url.endsWith('.map') || url.split('/').some((part) => part.startsWith('.'))
}

/** The first 32 hex digits of the SHA-256 of `bytes`: what the worker checks every download against. */
export function hashBytes(/** @type {Uint8Array} */ bytes) {
  return createHash('sha256').update(bytes).digest('hex').slice(0, 32)
}

/** Every file below `dir` as a posix path relative to it, sorted. */
export function listFiles(/** @type {string} */ dir, prefix = '') {
  /** @type {string[]} */
  const found = []
  for (const entry of readdirSync(join(dir, prefix), { withFileTypes: true })) {
    const path = prefix ? `${prefix}/${entry.name}` : entry.name
    if (entry.isDirectory()) found.push(...listFiles(dir, path))
    else if (entry.isFile()) found.push(path)
  }
  return found.sort()
}

// a name the worker can address with a plain URL: letters, marks and digits of any script (a URL carries them percent-encoded,
// and the worker decodes the request back to the name), a space and the punctuation that means nothing in a path. No query or
// fragment characters, no percent signs, and none of the invisible or direction-changing characters a name could hide behind.
const SAFE_NAME = /^[\p{L}\p{M}\p{N}_./ @+~()-]+$/u

/**
 * The files the worker stores, with their size, checksum and content type, sorted by path.
 * @returns {{ url: string, size: number, hash: string, type: string }[]}
 */
export function buildManifest(/** @type {string} */ dir) {
  const entries = []
  const unknown = []
  const unsafe = []
  for (const url of listFiles(dir)) {
    if (isExcluded(url)) continue
    if (!SAFE_NAME.test(url)) {
      unsafe.push(url)
      continue
    }
    const type = mimeFor(url)
    if (!type) {
      unknown.push(url)
      continue
    }
    const bytes = readFileSync(join(dir, url))
    entries.push({ url, size: bytes.length, hash: hashBytes(bytes), type })
  }
  if (unsafe.length) throw new Error(`These files have names a URL cannot carry safely: ${unsafe.join(', ')}`)
  if (unknown.length) {
    throw new Error(`No content type is known for: ${unknown.join(', ')}. Add the extension to TYPES in scripts/precache.mjs (and to assetRule() in scripts/csp.mjs).`)
  }
  if (!entries.some((entry) => entry.url === 'index.html')) throw new Error(`${dir} has no index.html: nothing to open offline`)
  return entries
}

/**
 * The build id: 12 hex digits that change when, and only when, any file's name, bytes or content type changes (or the
 * cache layout does). The same sources always give the same id, so an unchanged release never asks anyone to update.
 */
export function versionOf(/** @type {readonly { url: string, hash: string, type: string }[]} */ manifest, format = CACHE_FORMAT) {
  const hash = createHash('sha256').update(`format:${format}\n`)
  for (const entry of [...manifest].sort((a, b) => (a.url < b.url ? -1 : a.url > b.url ? 1 : 0))) hash.update(`${entry.url}\0${entry.hash}\0${entry.type}\n`)
  return hash.digest('hex').slice(0, 12)
}

/** Bundle sw/sw.ts into `distDir/sw.js` as one classic script, with the build id and file list compiled in. */
export async function buildWorker({ distDir, manifest, version, root = ROOT }) {
  const { build } = await import('vite')
  await build({
    root,
    configFile: false,
    publicDir: false,
    logLevel: 'warn',
    define: { __PRECACHE_VERSION__: JSON.stringify(version), __PRECACHE_MANIFEST__: JSON.stringify(manifest) },
    build: {
      outDir: distDir,
      emptyOutDir: false,
      copyPublicDir: false,
      minify: true,
      sourcemap: false,
      target: 'es2020',
      reportCompressedSize: false,
      lib: { entry: resolve(root, 'sw/sw.ts'), formats: ['iife'], name: 'wavelocalWorker', fileName: () => WORKER_FILE },
    },
  })
}

/**
 * Turn a finished build into an installable offline copy: list its files, derive the build id, write the worker and the
 * readable record. Run it again after any change to dist/ (it ignores its own earlier output).
 */
export async function injectServiceWorker({ distDir, root = ROOT }) {
  const manifest = buildManifest(distDir)
  const version = versionOf(manifest)
  await buildWorker({ distDir, manifest, version, root })
  writeFileSync(join(distDir, MANIFEST_FILE), `${JSON.stringify({ version, format: CACHE_FORMAT, entries: manifest }, null, 2)}\n`)
  return { version, manifest }
}
