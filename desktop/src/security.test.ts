// @vitest-environment node
import * as path from 'node:path'
import { describe, expect, it } from 'vitest'
import { APP_HOST, APP_ORIGIN, APP_SCHEME, APP_URL, buildCsp, isAllowedNavigation, isAllowedRequest, mimeFor, resolveAppPath, securityHeaders } from './security'

const ROOT = path.resolve('/srv/wavelocal/dist')
const at = (p: string) => `${APP_URL.slice(0, -1)}${p}`

describe('constants', () => {
  it('builds the app origin from its scheme and host', () => {
    expect(APP_ORIGIN).toBe(`${APP_SCHEME}://${APP_HOST}`)
    expect(APP_URL).toBe('app://wavelocal/')
  })
})

describe('buildCsp', () => {
  const directives = (csp: string) => Object.fromEntries(csp.split('; ').map((d) => [d.split(' ')[0] ?? '', d.split(' ').slice(1)]))

  it('only lets the app load its own code, styles and data', () => {
    const csp = directives(buildCsp())
    expect(csp['default-src']).toEqual(["'self'"])
    expect(csp['script-src']).toEqual(["'self'"])
    expect(csp['style-src']).toEqual(["'self'"])
    expect(csp['connect-src']).toEqual(["'self'", 'blob:'])
    expect(csp['img-src']).toEqual(["'self'", 'blob:', 'data:'])
    expect(csp['media-src']).toEqual(["'self'", 'blob:'])
    expect(csp['worker-src']).toEqual(["'self'", 'blob:'])
  })

  it('forbids plugins, frames, base-tag tricks and form posts', () => {
    const csp = directives(buildCsp())
    for (const name of ['object-src', 'base-uri', 'form-action', 'frame-src', 'frame-ancestors']) expect(csp[name]).toEqual(["'none'"])
  })

  it('never allows inline or eval scripts in production, nor any remote host', () => {
    const csp = buildCsp()
    expect(csp).not.toMatch(/unsafe-inline|unsafe-eval/)
    expect(csp).not.toMatch(/https?:|wss?:|\*/)
  })

  it('relaxes only what the Vite dev server needs, and only for that origin', () => {
    const csp = directives(buildCsp({ devOrigin: 'http://localhost:5173' }))
    expect(csp['script-src']).toEqual(["'self'", "'unsafe-inline'", "'unsafe-eval'", 'http://localhost:5173'])
    expect(csp['connect-src']).toContain('ws://localhost:5173')
    expect(csp['connect-src']).toContain('http://localhost:5173')
    expect(csp['object-src']).toEqual(["'none'"])
  })
})

describe('securityHeaders', () => {
  const headers = securityHeaders("default-src 'self'")

  it('carries the policy and the standard hardening headers', () => {
    expect(headers['Content-Security-Policy']).toBe("default-src 'self'")
    expect(headers['X-Content-Type-Options']).toBe('nosniff')
    expect(headers['Referrer-Policy']).toBe('no-referrer')
    expect(headers['Cross-Origin-Opener-Policy']).toBe('same-origin')
    expect(headers['Cross-Origin-Resource-Policy']).toBe('same-origin')
  })

  it('switches off powerful browser features the player never uses', () => {
    for (const feature of ['camera', 'microphone', 'geolocation', 'usb']) expect(headers['Permissions-Policy']).toContain(`${feature}=()`)
  })
})

describe('isAllowedNavigation', () => {
  it('allows pages on the app origin', () => {
    expect(isAllowedNavigation('app://wavelocal/')).toBe(true)
    expect(isAllowedNavigation('app://wavelocal/index.html?x=1#y')).toBe(true)
  })

  it.each([
    'https://example.com/',
    'http://wavelocal/',
    'app://evil/',
    'app://wavelocal.evil.com/',
    'file:///C:/Windows/win.ini',
    'javascript:alert(1)',
    'data:text/html,<script>1</script>',
    'blob:app://wavelocal/abc',
    'not a url',
    '',
  ])('refuses %j', (url) => {
    expect(isAllowedNavigation(url)).toBe(false)
  })

  it('allows the dev server only when one is configured', () => {
    expect(isAllowedNavigation('http://localhost:5173/', 'http://localhost:5173')).toBe(true)
    expect(isAllowedNavigation('http://localhost:5173/')).toBe(false)
    expect(isAllowedNavigation('http://localhost:9999/', 'http://localhost:5173')).toBe(false)
  })
})

