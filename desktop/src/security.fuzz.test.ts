import * as path from 'node:path'
import { describe, expect, it } from 'vitest'
import { APP_ORIGIN, APP_URL, isAllowedNavigation, isAllowedRequest, resolveAppPath } from './security'

// A small seeded generator of its own: the desktop shell is a separate project and does not reach into the web app's sources.
function mulberry32(seed: number): () => number {
  let a = seed
  return () => {
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}
const int = (random: () => number, below: number) => Math.floor(random() * below)
const pick = <T>(random: () => number, items: readonly T[]): T => items[int(random, items.length)] as T
const SCALE = Math.min(1000, Math.max(1, Number(process.env.FUZZ_RUNS) || 1))
const seeds = (count: number) => Array.from({ length: count * SCALE }, (_, i) => i + 1)

const ROOT = path.resolve('web-root')
const inside = (file: string) => file === ROOT || file.startsWith(ROOT + path.sep)

const PIECES = ['..', '.', '%2e%2e', '%2E%2E', '%2e', '%2f', '%5c', '%5C', '%00', '%252e', '%252f', '/', '//', '\\', ':', 'C:', 'c%3a', '~', '...', '\u202e', '%ef%bc%8e', '\u0000', '?', '#', 'index.html', 'assets', 'a b', 'ü', '%', '%zz', 'CON', 'NUL.txt', '::$DATA']
const mess = (random: () => number): string => Array.from({ length: 1 + int(random, 8) }, () => pick(random, PIECES)).join(pick(random, ['/', '/', '', '\\', '%2f']))

describe('serving the web app under fuzzing', () => {
  it('never maps a request outside the folder, however the path is written', () => {
    for (const seed of seeds(2000)) {
      const random = mulberry32(seed)
      const host = pick(random, ['wavelocal', 'wavelocal', 'WAVELOCAL', 'evil', 'wavelocal.evil.com', 'wavelocal:81', 'user@wavelocal', ''])
      const url = `${pick(random, ['app', 'app', 'http', 'file', 'APP'])}://${host}/${mess(random)}`
      const resolved = resolveAppPath(ROOT, url)
      if (resolved !== null) {
        expect(inside(resolved), `${url} -> ${resolved}`).toBe(true)
        expect(resolved).not.toContain('\0')
      }
    }
  })

  it('refuses each of the classic ways out', () => {
    // the URL parser itself folds a plain or percent-encoded dot segment ("/a/../b" is "/b"), which cannot leave the folder
    const folded = ['../secret', '%2e%2e/secret', 'a/../../secret', '.%2e/secret', '%2e./secret', 'a/./b', './a']
    // these keep their slash, backslash, colon or NUL, and the shell refuses them outright
    const refused = ['..%2fsecret', '%2e%2e%2fsecret', '..%5csecret', '..\\secret', 'a/..%2f..%2fsecret', 'C:/Windows/win.ini', 'c%3a/Windows/win.ini', '/C:/Windows/win.ini', '\\\\server\\share\\file', 'a%00.js', '%00', 'index.html::$DATA']
    for (const base of [APP_URL, `${APP_ORIGIN}/sub/`]) {
      for (const attack of folded) {
        const resolved = resolveAppPath(ROOT, `${base}${attack}`)
        if (resolved !== null) expect(inside(resolved), `${base}${attack} -> ${resolved}`).toBe(true)
      }
      for (const attack of refused) expect(resolveAppPath(ROOT, `${base}${attack}`), `${base}${attack}`).toBeNull()
    }
    // and the double slash that means "another host" to a browser is only a name here
    const doubled = resolveAppPath(ROOT, `${APP_URL}/server/share/file`)
    if (doubled !== null) expect(inside(doubled)).toBe(true)
  })

  it('serves plain paths, the root, and a query without leaving the folder', () => {
    expect(resolveAppPath(ROOT, `${APP_URL}assets/app.js`)).toBe(path.join(ROOT, 'assets', 'app.js'))
    expect(resolveAppPath(ROOT, APP_URL)).toBe(path.join(ROOT, 'index.html'))
    expect(resolveAppPath(ROOT, `${APP_URL}icons/icon%20192.png?v=2#x`)).toBe(path.join(ROOT, 'icons', 'icon 192.png'))
    expect(resolveAppPath(ROOT, 'http://wavelocal/index.html')).toBeNull()
    expect(resolveAppPath(ROOT, 'not a url')).toBeNull()
    expect(resolveAppPath(ROOT, '')).toBeNull()
  })

  it('lets a request through only when it is for the app itself or for in-memory data', () => {
    for (const seed of seeds(3000)) {
      const random = mulberry32(seed)
      const url = random() < 0.4 ? `${pick(random, ['app', 'APP', 'http', 'https', 'ws', 'file', 'blob', 'data', 'ftp', 'chrome-extension', 'devtools'])}://${pick(random, ['wavelocal', 'WAVELOCAL', 'wavelocal.evil.com', 'wavelocal@evil.com', 'evil.com', 'wavelocal:8080', ''])}/${mess(random)}` : mess(random)
      const allowedRequest = isAllowedRequest(url)
      if (allowedRequest && !url.startsWith('blob:') && !url.startsWith('data:')) {
        const parsed = new URL(url)
        expect(`${parsed.protocol}//${parsed.host}`, url).toBe(APP_ORIGIN)
      }
      if (isAllowedNavigation(url)) {
        const parsed = new URL(url)
        expect(`${parsed.protocol}//${parsed.host}`, url).toBe(APP_ORIGIN)
      }
    }
  })

  it('never lets the app reach the network, with or without a dev server configured', () => {
    for (const url of ['https://example.com/', 'http://127.0.0.1:8080/', 'ws://localhost:5173/', 'wss://example.com/s', 'file:///etc/passwd', 'ftp://example.com/', 'app://wavelocal.example.com/', 'app://wavelocal@evil.com/', 'app://wavelocal:81/', 'app://WAVELOCAL/']) {
      expect(isAllowedRequest(url), url).toBe(false)
      expect(isAllowedNavigation(url), url).toBe(false)
    }
    expect(isAllowedRequest('blob:app://wavelocal/1234')).toBe(true)
    expect(isAllowedRequest('data:audio/wav;base64,AAAA')).toBe(true)
    expect(isAllowedRequest(`${APP_URL}index.html`)).toBe(true)
    expect(isAllowedNavigation(`${APP_URL}index.html`)).toBe(true)
  })
})
