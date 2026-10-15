import { readFile } from 'node:fs/promises'
import { expect, test } from '@playwright/test'
import { PlayerPage, wav } from './helpers'
import type { Upload } from './helpers'
import { buildId3v2, withId3 } from '../src/test-utils/id3'
import { decodeTextBody, parseId3v2 } from '../src/lib/id3write'

/** A valid 1x1 PNG. */
const PNG_1PX = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64')

/** Not decodable audio, but a real MPEG frame stream with an ID3v2 tag: enough to import, list and re-tag. */
const FRAMES = Uint8Array.from({ length: 4000 }, (_, i) => (i % 417 < 4 ? [0xff, 0xfb, 0x90, 0x00][i % 417]! : (i * 7) & 0x7f))
const mp3 = (name: string, tags: Parameters<typeof buildId3v2>[0]): Upload => ({
  name,
  mimeType: 'audio/mpeg',
  buffer: Buffer.from(withId3(buildId3v2(tags), FRAMES)),
})

test.describe('tag editor', () => {
  let app: PlayerPage
  const pageErrors: string[] = []

  test.beforeEach(async ({ page }) => {
    pageErrors.length = 0
    page.on('pageerror', (e) => pageErrors.push(e.message))
    app = new PlayerPage(page)
    await app.open()
  })

  test.afterEach(() => {
    expect(pageErrors).toEqual([])
  })

  const dialog = () => app.page.getByRole('dialog', { name: 'Edit tags' })
  const titleField = () => dialog().getByLabel('Title')
  const artistField = () => dialog().getByLabel('Artist')
  const albumField = () => dialog().getByLabel('Album')
  const saveButton = () => dialog().getByRole('button', { name: 'Save', exact: true })

  async function openEditor(title: string) {
    await app.row(title).hover()
    await app.row(title).getByRole('button', { name: `Edit tags of ${title}` }).click()
    await expect(dialog()).toBeVisible()
  }

  test('opens prefilled, focuses the title and keeps Save disabled until something changes', async () => {
    await app.importFiles(mp3('a.mp3', { title: 'Old Title', artist: 'Old Band', album: 'Old LP' }), wav('tone-440', 'b.wav'))
    await openEditor('Old Title')
    await expect(titleField()).toHaveValue('Old Title')
    await expect(artistField()).toHaveValue('Old Band')
    await expect(albumField()).toHaveValue('Old LP')
    await expect(titleField()).toBeFocused()
    await expect(saveButton()).toBeDisabled()
    await albumField().fill('Another LP')
    await expect(saveButton()).toBeEnabled()
    await albumField().fill('Old LP')
    await expect(saveButton()).toBeDisabled()
  })

  test('saving updates the list, search and the now-playing title, and survives a reload', async () => {
    await app.importFiles(wav('tone-440', 'a.wav'), wav('tone-880', 'b.wav'))
    await app.play('a')
    await openEditor('a')
    await titleField().fill('  Brand   New  ')
    await artistField().fill('The Editors')
    await albumField().fill('Draft One')
    await saveButton().click()
    await expect(dialog()).toHaveCount(0)

    await expect.poll(() => app.titles()).toEqual(['Brand New', 'b'])
    await expect(app.nowPlayingTitle).toHaveText('Brand New')
    await expect(app.row('Brand New')).toContainText('The Editors')
    await app.expectPlaying() // the audio was not interrupted

    await app.search.fill('draft one')
    await expect(app.rows).toHaveCount(1)
    await app.search.fill('')

    await app.page.waitForTimeout(300)
    await app.reload()
    await expect.poll(() => app.titles()).toEqual(['Brand New', 'b'])
    await expect(app.row('Brand New')).toContainText('The Editors')
  })

  test('blank fields fall back like an import does', async () => {
    await app.importFiles(mp3('keep.mp3', { title: 'Has Tags', artist: 'Someone' }), wav('tone-440', 'x.wav'))
    await openEditor('Has Tags')
    await titleField().fill('')
    await artistField().fill('')
    await saveButton().click()
    await expect(dialog()).toHaveCount(0)
    await expect(app.row('keep')).toContainText('Unknown Artist')
  })

  test('Escape and Cancel discard changes', async () => {
    await app.importFiles(wav('tone-440', 'a.wav'))
    await openEditor('a')
    await titleField().fill('Discarded')
    await app.page.keyboard.press('Escape')
    await expect(dialog()).toHaveCount(0)
    await expect.poll(() => app.titles()).toEqual(['a'])

    await openEditor('a')
    await titleField().fill('Discarded again')
    await dialog().getByRole('button', { name: 'Cancel' }).click()
    await expect(dialog()).toHaveCount(0)
    await expect.poll(() => app.titles()).toEqual(['a'])
  })

  test('typing in the editor never triggers player shortcuts', async () => {
    await app.importFiles(wav('tone-440', 'a.wav'))
    await app.play('a')
    await openEditor('a')
    await titleField().fill('')
    await app.page.keyboard.type('m s r n p /  ')
    await app.expectPlaying()
    await expect(titleField()).toHaveValue('m s r n p /  ')
  })

  test('Tab stays inside the dialog and focus returns to the opener on close', async () => {
    await app.importFiles(wav('tone-440', 'a.wav'))
    await openEditor('a')
    for (let i = 0; i < 14; i++) {
      await app.page.keyboard.press('Tab')
      expect(await app.page.evaluate(() => Boolean(document.activeElement?.closest('[role=dialog]')))).toBe(true)
    }
    await app.page.keyboard.press('Escape')
    await expect(app.row('a').getByRole('button', { name: 'Edit tags of a' })).toBeFocused()
  })

  test('a new cover is previewed, saved, shown in the list and can be removed again', async () => {
    await app.importFiles(wav('tone-440', 'a.wav'))
    const rowImg = () => app.row('a').locator('img')
    await expect(rowImg()).toHaveCount(0)

    await openEditor('a')
    await dialog().getByLabel('Cover image file').setInputFiles({ name: 'cover.png', mimeType: 'image/png', buffer: PNG_1PX })
    await expect(dialog().getByTestId('tag-cover').locator('img')).toHaveAttribute('src', /^blob:/)
    await saveButton().click()
    await expect(dialog()).toHaveCount(0)
    await expect(rowImg()).toHaveAttribute('src', /^blob:/)

    await app.page.waitForTimeout(300)
    await app.reload()
    await expect(rowImg()).toHaveAttribute('src', /^blob:/)

    await openEditor('a')
    await dialog().getByRole('button', { name: 'Remove' }).click()
    await expect(dialog().getByTestId('tag-cover').locator('img')).toHaveCount(0)
    await dialog().getByRole('button', { name: 'Undo' }).click()
    await expect(dialog().getByTestId('tag-cover').locator('img')).toHaveCount(1)
    await dialog().getByRole('button', { name: 'Remove' }).click()
    await saveButton().click()
    await expect(dialog()).toHaveCount(0)
    await expect(rowImg()).toHaveCount(0)
  })

  test('an unusable cover is refused with a message and nothing changes', async () => {
    await app.importFiles(wav('tone-440', 'a.wav'))
    await openEditor('a')
    await dialog().getByLabel('Cover image file').setInputFiles({ name: 'notes.png', mimeType: 'image/png', buffer: Buffer.from('definitely not a png') })
    await expect(dialog().getByRole('alert')).toContainText('JPEG, PNG, GIF or WebP')
    await expect(saveButton()).toBeDisabled()
    await expect(dialog().getByTestId('tag-cover').locator('img')).toHaveCount(0)
  })

  test('MP3 tags are written into the stored file, which "Download copy" hands back', async () => {
    await app.importFiles(
      wav('tone-440', 'first.wav'),
      mp3('song.mp3', { title: 'Old Title', artist: 'Old Band', album: 'Old LP', replayGainTrack: '-6.50 dB', lyrics: 'kept lyrics' }),
    )
    await openEditor('Old Title')
    await titleField().fill('Ünïcode ♪ Title')
    await artistField().fill('New Band')
    await dialog().getByLabel('Cover image file').setInputFiles({ name: 'cover.png', mimeType: 'image/png', buffer: PNG_1PX })
    await saveButton().click()
    await expect(dialog()).toHaveCount(0)

    await openEditor('Ünïcode ♪ Title')
    const [download] = await Promise.all([app.page.waitForEvent('download'), dialog().getByRole('button', { name: 'Download copy' }).click()])
    expect(download.suggestedFilename()).toBe('song.mp3')
    const bytes = new Uint8Array(await readFile(await download.path()))

    const tag = parseId3v2(bytes)
    expect(tag?.version).toBe(3)
    const text = (id: string) => decodeTextBody(tag!.frames.find((f) => f.id === id)!.body)
    expect(text('TIT2')).toBe('Ünïcode ♪ Title')
    expect(text('TPE1')).toBe('New Band')
    expect(text('TALB')).toBe('Old LP')
    expect(tag!.frames.filter((f) => f.id === 'APIC')).toHaveLength(1)
    expect(tag!.frames.filter((f) => f.id === 'TXXX')).toHaveLength(1) // ReplayGain kept
    expect(tag!.frames.some((f) => f.id === 'USLT')).toBe(true) // lyrics kept
    // the MPEG audio is byte-identical
    expect(Array.from(bytes.subarray(tag!.length))).toEqual(Array.from(FRAMES))
  })
})
