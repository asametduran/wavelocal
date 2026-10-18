import AxeBuilder from '@axe-core/playwright'
import { expect, test } from '@playwright/test'
import type { Page } from '@playwright/test'
import { PlayerPage, settled, wav } from './helpers'

// What a person saved must survive a bad start: a read that fails, a value that is damaged, a connection that is closed under the
// window. Each of these used to end with the saved order, playlists and queue replaced by empty ones, or with saves that silently
// stopped; the first four tests are the experiments of the audit of 2026-10-18 made permanent.

const FLAG = '__failReads'

/** From the next load on, reading the tracks throws (`times` times in each load), as a database does when it is not ready. */
async function failReads(page: Page, times: number): Promise<void> {
  await page.addInitScript(
    ({ flag, count }) => {
      if (sessionStorage.getItem(flag) !== '1') return
      let left = count
      const getAll = IDBObjectStore.prototype.getAll
      IDBObjectStore.prototype.getAll = function (this: IDBObjectStore, ...args: Parameters<IDBObjectStore['getAll']>) {
        if (this.name === 'tracks' && left > 0) {
          left--
          throw new DOMException('Internal error opening backing store', 'UnknownError')
        }
        return getAll.apply(this, args)
      }
    },
    { flag: FLAG, count: times },
  )
}

/** A library of two songs with a playlist and a queued track saved, read back from the database to be sure. */
async function savedLibrary(app: PlayerPage) {
  await app.open()
  await app.importFiles(wav('tone-440', '01-a.wav'), wav('tone-880', '02-b.wav'))
  await expect(app.rows).toHaveCount(2)
  await expect.poll(async () => (await app.storedTracks()).length).toBe(2)
  const ids = (await app.storedTracks()).map((t) => t.id)
  await expect.poll(() => app.storedMeta('order')).toEqual(ids)
  await app.putMeta('playlists', [{ id: 'plKeep', name: 'Mine', trackIds: [ids[0]] }])
  await app.putMeta('upNext', [ids[1]])
  return ids
}

const names = async (app: PlayerPage): Promise<string[]> => (((await app.storedMeta('playlists')) as { name: string }[] | undefined) ?? []).map((p) => p.name)

test.describe('a start-up that goes wrong', () => {
  test('a read that fails once is tried again, and nothing that was saved is lost', async ({ page }) => {
    const app = new PlayerPage(page)
    const ids = await savedLibrary(app)
    await failReads(page, 1)
    await page.evaluate((flag) => sessionStorage.setItem(flag, '1'), FLAG)
    await app.reload()
    await expect(app.rows).toHaveCount(2, { timeout: 10_000 })
    await expect(app.viewSelect.locator('option', { hasText: 'Mine' })).toHaveText('Mine (1)')
    await expect(app.question).toBeHidden()
    await page.waitForTimeout(500)
    expect(await app.storedMeta('order')).toEqual(ids)
    expect(await names(app)).toEqual(['Mine'])
    expect(await app.storedMeta('upNext')).toEqual([ids[1]])
  })

  test('a library that cannot be read is never written over, and the window says so', async ({ page }) => {
    const app = new PlayerPage(page)
    const ids = await savedLibrary(app)
    await failReads(page, 1_000_000)
    await page.evaluate((flag) => sessionStorage.setItem(flag, '1'), FLAG)
    await app.reload()

    await expect(app.question).toContainText('Wavelocal is not saving', { timeout: 10_000 })
    await expect(app.question).toContainText('Your files are untouched')
    await settled(page)
    const scan = await new AxeBuilder({ page }).include('[data-testid="dialog"]').analyze()
    expect(scan.violations).toEqual([])
    await app.answerDialog(false) // Not now

    // the window still works, in memory; it does not pretend otherwise
    await expect(app.rows).toHaveCount(0)
    await app.importFiles(wav('sweep', '03-c.wav'))
    await expect(app.rows).toHaveCount(1)
    await expect(app.toast(/not saving in this window/i)).toBeVisible()
    await page.waitForTimeout(1500)

    // and what is saved is exactly what was saved
    expect(await app.storedMeta('order')).toEqual(ids)
    expect(await names(app)).toEqual(['Mine'])
    expect(await app.storedMeta('upNext')).toEqual([ids[1]])
    expect(await page.evaluate(() => new Promise<number>((resolve) => { const r = indexedDB.open('wavelocal', 1); r.onsuccess = () => { const q = r.result.transaction('tracks').objectStore('tracks').count(); q.onsuccess = () => { r.result.close(); resolve(q.result) } } }))).toBe(2)

    // reading works again after a reload: everything saved is back
    await page.evaluate((flag) => sessionStorage.removeItem(flag), FLAG)
    await app.reload()
    await expect(app.rows).toHaveCount(2)
    await expect(app.viewSelect.locator('option', { hasText: 'Mine' })).toHaveText('Mine (1)')
    await expect(app.question).toBeHidden()
  })

  test('damaged saved values are left out and counted, and never blank the page', async ({ page }) => {
    const app = new PlayerPage(page)
    const ids = await savedLibrary(app)
    await app.putMeta('playlists', [null, { id: 7 }, 'junk', { id: 'plFine', name: 'Fine', trackIds: [ids[0], 5] }])
    await page.evaluate(
      () =>
        new Promise<void>((resolve, reject) => {
          const r = indexedDB.open('wavelocal', 1)
          r.onsuccess = () => {
            const t = r.result.transaction('tracks', 'readwrite')
            t.objectStore('tracks').put({ id: 'broken', title: 'No audio in here' })
            t.oncomplete = () => {
              r.result.close()
              resolve()
            }
            t.onerror = () => reject(t.error)
          }
        }),
    )
    await app.reload()
    await expect(app.rows).toHaveCount(2)
    await expect(app.viewSelect.locator('option', { hasText: 'Fine' })).toHaveText('Fine (1)')
    await expect(app.toast(/4 damaged items in your saved library could not be read and were left out/)).toBeVisible()
    // the audio that could not be listed is still in the database
    expect(await page.evaluate(() => new Promise<number>((resolve) => { const r = indexedDB.open('wavelocal', 1); r.onsuccess = () => { const q = r.result.transaction('tracks').objectStore('tracks').count(); q.onsuccess = () => { r.result.close(); resolve(q.result) } } }))).toBe(3)
  })

  test('a browser that keeps nothing for the page says so, and the window still plays and browses', async ({ page }) => {
    await page.addInitScript(() => {
      indexedDB.open = () => {
        throw new DOMException('The operation is insecure.', 'SecurityError')
      }
    })
    const app = new PlayerPage(page)
    await app.open()
    await expect(app.question).toContainText('Nothing can be saved here')
    await expect(app.question).toContainText('gone when this tab closes')
    await app.answerDialog(true) // OK
    await app.importFiles(wav('tone-440', '01-a.wav'))
    await expect(app.rows).toHaveCount(1)
    await app.play('01-a')
    await app.expectPlaying()
  })
})

