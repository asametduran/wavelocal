import { _electron as electron, expect } from '@playwright/test'
import type { ElectronApplication, Page } from '@playwright/test'
import { createRequire } from 'node:module'
import path from 'node:path'

export const shell = path.resolve(__dirname, '..')
export const webRoot = path.resolve(shell, '..', 'dist')

// resolve the binary from the shell's own node_modules (Playwright would otherwise look next to the root package)
const electronPath: string = createRequire(path.join(shell, 'package.json'))('electron')

/** A short mono 16-bit PCM WAV with a sine tone, generated in memory (no audio files are committed). */
export function toneWav(seconds = 2, frequency = 440, rate = 8000): Buffer {
  const samples = Math.round(seconds * rate)
  const buf = Buffer.alloc(44 + samples * 2)
  buf.write('RIFF', 0)
  buf.writeUInt32LE(36 + samples * 2, 4)
  buf.write('WAVEfmt ', 8)
  buf.writeUInt32LE(16, 16)
  buf.writeUInt16LE(1, 20)
  buf.writeUInt16LE(1, 22)
  buf.writeUInt32LE(rate, 24)
  buf.writeUInt32LE(rate * 2, 28)
  buf.writeUInt16LE(2, 32)
  buf.writeUInt16LE(16, 34)
  buf.write('data', 36)
  buf.writeUInt32LE(samples * 2, 40)
  for (let i = 0; i < samples; i++) buf.writeInt16LE(Math.round(Math.sin((2 * Math.PI * frequency * i) / rate) * 12000), 44 + i * 2)
  return buf
}

export interface Launched {
  app: ElectronApplication
  page: Page
}

/** Start the real shell on the built web app with a private user-data directory and the test hooks enabled. */
export async function launchShell(userData: string): Promise<Launched> {
  const app = await electron.launch({
    cwd: shell,
    executablePath: electronPath,
    args: ['.'],
    env: { ...process.env, WAVELOCAL_WEB_ROOT: webRoot, WAVELOCAL_USER_DATA: userData, WAVELOCAL_TEST: '1' },
  })
  const page = await app.firstWindow()
  await page.waitForLoadState('domcontentloaded')
  // the window is shown on its first frame: wait for it so tests start from a settled state
  await expect
    .poll(() => app.evaluate(() => (globalThis as unknown as { __wavelocalTest: { windowVisible(): boolean } }).__wavelocalTest.windowVisible()))
    .toBe(true)
  return { app, page }
}

/** What the main process says about its tray (see `exposeTestHooks` in main.ts). */
export interface TrayInfo {
  tooltip: string
  menu: string[]
}
