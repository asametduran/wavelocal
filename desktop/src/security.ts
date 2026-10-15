import * as path from 'node:path'

/**
 * Pure security helpers for the desktop shell (no Electron imports, so they are unit-tested in plain Node).
 *
 * The built web app is served from a private, secure `app://wavelocal/` origin instead of `file://`: that gives it a
 * stable origin (so IndexedDB and settings persist), lets module Web Workers and dynamic imports work, and means the
 * request filter and CSP below can treat "our own files" and "everything else" as clearly different things.
 */

export const APP_SCHEME = 'app'
export const APP_HOST = 'wavelocal'
export const APP_ORIGIN = `${APP_SCHEME}://${APP_HOST}`
export const APP_URL = `${APP_ORIGIN}/`

// ---- Content-Security-Policy ----

export interface CspOptions {
  /** Development: also allow the Vite dev server (inline module preamble, eval for source maps, websocket for HMR). */
  devOrigin?: string
}

/** The policy applied to every document. Nothing may be loaded from, or sent to, anywhere but the app itself. */
export function buildCsp({ devOrigin }: CspOptions = {}): string {
  const dev = devOrigin ? [devOrigin, devOrigin.replace(/^http/, 'ws')] : []
  const directives: Record<string, string[]> = {
    'default-src': ["'self'"],
    'script-src': ["'self'", ...(devOrigin ? ["'unsafe-inline'", "'unsafe-eval'", devOrigin] : [])],
    // the app sets its inline styles through the CSSOM (allowed); only the stylesheet files are needed
    'style-src': ["'self'", ...(devOrigin ? ["'unsafe-inline'", devOrigin] : [])],
    'img-src': ["'self'", 'blob:', 'data:'],
    'media-src': ["'self'", 'blob:'],
    'worker-src': ["'self'", 'blob:'],
    'connect-src': ["'self'", 'blob:', ...dev],
    'font-src': ["'self'", 'data:'],
    'object-src': ["'none'"],
    'base-uri': ["'none'"],
    'form-action': ["'none'"],
    'frame-src': ["'none'"],
    'frame-ancestors': ["'none'"],
  }
  return Object.entries(directives)
    .map(([name, values]) => `${name} ${values.join(' ')}`)
    .join('; ')
}

/** Response headers for documents and assets served by the shell. */
export function securityHeaders(csp: string): Record<string, string> {
  return {
    'Content-Security-Policy': csp,
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
    'Cross-Origin-Opener-Policy': 'same-origin',
    'Cross-Origin-Resource-Policy': 'same-origin',
    'Permissions-Policy': 'camera=(), microphone=(), geolocation=(), payment=(), usb=(), serial=(), hid=(), bluetooth=()',
  }
}

// ---- what the window may load or navigate to ----

const originOf = (url: string): string | null => {
  try {
    const u = new URL(url)
    return `${u.protocol}//${u.host}`
  } catch {
    return null
  }
}

/** Top-level navigation is only allowed within the app's own origin (or the dev server while developing). */
export function isAllowedNavigation(url: string, devOrigin?: string): boolean {
  const origin = originOf(url)
  return origin !== null && (origin === APP_ORIGIN || (devOrigin !== undefined && origin === originOf(devOrigin)))
}

/**
 * Sub-resource requests: the app's own files, in-memory blob/data URLs, and (in development only) the dev server and
 * the devtools. Everything else - any http(s)/ws URL, file:// - is cancelled, so the player can never phone home.
 */
export function isAllowedRequest(url: string, devOrigin?: string): boolean {
  if (url.startsWith('blob:') || url.startsWith('data:')) return true
  if (devOrigin !== undefined && (url.startsWith('devtools:') || url.startsWith('chrome-extension:'))) return true
  const origin = originOf(url)
  if (origin === null) return false
  if (origin === APP_ORIGIN) return true
  if (devOrigin === undefined) return false
  const dev = originOf(devOrigin)
  return origin === dev || origin === dev?.replace(/^http/, 'ws')
}

// ---- serving the built web app ----

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.wasm': 'application/wasm',
  '.map': 'application/json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
}

export const mimeFor = (file: string): string => MIME[path.extname(file).toLowerCase()] ?? 'application/octet-stream'

/**
 * Map a request URL on the app origin to a file inside `webRoot`, or null if the request is for another host, is not
 * a plain path, or would escape the root in any way (dot segments, encoded separators, backslashes, NUL, drive letters).
 */
export function resolveAppPath(webRoot: string, requestUrl: string): string | null {
  let url: URL
  try {
    url = new URL(requestUrl)
  } catch {
    return null
  }
  if (url.protocol !== `${APP_SCHEME}:` || url.host !== APP_HOST) return null

  let decoded: string
  try {
    decoded = decodeURIComponent(url.pathname)
  } catch {
    return null
  }
  // Treat an encoded slash/backslash/dot-segment exactly like a raw one: refuse anything that is not a plain path.
  if (/[\0\\]/.test(decoded) || /%2f|%5c/i.test(url.pathname)) return null
  if (decoded.split('/').some((segment) => segment === '..' || segment === '.')) return null
  // drive letters and NTFS alternate data streams: no built asset has a colon in its path, and Windows resolves "C:foo" as drive-relative
  if (decoded.includes(':')) return null

  const relative = decoded === '/' || decoded === '' ? 'index.html' : decoded.replace(/^\/+/, '')
  const root = path.resolve(webRoot)
  const full = path.resolve(root, relative)
  return full === root || full.startsWith(root + path.sep) ? full : null
}
