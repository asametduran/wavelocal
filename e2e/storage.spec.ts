import AxeBuilder from '@axe-core/playwright'
import { expect, test } from '@playwright/test'
import type { Page } from '@playwright/test'
import { PlayerPage, settled, tone } from './helpers'

interface StorageStub {
  usage: number
  quota: number
  persisted: boolean
  /** What `persist()` answers. */
  grant: boolean
}

declare global {
  interface Window {
    __storage: StorageStub
  }
}

/** Make the browser report the storage numbers a test wants (install before the page loads); `window.__storage` changes them later. */
async function stubStorage(page: Page, initial: Partial<StorageStub> = {}): Promise<void> {
  await page.addInitScript((start) => {
    const state = { usage: 400e6, quota: 60e9, persisted: false, grant: true, ...start }
    window.__storage = state
    Object.defineProperty(navigator, 'storage', {
      configurable: true,
      value: {
        estimate: async () => ({ usage: state.usage, quota: state.quota }),
        persisted: async () => state.persisted,
        persist: async () => {
          state.persisted ||= state.grant
          return state.persisted
        },
      },
    })
  }, initial)
}

test.describe('storage manager', () => {
  let app: PlayerPage
  const region = () => app.tools.getByRole('region', { name: 'Storage' })

  async function open(...files: ReturnType<typeof tone>[]) {
    await app.open()
    if (files.length) {
      await app.importFiles(...files)
      await expect(app.rows).toHaveCount(files.length)
    }
  }
  async function openStorage() {
    await app.openTools()
    await region().scrollIntoViewIfNeeded()
  }

  test.beforeEach(({ page }) => {
    app = new PlayerPage(page)
  })

  test('shows what is used, what is left and what the library takes', async ({ page }) => {
    await stubStorage(page)
    await open(tone('01-a.wav', 1), tone('02-b.wav', 1), tone('03-c.wav', 1))
    await openStorage()
    await expect(region()).toContainText('400 MB used of 60.0 GB available (0.7%)')
    const meter = region().getByRole('meter', { name: 'Storage used' })
    await expect(meter).toHaveAttribute('aria-valuetext', '400 MB of 60.0 GB used, 59.6 GB free')
    await expect(region().getByText(/Music library: .* \(3 tracks\)/)).toBeVisible()
    await expect(region().getByText(/Free: 59\.6 GB/)).toBeVisible()
    await expect(region().getByRole('alert')).toHaveCount(0)
  })

  test('says so when the browser does not report storage', async ({ page }) => {
    await page.addInitScript(() => Object.defineProperty(navigator, 'storage', { configurable: true, value: {} }))
    await open(tone('01-a.wav', 1))
    await openStorage()
    await expect(region()).toContainText('does not say how much room is left')
    await expect(region().getByRole('meter')).toHaveCount(0)
  })

  test('warns when storage is getting full, and more firmly when it is almost full', async ({ page }) => {
    await stubStorage(page, { usage: 49e9, quota: 60e9 })
    await open(tone('01-a.wav', 1))
    await openStorage()
    await expect(region().getByRole('status').filter({ hasText: 'Storage is getting full: 11.0 GB left' })).toBeVisible()
    await page.evaluate(() => {
      window.__storage.usage = 58e9
    })
    await app.closeTools()
    await app.openTools()
    await expect(region().getByRole('alert')).toContainText('Storage is almost full: 2.00 GB left for Wavelocal.')
  })

  test('tells a person about full storage right after an import, once', async ({ page }) => {
    await stubStorage(page, { usage: 49e9, quota: 60e9 })
    await open()
    await app.importFiles(tone('01-a.wav', 1))
    await expect(app.toast(/Storage is getting full: 11\.0 GB left/)).toBeVisible()
    await app.importFiles(tone('02-b.wav', 1))
    await expect(app.rows).toHaveCount(2)
    await expect(app.toast(/Storage is getting full/)).toHaveCount(1)
  })

  test('explains the risk of unprotected storage and asks the browser to keep the library', async ({ page }) => {
    // the app asks once on its own at the first import; the browser said no then, and may say yes later
    await stubStorage(page, { persisted: false, grant: false })
    await open(tone('01-a.wav', 1))
    await openStorage()
    const protection = region().getByRole('group', { name: 'Protection from clean-up' })
    await expect(protection).toContainText('Not protected')
    await page.evaluate(() => {
      window.__storage.grant = true
    })
    await protection.getByRole('button', { name: 'Protect my library' }).click()
    await expect(app.toast(/Your library is protected/)).toBeVisible()
    await expect(protection).toContainText('Protected: the browser will not delete your library')
    await expect(protection.getByRole('button', { name: 'Protect my library' })).toHaveCount(0)
  })

  test('is honest when the browser refuses to protect the library', async ({ page }) => {
    await stubStorage(page, { persisted: false, grant: false })
    await open(tone('01-a.wav', 1))
    await openStorage()
    await region().getByRole('button', { name: 'Protect my library' }).click()
    await expect(app.toast(/did not agree/)).toBeVisible()
    await expect(region().getByRole('group', { name: 'Protection from clean-up' })).toContainText('Not protected')
  })

  test('lists the biggest tracks first and removes one only after asking', async ({ page }) => {
    await stubStorage(page)
    await open(tone('01-small.wav', 0.2), tone('02-big.wav', 6), tone('03-medium.wav', 2))
    await openStorage()
    const list = region().getByRole('list', { name: 'Largest tracks' })
    await expect(list.getByRole('listitem')).toHaveCount(3)
    await expect(list.getByRole('listitem').nth(0)).toContainText('02-big')
    await expect(list.getByRole('listitem').nth(1)).toContainText('03-medium')
    await expect(list.getByRole('listitem').nth(2)).toContainText('01-small')

    // Cancel keeps it
    await list.getByRole('button', { name: 'Remove 02-big from the library' }).click()
    await expect(app.question).toContainText('The original file on your device is not touched')
    await expect(app.question.getByTestId('dialog-cancel')).toBeFocused() // a destructive question starts on Cancel
    await app.answerDialog(false)
    await expect(list.getByRole('listitem')).toHaveCount(3)

    // Remove deletes it from the library, its saved copy and the list
    await list.getByRole('button', { name: 'Remove 02-big from the library' }).click()
    await app.answerDialog(true)
    await expect(app.toast(/Removed "02-big" and freed/)).toBeVisible()
    await expect(list.getByRole('listitem')).toHaveCount(2)
    await expect(list.getByRole('listitem').nth(0)).toContainText('03-medium')
    await app.closeTools()
    await expect(app.rows).toHaveCount(2)
    await expect.poll(() => app.storedTracks().then((stored) => stored.map((t) => t.name))).toEqual(['01-small.wav', '03-medium.wav'])
  })

  test('removing the playing track moves on to the next one', async ({ page }) => {
    await stubStorage(page)
    await open(tone('01-first.wav', 3), tone('02-second.wav', 6))
    await app.play('02-second')
    await app.expectPlaying()
    await openStorage()
    await region().getByRole('button', { name: 'Remove 02-second from the library' }).click()
    await app.answerDialog(true)
    await app.closeTools()
    await expect(app.rows).toHaveCount(1)
    await expect(app.nowPlayingTitle).not.toHaveText('02-second')
  })

  test('asks before an import that will not fit, and imports nothing when the answer is no', async ({ page }) => {
    await stubStorage(page, { usage: 59_999_900_000, quota: 60e9 }) // ~100 kB left
    await open()
    await app.importFiles(tone('01-big.wav', 6))
    await expect(app.question).toContainText('Not enough room?')
    await expect(app.question).toContainText('about 529 kB')
    await app.answerDialog(false)
    await expect(app.rows).toHaveCount(0)
    expect(await app.storedTracks()).toEqual([])

    await app.importFiles(tone('01-big.wav', 6))
    await expect(app.question).toBeVisible()
    await app.answerDialog(true)
    await expect(app.rows).toHaveCount(1)
  })

  test('does not ask about an import that fits', async ({ page }) => {
    await stubStorage(page)
    await open()
    await app.importFiles(tone('01-a.wav', 1))
    await expect(app.rows).toHaveCount(1)
    await expect(app.question).toBeHidden()
  })

  test('names the real reason when the device is out of space while saving', async ({ page }) => {
    await page.addInitScript(() => {
      const put = IDBObjectStore.prototype.put
      IDBObjectStore.prototype.put = function (this: IDBObjectStore, value: unknown, key?: IDBValidKey) {
        if (this.name === 'tracks') throw new DOMException('The quota has been exceeded.', 'QuotaExceededError')
        return put.call(this, value, key)
      }
    })
    await open()
    await app.importFiles(tone('01-a.wav', 1))
    await expect(app.toast(/out of storage space/i)).toBeVisible()
    await expect(app.toast(/Sound & tools, Storage/)).toBeVisible()
  })

  test('has no accessibility violations', async ({ page }) => {
    await stubStorage(page, { usage: 49e9, quota: 60e9, persisted: false })
    await open(tone('01-a.wav', 1), tone('02-b.wav', 2))
    await openStorage()
    await settled(page)
    const results = await new AxeBuilder({ page }).include('[role="dialog"]').analyze()
    expect(results.violations).toEqual([])
  })
})
