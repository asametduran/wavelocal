import { expect, test } from '@playwright/test'
import type { ElectronApplication, Locator, Page } from '@playwright/test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { launchShell, toneWav } from './harness'

// Electron does not implement window.prompt, and its confirm box is not the app's. Everything the app asks is asked in its
// own dialogs, which these tests run in the real shell: from the privileged app:// origin, under its strict CSP, with the
// dialog code fetched as a lazy chunk.

let userData = ''
let app: ElectronApplication
let page: Page

async function launch(): Promise<void> {
  ;({ app, page } = await launchShell(userData))
}

// every test gets a user-data directory of its own, so it starts from an empty library (a relaunch within a test reuses it)
test.beforeEach(async () => {
  userData = mkdtempSync(path.join(tmpdir(), 'wavelocal-e2e-dialogs-'))
  await launch()
})
test.afterEach(async () => {
  await app.close()
  rmSync(userData, { recursive: true, force: true })
})

/** The library panel (the phone's queue sheet holds a second, hidden one later in the page). */
const sidebar = (): Locator => page.locator('aside').first()
const chooser = (): Locator => sidebar().getByLabel('Library or playlist')
const option = (text: string): Locator => chooser().locator('option', { hasText: text })
const row = (title: string): Locator => sidebar().locator('ul > li', { has: page.locator('div.truncate.text-sm', { hasText: new RegExp(`^${title}$`) }) })

async function importTones(...names: string[]): Promise<void> {
  await page.locator('input[type=file]').first().setInputFiles(names.map((name, i) => ({ name: `${name}.wav`, mimeType: 'audio/wav', buffer: toneWav(2, 330 + i * 110) })))
  for (const name of names) await expect(row(name).first()).toBeVisible()
}

/** Make a playlist through the library chooser's "New playlist…" and its name dialog. */
async function newPlaylist(name: string): Promise<void> {
  await chooser().selectOption('__new')
  const dialog = page.getByRole('dialog', { name: 'New playlist' })
  await expect(dialog).toBeVisible()
  await dialog.getByRole('textbox', { name: 'Playlist name' }).fill(name)
  await dialog.getByRole('button', { name: 'Create' }).click()
  await expect(dialog).toBeHidden()
  await expect(option(name)).toHaveText(`${name} (0)`)
}

/** A value of the app's own database (`meta` store), read straight from IndexedDB: saving comes a moment after the screen changes. */
const stored = (key: string): Promise<unknown> =>
  page.evaluate(
    (key) =>
      new Promise<unknown>((resolve, reject) => {
        const open = indexedDB.open('wavelocal', 1)
        open.onsuccess = () => {
          const db = open.result
          const req = db.transaction('meta', 'readonly').objectStore('meta').get(key)
          req.onsuccess = () => {
            resolve(req.result)
            db.close()
          }
          req.onerror = () => reject(req.error)
        }
        open.onerror = () => reject(open.error)
      }),
    key,
  )

test('window.prompt is not there to be used, which is why the app asks in its own dialogs', async () => {
  const outcome = await page.evaluate(() => {
    try {
      window.prompt('Name?')
      return 'returned'
    } catch (error) {
      return error instanceof Error ? error.message : String(error)
    }
  })
  expect(outcome).toMatch(/prompt\(\) is not supported/i)
})

test('a new playlist is named in the app’s own dialog, and is still there after a relaunch', async () => {
  await importTones('a', 'b')
  await newPlaylist('Desk mix')
  await expect.poll(() => stored('playlists')).toMatchObject([{ name: 'Desk mix' }])

  await app.close()
  await launch()
  await expect(option('Desk mix')).toHaveText('Desk mix (0)')
})

test('clearing the library asks in the app: Escape says no, the button says yes', async () => {
  await importTones('a')
  const clear = page.getByRole('button', { name: 'Clear library' })
  const dialog = page.getByRole('alertdialog', { name: 'Remove every track from your library?' })

  await clear.click()
  await expect(dialog).toBeVisible()
  await expect(dialog.getByRole('button', { name: 'Cancel' })).toBeFocused() // a destructive question starts on the safe answer
  await page.keyboard.press('Escape')
  await expect(dialog).toBeHidden()
  await expect(row('a').first()).toBeVisible()

  await clear.click()
  await dialog.getByRole('button', { name: 'Clear library' }).click()
  await expect(row('a')).toHaveCount(0)
})

test('a deleted playlist comes back with the toast’s Undo, and with Ctrl+Z', async () => {
  await newPlaylist('Doomed')
  const openMenuAndDelete = async () => {
    await page.getByRole('button', { name: 'Playlist actions' }).click()
    await page.getByRole('menuitem', { name: 'Delete playlist' }).click()
    await expect(option('Doomed')).toHaveCount(0)
  }
  const toast = page.getByRole('status').filter({ hasText: 'Deleted “Doomed”' })

  await openMenuAndDelete()
  await toast.getByRole('button', { name: 'Undo' }).click()
  await expect(option('Doomed')).toHaveText('Doomed (0)')

  await openMenuAndDelete()
  await expect(toast).toBeVisible()
  await page.keyboard.press('Control+z')
  await expect(option('Doomed')).toHaveText('Doomed (0)')
})

test('Play next queues a track, and the queue is still there after a relaunch', async () => {
  await importTones('a', 'b', 'c')
  await row('c').hover()
  await row('c').getByRole('button', { name: 'Add c to playlist or queue' }).click()
  await page.getByRole('menuitem', { name: 'Play next', exact: true }).click()
  await expect(page.getByRole('status').filter({ hasText: 'Playing next: c' })).toBeVisible()
  await expect.poll(() => stored('upNext')).toHaveLength(1)

  await app.close()
  await launch()
  await expect(page.getByRole('tab', { name: 'Up Next (1 queued)' })).toBeVisible()
})

test('a playlist file dropped into the file picker becomes a playlist (its code is a lazy chunk, loaded under the CSP)', async () => {
  await importTones('01-alpha', '02-bravo')
  const m3u = '#EXTM3U\n#EXTINF:2,Bravo\n02-bravo.wav\n#EXTINF:2,Alpha\n01-alpha.wav\n'
  await page.locator('input[type=file]').first().setInputFiles({ name: 'Mix.m3u8', mimeType: 'audio/x-mpegurl', buffer: Buffer.from(m3u) })
  await expect(option('Mix')).toHaveText('Mix (2)')
  await expect(page.getByRole('status').filter({ hasText: 'Imported “Mix”: 2 tracks' })).toBeVisible()
})
