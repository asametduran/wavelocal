// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { LEGACY_CACHE, MARKER_PATH, SHELL, isOwnCache, isPrecacheCache, isSafeEntryUrl, parseMarker, planInstall, precacheName, routeRequest, staleCaches } from './precache'
import type { PrecacheEntry } from './precache'

const hash = (c: string) => c.repeat(32)
const entry = (url: string, h = 'a', size = 10, type = 'text/javascript'): PrecacheEntry => ({ url, size, hash: hash(h), type })
const SCOPE = 'https://music.example/app/'
const KEYS = new Set(['index.html', 'assets/index-abc.js', 'assets/chunk one.js', 'icons/icon-192.png', 'manifest.webmanifest'])
const get = (path: string, mode = 'cors', extra: { method?: string; range?: boolean } = {}) => routeRequest({ url: `https://music.example${path}`, method: extra.method ?? 'GET', mode, range: extra.range }, SCOPE, KEYS)

describe('cache names', () => {
  it('names the cache after the build, so two builds never share one', () => {
    expect(precacheName('1a2b3c4d5e6f')).toBe('wavelocal-precache-1a2b3c4d5e6f')
    expect(precacheName('1a2b3c4d5e6f')).not.toBe(precacheName('ffffffffffff'))
  })

  it('refuses a version that could not be a file-safe build id', () => {
    expect(() => precacheName('')).toThrow()
    expect(() => precacheName('a/b')).toThrow()
    expect(() => precacheName('x y')).toThrow()
  })

  it('knows its own caches by prefix and its precaches by shape', () => {
    expect(isOwnCache('wavelocal-v1')).toBe(true)
    expect(isOwnCache('wavelocal-precache-abc123abc123')).toBe(true)
    expect(isOwnCache('workbox-precache-v2')).toBe(false)
    expect(isOwnCache('')).toBe(false)
    expect(isPrecacheCache('wavelocal-precache-abc123abc123')).toBe(true)
    expect(isPrecacheCache('wavelocal-v1')).toBe(false)
    expect(LEGACY_CACHE).toBe('wavelocal-v1')
  })

  it('evicts every older version and the retired v1 cache, and only those', () => {
    const current = precacheName('bbbbbbbbbbbb')
    const names = ['wavelocal-v1', precacheName('aaaaaaaaaaaa'), current, precacheName('cccccccccccc'), 'workbox-runtime', 'another-app-cache']
    expect(staleCaches(names, current)).toEqual(['wavelocal-v1', precacheName('aaaaaaaaaaaa'), precacheName('cccccccccccc')])
  })

  it('evicts nothing when only the current version exists', () => {
    const current = precacheName('bbbbbbbbbbbb')
    expect(staleCaches([current], current)).toEqual([])
    expect(staleCaches([], current)).toEqual([])
  })
})

describe('isSafeEntryUrl', () => {
  it.each(['index.html', 'assets/a-b_c.js', 'icons/icon 192.png', 'a/b/c/d.css'])('accepts %s', (url) => {
    expect(isSafeEntryUrl(url)).toBe(true)
  })
  it.each(['', '/index.html', '../index.html', 'a/../b.js', './a.js', 'a//b.js', 'https://evil.example/a.js', 'a\\b.js', 'a?b.js', 'a#b.js', 'data:text/plain,hi', 'a/'])('rejects %j', (url) => {
    expect(isSafeEntryUrl(url)).toBe(false)
  })
})

describe('routeRequest', () => {
  it('serves a precached file from its entry', () => {
    expect(get('/app/assets/index-abc.js')).toEqual({ key: 'assets/index-abc.js' })
    expect(get('/app/icons/icon-192.png')).toEqual({ key: 'icons/icon-192.png' })
  })

  it('ignores the query string and finds names with escaped characters', () => {
    expect(get('/app/assets/index-abc.js?v=2')).toEqual({ key: 'assets/index-abc.js' })
    expect(get('/app/assets/chunk%20one.js')).toEqual({ key: 'assets/chunk one.js' })
  })

  it('leaves files the build did not list to the network', () => {
    expect(get('/app/assets/unknown.js')).toBeNull()
    expect(get('/app/robots.txt')).toBeNull()
    expect(get('/app/sw.js')).toBeNull()
  })

  it('serves the app shell for the scope root, with or without a query', () => {
    expect(get('/app/', 'navigate')).toEqual({ key: SHELL })
    expect(get('/app/?utm_source=x', 'navigate')).toEqual({ key: SHELL })
    expect(get('/app/index.html', 'navigate')).toEqual({ key: 'index.html' })
    expect(get('/app/', 'cors')).toEqual({ key: SHELL })
  })

  it('serves the shell for any page-like navigation inside the scope, but not for files', () => {
    expect(get('/app/library/songs', 'navigate')).toEqual({ key: SHELL })
    expect(get('/app/library/songs', 'cors')).toBeNull()
    expect(get('/app/notes.pdf', 'navigate')).toBeNull()
    expect(get('/app/assets/missing.js', 'navigate')).toBeNull()
  })

  it('leaves other origins, other paths and the scope parent alone', () => {
    expect(routeRequest({ url: 'https://cdn.example/app/assets/index-abc.js', method: 'GET', mode: 'cors' }, SCOPE, KEYS)).toBeNull()
    expect(routeRequest({ url: 'http://music.example/app/assets/index-abc.js', method: 'GET', mode: 'cors' }, SCOPE, KEYS)).toBeNull()
    expect(get('/other/assets/index-abc.js')).toBeNull()
    expect(get('/app', 'navigate')).toBeNull()
    expect(get('/', 'navigate')).toBeNull()
  })

  it('cannot be walked out of the scope with dot segments', () => {
    expect(get('/app/../secret/data.js')).toBeNull()
    expect(get('/app/assets/../../outside.js')).toBeNull()
    expect(get('/app/%2e%2e/x.js')).toBeNull()
  })

  it('only answers plain GETs, and leaves byte-range requests to the network', () => {
    expect(get('/app/assets/index-abc.js', 'cors', { method: 'POST' })).toBeNull()
    expect(get('/app/assets/index-abc.js', 'cors', { method: 'HEAD' })).toBeNull()
    expect(get('/app/assets/index-abc.js', 'cors', { range: true })).toBeNull()
    expect(get('/app/', 'navigate', { method: 'POST' })).toBeNull()
  })

  it('works for an app served from the root of a site', () => {
    const root = routeRequest({ url: 'https://music.example/assets/index-abc.js', method: 'GET', mode: 'cors' }, 'https://music.example/', KEYS)
    expect(root).toEqual({ key: 'assets/index-abc.js' })
    expect(routeRequest({ url: 'https://music.example/', method: 'GET', mode: 'navigate' }, 'https://music.example/', KEYS)).toEqual({ key: SHELL })
  })

  it('does not throw on a URL it cannot parse', () => {
    expect(routeRequest({ url: 'not a url', method: 'GET', mode: 'cors' }, SCOPE, KEYS)).toBeNull()
    expect(get('/app/%E0%A4%A.js')).toBeNull()
  })
})

