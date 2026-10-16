import AxeBuilder from '@axe-core/playwright'
import { expect, test } from '@playwright/test'
import type { Browser, BrowserContext } from '@playwright/test'
import { PlayerPage, wav } from './helpers'

/** A second device: its own browser context, so its own IndexedDB library (two pages of one context would share it). */
async function newDevice(browser: Browser, baseURL: string): Promise<{ context: BrowserContext; app: PlayerPage }> {
  const context = await browser.newContext({ baseURL, serviceWorkers: 'block', viewport: { width: 1280, height: 800 } })
  // record every RTCPeerConnection configuration so the privacy test can assert on it
  await context.addInitScript(() => {
    window.__rtcConfigs = []
    const Original = window.RTCPeerConnection
    window.RTCPeerConnection = class extends Original {
      constructor(config?: RTCConfiguration) {
        super(config)
        window.__rtcConfigs.push(config ?? {})
      }
    }
  })
  const page = await context.newPage()
  const app = new PlayerPage(page)
  await app.open()
  return { context, app }
}

/** Import a file with a fixed modified time, so two devices end up with the same library key (name|size|modified). */
async function importWithMtime(app: PlayerPage, file: ReturnType<typeof wav>, lastModified: number): Promise<void> {
  await app.page.evaluate(
    async ({ name, type, base64, lastModified }) => {
      const bytes = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0))
      const transfer = new DataTransfer()
      transfer.items.add(new File([bytes], name, { type, lastModified }))
      const input = document.querySelector<HTMLInputElement>('input[type=file]')
      if (!input) throw new Error('no file input')
      input.files = transfer.files
      input.dispatchEvent(new Event('change', { bubbles: true }))
    },
    { name: file.name, type: file.mimeType, base64: file.buffer.toString('base64'), lastModified },
  )
}

const code = (app: PlayerPage, name: RegExp) => app.tools.getByRole('textbox', { name })

/** Host creates an invite, guest joins with it, host pastes the reply: the whole pairing ritual through the UI. */
async function pair(host: PlayerPage, guest: PlayerPage, afterInvite?: () => Promise<void>): Promise<void> {
  await host.openTools()
  await host.tools.getByRole('button', { name: 'Host a session' }).click()
  const invite = await code(host, /^Invite code/).inputValue()
  expect(invite).toMatch(/^WL1\.o\./)
  await afterInvite?.()

  await guest.openTools()
  await code(guest, /^Or join a session/).fill(invite)
  await guest.tools.getByRole('button', { name: 'Join' }).click()
  await expect(code(guest, /^Reply code/)).toHaveValue(/^WL1\.a\./)
  const reply = await code(guest, /^Reply code/).inputValue()

  await code(host, /^Their reply code/).fill(reply)
  await host.tools.getByRole('button', { name: 'Connect' }).click()
  await expect(guest.tools.getByText(/Listening with/)).toBeVisible({ timeout: 20_000 })
  await expect(host.tools.getByRole('list', { name: 'Listeners' })).toContainText('Listening', { timeout: 20_000 })
  // panels are modal: close them so the rest of the page is reachable
  await host.closeTools()
  await guest.closeTools()
}

