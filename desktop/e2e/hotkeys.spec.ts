import { expect, test } from '@playwright/test'
import type { ElectronApplication, Page } from '@playwright/test'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { launchShell, toneWav } from './harness'

interface Entry {
  accelerator: string | null
  status: 'active' | 'disabled' | 'taken'
}
type State = Record<'toggle' | 'next' | 'prev' | 'volumeUp' | 'volumeDown' | 'mute', Entry>
type Result = { ok: true; state: State } | { ok: false; error: string; message: string; state: State }
type Bridge = { hotkeys: { get(): Promise<State>; set(command: string, accelerator: string | null): Promise<Result>; reset(): Promise<State> } }

let userData = ''
let app: ElectronApplication
let page: Page

const hook = <T>(name: 'hotkeys' | 'press', ...args: unknown[]): Promise<T> =>
  app.evaluate((_electron, [fn, params]) => (globalThis as unknown as { __wavelocalTest: Record<string, (...a: unknown[]) => unknown> }).__wavelocalTest[fn as string]!(...(params as unknown[])), [name, args] as const) as Promise<T>

const press = (accelerator: string) => hook<boolean>('press', accelerator)
const bridgeGet = () => page.evaluate(() => (window as unknown as { wavelocalDesktop: Bridge }).wavelocalDesktop.hotkeys.get())
const bridgeSet = (command: string, accelerator: string | null) =>
  page.evaluate(([c, a]) => (window as unknown as { wavelocalDesktop: Bridge }).wavelocalDesktop.hotkeys.set(c as string, a), [command, accelerator] as const)
const savedHotkeys = () => {
  try {
    return (JSON.parse(readFileSync(path.join(userData, 'desktop-settings.json'), 'utf8')) as { hotkeys?: Record<string, string | null> }).hotkeys
  } catch {
    return undefined
  }
}
const row = (title: string) => page.locator('ul > li', { has: page.locator('div.truncate.text-sm', { hasText: new RegExp(`^${title}$`) }) })
const pauseButton = () => page.getByRole('button', { name: 'Pause (Space)' })
const playButton = () => page.getByRole('button', { name: 'Play (Space)' })

async function importAndPlay(...titles: string[]) {
  await page.locator('input[type=file]').first().setInputFiles(titles.map((t, i) => ({ name: `${t}.wav`, mimeType: 'audio/wav', buffer: toneWav(3, 440 + 110 * i) })))
  await row(titles[0]!).locator('button[aria-current]').first().click()
  await expect(pauseButton()).toBeVisible()
}

test.beforeAll(() => {
  userData = mkdtempSync(path.join(tmpdir(), 'wavelocal-hotkeys-'))
})
test.afterAll(() => rmSync(userData, { recursive: true, force: true }))
test.beforeEach(async () => {
  rmSync(path.join(userData, 'desktop-settings.json'), { force: true })
  ;({ app, page } = await launchShell(userData))
})
test.afterEach(async () => {
  await app.close().catch(() => undefined)
})

test('the media keys are bound by default and drive the player', async () => {
  const state = await bridgeGet()
  expect(state.toggle.accelerator).toBe('MediaPlayPause')
  expect(state.volumeUp).toEqual({ accelerator: null, status: 'disabled' })

  await importAndPlay('one', 'two')
  expect(await press('MediaPlayPause')).toBe(true)
  await expect(playButton()).toBeVisible()
  expect(await press('MediaPlayPause')).toBe(true)
  await expect(pauseButton()).toBeVisible()
  expect(await press('MediaNextTrack')).toBe(true)
  await expect(row('two').locator('button[aria-current="true"]').first()).toBeVisible()
})

test('a custom accelerator is canonicalised, registered, saved and then works', async () => {
  const result = await bridgeSet('mute', 'ctrl+shift+alt+f10')
  expect(result, JSON.stringify(result)).toMatchObject({ ok: true })
  expect(result.state.mute).toEqual({ accelerator: 'Ctrl+Alt+Shift+F10', status: expect.stringMatching(/active|taken/) })
  await expect.poll(() => savedHotkeys()?.mute).toBe('Ctrl+Alt+Shift+F10')
  if (result.state.mute.status === 'active') expect(await press('Ctrl+Alt+Shift+F10')).toBe(true)
})

test('refused changes explain why and leave the old binding in place', async () => {
  const invalid = await bridgeSet('toggle', 'Banana')
  expect(invalid).toMatchObject({ ok: false, error: 'invalid' })
  const reserved = await bridgeSet('toggle', 'Ctrl+C')
  expect(reserved).toMatchObject({ ok: false, error: 'reserved' })
  const conflict = await bridgeSet('toggle', 'MediaNextTrack')
  expect(conflict).toMatchObject({ ok: false, error: 'conflict' })
  expect((await bridgeGet()).toggle.accelerator).toBe('MediaPlayPause')
  expect(await press('MediaPlayPause')).toBe(true)
})

test('the page cannot send an unknown command', async () => {
  await expect(bridgeSet('formatDisk', 'F9')).rejects.toThrow()
})

test('bindings are remembered across a restart, and reset restores the defaults', async () => {
  expect((await bridgeSet('next', null)).ok).toBe(true)
  await expect.poll(() => savedHotkeys()?.next).toBeNull()
  await app.close()

  ;({ app, page } = await launchShell(userData))
  expect((await bridgeGet()).next).toEqual({ accelerator: null, status: 'disabled' })
  expect(await press('MediaNextTrack')).toBe(false)

  const reset = await page.evaluate(() => (window as unknown as { wavelocalDesktop: Bridge }).wavelocalDesktop.hotkeys.reset())
  expect(reset.next.accelerator).toBe('MediaNextTrack')
  await expect.poll(() => savedHotkeys()?.next).toBe('MediaNextTrack')
})

test('the settings dialog lists the hotkeys and records a new one', async () => {
  await page.getByRole('button', { name: /equalizer/i }).first().click()
  const section = page.getByRole('region', { name: 'Global hotkeys' })
  await expect(section).toBeVisible()
  await expect(section.getByText('Play Pause')).toBeVisible()

  await section.getByRole('button', { name: 'Record shortcut for Volume up' }).click()
  await expect(section.getByText('Press a key…')).toBeVisible()
  await page.keyboard.press('Control+Alt+ArrowUp')
  await expect(section.getByText('Ctrl + Alt + Up')).toBeVisible()
  await expect.poll(() => savedHotkeys()?.volumeUp).toBe('Ctrl+Alt+Up')

  await section.getByRole('button', { name: 'Record shortcut for Mute' }).click()
  await page.keyboard.press('Control+Alt+ArrowUp') // already used by Volume up
  await expect(section.getByRole('status')).toContainText('volumeUp')
})