test.describe('a save that fails', () => {
  /** From now on a write to `meta` is refused with the error a full device gives, while `window.__full` is true. */
  async function deviceCanFill(page: Page): Promise<void> {
    await page.addInitScript(() => {
      const w = window as unknown as { __full: boolean }
      w.__full = false
      const put = IDBObjectStore.prototype.put
      IDBObjectStore.prototype.put = function (this: IDBObjectStore, value: unknown, key?: IDBValidKey) {
        if (this.name === 'meta' && w.__full) throw new DOMException('The quota has been exceeded.', 'QuotaExceededError')
        return put.call(this, value, key)
      }
    })
  }
  const fill = (page: Page, full: boolean): Promise<void> => page.evaluate((on) => void ((window as unknown as { __full: boolean }).__full = on), full)

  async function makePlaylist(app: PlayerPage, name: string): Promise<void> {
    await app.viewSelect.selectOption('__new')
    await app.answerDialog(true, name)
  }

  async function savingCard(app: PlayerPage) {
    await app.openTools()
    const card = app.tools.getByRole('group', { name: 'Saving' })
    await card.scrollIntoViewIfNeeded()
    return card
  }

  test('is said once with the advice, tried again by itself, and said to work again; nothing is lost', async ({ page }) => {
    await deviceCanFill(page)
    const app = new PlayerPage(page)
    await app.open()
    await app.importFiles(wav('tone-440', '01-a.wav'))
    await expect(app.rows).toHaveCount(1)
    await expect.poll(() => app.storedMeta('order')).toHaveLength(1)

    await fill(page, true)
    await makePlaylist(app, 'Full')
    const failure = app.toast(/out of storage space/i)
    await expect(failure).toBeVisible()
    await expect(failure.getByRole('button', { name: 'Try again' })).toBeVisible()
    expect(await names(app)).toEqual([])

    // it is said once for the whole episode: another change that cannot be saved either does not bring the toast back
    await failure.getByRole('button', { name: 'Dismiss' }).click()
    await expect(failure).toBeHidden()
    await makePlaylist(app, 'Also full')
    await page.waitForTimeout(700)
    await expect(failure).toBeHidden()

    // and the Storage panel says what is going on, in the words of the cause
    const card = await savingCard(app)
    await expect(card).toContainText('could not be saved yet')
    await expect(card).toContainText('out of storage space')
    await settled(app.page)
    const scan = await new AxeBuilder({ page }).include('[aria-label="Saving"]').analyze()
    expect(scan.violations).toEqual([])

    // room again: the newest value of each write is tried by itself, nothing is lost, and it says so
    await fill(page, false)
    await expect.poll(() => names(app), { timeout: 12_000 }).toEqual(['Full', 'Also full'])
    await expect(app.toast('Saving works again.')).toBeVisible()
    await expect(card).toContainText('saved on this device')
  })

  test('is tried again at once with Try again', async ({ page }) => {
    await deviceCanFill(page)
    const app = new PlayerPage(page)
    await app.open()
    await app.importFiles(wav('tone-440', '01-a.wav'))
    await expect(app.rows).toHaveCount(1)
    await expect.poll(() => app.storedMeta('order')).toHaveLength(1)

    await fill(page, true)
    await makePlaylist(app, 'Full')
    await expect(app.toast(/out of storage space/i)).toBeVisible()
    await fill(page, false)
    await app.toast(/out of storage space/i).getByRole('button', { name: 'Try again' }).click()
    await expect.poll(() => names(app), { timeout: 5000 }).toEqual(['Full'])
    await expect(app.toast('Saving works again.')).toBeVisible()
  })
})

