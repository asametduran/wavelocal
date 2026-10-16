import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from '@playwright/test'
import type { Locator } from '@playwright/test'
import { PlayerPage, wav } from './helpers'
import type { Upload } from './helpers'

/** Write synthetic WAVs under `<tmp>/Music/...` and return the `Music` folder (what a folder picker would hand over). */
function makeLibrary(files: Record<string, Upload>): { dir: string; cleanup: () => void } {
  const base = mkdtempSync(join(tmpdir(), 'wavelocal-folders-'))
  const dir = join(base, 'Music')
  for (const [rel, upload] of Object.entries(files)) {
    const target = join(dir, ...rel.split('/'))
    mkdirSync(join(target, '..'), { recursive: true })
    writeFileSync(target, upload.buffer)
  }
  return { dir, cleanup: () => rmSync(base, { recursive: true, force: true }) }
}

test.describe('folder tree browser', () => {
  let app: PlayerPage
  let cleanup: () => void

  const folder = (path: string): Locator => app.sidebar.locator(`[role=treeitem][data-folder="${path}"]`)
  const trackRow = (title: string): Locator => app.sidebar.locator('[role=treeitem][data-track]').filter({ hasText: title })
  const folderButton = (path: string): Locator => folder(path).getByRole('button').first()

  test.beforeEach(async ({ page }) => {
    app = new PlayerPage(page)
    await app.open()
    const lib = makeLibrary({
      'Rock/Album 2/s1.wav': wav('tone-440'),
      'Rock/Album 10/s2.wav': wav('tone-880'),
      'Rock/Album 1/s3.wav': wav('sweep'),
      'Rock/single.wav': wav('tone-440'),
      'Jazz/j1.wav': wav('tone-880'),
      'intro.wav': wav('sweep'),
    })
    cleanup = lib.cleanup
    await page.locator('input[type=file]').nth(1).setInputFiles(lib.dir)
    await expect(app.rows).toHaveCount(6)
    await app.showMode('Folders')
    await expect(app.sidebar.getByRole('tree', { name: 'Library folders' })).toBeVisible()
  })

  test.afterEach(() => cleanup())

  test('mirrors the imported folder structure, opening only the top level at first', async () => {
    await expect(folder('Music')).toHaveAttribute('aria-expanded', 'true')
    await expect(folder('Music/Jazz')).toHaveAttribute('aria-expanded', 'false')
    await expect(folder('Music/Rock')).toHaveAttribute('aria-expanded', 'false')
    await expect(app.sidebar.getByText('6 tracks in 6 folders')).toBeVisible() // Music, Jazz, Rock, Album 1, 2, 10
    await expect(trackRow('j1')).toHaveCount(0) // inside the collapsed Jazz folder
  })

  test('expands and collapses folders, sorting numbered folders naturally', async () => {
    await folderButton('Music/Rock').click()
    await expect(folder('Music/Rock')).toHaveAttribute('aria-expanded', 'true')
    const names = await app.sidebar.locator('[role=treeitem][data-folder^="Music/Rock/"]').evaluateAll((els) => els.map((e) => e.getAttribute('data-folder')))
    expect(names).toEqual(['Music/Rock/Album 1', 'Music/Rock/Album 2', 'Music/Rock/Album 10'])
    await expect(trackRow('single')).toBeVisible() // tracks of the folder itself come after its sub-folders
    await folderButton('Music/Rock').click()
    await expect(folder('Music/Rock/Album 1')).toHaveCount(0)
  })

  test('shows loose files at the top level and plays a track on click', async () => {
    await expect(trackRow('intro')).toBeVisible()
    await trackRow('intro').locator('button[aria-current]').click()
    await app.expectPlaying()
    await expect(app.nowPlayingTitle).toHaveText('intro')
    await expect(trackRow('intro')).toHaveAttribute('aria-selected', 'true')
  })

  test('remembers which folders are open across a reload, and the view mode', async () => {
    await folderButton('Music/Jazz').click()
    await expect(trackRow('j1')).toBeVisible()
    await app.reload()
    await expect(app.sidebar.getByRole('tree', { name: 'Library folders' })).toBeVisible() // still the folder view
    await expect(folder('Music/Jazz')).toHaveAttribute('aria-expanded', 'true')
    await expect(trackRow('j1')).toBeVisible() // the stored path survived in IndexedDB
    await expect(folder('Music/Rock')).toHaveAttribute('aria-expanded', 'false')
  })

  test('search shows matches with their folders opened, and clearing restores the tree', async () => {
    await app.search.fill('s3')
    await expect(trackRow('s3')).toBeVisible()
    await expect(folder('Music/Rock/Album 1')).toHaveAttribute('aria-expanded', 'true')
    await expect(folder('Music/Jazz')).toHaveCount(0)
    await expect(app.sidebar.getByText('1 track in 3 folders')).toBeVisible()
    await app.search.fill('')
    await expect(folder('Music/Jazz')).toBeVisible()
    await expect(trackRow('s3')).toHaveCount(0)
  })

  test('search also matches the folder name', async () => {
    await app.search.fill('jazz')
    await expect(trackRow('j1')).toBeVisible()
    await expect(trackRow('s1')).toHaveCount(0)
  })

  test('keyboard: arrows move, right/left expand and collapse, enter plays', async ({ page }) => {
    await folderButton('Music').focus()
    await page.keyboard.press('ArrowDown') // Music/Jazz
    await expect(folderButton('Music/Jazz')).toBeFocused()
    await page.keyboard.press('ArrowRight') // open Jazz
    await expect(folder('Music/Jazz')).toHaveAttribute('aria-expanded', 'true')
    await page.keyboard.press('ArrowRight') // into Jazz
    await expect(trackRow('j1').locator('button[aria-current]')).toBeFocused()
    await page.keyboard.press('ArrowLeft') // back to the parent folder
    await expect(folderButton('Music/Jazz')).toBeFocused()
    await page.keyboard.press('ArrowLeft') // collapse it
    await expect(folder('Music/Jazz')).toHaveAttribute('aria-expanded', 'false')
    await page.keyboard.press('End')
    await expect(trackRow('intro').locator('button[aria-current]')).toBeFocused()
    await page.keyboard.press('Enter')
    await app.expectPlaying()
    await expect(app.nowPlayingTitle).toHaveText('intro')
    await page.keyboard.press('Home')
    await expect(folderButton('Music')).toBeFocused()
  })

  test('only the focused row is in the tab order (roving tabindex)', async () => {
    await expect(app.sidebar.locator('[role=tree] [data-idx="0"] button[tabindex="0"]').first()).toBeVisible()
    await expect(app.sidebar.locator('[role=tree] [data-idx="1"] button[tabindex="0"]')).toHaveCount(0)
  })

  test('"Play folder" starts the first track of that folder', async () => {
    await folder('Music/Jazz').hover()
    await folder('Music/Jazz').getByRole('button', { name: 'Play folder Jazz' }).click()
    await app.expectPlaying()
    await expect(app.nowPlayingTitle).toHaveText('j1')
  })

  test('"Save as playlist" collects every track below a folder', async () => {
    await folder('Music/Rock').hover()
    await folder('Music/Rock').getByRole('button', { name: 'Save folder Rock as playlist' }).click()
    await expect(app.viewSelect.locator('option', { hasText: 'Rock' })).toHaveText('Rock (4)')
  })

  test('"Show playing track" opens the folders above it and brings it into view', async () => {
    // start a deep track from the list view, then return to the tree
    await app.showMode('Tracks')
    await app.play('s3')
    await app.showMode('Folders')
    await expect(folder('Music/Rock/Album 1')).toHaveCount(0)
    await app.sidebar.getByRole('button', { name: 'Show playing track' }).click()
    await expect(folder('Music/Rock')).toHaveAttribute('aria-expanded', 'true')
    await expect(folder('Music/Rock/Album 1')).toHaveAttribute('aria-expanded', 'true')
    await expect(trackRow('s3')).toBeInViewport()
  })

  test('expand all / collapse all', async () => {
    await app.sidebar.getByRole('button', { name: 'Expand all' }).click()
    await expect(trackRow('s1')).toBeVisible()
    await expect(trackRow('j1')).toBeVisible()
    await app.sidebar.getByRole('button', { name: 'Collapse all' }).click()
    await expect(folder('Music/Jazz')).toHaveCount(0)
    await expect(folder('Music')).toHaveAttribute('aria-expanded', 'false')
  })

  test('removing a track from the tree updates counts and prunes empty folders', async () => {
    await folderButton('Music/Jazz').click()
    await trackRow('j1').hover()
    await trackRow('j1').getByRole('button', { name: 'Remove j1' }).click()
    await expect(folder('Music/Jazz')).toHaveCount(0) // Jazz is empty now: gone from the tree
    await expect(app.sidebar.getByText('5 tracks in 5 folders')).toBeVisible()
  })

  test('the tag editor opens from a tree row', async () => {
    await trackRow('intro').hover()
    await trackRow('intro').getByRole('button', { name: 'Edit tags of intro' }).click()
    await expect(app.page.getByRole('dialog')).toBeVisible()
  })

  test('switching back to the list keeps every track', async () => {
    await app.showMode('Tracks')
    await expect(app.rows).toHaveCount(6)
  })

  test('files added one by one (no folder) land at the top level', async () => {
    await app.importFiles(wav('tone-440', 'loose-a.wav'))
    await expect(trackRow('loose-a')).toBeVisible()
    await expect(trackRow('loose-a')).toHaveAttribute('aria-level', '1')
  })
})