describe('planInstall', () => {
  const a = entry('assets/a.js', 'a')
  const b = entry('assets/b.js', 'b')
  const c = entry('index.html', 'c')
  const manifest = [a, b, c]

  it('fetches everything on a first install', () => {
    const plan = planInstall(manifest, [], new Set())
    expect(plan.fetch).toEqual(manifest)
    expect(plan.reuse).toEqual([])
    expect(plan.keep).toEqual([])
  })

  it('copies what an older version already holds with the very same bytes', () => {
    const plan = planInstall(manifest, [{ name: 'wavelocal-precache-old', manifest: [a, entry('assets/b.js', 'z'), entry('gone.js', 'g')] }], new Set())
    expect(plan.reuse).toEqual([{ entry: a, from: 'wavelocal-precache-old' }])
    expect(plan.fetch).toEqual([b, c])
  })

  it('does not reuse a file whose size differs even if its hash matches', () => {
    const plan = planInstall([a], [{ name: 'old', manifest: [{ ...a, size: 11 }] }], new Set())
    expect(plan.reuse).toEqual([])
    expect(plan.fetch).toEqual([a])
  })

  it('keeps what an interrupted install of this very version already stored', () => {
    const plan = planInstall(manifest, [{ name: 'old', manifest: [a] }], new Set(['assets/a.js', 'index.html']))
    expect(plan.keep).toEqual(['assets/a.js', 'index.html'])
    expect(plan.reuse).toEqual([])
    expect(plan.fetch).toEqual([b])
  })

  it('takes a file from the first older version that has it', () => {
    const plan = planInstall([a], [{ name: 'v1', manifest: [a] }, { name: 'v2', manifest: [a] }], new Set())
    expect(plan.reuse).toEqual([{ entry: a, from: 'v1' }])
  })

  it('keeps the manifest order in every list', () => {
    const plan = planInstall([c, a, b], [], new Set())
    expect(plan.fetch.map((e) => e.url)).toEqual(['index.html', 'assets/a.js', 'assets/b.js'])
  })
})

describe('parseMarker', () => {
  const good = { version: '1a2b3c4d5e6f', manifest: [entry('index.html', 'a', 5, 'text/html'), entry('assets/a.js', 'b')] }

  it('reads what the worker stores', () => {
    expect(parseMarker(JSON.stringify(good))).toEqual(good)
  })

  it.each([
    ['not json', 'nope'],
    ['not an object', '[]'],
    ['no version', JSON.stringify({ manifest: [] })],
    ['empty version', JSON.stringify({ version: '', manifest: [] })],
    ['no manifest', JSON.stringify({ version: '1a2b3c4d5e6f' })],
    ['an entry without a hash', JSON.stringify({ version: '1a2b3c4d5e6f', manifest: [{ url: 'a.js', size: 1, type: 'text/javascript' }] })],
    ['a short hash', JSON.stringify({ version: '1a2b3c4d5e6f', manifest: [{ url: 'a.js', size: 1, type: 'text/javascript', hash: 'abc' }] })],
    ['a negative size', JSON.stringify({ version: '1a2b3c4d5e6f', manifest: [{ ...entry('a.js'), size: -1 }] })],
    ['a fractional size', JSON.stringify({ version: '1a2b3c4d5e6f', manifest: [{ ...entry('a.js'), size: 1.5 }] })],
    ['an unsafe url', JSON.stringify({ version: '1a2b3c4d5e6f', manifest: [entry('../a.js')] })],
    ['a content type with a line break in it', JSON.stringify({ version: '1a2b3c4d5e6f', manifest: [entry('a.js', 'a', 1, 'text/javascript\r\nSet-Cookie: x=1')] })],
    ['a duplicate url', JSON.stringify({ version: '1a2b3c4d5e6f', manifest: [entry('a.js'), entry('a.js', 'b')] })],
  ])('rejects %s', (_label, text) => {
    expect(parseMarker(text)).toBeNull()
  })

  it('has a marker path that no request can reach', () => {
    expect(MARKER_PATH).toMatch(/^[\w.-]+$/)
    expect(routeRequest({ url: `${SCOPE}${MARKER_PATH}`, method: 'GET', mode: 'cors' }, SCOPE, KEYS)).toBeNull()
  })
})