test.describe('two windows', () => {
  test('the older one is told the first time a change of its own would be lost, and can take over; what the newer one saved is never overwritten', async ({ page, context }) => {
    const older = new PlayerPage(page)
    await older.open()
    await older.importFiles(wav('tone-440', '01-a.wav'), wav('tone-880', '02-b.wav'))
    await expect(older.rows).toHaveCount(2)
    await expect.poll(async () => (await older.storedTracks()).length).toBe(2)

    const newer = new PlayerPage(await context.newPage()) // opening a window takes the library from the one that had it
    await newer.open()
    await expect(newer.rows).toHaveCount(2)

    // a playlist made in the older window cannot be saved, and the window says so
    await older.viewSelect.selectOption('__new')
    await expect(older.question).toBeVisible()
    await older.question.getByRole('textbox').fill('One')
    await older.question.getByTestId('dialog-confirm').click()
    await expect(older.question).toContainText('Another window took over')
    await expect(older.question).toContainText('Changes made here are not saved')
    await settled(older.page)
    const scan = await new AxeBuilder({ page: older.page }).include('[data-testid="dialog"]').analyze()
    expect(scan.violations).toEqual([])
    await older.question.getByTestId('dialog-cancel').click() // Not now
    await expect(older.question).toBeHidden()

    // the newer window's playlist is the one that is kept, and the older window never overwrites it
    await newer.viewSelect.selectOption('__new')
    await newer.answerDialog(true, 'Two')
    await expect.poll(() => names(newer)).toEqual(['Two'])
    await page.waitForTimeout(500)
    expect(await names(older)).toEqual(['Two'])

    // the older window keeps saying so where a person looks, and can take over: that is a reload, and then it is the one that saves
    const card = await (async () => {
      await older.openTools()
      const group = older.tools.getByRole('group', { name: 'Saving' })
      await group.scrollIntoViewIfNeeded()
      return group
    })()
    await expect(card).toContainText('Not saving here')
    await card.getByRole('button', { name: 'Use this window' }).click()
    await expect(older.viewSelect).toBeVisible()
    await expect(older.viewSelect.locator('option', { hasText: 'Two' })).toHaveText('Two (0)') // the playlist the other window made is here
    await older.viewSelect.selectOption('__new')
    await older.answerDialog(true, 'Three')
    await expect.poll(() => names(older)).toEqual(['Two', 'Three'])

    // and now it is the other window that is told
    await newer.viewSelect.selectOption('__new')
    await expect(newer.question).toBeVisible()
    await newer.question.getByRole('textbox').fill('Four')
    await newer.question.getByTestId('dialog-confirm').click()
    await expect(newer.question).toContainText('Another window took over')
    await page.waitForTimeout(500)
    expect(await names(older)).toEqual(['Two', 'Three'])
  })
})

test.describe('a connection that is closed under the window', () => {
  test('is replaced, and the next import is saved', async ({ page }) => {
    await page.addInitScript(() => {
      const open = IDBFactory.prototype.open
      IDBFactory.prototype.open = function (this: IDBFactory, ...args: Parameters<IDBFactory['open']>) {
        const request = open.apply(this, args)
        request.addEventListener('success', () => {
          const w = window as unknown as { __dbs?: IDBDatabase[] }
          ;(w.__dbs ??= []).push(request.result)
        })
        return request
      }
    })
    const app = new PlayerPage(page)
    await app.open()
    await app.importFiles(wav('tone-440', '01-a.wav'))
    await expect(app.rows).toHaveCount(1)
    await expect.poll(async () => (await app.storedTracks()).length).toBe(1)

    // what the browser does when site data is cleared under an open window (here by hand: the effect on later transactions is the same)
    await page.evaluate(() => (window as unknown as { __dbs: IDBDatabase[] }).__dbs[0]?.close())

    await app.importFiles(wav('tone-880', '02-b.wav'))
    await expect(app.rows).toHaveCount(2)
    await expect.poll(async () => (await app.storedTracks()).map((t) => t.name)).toEqual(['01-a.wav', '02-b.wav'])
    await expect.poll(async () => ((await app.storedMeta('order')) as string[] | undefined)?.length).toBe(2)
  })
})
