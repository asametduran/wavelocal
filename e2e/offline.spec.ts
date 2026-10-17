import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { expect, test } from '@playwright/test'
import type { Page } from '@playwright/test'
import { PlayerPage, denyNativeLossless, flac, installAudioProbe, installPolicyWatch, tone } from './helpers'
import { startSite } from './staticServer'
import type { Site } from './staticServer'
import { injectServiceWorker } from '../scripts/precache.mjs'

// The offline copy, against a real server that the tests can switch off, replace and sabotage, in a real browser with
// its service worker running (the other specs block service workers so that nothing is cached between tests).
test.use({ serviceWorkers: 'allow' })

const DIST = fileURLToPath(new URL('../dist', import.meta.url))

interface Release {
  version: string
  entries: { url: string; size: number }[]
}
const releaseOf = (dir: string): Release => JSON.parse(readFileSync(join(dir, 'precache-manifest.json'), 'utf8')) as Release

/** The service worker the app shipped before the offline copy was versioned, as people still have it installed. */
const RETIRED_WORKER = `/* Wavelocal service worker: app-shell caching so the player installs and runs offline.
   User audio never touches the network or this cache (it lives in memory as blob: URLs). */
const CACHE = 'wavelocal-v1'
const SHELL = ['./', './manifest.webmanifest', './favicon.svg', './icons/icon-192.png', './icons/icon-512.png']

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()))
})

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim()),
  )
})

self.addEventListener('fetch', (event) => {
  const req = event.request
  const url = new URL(req.url)
  if (req.method !== 'GET' || url.origin !== self.location.origin) return
  if (req.mode === 'navigate') {
    event.respondWith(
      fetch(req)
        .then((res) => {
          const copy = res.clone()
          caches.open(CACHE).then((c) => c.put('./', copy))
          return res
        })
        .catch(() => caches.match('./')),
    )
    return
  }
  event.respondWith(
    caches.match(req).then((hit) => {
      const net = fetch(req)
        .then((res) => {
          if (res.ok) {
            const copy = res.clone()
            caches.open(CACHE).then((c) => c.put(req, copy))
          }
          return res
        })
        .catch(() => hit)
      return hit || net
    }),
  )
})
`

const folders: string[] = []
const scratch = (): string => {
  const dir = mkdtempSync(join(tmpdir(), 'wavelocal-site-'))
  folders.push(dir)
  return dir
}

/** The next release: the same app with one more tag in the page, built the way the real build builds it. */
let next: { dir: string; version: string }
test.beforeAll(async () => {
  test.setTimeout(120_000)
  const dir = scratch()
  cpSync(DIST, dir, { recursive: true })
  writeFileSync(join(dir, 'index.html'), readFileSync(join(dir, 'index.html'), 'utf8').replace('</head>', '<meta name="x-release" content="two" /></head>'))
  const { version } = await injectServiceWorker({ distDir: dir })
  next = { dir, version }
})
test.afterAll(() => {
  for (const dir of folders) rmSync(dir, { recursive: true, force: true })
})

let site: Site
test.afterEach(async () => {
  await site?.close()
})

/** Open the app from `from` and wait for it to be ready. */
async function visit(page: Page, from: Site): Promise<PlayerPage> {
  const app = new PlayerPage(page)
  await installAudioProbe(page)
  await installPolicyWatch(page)
  await page.goto(`${from.origin}/`)
  await expect(app.viewSelect).toBeVisible()
  return app
}

const controlled = (page: Page) => expect.poll(() => page.evaluate(() => navigator.serviceWorker.controller !== null), { timeout: 20_000 }).toBe(true)
// these are polled while the app reloads itself after an update: a page that is going away answers nothing, which is not an error
const cacheNames = async (page: Page): Promise<string[]> => (await page.evaluate(() => caches.keys()).catch(() => [] as string[])).sort()
const cacheSizes = (page: Page) =>
  page
    .evaluate(async () => Object.fromEntries(await Promise.all((await caches.keys()).map(async (name) => [name, (await (await caches.open(name)).keys()).length] as const))))
    .catch(() => ({}) as Record<string, number>)
