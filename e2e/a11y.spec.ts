import AxeBuilder from '@axe-core/playwright'
import { expect, test } from '@playwright/test'
import type { Page } from '@playwright/test'
import { PlayerPage, lrc, settled, wav } from './helpers'
import { AA, SURFACES, contrastRatio, parseHex } from '../src/lib/contrast'

const TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa', 'best-practice']

/** Run axe over the current page state and fail with a readable list of every violation. */
async function expectNoViolations(page: Page, state: string): Promise<void> {
  await settled(page) // not while a dialog is still fading in: half-faded colours read as too little contrast
  const { violations } = await new AxeBuilder({ page }).withTags(TAGS).analyze()
  const report = violations.map((v) => {
    const nodes = v.nodes
      .slice(0, 6)
      .map((n) => `    ${n.target.join(' ')}\n      ${(n.any[0]?.message ?? n.all[0]?.message ?? n.none[0]?.message ?? n.failureSummary ?? '').replace(/\n/g, ' ')}`)
      .join('\n')
    return `${v.id} [${v.impact}] ${v.help} (${v.nodes.length} nodes)\n${nodes}`
  })
  expect(report, `accessibility violations in: ${state}`).toEqual([])
}

const LINES = [
  [0, 'first line'],
  [1, 'second line'],
  [2, 'third line'],
] as const

test.describe('automated audit (axe-core, WCAG 2.2 AA + best practices)', () => {
  let app: PlayerPage

  test.beforeEach(async ({ page }) => {
    app = new PlayerPage(page)
    await app.open()
  })

  test('empty library', async ({ page }) => {
    await expectNoViolations(page, 'empty library')
  })

  test('library with a playing track, both stage tabs and search', async ({ page }) => {
    // a is the 30 s fixture: a 4 s track can end while the audits are still scanning, and b (which plays after it) has no lyrics
    await app.importFiles(wav('long', 'a.wav'), wav('tone-880', 'b.wav'), lrc('a.lrc', LINES))
    await app.play('a')
    await expectNoViolations(page, 'artwork tab')
    await app.stage.getByRole('tab', { name: /^Lyrics/ }).click()
    await expect(app.stage.getByRole('region', { name: 'Lyrics' })).toBeVisible()
    await expectNoViolations(page, 'lyrics tab')
    await app.search.fill('zzz')
    await expectNoViolations(page, 'search without matches')
  })

  test('folder view', async ({ page }) => {
    await app.importFiles(wav('tone-440', 'a.wav'), wav('tone-880', 'b.wav'))
    await app.showMode('Folders')
    await expect(app.sidebar.getByRole('tree', { name: 'Library folders' })).toBeVisible()
    await expectNoViolations(page, 'folder view')
  })

  test('sound tools dialog', async ({ page }) => {
    await app.importFiles(wav('tone-440', 'a.wav'))
    await app.play('a')
    await app.openTools()
    await expectNoViolations(page, 'sound tools (graphic EQ)')
    await app.tools.getByRole('tab', { name: 'parametric' }).click()
    await expectNoViolations(page, 'sound tools (parametric EQ)')
  })

  test('keyboard shortcut list', async ({ page }) => {
    await app.blur()
    await page.keyboard.press('?')
    await expect(page.getByRole('dialog', { name: 'Keyboard shortcuts' })).toBeVisible()
    await expectNoViolations(page, 'shortcut list')
  })

  test('tag editor', async ({ page }) => {
    await app.importFiles(wav('tone-440', 'a.wav'))
    await app.row('a').hover()
    await app.row('a').getByRole('button', { name: 'Edit tags of a' }).click()
    await expect(page.getByRole('dialog', { name: 'Edit tags' })).toBeVisible()
    await expectNoViolations(page, 'tag editor')
  })

  test.describe('phone layout', () => {
    test.use({ viewport: { width: 390, height: 844 }, hasTouch: true })

    test('mini player, now playing sheet and queue sheet', async ({ page }) => {
      await app.importFiles(wav('tone-440', 'a.wav'), wav('tone-880', 'b.wav'))
      await expectNoViolations(page, 'phone library')
      await app.rows.first().locator('button[aria-current]').click()
      await expect(page.getByRole('button', { name: 'Open now playing' })).toBeVisible()
      await expectNoViolations(page, 'phone with mini player')
      await page.getByRole('button', { name: 'Open now playing' }).click()
      await expect(page.getByRole('dialog', { name: 'Now playing' })).toBeVisible()
      await expectNoViolations(page, 'now playing sheet')
      await page.getByRole('button', { name: 'Open queue' }).click()
      await expect(page.getByRole('dialog', { name: 'Queue' })).toBeVisible()
      await expectNoViolations(page, 'queue sheet')
    })
  })
})

