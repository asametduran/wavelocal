import { expect, test } from '@playwright/test'
import type { Page } from '@playwright/test'
import { PlayerPage, wav } from './helpers'

const HUGE = 10_000

/** Write `count` tiny library records straight into the app's IndexedDB (no 10,000 real uploads needed). */
async function seedLibrary(page: Page, count: number): Promise<void> {
  await page.evaluate(async (n) => {
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const r = indexedDB.open('wavelocal', 1)
      r.onupgradeneeded = () => {
        r.result.createObjectStore('tracks', { keyPath: 'id' })
        r.result.createObjectStore('meta')
      }
      r.onsuccess = () => resolve(r.result)
      r.onerror = () => reject(r.error)
    })
    const cover = new Blob(['not-really-a-jpeg'], { type: 'image/jpeg' })
    const ids: string[] = []
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(['tracks', 'meta'], 'readwrite')
      const tracks = tx.objectStore('tracks')
      for (let i = 0; i < n; i++) {
        const id = `seed${i}`
        ids.push(id)
        tracks.put({
          id,
          key: `song ${i}.mp3|1|${i}`,
          file: new File(['x'], `song ${i}.mp3`, { type: 'audio/mpeg', lastModified: i }),
          path: `Music/Album ${Math.floor(i / 50)}`,
          coverBlob: i % 2 === 0 ? cover : null,
          title: `Song ${String(i).padStart(5, '0')}`,
          artist: `Artist ${i % 97}`,
          album: `Album ${Math.floor(i / 50)}`,
          duration: 180,
          lyrics: null,
          gainDb: null,
        })
      }
      tx.objectStore('meta').put(ids, 'order')
      tx.oncomplete = () => resolve()
      tx.onerror = () => reject(tx.error)
    })
    db.close()
  }, count)
}

test.describe('performance with a huge library', () => {
  test('10,000 tracks load with a bounded DOM and almost no object URLs', async ({ page }) => {
    const app = new PlayerPage(page)
    await app.open()
    await seedLibrary(page, HUGE)

    const started = Date.now()
    await app.reload()
    await expect(app.viewSelect.locator('option[value="all"]')).toHaveText(`Library (${HUGE})`, { timeout: 15_000 })
    await expect(app.rows.first()).toBeVisible()
    const loadMs = Date.now() - started

    // virtualized: only the visible window (plus overscan) is in the DOM
    expect(await app.rows.count()).toBeLessThan(80)
    // generous bound: a regression to per-track work at startup would take many seconds, not a few hundred ms
    expect(loadMs).toBeLessThan(10_000)

    // object URLs are minted for what is on screen and the current track, not for all 10,000 (x2 with covers)
    const minted = await page.evaluate(() => window.__probe.blobs.size)
    expect(minted).toBeLessThan(150)
  })

  test('scrolling to the end of a huge library stays virtualized and shows the last track', async ({ page }) => {
    const app = new PlayerPage(page)
    await app.open()
    await seedLibrary(page, HUGE)
    await app.reload()
    await expect(app.rows.first()).toBeVisible()

    await app.sidebar.locator('ul').first().evaluate((el) => el.scrollTo(0, el.scrollHeight))
    await expect(app.row(`Song ${String(HUGE - 1).padStart(5, '0')}`)).toBeVisible()
    expect(await app.rows.count()).toBeLessThan(80)
    expect(await page.evaluate(() => window.__probe.blobs.size)).toBeLessThan(300)
  })

  test('removing a track frees only the object URLs that were created', async ({ page }) => {
    const app = new PlayerPage(page)
    await app.open()
    await app.importFiles(wav('tone-440', 'a.wav'), wav('tone-880', 'b.wav'))
    await expect(app.rows).toHaveCount(2)
    await app.row('b').hover()
    await app.row('b').getByRole('button', { name: 'Remove b' }).click()
    await expect(app.rows).toHaveCount(1)
    const { created, revoked } = await page.evaluate(() => ({ created: [...window.__probe.blobs.keys()], revoked: window.__probe.revoked }))
    // everything revoked was really created: lazy tracks never revoke a URL they did not mint
    for (const url of revoked) expect(created).toContain(url)
  })
})

test.describe('code splitting', () => {
  const chunkRequests = (page: Page): string[] => {
    const seen: string[] = []
    page.on('request', (r) => {
      const m = /\/assets\/([A-Za-z.]+)-[\w-]+\.js/.exec(r.url())
      if (m?.[1]) seen.push(m[1])
    })
    return seen
  }

  test('the tag reader is not downloaded until files are imported', async ({ page }) => {
    const seen = chunkRequests(page)
    const app = new PlayerPage(page)
    await app.open()
    expect(seen.some((n) => n.startsWith('jsmediatags'))).toBe(false)
    await app.importFiles(wav('tone-440', 'a.wav'))
    await expect(app.rows).toHaveCount(1)
    expect(seen.some((n) => n.startsWith('jsmediatags'))).toBe(true)
  })

  test('the sound tools open (fetching their chunk) and close again', async ({ page }) => {
    const seen = chunkRequests(page)
    const app = new PlayerPage(page)
    await app.open()
    await app.openTools()
    await expect(page.getByRole('dialog', { name: 'Sound and tools' })).toBeVisible()
    expect(seen).toContain('ToolsModal')
    await app.closeTools()
    await expect(page.getByRole('dialog', { name: 'Sound and tools' })).toBeHidden()
  })

  test('a panel whose chunk cannot be fetched shows a notice instead of blanking the app', async ({ page }) => {
    await page.route(/\/assets\/ShortcutsModal-.*\.js/, (route) => route.abort())
    const app = new PlayerPage(page)
    await app.open()
    await page.keyboard.press('?')
    await expect(page.getByRole('alert')).toContainText('Could not load the shortcut list')
    await expect(app.viewSelect).toBeVisible() // the rest of the app is untouched
    await page.getByRole('button', { name: 'Dismiss' }).click()
    await expect(page.getByRole('alert')).toBeHidden()

    // back online: the next open downloads the chunk again instead of replaying the cached failure
    await page.unroute(/\/assets\/ShortcutsModal-.*\.js/)
    await page.keyboard.press('?')
    await expect(page.getByRole('dialog', { name: 'Keyboard shortcuts' })).toBeVisible()
  })
})
