import { existsSync, readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import * as path from 'node:path'
import { describe, expect, it } from 'vitest'

// The installer config is plain data, so the invariants the app relies on are checked here without running a build.
const desktop = path.resolve(__dirname, '..')
const require = createRequire(__filename)
const config = require(path.join(desktop, 'electron-builder.config.cjs')) as {
  appId: string
  productName: string
  asar: boolean
  files: string[]
  extraResources: { from: string; to: string; filter?: string[] }[]
  directories: { output: string }
  win: { target: { target: string; arch: string[] }[]; icon: string; artifactName: string }
  nsis: { oneClick: boolean; perMachine: boolean }
}
const pkg = JSON.parse(readFileSync(path.join(desktop, 'package.json'), 'utf8')) as { main: string; scripts: Record<string, string>; version: string }

describe('electron-builder config', () => {
  it('builds a Windows NSIS installer for x64', () => {
    expect(config.win.target).toEqual([{ target: 'nsis', arch: ['x64'] }])
  })

  it('uses a stable reverse-DNS app id and product name', () => {
    expect(config.appId).toMatch(/^[a-z][a-z0-9]*(\.[a-z][a-z0-9]*)+$/)
    expect(config.productName).toBe('Wavelocal')
  })

  it('names the installer so the verifier and CI can find it', () => {
    expect(config.win.artifactName).toBe('Wavelocal-Setup-${version}-${arch}.${ext}')
  })

  it('bundles the web build where main.ts looks for it when packaged', () => {
    const main = readFileSync(path.join(desktop, 'src', 'main.ts'), 'utf8')
    const resource = config.extraResources.find((entry) => entry.from === '../dist')
    expect(resource?.to).toBe('web')
    expect(main).toContain("path.join(process.resourcesPath, 'web')")
  })

  it('packs the compiled entry point named in package.json and keeps tests and maps out', () => {
    expect(config.asar).toBe(true)
    expect(config.files).toContain('package.json')
    expect(config.files).toEqual(expect.arrayContaining(['!**/*.test.js', '!**/*.map']))
    expect(pkg.main).toBe('out/desktop/src/main.js')
    expect(config.files.some((glob) => glob.startsWith('out/desktop/src/'))).toBe(true)
    expect(config.files).toContain('out/src/desktop-bridge.js')
  })

  it('points at an icon that exists and is large enough to be converted to .ico', () => {
    const icon = path.resolve(desktop, config.win.icon)
    expect(existsSync(icon)).toBe(true)
    // PNG header: width at byte 16, height at byte 20
    const header = readFileSync(icon)
    expect(header.readUInt32BE(16)).toBeGreaterThanOrEqual(256)
    expect(header.readUInt32BE(20)).toBeGreaterThanOrEqual(256)
  })

  it('installs per user with a visible wizard (no admin rights, user picks the folder)', () => {
    expect(config.nsis.perMachine).toBe(false)
    expect(config.nsis.oneClick).toBe(false)
  })

  it('writes output to a directory that is git-ignored', () => {
    const ignore = readFileSync(path.resolve(desktop, '..', '.gitignore'), 'utf8').split(/\r?\n/)
    expect(ignore).toContain(config.directories.output)
  })

  it('exposes pack, dist and verify scripts', () => {
    expect(Object.keys(pkg.scripts)).toEqual(expect.arrayContaining(['pack', 'dist', 'verify:package']))
    expect(pkg.scripts.dist).toContain('verify-package')
  })
})
