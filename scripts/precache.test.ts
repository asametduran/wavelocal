// @vitest-environment node
import { createHash } from 'node:crypto'
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import vm from 'node:vm'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
// @ts-expect-error plain ES module without type declarations (build tooling, not app code)
import { buildManifest, hashBytes, injectServiceWorker, isExcluded, listFiles, mimeFor, versionOf } from './precache.mjs'
// @ts-expect-error plain ES module without type declarations (build tooling, not app code)
import { checkDist } from './check-dist.mjs'
// @ts-expect-error plain ES module without type declarations (build tooling, not app code)
import { injectCsp } from './csp.mjs'
// @ts-expect-error plain ES module without type declarations (build tooling, not app code)
import { offline } from './vite-plugin-offline.mjs'

interface Entry {
  url: string
  size: number
  hash: string
  type: string
}
interface Built {
  version: string
  manifest: Entry[]
}
interface Checked {
  ok: boolean
  problems: string[]
  summary: { files: number; bytes: number; version: string | null }
}
const manifestOf = (dir: string): Entry[] => buildManifest(dir)
const versionFor = (manifest: Entry[], format?: number): string => versionOf(manifest, format)
const inject = (distDir: string): Promise<Built> => injectServiceWorker({ distDir })
const check = (dir: string): Checked => checkDist(dir)

const roots: string[] = []
function folder(): string {
  const dir = mkdtempSync(join(tmpdir(), 'wavelocal-dist-'))
  roots.push(dir)
  return dir
}
function write(dir: string, files: Record<string, string | Uint8Array>): string {
  for (const [name, content] of Object.entries(files)) {
    const path = join(dir, name)
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, content)
  }
  return dir
}
afterAll(() => {
  for (const dir of roots) rmSync(dir, { recursive: true, force: true })
})

const PAGE =
  '<!doctype html><html lang="en"><head><meta charset="UTF-8" /><title>t</title><script type="module" crossorigin src="./assets/index-abc123.js"></script><link rel="stylesheet" crossorigin href="./assets/index-def456.css"></head><body><div id="root"></div></body></html>'
const SITE: Record<string, string | Uint8Array> = {
  'index.html': injectCsp(PAGE),
  'assets/index-abc123.js': 'import("./lazy-abc123.js").then(()=>new Worker(new URL("thing.worker-abc123.js",import.meta.url)))',
  'assets/lazy-abc123.js': 'export default 1',
  'assets/thing.worker-abc123.js': 'self.onmessage=()=>{}',
  'assets/index-def456.css': 'body{margin:0}',
  'manifest.webmanifest': '{"name":"t"}',
  'favicon.svg': '<svg xmlns="http://www.w3.org/2000/svg"/>',
  'icons/icon-192.png': new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 0, 1, 2, 3]),
  'robots.txt': 'User-agent: *',
}

describe('mimeFor', () => {
  it.each([
    ['index.html', 'text/html; charset=utf-8'],
    ['assets/a-b.js', 'text/javascript; charset=utf-8'],
    ['assets/a.css', 'text/css; charset=utf-8'],
    ['manifest.webmanifest', 'application/manifest+json'],
    ['icons/a.PNG', 'image/png'],
    ['favicon.svg', 'image/svg+xml'],
    ['fonts/a.woff2', 'font/woff2'],
  ])('%s is served as %s', (file, type) => {
    expect(mimeFor(file)).toBe(type)
  })

  it('does not guess at a type it does not know', () => {
    expect(mimeFor('LICENSE')).toBeNull()
    expect(mimeFor('assets/model.bin')).toBeNull()
    expect(mimeFor('dir.with.dots/readme')).toBeNull()
  })
})

describe('isExcluded', () => {
  it('leaves out the worker, its record, robots.txt, source maps and dotfiles, and nothing else', () => {
    for (const file of ['sw.js', 'precache-manifest.json', 'robots.txt', 'assets/a.js.map', '.DS_Store', 'assets/.keep']) expect(isExcluded(file), file).toBe(true)
    for (const file of ['index.html', 'assets/sw.js', 'assets/a.js', 'manifest.webmanifest', 'robots.txt.html']) expect(isExcluded(file), file).toBe(false)
  })
})