const release = (page: Page): Promise<string | null> =>
  page.evaluate(() => document.querySelector('meta[name="x-release"]')?.getAttribute('content') ?? null).catch(() => null)

/** Wait until the whole of `version` is saved (every file, plus the record that says so). */
async function saved(page: Page, version: string, files: number): Promise<void> {
  await expect.poll(() => cacheSizes(page), { timeout: 20_000 }).toMatchObject({ [`wavelocal-precache-${version}`]: files + 1 })
}

test.describe('the offline copy', () => {
  test('saves the whole app the first time it is opened', async ({ page }) => {
    site = await startSite(DIST)
    const app = await visit(page, site)
    await controlled(page)
    const one = releaseOf(DIST)
    await saved(page, one.version, one.entries.length)
    expect(await cacheNames(page)).toEqual([`wavelocal-precache-${one.version}`])
    expect(await page.evaluate(() => navigator.serviceWorker.controller?.scriptURL)).toBe(`${site.origin}/sw.js`)
    expect(await app.policyViolations()).toEqual([])
  })

  test('opens with no network at all, with the library where it was', async ({ page }) => {
    site = await startSite(DIST)
    const app = await visit(page, site)
    await controlled(page)
    const one = releaseOf(DIST)
    await saved(page, one.version, one.entries.length)
    await app.importFiles(tone('01-offline.wav', 2))
    await expect(app.rows).toHaveCount(1)
    await expect.poll(() => app.storedTracks()).toHaveLength(1)

    await site.down()
    await page.reload()
    await expect(app.viewSelect).toBeVisible()
    await expect(app.rows).toHaveCount(1)
    await app.play('01-offline')
    await app.expectPlaying()
    expect(await app.policyViolations()).toEqual([])
  })

  test('has panels and the decoder that were never opened while online', async ({ page }) => {
    await denyNativeLossless(page) // FLAC then goes through the decoder worker, a separate file
    site = await startSite(DIST)
    const app = await visit(page, site)
    await controlled(page)
    const one = releaseOf(DIST)
    await saved(page, one.version, one.entries.length)

    await site.down()
    await page.reload()
    await expect(app.viewSelect).toBeVisible()
    await app.importFiles(flac('tone-440', '01-lossless.flac'))
    await expect(app.rows).toHaveCount(1)
    await app.play('01-lossless')
    await app.expectPlaying()
    expect(await app.workerCount()).toBeGreaterThan(0)

    await app.openTools()
    await expect(app.tools.getByRole('region', { name: 'Storage' })).toBeVisible()
    await expect(app.tools.getByRole('group', { name: 'Offline copy of the app' })).toContainText(`Ready: all ${one.entries.length} files`)

    // and every file of the build can be had without the network
    const missing = await page.evaluate(async (urls) => {
      const bad: string[] = []
      for (const url of urls) {
        try {
          if (!(await fetch(url)).ok) bad.push(url)
        } catch {
          bad.push(url)
        }
      }
      return bad
    }, one.entries.map((entry) => entry.url))
    expect(missing).toEqual([])
  })
})

