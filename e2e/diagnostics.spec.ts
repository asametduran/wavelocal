import AxeBuilder from '@axe-core/playwright'
import { expect, test } from '@playwright/test'
import type { Locator, Page } from '@playwright/test'
import { PlayerPage, flac, settled, song, wav } from './helpers'
import type { Upload } from './helpers'

// The error log: what Wavelocal ran into is kept on this device, shown in Sound & tools, and copied only when asked for, with the names
// of the person's files and titles taken out (the title below is in every message these tests raise, and must be in no report).

const TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa', 'best-practice']
const TITLE = 'Zebra Quartet - Night Train'

interface Stored {
  entries: { kind: string; name: string; message: string; count: number }[]
}

/** The log as it is stored on this device. */
const stored = (page: Page): Promise<Stored | null> => page.evaluate(() => JSON.parse(localStorage.getItem('wl.diagnostics') ?? 'null') as Stored | null)
const storedCount = async (page: Page): Promise<number> => (await stored(page))?.entries.length ?? 0

/** Raise an error nobody catches and reject a promise nobody handles, with a title and a path in the words, the way a bug would. */
async function breakThings(page: Page): Promise<void> {
  await page.evaluate((title) => {
    setTimeout(() => {
      throw new TypeError(`Cannot read "${title}" at C:\\Users\\jane\\Music\\${title}.mp3`)
    })
    void Promise.reject(new RangeError(`Bad value for ${title}.flac`))
  }, TITLE)
  await expect.poll(() => storedCount(page)).toBe(2)
}

/** Open Sound & tools at the Diagnostics section. A phone has no footer: it opens the dialog with its key, as the player bar's button would. */
async function diagnostics(app: PlayerPage, footer = true): Promise<Locator> {
  if (footer) {
    await app.openTools()
  } else {
    await app.page.keyboard.press('e')
    await expect(app.tools).toBeVisible()
  }
  const section = app.tools.getByRole('region', { name: 'Diagnostics' })
  await section.scrollIntoViewIfNeeded()
  await settled(app.page)
  return section
}

const garbage = (name: string): Upload => ({ name, mimeType: 'audio/mpeg', buffer: Buffer.from(Array.from({ length: 4096 }, (_, i) => (i * 131 + 5) & 0xff)) })

