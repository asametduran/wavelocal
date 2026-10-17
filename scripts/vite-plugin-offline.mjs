// Vite plugins for the production build only (the dev server and the tests are untouched):
//  - the Content-Security-Policy <meta> tag in index.html (policy and checks: csp.mjs)
//  - the offline service worker with the build's file list compiled in (precache.mjs)
import { resolve } from 'node:path'
import { injectCsp } from './csp.mjs'
import { injectServiceWorker } from './precache.mjs'

export function offline() {
  let root = ''
  let distDir = ''
  let failed = false
  return [
    {
      name: 'wavelocal:csp',
      apply: 'build',
      transformIndexHtml: { order: 'post', handler: (/** @type {string} */ html) => injectCsp(html) },
    },
    {
      name: 'wavelocal:service-worker',
      apply: 'build',
      configResolved(/** @type {{ root: string, build: { outDir: string } }} */ config) {
        root = config.root
        distDir = resolve(config.root, config.build.outDir)
      },
      buildEnd(/** @type {unknown} */ error) {
        failed = Boolean(error)
      },
      // after the bundle and the public/ files are written: the worker's file list is whatever is really in dist/
      async closeBundle() {
        if (failed) return
        const { version, manifest } = await injectServiceWorker({ distDir, root })
        const kb = manifest.reduce((sum, entry) => sum + entry.size, 0) / 1024
        console.log(`offline copy: ${manifest.length} files, ${kb.toFixed(0)} kB, build ${version}`)
      },
    },
  ]
}