test.describe('keyboard and focus', () => {
  let app: PlayerPage

  test.beforeEach(async ({ page }) => {
    app = new PlayerPage(page)
    await app.open()
  })

  const focusInside = (page: Page, selector: string) => page.evaluate((s) => !!document.activeElement?.closest(s), selector)

  test('skip links are the first tab stops and jump to the library and player controls', async ({ page }) => {
    await app.importFiles(wav('tone-440', 'a.wav'))
    await page.keyboard.press('Tab')
    const toLibrary = page.getByRole('link', { name: 'Skip to library' })
    await expect(toLibrary).toBeFocused()
    await expect(toLibrary).toBeInViewport()
    await page.keyboard.press('Enter')
    expect(await focusInside(page, '#library')).toBe(true)

    await page.getByRole('link', { name: 'Skip to player controls' }).focus()
    await page.keyboard.press('Enter')
    expect(await focusInside(page, '#player')).toBe(true)
  })

  test('the sound tools dialog takes focus, keeps Tab inside, hides the page behind it and gives focus back', async ({ page }) => {
    await app.importFiles(wav('tone-440', 'a.wav'))
    await app.play('a')
    const opener = app.footer.getByRole('button', { name: /^Equalizer, sleep timer/ })
    await opener.focus()
    await page.keyboard.press('Enter')
    await expect(app.tools).toBeVisible()
    expect(await focusInside(page, '[role="dialog"][aria-label="Sound and tools"]')).toBe(true)
    expect(await page.locator('main').evaluate((el) => !!el.closest('[inert]'))).toBe(true)

    for (let i = 0; i < 70; i++) {
      await page.keyboard.press(i % 7 === 6 ? 'Shift+Tab' : 'Tab')
      expect(await focusInside(page, '[role="dialog"][aria-label="Sound and tools"]'), `Tab press ${i + 1}`).toBe(true)
    }

    await page.keyboard.press('Escape')
    await expect(app.tools).toBeHidden()
    await expect(opener).toBeFocused()
    expect(await page.locator('main').evaluate((el) => !!el.closest('[inert]'))).toBe(false)
  })

  test('the shortcut list opens with ? and closes with Escape', async ({ page }) => {
    await app.importFiles(wav('tone-440', 'a.wav'))
    await app.blur()
    await page.keyboard.press('?')
    const dialog = page.getByRole('dialog', { name: 'Keyboard shortcuts' })
    await expect(dialog).toBeVisible()
    expect(await focusInside(page, '[aria-labelledby="shortcuts-title"]')).toBe(true)
    await page.keyboard.press('Tab')
    await page.keyboard.press('Tab')
    expect(await focusInside(page, '[aria-labelledby="shortcuts-title"]')).toBe(true)
    await page.keyboard.press('Escape')
    await expect(dialog).toBeHidden()
  })

  test('the tag editor traps Tab and returns focus to the row button that opened it', async ({ page }) => {
    await app.importFiles(wav('tone-440', 'a.wav'))
    const edit = app.row('a').getByRole('button', { name: 'Edit tags of a' })
    await edit.focus()
    await page.keyboard.press('Enter')
    const dialog = page.getByRole('dialog', { name: 'Edit tags' })
    await expect(dialog).toBeVisible()
    await expect(dialog.getByLabel('Title')).toBeFocused()
    for (let i = 0; i < 14; i++) {
      await page.keyboard.press('Tab')
      expect(await focusInside(page, '[role="dialog"][aria-modal="true"]'), `Tab press ${i + 1}`).toBe(true)
    }
    await page.keyboard.press('Shift+Tab')
    expect(await focusInside(page, '[role="dialog"][aria-modal="true"]')).toBe(true)
    await page.keyboard.press('Escape')
    await expect(dialog).toHaveCount(0)
    await expect(edit).toBeFocused()
  })

  test('the stage tabs follow the tab pattern: one tab stop, arrows select, panel is labelled', async ({ page }) => {
    await app.importFiles(wav('tone-440', 'a.wav'), lrc('a.lrc', LINES))
    await app.play('a')
    const art = app.stage.getByRole('tab', { name: 'Artwork' })
    const lyrics = app.stage.getByRole('tab', { name: /^Lyrics/ })
    const queue = app.stage.getByRole('tab', { name: /^Up Next/ })
    await expect(art).toHaveAttribute('tabindex', '0')
    await expect(lyrics).toHaveAttribute('tabindex', '-1')
    await expect(queue).toHaveAttribute('tabindex', '-1')
    await art.focus()
    await page.keyboard.press('ArrowRight')
    await expect(lyrics).toBeFocused()
    await expect(lyrics).toHaveAttribute('aria-selected', 'true')
    await expect(lyrics).toHaveAttribute('tabindex', '0')
    const panel = app.stage.getByRole('tabpanel')
    await expect(panel).toBeVisible()
    await expect(panel).toHaveAccessibleName(/Lyrics/)
    await page.keyboard.press('ArrowRight')
    await expect(queue).toBeFocused()
    await expect(queue).toHaveAttribute('aria-selected', 'true')
    await expect(panel).toHaveAccessibleName(/Up Next/)
    await page.keyboard.press('ArrowRight') // wraps
    await expect(art).toBeFocused()
    await expect(art).toHaveAttribute('aria-selected', 'true')
    await page.keyboard.press('End')
    await expect(queue).toBeFocused()
    await page.keyboard.press('Home')
    await expect(art).toBeFocused()
  })

  test('radio groups use arrow keys and expose a single tab stop', async ({ page }) => {
    await app.importFiles(wav('tone-440', 'a.wav'))
    await app.play('a')
    await app.openTools()
    const group = app.tools.getByRole('radiogroup', { name: 'Track transitions' })
    const off = group.getByRole('radio', { name: 'Off' })
    await off.click()
    await expect(off).toHaveAttribute('aria-checked', 'true')
    await expect(group.getByRole('radio', { name: 'Gapless' })).toHaveAttribute('tabindex', '-1')
    await page.keyboard.press('ArrowRight')
    await expect(group.getByRole('radio', { name: 'Gapless' })).toBeFocused()
    await expect(group.getByRole('radio', { name: 'Gapless' })).toHaveAttribute('aria-checked', 'true')
    await page.keyboard.press('ArrowLeft')
    await page.keyboard.press('ArrowLeft')
    await expect(group.getByRole('radio', { name: 'Crossfade' })).toHaveAttribute('aria-checked', 'true')
  })

  test('Alt+Arrow moves a track without dragging, keeps focus on it and announces the move', async ({ page }) => {
    await app.importFiles(wav('tone-440', 'a.wav'), wav('sweep', 'b.wav'), wav('tone-880', 'c.wav'))
    await expect.poll(() => app.titles()).toEqual(['a', 'b', 'c'])
    const aButton = app.row('a').locator('button[aria-current]')
    await aButton.focus()
    await page.keyboard.press('Alt+ArrowDown')
    await expect.poll(() => app.titles()).toEqual(['b', 'a', 'c'])
    await expect(aButton).toBeFocused()
    await expect(page.getByTestId('announcer')).toHaveText('a moved to position 2 of 3')
    await page.keyboard.press('Alt+ArrowDown')
    await page.keyboard.press('Alt+ArrowDown') // already last: no change
    await expect.poll(() => app.titles()).toEqual(['b', 'c', 'a'])
    await page.keyboard.press('Alt+ArrowUp')
    await expect.poll(() => app.titles()).toEqual(['b', 'a', 'c'])
    await expect(aButton).toBeFocused()
  })

  test('rows say where they are in the list', async () => {
    await app.importFiles(wav('tone-440', 'a.wav'), wav('sweep', 'b.wav'))
    await expect(app.sidebar.getByRole('list', { name: 'Library tracks' })).toBeVisible()
    await expect(app.row('b')).toHaveAttribute('aria-posinset', '2')
    await expect(app.row('b')).toHaveAttribute('aria-setsize', '2')
  })

  test('track changes and play state are announced to screen readers', async ({ page }) => {
    await app.importFiles(wav('tone-440', 'a.wav'), wav('sweep', 'b.wav'))
    await app.play('a')
    await expect(page.getByTestId('announcer')).toHaveText(/Now playing: a/)
    await app.footer.getByRole('button', { name: 'Next (N)' }).click()
    await expect(page.getByTestId('announcer')).toHaveText(/Now playing: b/)
    await app.footer.getByRole('button', { name: /^Pause/ }).click()
    await expect(page.getByTestId('announcer')).toHaveText(/Paused/)
  })

  test('search results are announced', async ({ page }) => {
    await app.importFiles(wav('tone-440', 'alpha.wav'), wav('sweep', 'beta.wav'))
    await app.search.fill('alp')
    await expect(page.getByTestId('announcer')).toHaveText('1 track matches')
    await app.search.fill('zzz')
    await expect(page.getByTestId('announcer')).toHaveText('No tracks match your search')
  })

  test('the add-to-playlist menu is keyboard operable and returns focus', async ({ page }) => {
    await app.importFiles(wav('tone-440', 'a.wav'))
    const trigger = app.row('a').getByRole('button', { name: 'Add a to playlist' })
    await trigger.focus()
    await page.keyboard.press('Enter')
    const menu = page.getByRole('menu', { name: 'Add a to a playlist' })
    await expect(menu).toBeVisible()
    await expect(menu.getByRole('menuitem').first()).toBeFocused()
    await page.keyboard.press('Escape')
    await expect(menu).toHaveCount(0)
    await expect(trigger).toBeFocused()
  })

  test('sliders speak their value instead of a raw number', async ({ page }) => {
    await app.importFiles(wav('tone-440', 'a.wav'))
    await app.play('a')
    await expect.poll(() => app.duration()).toBeGreaterThan(0)
    await expect(app.seekBar).toHaveAttribute('aria-valuetext', /(second|minute)/)
    await expect(app.footer.getByRole('slider', { name: 'Volume' })).toHaveAttribute('aria-valuetext', /percent|Muted/)
    await app.openTools()
    await expect(app.tools.getByRole('slider', { name: 'Playback speed' })).toHaveAttribute('aria-valuetext', /times normal speed/)
    await page.keyboard.press('Escape')
  })

  test('plain lyrics are text, and the active synced line is marked', async ({ page }) => {
    await app.importFiles(wav('tone-440', 'a.wav'), lrc('a.lrc', LINES))
    await app.play('a')
    await app.stage.getByRole('tab', { name: /^Lyrics/ }).click()
    const region = app.stage.getByRole('region', { name: 'Lyrics' })
    await expect(region).toHaveAttribute('tabindex', '0')
    await expect(region.locator('button[aria-current="true"]')).toHaveCount(1)
    await expect(page.locator('button[disabled]:has-text("line")')).toHaveCount(0)
  })
})