test.describe('listen together', () => {
  test.describe.configure({ timeout: 90_000 })

  let host: PlayerPage
  let guest: PlayerPage
  const contexts: BrowserContext[] = []

  test.beforeEach(async ({ browser, baseURL }) => {
    for (const set of [(d: PlayerPage) => (host = d), (d: PlayerPage) => (guest = d)]) {
      const device = await newDevice(browser, baseURL ?? 'http://127.0.0.1:4173')
      contexts.push(device.context)
      set(device.app)
    }
  })

  test.afterEach(async () => {
    await Promise.all(contexts.splice(0).map((c) => c.close()))
  })

  test('a guest without the song receives it from the host, saves it, and plays along', async () => {
    await host.importFiles(wav('long', 'shared-song.wav'))
    await pair(host, guest)
    await host.play('shared-song')

    // the track arrives over the data channel and lands in the guest's own library
    await expect(guest.rows).toHaveCount(1, { timeout: 30_000 })
    await expect(guest.row('shared-song')).toBeVisible()
    await guest.expectPlaying()
    await expect(guest.nowPlayingTitle).toHaveText('shared-song')

    // both are at about the same place in the track
    await expect
      .poll(async () => Math.abs((await host.position()) - (await guest.position())), { timeout: 10_000 })
      .toBeLessThanOrEqual(1)
  })

  test('pausing and seeking on the host are followed by the guest', async () => {
    await host.importFiles(wav('long', 'shared-song.wav'))
    await pair(host, guest)
    await host.play('shared-song')
    await guest.expectPlaying()
    await expect.poll(() => guest.duration(), { timeout: 20_000 }).toBe(30)

    await host.playButton.click()
    await host.expectPaused()
    await guest.expectPaused()

    await host.seekTo(20)
    await expect.poll(() => guest.position(), { timeout: 10_000 }).toBe(20)

    await host.playButton.click()
    await host.expectPlaying()
    await guest.expectPlaying()
    await expect.poll(() => guest.position(), { timeout: 10_000 }).toBeGreaterThanOrEqual(20)
  })

  test('a guest that already owns the file does not download it again', async () => {
    const song = wav('long', 'shared-song.wav')
    // same name, size and modified time => same library key
    await importWithMtime(host, song, 1_700_000_000_000)
    await importWithMtime(guest, song, 1_700_000_000_000)
    await expect(host.rows).toHaveCount(1)
    await expect(guest.rows).toHaveCount(1)
    await pair(host, guest)
    await host.play('shared-song')
    await guest.expectPlaying()
    await expect(guest.rows).toHaveCount(1)
    await expect(guest.page.getByRole('progressbar', { name: 'Receiving track' })).toHaveCount(0)
  })

  test('only talks to the local network: no ICE servers, no third-party requests', async () => {
    const seen: string[] = []
    guest.page.on('request', (r) => seen.push(new URL(r.url()).host))
    host.page.on('request', (r) => seen.push(new URL(r.url()).host))
    await host.importFiles(wav('long', 'shared-song.wav'))
    await pair(host, guest)
    expect(new Set(seen.filter((h) => h))).toEqual(new Set(['127.0.0.1:4173']))
    for (const app of [host, guest]) {
      const configs = await app.page.evaluate(() => window.__rtcConfigs)
      expect(configs.length).toBeGreaterThan(0)
      for (const config of configs) expect(config.iceServers ?? []).toEqual([])
    }
  })

  test('guests can only control playback when the host allows it', async () => {
    await host.importFiles(wav('long', 'shared-song.wav'))
    await pair(host, guest)
    await host.play('shared-song')
    await guest.expectPlaying()

    await guest.openTools()
    const controls = guest.tools.getByRole('group', { name: /Control the host/ })
    await expect(controls).toHaveCount(0)

    const allow = host.tools.getByRole('switch', { name: 'Let listeners control playback' })
    await host.openTools()
    await allow.click()
    await expect(controls).toBeVisible()
    await controls.getByRole('button', { name: 'Play or pause' }).click()
    await host.closeTools()
    await host.expectPaused()

    await host.openTools()
    await allow.click()
    await expect(controls).toHaveCount(0)
  })

  test('leaving ends the session on both sides', async () => {
    await host.importFiles(wav('long', 'shared-song.wav'))
    await pair(host, guest)
    await guest.openTools()
    await guest.tools.getByRole('button', { name: 'Leave session' }).click()
    await expect(guest.tools.getByRole('button', { name: 'Host a session' })).toBeVisible()
    await host.openTools()
    // the host forgets a listener that said goodbye
    await expect(host.tools.getByRole('list', { name: 'Listeners' })).toHaveCount(0, { timeout: 15_000 })

    await host.tools.getByRole('button', { name: 'Stop hosting' }).click()
    await expect(host.tools.getByRole('button', { name: 'Host a session' })).toBeVisible()
  })

  test('explains bad codes instead of failing silently', async () => {
    await guest.openTools()
    const paste = code(guest, /^Or join a session/)
    await paste.fill('hello')
    await guest.tools.getByRole('button', { name: 'Join' }).click()
    await expect(guest.tools.getByRole('alert')).toContainText('does not look like a Wavelocal code')

    // a reply pasted where an invite is expected
    await host.openTools()
    await host.tools.getByRole('button', { name: 'Host a session' }).click()
    const invite = await code(host, /^Invite code/).inputValue()
    await code(host, /^Their reply code/).fill(invite)
    await host.tools.getByRole('button', { name: 'Connect' }).click()
    await expect(host.tools.getByRole('alert')).toContainText('invite, not a reply')
  })

  test('the panel has no accessibility violations while idle, inviting and connected', async () => {
    const scan = async (app: PlayerPage, state: string) => {
      const { violations } = await new AxeBuilder({ page: app.page }).include('section[aria-label="Listen together"]').withTags(['wcag2a', 'wcag2aa', 'wcag21aa', 'wcag22aa', 'best-practice']).analyze()
      expect(violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(' ')).join(', ')}`), state).toEqual([])
    }
    await host.importFiles(wav('long', 'shared-song.wav'))
    await host.openTools()
    await scan(host, 'idle panel')
    await host.closeTools()
    await pair(host, guest, async () => scan(host, 'host with an invite waiting'))
    await host.openTools()
    await guest.openTools()
    await scan(host, 'host with a listener')
    await scan(guest, 'connected guest')
  })

  test('the status pill shows the session while the panel is closed', async () => {
    await host.importFiles(wav('long', 'shared-song.wav'))
    await pair(host, guest)
    await expect(host.page.getByRole('button', { name: /Listening together/ })).toContainText('Hosting · 1 listening')
    await expect(guest.page.getByRole('button', { name: /Listening together/ })).toContainText('Listening with')
  })
})

declare global {
  interface Window {
    __rtcConfigs: RTCConfiguration[]
  }
}