test.describe('the error log', () => {
  test('lists an error nobody caught and a promise nobody handled, with the names in them taken out, and is still there after a reload', async ({ page }) => {
    const app = new PlayerPage(page)
    await app.open()
    await breakThings(page)
    const section = await diagnostics(app)
    const list = section.getByRole('list', { name: 'Recorded errors' })
    await expect(list.getByRole('listitem')).toHaveCount(2)
    await expect(list).toContainText('TypeError: Cannot read <text> at <path>')
    await expect(list).toContainText('RangeError: <file>')
    await expect(list.getByText('error', { exact: true })).toBeVisible()
    await expect(list.getByText('rejection', { exact: true })).toBeVisible()
    await expect(section).not.toContainText('Zebra')
    expect(JSON.stringify(await stored(page))).not.toContain('Zebra')
    expect(JSON.stringify(await stored(page))).not.toContain('jane')

    await app.closeTools()
    await app.reload()
    const again = await diagnostics(app)
    await expect(again.getByRole('list', { name: 'Recorded errors' }).getByRole('listitem')).toHaveCount(2)
  })

  test('ordinary listening leaves nothing in the log: no error, no rejection, nothing a person would have to wonder about', async ({ page }) => {
    const pageErrors: string[] = []
    page.on('pageerror', (error) => pageErrors.push(error.message))
    const app = new PlayerPage(page)
    await app.open()
    await app.importFiles(wav('tone-440', '01-a.wav'), wav('long', '02-b.wav'), flac('tone-880', '03-c.flac'), song('04-d.mp3', { title: '04-d', artist: 'Nobody' }, 120))
    await expect(app.rows).toHaveCount(4)
    await app.play('01-a')
    await app.playButton.click()
    await app.expectPaused()
    await app.playButton.click()
    await app.expectPlaying()
    await app.next()
    await app.next()
    await app.previous()
    await app.seekTo(1)
    await app.key('s') // shuffle
    await app.key('r') // repeat
    await app.openTools()
    await app.tools.getByRole('radio', { name: 'Crossfade' }).click()
    await app.tools.getByRole('slider', { name: 'Playback speed' }).fill('1.5')
    await settled(page)
    await app.closeTools()
    await app.play('02-b') // tracks changed one after the other, faster than the files are read
    await app.play('04-d')
    await app.play('01-a')
    await app.reload()
    await expect(app.rows).toHaveCount(4)
    await app.play('03-c')
    await app.expectPlaying()
    await page.waitForTimeout(500) // a failure is written a moment after it happens
    expect(await stored(page)).toBeNull()
    expect(pageErrors).toEqual([])
  })

  test('says so when nothing has gone wrong', async ({ page }) => {
    const app = new PlayerPage(page)
    await app.open()
    const section = await diagnostics(app)
    await expect(section.getByRole('status')).toHaveText('No errors recorded.')
    await expect(section.getByRole('button', { name: 'Copy report' })).toBeDisabled()
    await expect(section.getByRole('button', { name: 'Clear log' })).toBeDisabled()
  })

  test('the same failure again and again is one entry with a count', async ({ page }) => {
    const app = new PlayerPage(page)
    await app.open()
    await page.evaluate(() => {
      for (let i = 0; i < 25; i++) {
        setTimeout(function again() {
          throw new Error('the same thing')
        })
      }
    })
    await expect.poll(async () => (await stored(page))?.entries[0]?.count).toBe(25)
    expect((await stored(page))?.entries).toHaveLength(1)
    const section = await diagnostics(app)
    await expect(section.getByRole('list', { name: 'Recorded errors' }).getByRole('listitem')).toHaveCount(1)
    await expect(section).toContainText('\u00d725')
  })

  test('copies a report that has the entries and where they happened, and none of the names', async ({ page, context }) => {
    await context.grantPermissions(['clipboard-read', 'clipboard-write'])
    const app = new PlayerPage(page)
    await app.open()
    await breakThings(page)
    const section = await diagnostics(app)
    await section.getByRole('button', { name: 'Copy report' }).click()
    await expect(app.toast(/Report copied/)).toBeVisible()
    const report = await page.evaluate(() => navigator.clipboard.readText())
    expect(report).toContain('Wavelocal error report')
    expect(report).toMatch(/Build \S+ \u00b7 \S.* on \S+/)
    expect(report).toContain('2 entries, newest first:')
    expect(report).toContain('\u00b7 error \u00b7 TypeError')
    expect(report).toContain('\u00b7 rejection \u00b7 RangeError')
    expect(report).toContain('Cannot read <text> at <path>')
    expect(report).not.toContain('Zebra')
    expect(report).not.toContain('jane')
    expect(report).not.toMatch(/https?:\/\//) // no links, not even the address of this page
  })

  test('shows the report to copy by hand when the browser will not copy it', async ({ page }) => {
    await page.addInitScript(() => {
      Object.defineProperty(navigator, 'clipboard', { value: { writeText: () => Promise.reject(new DOMException('denied', 'NotAllowedError')) } })
    })
    const app = new PlayerPage(page)
    await app.open()
    await breakThings(page)
    const section = await diagnostics(app)
    await section.getByRole('button', { name: 'Copy report' }).click()
    await expect(app.toast(/would not copy/)).toBeVisible()
    const box = section.getByRole('textbox', { name: 'Report' })
    await expect(box).toHaveValue(/Wavelocal error report/)
    await expect(box).not.toHaveValue(/Zebra/)
  })

  test('is cleared on request, and the clearing can be taken back', async ({ page }) => {
    const app = new PlayerPage(page)
    await app.open()
    await breakThings(page)
    const section = await diagnostics(app)
    await section.getByRole('button', { name: 'Clear log' }).click()
    await expect(section.getByRole('status')).toHaveText('No errors recorded.')
    expect(await stored(page)).toBeNull()
    const cleared = app.toast(/Cleared 2 entries/)
    await expect(cleared).toBeVisible()
    await cleared.getByRole('button', { name: 'Undo' }).click()
    await expect(section.getByRole('list', { name: 'Recorded errors' }).getByRole('listitem')).toHaveCount(2)
    expect(await storedCount(page)).toBe(2)
  })

  test('keeps the entries a full device could not take, and writes them when it can', async ({ page }) => {
    await page.addInitScript(() => {
      const w = window as unknown as { __fullLog: boolean }
      w.__fullLog = false
      const set = Storage.prototype.setItem
      Storage.prototype.setItem = function (this: Storage, key: string, value: string) {
        if (key === 'wl.diagnostics' && w.__fullLog) throw new DOMException('The quota has been exceeded.', 'QuotaExceededError')
        set.call(this, key, value)
      }
    })
    const app = new PlayerPage(page)
    await app.open()
    await page.evaluate(() => void ((window as unknown as { __fullLog: boolean }).__fullLog = true))
    await page.evaluate(() => {
      setTimeout(() => {
        throw new Error('first, while the device is full')
      })
    })
    const section = await diagnostics(app)
    await expect(section.getByRole('list', { name: 'Recorded errors' })).toContainText('first, while the device is full')
    expect(await stored(page)).toBeNull()
    await page.evaluate(() => void ((window as unknown as { __fullLog: boolean }).__fullLog = false))
    await page.evaluate(() => {
      setTimeout(() => {
        throw new Error('second, once there is room')
      })
    })
    await expect.poll(async () => (await stored(page))?.entries.map((e) => e.message)).toEqual(['first, while the device is full', 'second, once there is room'])
  })

  test('records a file the browser could not play as a play error, without its name', async ({ page }) => {
    const app = new PlayerPage(page)
    await app.open()
    await app.importFiles(garbage(`${TITLE}.mp3`), wav('tone-440', 'zz-good.wav'))
    await expect(app.rows).toHaveCount(2)
    await app.row(TITLE).locator('button[aria-current]').click()
    await expect(app.toast(/Skipped/)).toBeVisible({ timeout: 15_000 })
    await expect.poll(async () => (await stored(page))?.entries.find((e) => e.kind === 'play')?.name).toBe('MediaError')
    const section = await diagnostics(app)
    await expect(section.getByRole('list', { name: 'Recorded errors' })).toContainText('MediaError: Media error 4')
    await expect(section).not.toContainText('Zebra')
    expect(JSON.stringify(await stored(page))).not.toContain('Zebra')
  })

  test('records a save that failed quietly, which nobody is told about at the time', async ({ page }) => {
    await page.addInitScript(() => {
      const w = window as unknown as { __full: boolean }
      w.__full = false
      const put = IDBObjectStore.prototype.put
      IDBObjectStore.prototype.put = function (this: IDBObjectStore, value: unknown, key?: IDBValidKey) {
        if (this.name === 'meta' && w.__full) throw new DOMException('The quota has been exceeded.', 'QuotaExceededError')
        return put.call(this, value, key)
      }
    })
    const app = new PlayerPage(page)
    await app.open()
    await app.importFiles(wav('long', '01-a.wav'))
    await expect(app.rows).toHaveCount(1)
    await expect.poll(async () => (await app.storedTracks()).length).toBe(1)
    await app.play('01-a')
    await page.evaluate(() => void ((window as unknown as { __full: boolean }).__full = true))
    await app.playButton.click() // pausing writes the place being played, which is an automatic write
    await expect.poll(async () => (await stored(page))?.entries.find((e) => e.kind === 'save')?.name).toBe('QuotaExceededError')
    const section = await diagnostics(app)
    await expect(section.getByRole('list', { name: 'Recorded errors' })).toContainText('QuotaExceededError: The quota has been exceeded.')
  })

  test('records settings the device had no room to keep, which nobody is told about at the time', async ({ page }) => {
    await page.addInitScript(() => {
      const w = window as unknown as { __noRoom: boolean }
      w.__noRoom = false
      const set = Storage.prototype.setItem
      Storage.prototype.setItem = function (this: Storage, key: string, value: string) {
        if (key === 'wl-settings' && w.__noRoom) throw new DOMException('The quota has been exceeded.', 'QuotaExceededError')
        set.call(this, key, value)
      }
    })
    const app = new PlayerPage(page)
    await app.open()
    await page.evaluate(() => void ((window as unknown as { __noRoom: boolean }).__noRoom = true))
    await app.key('s') // shuffle: a setting changes, and the page tries to keep it
    await expect.poll(async () => (await stored(page))?.entries.find((e) => e.kind === 'save')?.name).toBe('QuotaExceededError')
  })

  test('records a saved library that could not be read, with what the database said', async ({ page }) => {
    const app = new PlayerPage(page)
    await app.open()
    await app.importFiles(wav('tone-440', '01-a.wav'))
    await expect(app.rows).toHaveCount(1)
    await expect.poll(async () => (await app.storedTracks()).length).toBe(1)
    // from the next load on, reading the tracks throws every time, as a database does when it is not ready
    await page.addInitScript(() => {
      if (sessionStorage.getItem('__failReads') !== '1') return
      const getAll = IDBObjectStore.prototype.getAll
      IDBObjectStore.prototype.getAll = function (this: IDBObjectStore, ...args: Parameters<IDBObjectStore['getAll']>) {
        if (this.name === 'tracks') throw new DOMException('Internal error opening backing store', 'UnknownError')
        return getAll.apply(this, args)
      }
    })
    await page.evaluate(() => sessionStorage.setItem('__failReads', '1'))
    await app.reload()
    await expect.poll(async () => (await stored(page))?.entries.find((e) => e.kind === 'library')?.name, { timeout: 15_000 }).toBe('UnknownError')
    expect((await stored(page))?.entries.find((e) => e.kind === 'library')?.message).toContain('Internal error opening backing store')
  })

  test('records the damaged items of a saved library as a count, never their names', async ({ page }) => {
    const app = new PlayerPage(page)
    await app.open()
    await app.importFiles(wav('tone-440', '01-a.wav'))
    await expect(app.rows).toHaveCount(1)
    await expect.poll(async () => (await app.storedTracks()).length).toBe(1)
    await app.putMeta('playlists', [null, { id: 7 }, { id: 'plFine', name: TITLE, trackIds: [] }])
    await app.reload()
    await expect(app.rows).toHaveCount(1)
    await expect(app.toast(/2 damaged items/)).toBeVisible()
    await expect.poll(async () => (await stored(page))?.entries.find((e) => e.kind === 'library')?.message).toMatch(/2 .*left out/)
    expect(JSON.stringify(await stored(page))).not.toContain('Zebra')
  })
})

// ---- the section on a phone, a tablet, a desktop and a TV ----

interface Layout {
  name: string
  viewport: { width: number; height: number }
  tv?: boolean
  touch?: boolean
  /** The smallest side of a button to hit (CSS pixels). Sound & tools buttons are 36 px tall everywhere; WCAG 2.5.8 asks for 24. */
  target: number
}

const LAYOUTS: readonly Layout[] = [
  { name: 'phone', viewport: { width: 390, height: 844 }, touch: true, target: 36 },
  { name: 'tablet', viewport: { width: 820, height: 1180 }, target: 24 },
  { name: 'desktop', viewport: { width: 1280, height: 800 }, target: 24 },
  { name: 'TV', viewport: { width: 1920, height: 1080 }, tv: true, target: 36 },
]

/** Entries in their widest state: messages that fill the line limit, a long name, a count with four digits. */
async function fillLog(page: Page): Promise<void> {
  await page.evaluate(() => {
    for (let i = 0; i < 9; i++) {
      setTimeout(() => {
        throw new Error(`failure number ${i} ${'wide words that make a long line '.repeat(12)}`)
      })
    }
    void Promise.reject(Object.assign(new Error('a name that is long'), { name: 'AnExtremelyLongNameOfAnErrorClassThatGoesOnAndOn' }))
    for (let i = 0; i < 1200; i++) setTimeout(() => void Promise.reject(new Error('many times')))
  })
  await expect.poll(async () => (await stored(page))?.entries.find((e) => e.message === 'many times')?.count).toBe(1200)
}

for (const layout of LAYOUTS) {
  test.describe(`the Diagnostics section on a ${layout.name}`, () => {
    test.use({ viewport: layout.viewport, hasTouch: layout.touch ?? false })

    test('fits, can be hit, and has nothing for axe to find', async ({ page }) => {
      if (layout.tv) await page.addInitScript(() => localStorage.setItem('wl-tv', '1'))
      const app = new PlayerPage(page)
      await app.open()
      await fillLog(page)
      const section = await diagnostics(app, layout.viewport.width >= 768)
      const dialog = app.tools
      const box = (await dialog.boundingBox())!
      const list = section.getByRole('list', { name: 'Recorded errors' })
      await expect(list.getByRole('listitem').first()).toBeVisible()
      for (const name of ['Copy report', 'Clear log']) {
        const button = section.getByRole('button', { name })
        await button.scrollIntoViewIfNeeded()
        const b = (await button.boundingBox())!
        expect(b.width, name).toBeGreaterThanOrEqual(layout.target)
        expect(b.height, name).toBeGreaterThanOrEqual(layout.target)
        expect(b.x, name).toBeGreaterThanOrEqual(box.x - 1)
        expect(b.x + b.width, name).toBeLessThanOrEqual(box.x + box.width + 1)
      }
      // the list scrolls inside its box instead of widening the page, and the page does not scroll sideways
      const listBox = (await list.boundingBox())!
      expect(listBox.x + listBox.width).toBeLessThanOrEqual(box.x + box.width + 1)
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true)
      expect(await list.evaluate((el) => el.scrollWidth <= el.clientWidth + 1)).toBe(true)
      // the keyboard reaches the list (it scrolls), and then the two buttons, in that order
      await list.focus()
      await page.keyboard.press('Tab')
      await expect(section.getByRole('button', { name: 'Copy report' })).toBeFocused()
      await page.keyboard.press('Tab')
      await expect(section.getByRole('button', { name: 'Clear log' })).toBeFocused()
      await settled(page)
      const scan = await new AxeBuilder({ page }).include('[role="dialog"]').withTags(TAGS).analyze()
      expect(scan.violations).toEqual([])
    })
  })
}
