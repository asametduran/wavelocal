import AxeBuilder from '@axe-core/playwright'
import { expect, test } from '@playwright/test'
import type { Page } from '@playwright/test'
import { PlayerPage, wav } from './helpers'

/** Whether the focused element is inside the (single) question dialog. */
const focusInDialog = (page: Page): Promise<boolean> => page.evaluate(() => !!document.activeElement?.closest('[data-testid="dialog"]'))

test.describe('in-app dialogs and toasts', () => {
  let app: PlayerPage

  test.beforeEach(async ({ page }) => {
    app = new PlayerPage(page)
    await app.open()
    await app.importFiles(wav('tone-440', 'a.wav'), wav('tone-880', 'b.wav'))
    await expect(app.rows).toHaveCount(2)
  })

  test('a name prompt is a labelled dialog with its field focused; Enter confirms and focus goes back where it came from', async ({ page }) => {
    await app.viewSelect.focus()
    await app.viewSelect.selectOption('__new')
    const dialog = page.getByRole('dialog', { name: 'New playlist' })
    await expect(dialog).toBeVisible()
    const field = dialog.getByRole('textbox', { name: 'Playlist name' })
    await expect(field).toBeFocused()

    await field.fill('Road Trip')
    await page.keyboard.press('Enter')
    await expect(dialog).toHaveCount(0)
    await expect(app.viewSelect.locator('option', { hasText: 'Road Trip' })).toHaveText('Road Trip (0)')
    await expect(app.viewSelect).toBeFocused()
  })

  test('Escape cancels the question, and the dialog under it stays open', async ({ page }) => {
    await app.play('a')
    await app.openTools()
    await app.tools.getByRole('button', { name: 'Save preset…' }).click()
    await expect(app.question).toBeVisible()
    await expect(app.question.getByRole('textbox', { name: 'Preset name' })).toBeFocused()

    await page.keyboard.press('Escape')
    await expect(app.question).toBeHidden()
    await expect(app.tools).toBeVisible()
    await expect(app.tools.getByRole('button', { name: 'Save preset…' })).toBeFocused()
  })

  test('the page behind a question is inert: Tab stays inside it, and everything is let back in when it closes', async ({ page }) => {
    await app.sidebar.getByRole('button', { name: 'Clear library' }).click()
    await expect(app.question).toBeVisible()
    expect(await page.locator('#root').evaluate((el) => el.hasAttribute('inert'))).toBe(true)
    for (let i = 0; i < 12; i++) {
      await page.keyboard.press(i % 5 === 4 ? 'Shift+Tab' : 'Tab')
      expect(await focusInDialog(page), `Tab press ${i + 1}`).toBe(true)
    }
    await page.keyboard.press('Escape')
    await expect(app.question).toBeHidden()
    expect(await page.locator('#root').evaluate((el) => el.hasAttribute('inert'))).toBe(false)
    await expect(app.sidebar.getByRole('button', { name: 'Clear library' })).toBeFocused()
  })

  test('a destructive question starts on Cancel, so a stray Enter keeps the music', async ({ page }) => {
    await app.sidebar.getByRole('button', { name: 'Clear library' }).click()
    const dialog = page.getByRole('alertdialog', { name: 'Remove every track from your library?' })
    await expect(dialog).toBeVisible()
    await expect(dialog.getByRole('button', { name: 'Cancel' })).toBeFocused()
    await page.keyboard.press('Enter')
    await expect(dialog).toBeHidden()
    await expect(app.rows).toHaveCount(2)

    await app.sidebar.getByRole('button', { name: 'Clear library' }).click()
    await dialog.getByRole('button', { name: 'Clear library' }).click()
    await expect(app.rows).toHaveCount(0)
  })

  test('clicking outside the question cancels it', async ({ page }) => {
    await app.sidebar.getByRole('button', { name: 'Clear library' }).click()
    await expect(app.question).toBeVisible()
    await page.mouse.click(4, 4)
    await expect(app.question).toBeHidden()
    await expect(app.rows).toHaveCount(2)
  })

  test('typing in a question does not reach the player shortcuts', async ({ page }) => {
    await app.play('a')
    await app.viewSelect.selectOption('__new')
    const field = app.question.getByRole('textbox', { name: 'Playlist name' })
    await field.pressSequentially('mmm sss nnn rrr')
    await expect(field).toHaveValue('mmm sss nnn rrr')
    await app.answerDialog(false)
    await app.expectPlaying()
    await expect(app.nowPlayingTitle).toHaveText('a')
  })

  test('a toast is announced as a status, can be dismissed, and at most three are kept', async () => {
    await app.play('a')
    await app.importFiles(wav('tone-440', 'c.wav'), wav('tone-880', 'd.wav'))
    await expect(app.rows).toHaveCount(4)
    for (const title of ['a', 'b', 'c', 'd']) await app.queueTrack(title, 'Play next')

    await expect(app.toast('Playing next: d')).toBeVisible()
    await expect(app.toast('Playing next: b')).toBeVisible()
    await expect(app.toast('Playing next: a')).toHaveCount(0) // the oldest made room
    await app.toast('Playing next: d').getByRole('button', { name: 'Dismiss' }).click()
    await expect(app.toast('Playing next: d')).toHaveCount(0)
    await expect(app.toast('Playing next: c')).toBeVisible()
  })

  test('a toast leaves by itself, but waits while the pointer is on it', async ({ page }) => {
    await page.clock.install()
    await app.play('a')
    await app.queueTrack('b', 'Play next')
    const toast = app.toast('Playing next: b')
    await expect(toast).toBeVisible()

    await toast.hover()
    await page.clock.fastForward(30_000)
    await expect(toast).toBeVisible()

    await page.mouse.move(600, 300)
    await page.clock.fastForward(30_000)
    await expect(toast).toHaveCount(0)
  })

  test('Ctrl+Z leaves a text field its own undo, and otherwise takes back the latest toast action', async ({ page }) => {
    await app.viewSelect.selectOption('__new')
    await app.answerDialog(true, 'Doomed')
    await app.playlistAction('Delete playlist')
    await expect(app.viewSelect.locator('option', { hasText: 'Doomed' })).toHaveCount(0)
    await expect(app.toast('Deleted “Doomed”')).toBeVisible()

    await app.search.fill('abc')
    await app.search.press('Control+z')
    await expect(app.viewSelect.locator('option', { hasText: 'Doomed' })).toHaveCount(0)

    await app.blur()
    await page.keyboard.press('Control+z')
    await expect(app.viewSelect.locator('option', { hasText: 'Doomed' })).toHaveCount(1)
    await expect(app.toast('Deleted “Doomed”')).toHaveCount(0)
  })

  test('a notice has an OK and nothing to cancel', async ({ page }) => {
    // importing a playlist file that names tracks the library does not have ends in a notice that lists them
    await app.importFiles({ name: 'mix.m3u8', mimeType: 'audio/x-mpegurl', buffer: Buffer.from('#EXTM3U\nmissing-one.mp3\nmissing-two.mp3\n') })
    const dialog = page.getByRole('dialog', { name: /Nothing to import/ })
    await expect(dialog).toBeVisible()
    await expect(dialog).toContainText('missing-one.mp3')
    await expect(dialog.getByRole('button', { name: 'Cancel' })).toHaveCount(0)
    await app.answerDialog(true)
  })

  test('has no accessibility violations with a question or a toast on screen', async ({ page }) => {
    const check = async (state: string) => {
      const { violations } = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa', 'best-practice']).analyze()
      expect(
        violations.map((v) => `${v.id}: ${v.help} (${v.nodes.map((n) => n.target.join(' ')).join(' | ')})`),
        `accessibility violations in: ${state}`,
      ).toEqual([])
    }
    await app.play('a')
    await app.queueTrack('b', 'Play next')
    await expect(app.toast('Playing next: b')).toHaveCSS('opacity', '1') // the fade-in is over: colours are measured as they rest
    await check('a toast with an undo')

    await app.viewSelect.selectOption('__new')
    await expect(app.question).toHaveCSS('opacity', '1')
    await check('a name prompt')
    await app.answerDialog(false)

    await app.sidebar.getByRole('button', { name: 'Clear library' }).click()
    await expect(app.question).toHaveCSS('opacity', '1')
    await check('a destructive question')
    await app.answerDialog(false)
  })

  test.describe('Back', () => {
    /** Where the page is in its history (the Navigation API counts entries, whatever pushed them). */
    const entry = (page: Page) => page.evaluate(() => (window as unknown as { navigation: { currentEntry: { index: number } } }).navigation.currentEntry.index)

    test('Back cancels a question instead of leaving the app, and answering by button leaves the history as it was', async ({ page }) => {
      const start = await entry(page)

      await app.viewSelect.selectOption('__new')
      await expect(app.question).toBeVisible()
      expect(await entry(page)).toBe(start + 1)
      await app.answerDialog(false)
      await expect.poll(() => entry(page)).toBe(start) // the question's own entry is taken away again

      await app.sidebar.getByRole('button', { name: 'Clear library' }).click()
      await expect(app.question).toBeVisible()
      await page.goBack()
      await expect(app.question).toBeHidden()
      await expect(app.rows).toHaveCount(2) // cancelled, not confirmed
      expect(await entry(page)).toBe(start)
      expect(page.url()).toMatch(/^http:\/\/127\.0\.0\.1/) // still on the app
    })

    test('Back cancels the question and leaves the sheet under it open; the next Back closes the sheet', async ({ page }) => {
      await app.play('a')
      await app.openTools()
      await app.tools.getByRole('button', { name: 'Save preset…' }).click()
      await expect(app.question).toBeVisible()

      await page.goBack()
      await expect(app.question).toBeHidden()
      await expect(app.tools).toBeVisible()

      await page.goBack()
      await expect(app.tools).toBeHidden()
    })

    test('answering a question that sits over a sheet does not close the sheet', async ({ page }) => {
      await app.play('a')
      await app.openTools()
      await app.tools.getByRole('button', { name: 'Save preset…' }).click()
      await app.answerDialog(true, 'Kept')
      await page.waitForTimeout(300) // the entry the question added is taken away behind the scenes
      await expect(app.tools).toBeVisible()
      await expect(app.tools.getByRole('button', { name: 'Kept', exact: true })).toBeVisible()
    })

    test('with questions waiting, each Back answers one of them', async ({ page }) => {
      const start = await entry(page)
      await app.importFiles(
        { name: 'one.m3u8', mimeType: 'audio/x-mpegurl', buffer: Buffer.from('#EXTM3U\nnowhere-1.mp3\n') },
        { name: 'two.m3u8', mimeType: 'audio/x-mpegurl', buffer: Buffer.from('#EXTM3U\nnowhere-2.mp3\n') },
      )
      await expect(page.getByRole('dialog', { name: /Nothing to import from “one”/ })).toBeVisible()
      await page.goBack()
      await expect(page.getByRole('dialog', { name: /Nothing to import from “two”/ })).toBeVisible()
      await page.goBack()
      await expect(app.question).toBeHidden()
      await expect.poll(() => entry(page)).toBe(start)
    })

    test("a remote's Back key cancels the question and leaves the sheet under it alone", async ({ page }) => {
      await app.play('a')
      await app.openTools()
      await app.tools.getByRole('button', { name: 'Save preset…' }).click()
      await expect(app.question).toBeVisible()

      await page.evaluate(() => document.activeElement?.dispatchEvent(new KeyboardEvent('keydown', { key: 'GoBack', bubbles: true, cancelable: true })))
      await expect(app.question).toBeHidden()
      await expect(app.tools).toBeVisible()
    })
  })
})