test.describe('updates', () => {
  async function checkForUpdates(app: PlayerPage): Promise<void> {
    if (!(await app.tools.isVisible())) await app.openTools() // the footer is inert while the panel is open
    await app.tools.getByRole('button', { name: 'Check for updates' }).click()
  }

  test('a new release is offered, not forced; it downloads only what changed; the old copy goes when it takes over', async ({ page }) => {
    site = await startSite(DIST)
    const app = await visit(page, site)
    await controlled(page)
    const one = releaseOf(DIST)
    await saved(page, one.version, one.entries.length)
    await app.importFiles(tone('01-kept.wav', 2))
    await expect(app.rows).toHaveCount(1)
    await expect.poll(() => app.storedTracks()).toHaveLength(1)
    // leftovers: the cache of an older build that never finished, and one that is not ours
    await page.evaluate(async () => {
      await caches.open('wavelocal-precache-deadbeef0000')
      await caches.open('someone-elses-cache')
    })

    site.serve(next.dir)
    site.forget()
    await checkForUpdates(app)
    await expect(app.toast(/new version of Wavelocal is ready/i)).toBeVisible({ timeout: 20_000 })
    await expect(app.tools.getByRole('group', { name: 'Offline copy of the app' })).toContainText('A new version is ready')

    // still the old release, and both copies exist: nothing changed behind the listener's back
    expect(await release(page)).toBeNull()
    expect(await cacheNames(page)).toEqual(expect.arrayContaining([`wavelocal-precache-${one.version}`, `wavelocal-precache-${next.version}`]))
    // only what changed was downloaded: the shell, and not one of the hashed files
    expect(site.requests).toEqual(expect.arrayContaining(['/sw.js', '/index.html']))
    expect(site.requests.filter((path) => path.startsWith('/assets/'))).toEqual([])

    await app.toast(/new version of Wavelocal is ready/i).getByRole('button', { name: 'Reload' }).click()
    await expect.poll(() => release(page), { timeout: 20_000 }).toBe('two')
    await expect(app.viewSelect).toBeVisible()
    await expect(app.rows).toHaveCount(1) // the library came through the update
    await expect.poll(() => cacheNames(page)).toEqual([`wavelocal-precache-${next.version}`, 'someone-elses-cache'].sort())
    expect(await app.policyViolations()).toEqual([])
  })

  test('the update can be applied from Sound & tools as well', async ({ page }) => {
    site = await startSite(DIST)
    const app = await visit(page, site)
    await controlled(page)
    const one = releaseOf(DIST)
    await saved(page, one.version, one.entries.length)

    site.serve(next.dir)
    await checkForUpdates(app)
    await app.tools.getByRole('button', { name: 'Reload to update' }).click()
    await expect.poll(() => release(page), { timeout: 20_000 }).toBe('two')
  })

  test('says so when it is up to date', async ({ page }) => {
    site = await startSite(DIST)
    const app = await visit(page, site)
    await controlled(page)
    await checkForUpdates(app)
    await expect(app.toast('Wavelocal is up to date.')).toBeVisible()
  })

  test('says so when the server cannot be reached, and keeps working', async ({ page }) => {
    site = await startSite(DIST)
    const app = await visit(page, site)
    await controlled(page)
    const one = releaseOf(DIST)
    await saved(page, one.version, one.entries.length)
    await site.down()
    await checkForUpdates(app)
    await expect(app.toast(/could not reach the server/i)).toBeVisible()
    await app.closeTools()
    await expect(app.viewSelect).toBeVisible()
  })

  test('a release that arrives damaged is not installed; the working copy stays; the next try works', async ({ page }) => {
    site = await startSite(DIST)
    const app = await visit(page, site)
    await controlled(page)
    const one = releaseOf(DIST)
    await saved(page, one.version, one.entries.length)

    site.serve(next.dir)
    site.override('/index.html', { status: 200, body: '<html><body>Sign in to the hotel Wi-Fi</body></html>' })
    site.forget()
    await checkForUpdates(app)
    await expect.poll(() => site.requests.includes('/index.html'), { timeout: 20_000 }).toBe(true)
    await expect.poll(() => page.evaluate(async () => Boolean((await navigator.serviceWorker.getRegistration())?.installing)), { timeout: 20_000 }).toBe(false)
    await expect(app.toast(/new version of Wavelocal is ready/i)).toHaveCount(0)
    expect(await page.evaluate(async () => Boolean((await navigator.serviceWorker.getRegistration())?.waiting))).toBe(false)

    // the first release still opens, offline
    await site.down()
    await page.reload()
    await expect(app.viewSelect).toBeVisible()
    expect(await release(page)).toBeNull()
    await site.up()

    // the hotel's page is gone: the same release now installs
    site.override('/index.html', null)
    await checkForUpdates(app)
    await expect(app.toast(/new version of Wavelocal is ready/i)).toBeVisible({ timeout: 20_000 })
  })

  test('a window that was open when another one updated is told, and can follow', async ({ page, context }) => {
    site = await startSite(DIST)
    const first = await visit(page, site)
    await controlled(page)
    const one = releaseOf(DIST)
    await saved(page, one.version, one.entries.length)
    const other = await context.newPage()
    const second = await visit(other, site)
    await controlled(other)

    site.serve(next.dir)
    await checkForUpdates(first)
    await expect(first.toast(/new version of Wavelocal is ready/i)).toBeVisible({ timeout: 20_000 })
    await expect(second.toast(/new version of Wavelocal is ready/i)).toBeVisible({ timeout: 20_000 })

    await first.toast(/new version of Wavelocal is ready/i).getByRole('button', { name: 'Reload' }).click()
    await expect.poll(() => release(page), { timeout: 20_000 }).toBe('two')
    // the other window was not reloaded behind its listener's back, and its own Reload now just reloads
    expect(await release(other)).toBeNull()
    await second.toast(/new version of Wavelocal is ready/i).getByRole('button', { name: 'Reload' }).click()
    await expect.poll(() => release(other), { timeout: 20_000 }).toBe('two')
  })

  test('replaces the retired static worker of earlier releases without asking, and without a reload', async ({ page }) => {
    const retired = scratch()
    cpSync(DIST, retired, { recursive: true })
    writeFileSync(join(retired, 'sw.js'), RETIRED_WORKER)
    rmSync(join(retired, 'precache-manifest.json'))

    site = await startSite(retired)
    const app = await visit(page, site)
    await controlled(page)
    await expect.poll(() => cacheNames(page)).toEqual(['wavelocal-v1'])
    await page.evaluate(() => Object.assign(window, { __kept: true })) // a reload would lose this

    site.serve(DIST)
    await checkForUpdates(app)
    const one = releaseOf(DIST)
    await expect.poll(() => cacheNames(page), { timeout: 20_000 }).toEqual([`wavelocal-precache-${one.version}`])
    await expect.poll(() => page.evaluate(() => navigator.serviceWorker.controller?.state), { timeout: 20_000 }).toBe('activated')
    expect(await page.evaluate(() => (window as unknown as { __kept?: boolean }).__kept)).toBe(true)
    await expect(app.toast(/new version of Wavelocal is ready|updated in another window/i)).toHaveCount(0)
    await expect(app.tools.getByRole('group', { name: 'Offline copy of the app' })).not.toContainText('Reload')
  })
})

