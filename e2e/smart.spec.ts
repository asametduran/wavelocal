import AxeBuilder from '@axe-core/playwright'
import { expect, test } from '@playwright/test'
import { PlayerPage, tone } from './helpers'

/** A two-second tone: it counts as played after one second of listening, so the tests stay fast. */
const song = (name: string, frequency = 440) => tone(name, 2, frequency)

test.describe('smart playlists', () => {
  let app: PlayerPage

  test.beforeEach(async ({ page }) => {
    app = new PlayerPage(page)
    await app.open()
  })

  const option = (label: RegExp) => app.viewSelect.locator('option', { hasText: label })
  const open = (value: string) => app.viewSelect.selectOption(value)

  test('are offered next to the library with live counts', async () => {
    await expect(option(/^Recently added \(0\)/)).toHaveCount(1)
    await expect(option(/^Most played \(0\)/)).toHaveCount(1)
    await expect(option(/^Recently played \(0\)/)).toHaveCount(1)
    await expect(option(/^Never played \(0\)/)).toHaveCount(1)

    await app.importFiles(song('a'), song('b', 523), song('c', 660))
    await expect(option(/^Recently added \(3\)/)).toHaveCount(1)
    await expect(option(/^Most played \(0\)/)).toHaveCount(1)
    await expect(option(/^Never played \(3\)/)).toHaveCount(1)
  })

  test('recently added puts the newest first and says when', async () => {
    await app.importFiles(song('a'), song('b', 523))
    await open('smart:recent')
    await expect(app.rows).toHaveCount(2)
    expect(await app.titles()).toEqual(['b', 'a'])
    await expect(app.sidebar.getByText('added today').first()).toBeVisible()
    await expect(app.sidebar.getByText('The newest additions to your library.')).toBeVisible()
  })

  test('a track counts as played after it has really been listened to', async () => {
    await app.importFiles(song('a'), song('b', 523))
    await app.play('a')
    await expect(option(/^Most played \(1\)/)).toHaveCount(1, { timeout: 10_000 })
    await expect(option(/^Recently played \(1\)/)).toHaveCount(1)
    await expect(option(/^Never played \(1\)/)).toHaveCount(1)

    await open('smart:top')
    expect(await app.titles()).toEqual(['a'])
    await expect(app.sidebar.getByText('1 play', { exact: false }).first()).toBeVisible()

    await open('smart:never')
    expect(await app.titles()).toEqual(['b'])
    await open('smart:played')
    expect(await app.titles()).toEqual(['a'])
    await expect(app.sidebar.getByText('played today').first()).toBeVisible()
  })

  test('skipping through tracks, or seeking to the end, does not count', async () => {
    await app.importFiles(song('solo'))
    await app.play('solo')
    await app.seekTo(1.9)
    // let it finish: it was only heard for a moment
    await app.expectPaused()
    await app.page.waitForTimeout(1500)
    await expect(option(/^Most played \(0\)/)).toHaveCount(1)
    await expect(option(/^Never played \(1\)/)).toHaveCount(1)
  })

  test('play counts and dates survive a reload', async () => {
    await app.importFiles(song('a'), song('b', 523))
    await app.play('a')
    await expect(option(/^Most played \(1\)/)).toHaveCount(1, { timeout: 10_000 })
    await app.page.waitForTimeout(300) // the count is written to IndexedDB right after it is counted
    await app.reload()
    await expect(option(/^Most played \(1\)/)).toHaveCount(1)
    await expect(option(/^Never played \(1\)/)).toHaveCount(1)
    await open('smart:top')
    expect(await app.titles()).toEqual(['a'])
  })

  test('smart lists are read-only: nothing to drag, nothing to take out', async () => {
    await app.importFiles(song('a'), song('b', 523))
    await open('smart:recent')
    const row = app.rows.first()
    await expect(row).toHaveAttribute('draggable', 'false')
    await expect(row.getByRole('button', { name: /^Remove / })).toHaveCount(0)
    await expect(row.getByRole('button', { name: /^Add .* to playlist$/ })).toBeAttached()
    await expect(app.sidebar.getByRole('list', { name: 'Recently added smart playlist' })).toBeVisible()
  })

  test('playing from a smart list stays inside it', async () => {
    await app.importFiles(song('a'), song('b', 523), song('c', 660))
    await open('smart:never')
    await app.play('a')
    await app.key('n')
    await expect(app.nowPlayingTitle).toHaveText('b')
    await app.key('n')
    await expect(app.nowPlayingTitle).toHaveText('c')
  })

  test('the list does not reshuffle under you while a count is recorded', async () => {
    await app.importFiles(song('a'), song('b', 523))
    await open('smart:never')
    await app.play('b')
    await expect(option(/^Most played \(1\)/)).toHaveCount(1, { timeout: 10_000 })
    // b is no longer "never played", but the open list keeps its order until it is opened again
    expect(await app.titles()).toEqual(['a', 'b'])
    await open('all')
    await open('smart:never')
    expect(await app.titles()).toEqual(['a'])
  })

  test('clearing play counts starts the lists over without touching the music', async () => {
    await app.importFiles(song('a'), song('b', 523))
    await app.play('a')
    await expect(option(/^Most played \(1\)/)).toHaveCount(1, { timeout: 10_000 })
    await open('smart:top')
    app.page.once('dialog', (d) => void d.accept())
    await app.sidebar.getByRole('button', { name: 'Clear play counts' }).click()
    await expect(option(/^Most played \(0\)/)).toHaveCount(1)
    await expect(option(/^Never played \(2\)/)).toHaveCount(1)
    await expect(app.viewSelect.locator('option[value="all"]')).toHaveText('Library (2)')
    await expect(app.sidebar.getByRole('button', { name: 'Clear play counts' })).toBeDisabled()
  })

  test('an empty smart list explains itself', async () => {
    await app.importFiles(song('a'))
    await open('smart:top')
    await expect(app.sidebar.getByText(/Nothing played yet/)).toBeVisible()
    await open('smart:never')
    await expect(app.rows).toHaveCount(1)
  })

  test('a library saved before play counts existed keeps working', async () => {
    await app.importFiles(song('old1'), song('old2', 523))
    // rewrite the stored records without the new fields, as an older version of the app saved them
    await app.page.evaluate(
      () =>
        new Promise<void>((resolve, reject) => {
          const open = indexedDB.open('wavelocal', 1)
          open.onsuccess = () => {
            const tx = open.result.transaction('tracks', 'readwrite')
            const store = tx.objectStore('tracks')
            store.getAll().onsuccess = (e) => {
              for (const rec of (e.target as IDBRequest<Record<string, unknown>[]>).result) {
                delete rec.addedAt
                delete rec.plays
                delete rec.lastPlayedAt
                store.put(rec)
              }
            }
            tx.oncomplete = () => resolve()
            tx.onerror = () => reject(tx.error)
          }
          open.onerror = () => reject(open.error)
        }),
    )
    await app.reload()
    await expect(option(/^Never played \(2\)/)).toHaveCount(1)
    await open('smart:recent')
    // no dates, so they follow import order with the last one first, and no made-up "added" text
    expect(await app.titles()).toEqual(['old2', 'old1'])
    await expect(app.sidebar.getByText(/· added/)).toHaveCount(0)
  })

  test('has no accessibility violations in a smart list', async () => {
    await app.importFiles(song('a'), song('b', 523))
    await app.play('a')
    await expect(option(/^Most played \(1\)/)).toHaveCount(1, { timeout: 10_000 })
    for (const view of ['smart:top', 'smart:never', 'smart:recent', 'smart:played']) {
      await open(view)
      const { violations } = await new AxeBuilder({ page: app.page }).include('aside').withTags(['wcag2a', 'wcag2aa', 'wcag21aa', 'wcag22aa', 'best-practice']).analyze()
      expect(violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(' ')).join(', ')}`), view).toEqual([])
    }
  })
})
