/**
 * The service worker's entry point: it only connects the browser's worker events to `createWorker`, which holds the logic
 * (and is tested without a browser). `scripts/precache.mjs` bundles this file into `dist/sw.js` after every build, with the
 * build's file list compiled in.
 */
import { createWorker } from '../src/lib/offline/worker'
import type { PrecacheEntry } from '../src/lib/offline/precache'

// replaced by the bundler with the build id and the list of the build's files
declare const __PRECACHE_VERSION__: string
declare const __PRECACHE_MANIFEST__: readonly PrecacheEntry[]

const sw = self as unknown as ServiceWorkerGlobalScope

const worker = createWorker({
  version: __PRECACHE_VERSION__,
  manifest: __PRECACHE_MANIFEST__,
  scope: sw.registration.scope,
  caches: sw.caches,
  fetch: (request) => sw.fetch(request),
  skipWaiting: () => sw.skipWaiting(),
  claim: () => sw.clients.claim(),
})

sw.addEventListener('install', (event) => event.waitUntil(worker.install()))
sw.addEventListener('activate', (event) => event.waitUntil(worker.activate()))

sw.addEventListener('fetch', (event) => {
  const answer = worker.respond(event.request, (work) => event.waitUntil(work))
  if (answer) event.respondWith(answer)
})

// a page asks the worker something over a MessageChannel (`status`) or tells it to take over (`skip-waiting`)
sw.addEventListener('message', (event) => {
  const reply = event.ports[0]
  event.waitUntil(
    worker.message(event.data).then((result) => {
      if (result && reply) reply.postMessage(result)
    }),
  )
})