test.describe('where an offline copy is not wanted', () => {
  test('the Android app removes the workers and caches earlier versions left behind', async ({ page }) => {
    site = await startSite(DIST)
    const app = await visit(page, site)
    await controlled(page)
    const one = releaseOf(DIST)
    await saved(page, one.version, one.entries.length)

    // from now on the page looks like the Capacitor WebView of the Android app
    await page.addInitScript(() => Object.assign(window, { Capacitor: { isNativePlatform: () => true } }))
    await page.reload()
    await expect(app.viewSelect).toBeVisible()
    // the worker that was registered keeps serving the page it already controls until that page is gone, so it may still
    // refill a cache in the meantime; the next launch (which no worker controls any more) finds nothing left to remove
    await expect.poll(() => page.evaluate(async () => (await navigator.serviceWorker.getRegistrations()).length)).toBe(0)
    await page.reload()
    await expect(app.viewSelect).toBeVisible()
    expect(await page.evaluate(() => navigator.serviceWorker.controller)).toBeNull()
    await expect.poll(() => cacheNames(page)).toEqual([])

    await app.openTools()
    await expect(app.tools.getByRole('group', { name: 'Offline copy of the app' })).toContainText('already runs from files on your device')
    await expect(app.tools.getByRole('button', { name: 'Check for updates' })).toHaveCount(0)
  })
})