test.describe('motion, contrast and colour preferences', () => {
  test('the system "reduce motion" setting switches animation off, and the user can override it', async ({ page }) => {
    await page.emulateMedia({ reducedMotion: 'reduce' })
    const app = new PlayerPage(page)
    await app.open()
    await expect(page.locator('html')).toHaveClass(/reduce-motion/)
    await app.importFiles(wav('tone-440', 'a.wav'))
    await app.play('a')
    await app.openTools()
    const seconds = await app.tools.locator('div.animate-fadeIn').evaluate((el) => parseFloat(getComputedStyle(el).animationDuration))
    expect(seconds).toBeLessThan(0.001)
    await expect(app.tools.getByRole('radio', { name: 'Follow device' })).toHaveAttribute('aria-checked', 'true')
    await app.tools.getByRole('radio', { name: 'Full motion' }).click()
    await expect(page.locator('html')).not.toHaveClass(/reduce-motion/)
  })

  test('the in-app motion setting is remembered across reloads', async ({ page }) => {
    const app = new PlayerPage(page)
    await app.open()
    await expect(page.locator('html')).not.toHaveClass(/reduce-motion/)
    await app.importFiles(wav('tone-440', 'a.wav'))
    await app.play('a')
    await app.openTools()
    await app.tools.getByRole('radio', { name: 'Reduce motion' }).click()
    await expect(page.locator('html')).toHaveClass(/reduce-motion/)
    await app.reload()
    await expect(page.locator('html')).toHaveClass(/reduce-motion/)
  })

  test('a custom accent that is too dark is lightened until it is readable', async ({ page }) => {
    const app = new PlayerPage(page)
    await app.open()
    await app.importFiles(wav('tone-440', 'a.wav'))
    await app.play('a')
    await app.openTools()
    await app.tools.getByLabel('Custom accent color').fill('#000020')
    await expect(app.tools.getByText(/too dark to read/)).toBeVisible()
    const shown = parseHex(await page.evaluate(() => document.documentElement.style.getPropertyValue('--accent-hex')))
    expect(shown).not.toBeNull()
    for (const surface of SURFACES) expect(contrastRatio(shown ?? [0, 0, 0], surface)).toBeGreaterThanOrEqual(AA.text)
  })

  test('filled accent buttons keep AA contrast between fill and text', async ({ page }) => {
    const app = new PlayerPage(page)
    await app.open()
    await app.importFiles(wav('tone-440', 'a.wav'))
    await app.play('a')
    await app.openTools()
    const colors = await page.evaluate(() => {
      const el = document.querySelector<HTMLElement>('[role="dialog"] [role="radio"][aria-checked="true"].bg-accent, [role="dialog"] button[aria-pressed="true"].bg-accent')
      if (!el) return null
      const s = getComputedStyle(el)
      return { bg: s.backgroundColor, fg: s.color }
    })
    expect(colors).not.toBeNull()
    const channels = (css: string) => (css.match(/\d+(\.\d+)?/g) ?? []).slice(0, 3).map(Number)
    const [br = 0, bg = 0, bb = 0] = channels(colors?.bg ?? '')
    const [fr = 0, fg = 0, fb = 0] = channels(colors?.fg ?? '')
    expect(contrastRatio([br, bg, bb], [fr, fg, fb])).toBeGreaterThanOrEqual(AA.text)
  })
})