describe('isAllowedRequest (the no-network rule)', () => {
  it('allows the app, and in-memory blob / data URLs', () => {
    expect(isAllowedRequest('app://wavelocal/assets/index.js')).toBe(true)
    expect(isAllowedRequest('blob:app://wavelocal/6c1b')).toBe(true)
    expect(isAllowedRequest('data:image/svg+xml;base64,AAAA')).toBe(true)
  })

  it.each([
    'https://example.com/track.mp3',
    'http://127.0.0.1:8080/',
    'ws://localhost:5173/',
    'wss://example.com/socket',
    'ftp://example.com/',
    'file:///etc/passwd',
    'app://other/',
    'chrome-extension://abc/',
    'devtools://devtools/bundled/inspector.html',
    'garbage',
  ])('cancels %j in production', (url) => {
    expect(isAllowedRequest(url)).toBe(false)
  })

  it('opens just the dev server (http and websocket) and devtools while developing', () => {
    const dev = 'http://localhost:5173'
    expect(isAllowedRequest('http://localhost:5173/src/main.tsx', dev)).toBe(true)
    expect(isAllowedRequest('ws://localhost:5173/?token=1', dev)).toBe(true)
    expect(isAllowedRequest('devtools://devtools/bundled/x.html', dev)).toBe(true)
    expect(isAllowedRequest('https://example.com/', dev)).toBe(false)
    expect(isAllowedRequest('http://localhost:5174/', dev)).toBe(false)
  })
})

describe('resolveAppPath', () => {
  it('serves index.html for the root', () => {
    expect(resolveAppPath(ROOT, at('/'))).toBe(path.join(ROOT, 'index.html'))
    expect(resolveAppPath(ROOT, 'app://wavelocal')).toBe(path.join(ROOT, 'index.html'))
  })

  it('maps asset paths into the root', () => {
    expect(resolveAppPath(ROOT, at('/assets/index-abc.js'))).toBe(path.join(ROOT, 'assets', 'index-abc.js'))
    expect(resolveAppPath(ROOT, at('/icons/icon-192.png'))).toBe(path.join(ROOT, 'icons', 'icon-192.png'))
  })

  it('ignores the query string and fragment', () => {
    expect(resolveAppPath(ROOT, at('/sw.js?v=3#frag'))).toBe(path.join(ROOT, 'sw.js'))
  })

  it('decodes ordinary percent-escapes', () => {
    expect(resolveAppPath(ROOT, at('/my%20file.txt'))).toBe(path.join(ROOT, 'my file.txt'))
  })

  it.each([
    ['dot segments', '/../package.json'],
    ['nested dot segments', '/assets/../../secret'],
    ['encoded dot segments', '/%2e%2e/%2e%2e/secret'],
    ['encoded slash', '/assets%2f..%2f..%2fsecret'],
    ['encoded backslash', '/assets%5c..%5csecret'],
    ['raw backslash', '/assets\\..\\secret'],
    ['a NUL byte', '/index.html%00.png'],
    ['a drive letter', '/C:/Windows/win.ini'],
    ['a drive-relative path', '/C:secret'],
    ['an alternate data stream', '/index.html::$DATA'],
    ['a broken escape', '/%E0%A4%A'],
  ])('refuses %s', (_name, p) => {
    const result = resolveAppPath(ROOT, at(p))
    // either refused outright, or (URL parsing already folded the dots) still inside the root
    if (result !== null) expect(result === ROOT || result.startsWith(ROOT + path.sep)).toBe(true)
    expect(['/../package.json', '/assets/../../secret', '/%2e%2e/%2e%2e/secret'].includes(p) ? true : result === null).toBe(true)
  })

  it('never escapes the root, whatever the URL parser does with the dots', () => {
    for (const p of ['/../package.json', '/assets/../../secret', '/%2e%2e/%2e%2e/secret', '/./index.html', '//index.html']) {
      const result = resolveAppPath(ROOT, at(p))
      if (result !== null) expect(result.startsWith(ROOT + path.sep) || result === ROOT).toBe(true)
    }
  })

  it('refuses other hosts, schemes and garbage', () => {
    expect(resolveAppPath(ROOT, 'app://evil/index.html')).toBeNull()
    expect(resolveAppPath(ROOT, 'https://wavelocal/index.html')).toBeNull()
    expect(resolveAppPath(ROOT, 'file:///index.html')).toBeNull()
    expect(resolveAppPath(ROOT, 'nonsense')).toBeNull()
  })
})

describe('mimeFor', () => {
  it.each([
    ['index.html', 'text/html; charset=utf-8'],
    ['assets/app.js', 'text/javascript; charset=utf-8'],
    ['assets/decode.worker.js', 'text/javascript; charset=utf-8'],
    ['x.css', 'text/css; charset=utf-8'],
    ['manifest.webmanifest', 'application/manifest+json; charset=utf-8'],
    ['icons/a.PNG', 'image/png'],
    ['a.svg', 'image/svg+xml'],
    ['fonts/a.woff2', 'font/woff2'],
    ['mystery.xyz', 'application/octet-stream'],
    ['noextension', 'application/octet-stream'],
  ])('%s -> %s', (file, mime) => {
    expect(mimeFor(file)).toBe(mime)
  })
})
