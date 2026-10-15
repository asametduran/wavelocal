import { _electron as electron, expect, test } from '@playwright/test'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { shell } from './harness'

// Launches the installer's unpacked output (`npm run desktop:pack` or `desktop:dist`), not the development tree, to prove
// the packaged layout works: the web build is found under resources/web and the page runs from the private app origin.
// Skipped when nothing has been packaged, so `npm run desktop:test` stays usable without a Windows build.
const exe = path.join(shell, 'release', 'win-unpacked', 'Wavelocal.exe')
test.skip(process.platform !== 'win32' || !existsSync(exe), 'no packaged Windows build (run npm run desktop:pack)')

test('packaged app loads the bundled web build from the app origin', async () => {
  const userData = mkdtempSync(path.join(tmpdir(), 'wavelocal-packaged-'))
  // a packaged build ignores the development overrides, so the data directory is set with Chromium's own switch
  const app = await electron.launch({ executablePath: exe, args: [`--user-data-dir=${userData}`] })
  try {
    const page = await app.firstWindow()
    await page.waitForLoadState('domcontentloaded')
    expect(page.url()).toMatch(/^app:\/\/wavelocal\//)
    await expect(page.getByRole('button', { name: /add|import|open/i }).first()).toBeVisible()
    expect(await page.evaluate(() => typeof (window as unknown as { wavelocalDesktop?: unknown }).wavelocalDesktop)).toBe('object')
    const packaged = await app.evaluate(({ app: electronApp }) => electronApp.isPackaged)
    expect(packaged).toBe(true)
  } finally {
    await app.close()
    rmSync(userData, { recursive: true, force: true })
  }
})