describe('buildManifest', () => {
  it('records the size, checksum and content type of every file, sorted by path', () => {
    const dir = write(folder(), SITE)
    const manifest = manifestOf(dir)
    expect(manifest.map((e) => e.url)).toEqual([...manifest.map((e) => e.url)].sort())
    const index = manifest.find((e) => e.url === 'index.html')
    const bytes = readFileSync(join(dir, 'index.html'))
    expect(index).toEqual({ url: 'index.html', size: bytes.length, hash: createHash('sha256').update(bytes).digest('hex').slice(0, 32), type: 'text/html; charset=utf-8' })
    expect(manifest.find((e) => e.url === 'icons/icon-192.png')).toMatchObject({ size: 12, type: 'image/png' })
  })

  it('uses forward slashes for files in folders', () => {
    const manifest = manifestOf(write(folder(), SITE))
    expect(manifest.some((e) => e.url === 'assets/lazy-abc123.js')).toBe(true)
    expect(manifest.some((e) => e.url.includes('\\'))).toBe(false)
  })

  it('does not list the worker, its record, robots.txt or dotfiles', () => {
    const dir = write(folder(), { ...SITE, 'sw.js': 'old', 'precache-manifest.json': '{}', 'assets/a.js.map': '{}', '.DS_Store': 'x' })
    const urls = manifestOf(dir).map((e) => e.url)
    for (const left of ['sw.js', 'precache-manifest.json', 'robots.txt', 'assets/a.js.map', '.DS_Store']) expect(urls).not.toContain(left)
  })

  it('fails the build on a file type it has no content type for, naming the file', () => {
    const dir = write(folder(), { ...SITE, 'assets/model.bin': 'x' })
    expect(() => manifestOf(dir)).toThrow(/model\.bin/)
  })

  it('fails the build on a file name a URL cannot carry', () => {
    expect(() => manifestOf(write(folder(), { ...SITE, 'assets/a#b.js': 'x' }))).toThrow(/a#b\.js/)
    expect(() => manifestOf(write(folder(), { ...SITE, 'assets/100%.js': 'x' }))).toThrow(/100%\.js/)
  })

  it('keeps files whose names are not ASCII: a URL carries them percent-encoded and the worker reads them back', () => {
    const names = ['icons/ışık ŞŞ.png', 'assets/İstanbul-Yarısı.svg', 'assets/café.png', 'assets/音楽.svg']
    const manifest = manifestOf(write(folder(), { ...SITE, ...Object.fromEntries(names.map((name) => [name, 'x'])) }))
    for (const name of names) expect(manifest.map((e) => e.url)).toContain(name)
  })

  it('still fails the build on names that only look like a file name: invisible and direction-changing characters', () => {
    expect(() => manifestOf(write(folder(), { ...SITE, 'assets/a​b.js': 'x' }))).toThrow(/names a URL cannot carry/)
    expect(() => manifestOf(write(folder(), { ...SITE, 'assets/a‮b.js': 'x' }))).toThrow(/names a URL cannot carry/)
  })

  it('fails the build without an index.html, since nothing could be opened offline', () => {
    const { 'index.html': _page, ...rest } = SITE
    expect(() => manifestOf(write(folder(), rest))).toThrow(/index\.html/)
  })
})

describe('hashBytes and versionOf', () => {
  it('hashes to 32 hex digits of the SHA-256', () => {
    expect(hashBytes(new TextEncoder().encode('abc'))).toBe('ba7816bf8f01cfea414140de5dae2223')
  })

  const base: Entry[] = [
    { url: 'index.html', size: 1, hash: 'a'.repeat(32), type: 'text/html' },
    { url: 'assets/a.js', size: 1, hash: 'b'.repeat(32), type: 'text/javascript' },
  ]

  it('is 12 hex digits and does not depend on the order of the list', () => {
    expect(versionFor(base)).toMatch(/^[0-9a-f]{12}$/)
    expect(versionFor([...base].reverse())).toBe(versionFor(base))
  })

  it('changes when any file changes: its bytes, its name or its content type', () => {
    const first = base[0] as Entry
    const second = base[1] as Entry
    const id = versionFor(base)
    expect(versionFor([first, { ...second, hash: 'c'.repeat(32) }])).not.toBe(id)
    expect(versionFor([first, { ...second, url: 'assets/b.js' }])).not.toBe(id)
    expect(versionFor([first, { ...second, type: 'text/plain' }])).not.toBe(id)
    expect(versionFor([first])).not.toBe(id)
  })

  it('does not change when only the size field differs (the hash already covers the bytes)', () => {
    const first = base[0] as Entry
    const second = base[1] as Entry
    expect(versionFor([first, { ...second, size: 99 }])).toBe(versionFor(base))
  })

  it('changes with the cache layout version, so a new layout starts a fresh cache everywhere', () => {
    expect(versionFor(base, 1)).not.toBe(versionFor(base, 2))
  })
})

describe('the Vite plugins', () => {
  interface Plugins {
    csp: { name: string; apply: string; transformIndexHtml: { order: string; handler: (html: string) => string } }
    worker: { name: string; apply: string; configResolved: (config: { root: string; build: { outDir: string } }) => void; buildEnd: (error?: unknown) => void; closeBundle: () => Promise<void> }
  }
  const plugins = (): Plugins => {
    const [csp, worker] = offline() as [Plugins['csp'], Plugins['worker']]
    return { csp, worker }
  }

  it('run for the production build only, never for the dev server or the tests', () => {
    const { csp, worker } = plugins()
    expect(csp.apply).toBe('build')
    expect(worker.apply).toBe('build')
  })

  it('put the policy into the page after Vite has finished with it', () => {
    const { csp } = plugins()
    expect(csp.transformIndexHtml.order).toBe('post')
    expect(csp.transformIndexHtml.handler(PAGE)).toContain('Content-Security-Policy')
  })

  it('build the worker from what is really in the output folder once the bundle is written', async () => {
    const dir = write(folder(), SITE)
    const { worker } = plugins()
    worker.configResolved({ root: join(__dirname, '..'), build: { outDir: dir } }) // the project root, where Vite finds sw/sw.ts
    worker.buildEnd(undefined)
    const log = console.log
    const lines: string[] = []
    console.log = (line: string) => void lines.push(line)
    try {
      await worker.closeBundle()
    } finally {
      console.log = log
    }
    expect(readFileSync(join(dir, 'sw.js'), 'utf8')).toContain((JSON.parse(readFileSync(join(dir, 'precache-manifest.json'), 'utf8')) as { version: string }).version)
    expect(lines.join('\n')).toMatch(/offline copy: \d+ files, \d+ kB, build [0-9a-f]{12}/)
  }, 120_000)

  it('leave a failed build alone instead of hiding its error behind another one', async () => {
    const dir = folder() // an output folder with nothing in it, as after a build that stopped halfway
    const { worker } = plugins()
    worker.configResolved({ root: join(__dirname, '..'), build: { outDir: dir } })
    worker.buildEnd(new Error('the build failed'))
    await expect(worker.closeBundle()).resolves.toBeUndefined()
    expect(() => readFileSync(join(dir, 'sw.js'))).toThrow()
  })
})

describe('listFiles', () => {
  it('walks folders and returns sorted posix paths', () => {
    const dir = write(folder(), { 'b.txt': '1', 'a/z.txt': '1', 'a/b/c.txt': '1' })
    expect(listFiles(dir)).toEqual(['a/b/c.txt', 'a/z.txt', 'b.txt'])
  })
})

describe('the offline copy of a build', () => {
  let dist = ''
  let built: Built
  beforeAll(async () => {
    dist = write(folder(), SITE)
    built = await inject(dist)
  }, 120_000)

  it('writes the worker and a record that agrees with the files', () => {
    const record = JSON.parse(readFileSync(join(dist, 'precache-manifest.json'), 'utf8')) as { version: string; format: number; entries: Entry[] }
    expect(record.version).toBe(built.version)
    expect(record.format).toBe(1)
    expect(record.entries).toEqual(manifestOf(dist))
    expect(built.manifest.length).toBe(Object.keys(SITE).length - 1) // everything but robots.txt
  })

  it('writes a worker that is a single classic script carrying the build id and the list of files', () => {
    const code = readFileSync(join(dist, 'sw.js'), 'utf8')
    expect(() => new vm.Script(code)).not.toThrow()
    expect(code).not.toMatch(/^\s*(?:import|export)\s/m)
    expect(code).toContain(built.version)
    for (const entry of built.manifest) expect(code).toContain(entry.hash)
  })

  it('starts up in a worker, listens for the four events and answers a status request', async () => {
    const code = readFileSync(join(dist, 'sw.js'), 'utf8')
    const listeners = new Map<string, (event: unknown) => void>()
    const scope = {
      registration: { scope: 'https://music.example/app/' },
      caches: { has: async () => false },
      fetch: async () => new Response(''),
      skipWaiting: async () => {},
      clients: { claim: async () => {} },
      addEventListener: (type: string, listener: (event: unknown) => void) => listeners.set(type, listener),
    }
    vm.runInNewContext(code, { self: scope, crypto, Request, Response, URL, TextEncoder, JSON, Promise, Set, Map, Array, Error, TypeError, Math, Number, String, Object, RegExp })
    expect([...listeners.keys()].sort()).toEqual(['activate', 'fetch', 'install', 'message'])

    const replies: unknown[] = []
    const pending: Promise<unknown>[] = []
    listeners.get('message')?.({ data: { type: 'status' }, ports: [{ postMessage: (reply: unknown) => replies.push(reply) }], waitUntil: (work: Promise<unknown>) => pending.push(work) })
    await Promise.all(pending)
    expect(replies).toEqual([{ version: built.version, entries: built.manifest.length, bytes: built.manifest.reduce((n, e) => n + e.size, 0), complete: false }])
  })

  it('is reproducible: building the same files again gives the same worker, byte for byte', async () => {
    const copy = folder()
    cpSync(dist, copy, { recursive: true })
    const again = await inject(copy)
    expect(again.version).toBe(built.version)
    expect(readFileSync(join(copy, 'sw.js'), 'utf8')).toBe(readFileSync(join(dist, 'sw.js'), 'utf8'))
  }, 120_000)

  it('ignores its own earlier output, so a rebuild never lists the old worker', async () => {
    const copy = folder()
    cpSync(dist, copy, { recursive: true })
    await inject(copy)
    expect((JSON.parse(readFileSync(join(copy, 'precache-manifest.json'), 'utf8')) as { entries: Entry[] }).entries.map((e) => e.url)).not.toContain('sw.js')
  }, 120_000)

  it('is a different worker, with a different id, as soon as one file differs', async () => {
    const copy = folder()
    cpSync(dist, copy, { recursive: true })
    writeFileSync(join(copy, 'assets', 'lazy-abc123.js'), 'export default 2')
    const next = await inject(copy)
    expect(next.version).not.toBe(built.version)
    expect(readFileSync(join(copy, 'sw.js'), 'utf8')).not.toBe(readFileSync(join(dist, 'sw.js'), 'utf8'))
  }, 120_000)

  describe('checkDist', () => {
    const copyOfBuild = (): string => {
      const dir = folder()
      cpSync(dist, dir, { recursive: true })
      return dir
    }

    it('passes a build whose policy covers every file and whose offline copy is whole', () => {
      const result = check(dist)
      expect(result.problems).toEqual([])
      expect(result.ok).toBe(true)
      expect(result.summary).toMatchObject({ files: built.manifest.length, version: built.version })
    })

    it('fails when a file changed after the worker was built', () => {
      const dir = copyOfBuild()
      writeFileSync(join(dir, 'assets', 'lazy-abc123.js'), 'export default 3')
      expect(check(dir).problems.join('\n')).toMatch(/does not describe the files/)
    })

    it('fails when the page has lost its policy', () => {
      const dir = copyOfBuild()
      writeFileSync(join(dir, 'index.html'), PAGE)
      const result = check(dir)
      expect(result.ok).toBe(false)
      expect(result.problems.join('\n')).toMatch(/Content-Security-Policy meta tag/)
    })

    it('fails when the page carries a different policy than the one in the repository', () => {
      const dir = copyOfBuild()
      writeFileSync(join(dir, 'index.html'), injectCsp(PAGE, "default-src 'self'"))
      expect(check(dir).problems.join('\n')).toMatch(/not POLICY/)
    })

    it.each([
      ['an inline script', '<script>alert(1)</script>', /inline <script>/],
      ['an inline event handler', '<button onclick="go()">x</button>', /inline event handler/],
      ['a style attribute', '<div style="color:red">x</div>', /style attribute/],
    ])('fails when the page has %s, which the policy would block without a word', (_label, markup, message) => {
      const dir = copyOfBuild()
      writeFileSync(join(dir, 'index.html'), (readFileSync(join(dir, 'index.html'), 'utf8') as string).replace('<div id="root"></div>', `<div id="root"></div>${markup}`))
      expect(check(dir).problems.join('\n')).toMatch(message)
    })

    it('fails when the build emits a kind of file the policy does not let a page load', () => {
      const dir = copyOfBuild()
      writeFileSync(join(dir, 'assets', 'inter-abc123.woff2'), 'font')
      const result = check(dir)
      expect(result.ok).toBe(false)
      expect(result.problems.join('\n')).toMatch(/inter-abc123\.woff2: blocked by the policy; font-src/)
    })

    it('fails when a chunk refers to a file that is not in the build, so a panel would be missing offline', () => {
      const dir = copyOfBuild()
      writeFileSync(join(dir, 'assets', 'index-abc123.js'), 'import("./gone-abc123.js")')
      expect(check(dir).problems.join('\n')).toMatch(/not part of the offline copy: assets\/gone-abc123\.js/)
    })

    it('fails when a worker the app starts is not in the build', () => {
      const dir = copyOfBuild()
      writeFileSync(join(dir, 'assets', 'index-abc123.js'), 'new Worker(new URL("lost.worker-abc123.js",import.meta.url))')
      expect(check(dir).problems.join('\n')).toMatch(/not part of the offline copy: assets\/lost\.worker-abc123\.js/)
    })

    it('fails when the preload list of a chunk names a file that is not in the build', () => {
      const dir = copyOfBuild()
      writeFileSync(join(dir, 'assets', 'index-abc123.js'), 'const deps=["assets/gone-abc123.js","assets/lazy-abc123.js"]')
      const problems = check(dir).problems.join('\n')
      expect(problems).toMatch(/not part of the offline copy: assets\/gone-abc123\.js/)
      expect(problems).not.toMatch(/lazy-abc123/)
    })

    it('fails when the worker script is missing', () => {
      const dir = copyOfBuild()
      rmSync(join(dir, 'sw.js'))
      expect(check(dir).problems.join('\n')).toMatch(/offline copy was not built/)
    })

    it('fails when the worker is a module rather than a classic script', () => {
      const dir = copyOfBuild()
      writeFileSync(join(dir, 'sw.js'), `export const version = "${built.version}"`)
      expect(check(dir).problems.join('\n')).toMatch(/not a valid classic script/)
    })

    it('fails when the worker belongs to another build', () => {
      const dir = copyOfBuild()
      writeFileSync(join(dir, 'sw.js'), '/* some other build */')
      expect(check(dir).problems.join('\n')).toMatch(/does not carry this build's id/)
    })

    it('asks for a build first when there is none', () => {
      expect(check(folder()).problems.join('\n')).toMatch(/run the build first/)
    })
  })
})
