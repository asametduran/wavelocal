import { describe, expect, it } from 'vitest'
// @ts-expect-error plain ES module without type declarations (build tooling, not app code)
import { POLICY, RUNTIME_SOURCES, assetRule, checkAssets, extractCsp, injectCsp, parsePolicy, permits, serializePolicy } from './csp.mjs'

type Policy = Map<string, string[]>
type Kind = 'self' | 'blob' | 'data' | 'wasm'
interface Rule {
  directive: string | null
  kind?: Kind
}
interface Check {
  ok: boolean
  problems: string[]
  checked: { file: string; directive: string | null }[]
}
const parse = (text: string): Policy => parsePolicy(text)
const allowed = (policy: string | Policy, directive: string, kind: Kind): boolean => permits(policy, directive, kind)
const rule = (file: string): Rule | null => assetRule(file)
const check = (files: string[], policy: string | Policy): Check => checkAssets(files, policy)
const inject = (html: string, policy?: string): string => injectCsp(html, policy)
const extract = (html: string): string | null => extractCsp(html)
const shipped = serializePolicy(POLICY) as string

describe('the shipped policy', () => {
  it('starts from nothing allowed and names every directive it opens up', () => {
    const p = parse(shipped)
    expect(p.get('default-src')).toEqual(["'none'"])
    expect(p.get('object-src')).toEqual(["'none'"])
    expect(p.get('form-action')).toEqual(["'none'"])
    expect(p.get('base-uri')).toEqual(["'self'"])
  })

  it('lets the page talk to nobody but itself: no remote host, wildcard, eval or inline code anywhere', () => {
    for (const [directive, sources] of parse(shipped)) {
      for (const source of sources) {
        expect(["'self'", "'none'", 'blob:'], `${directive} allows ${source}`).toContain(source)
      }
    }
    expect(shipped).not.toMatch(/unsafe-|\*|https?:|wss?:/)
  })

  it('is delivered through a meta tag, so it holds no directive a meta tag ignores', () => {
    const ignoredInMeta = ['frame-ancestors', 'report-uri', 'sandbox']
    for (const name of ignoredInMeta) expect(parse(shipped).has(name)).toBe(false)
  })

  it('allows everything the running app loads that is not an emitted file', () => {
    expect(RUNTIME_SOURCES.length).toBeGreaterThan(3)
    for (const { directive, source, why } of RUNTIME_SOURCES as { directive: string; source: Kind; why: string }[]) {
      expect(allowed(shipped, directive, source), `${directive} must allow ${source}: ${why}`).toBe(true)
    }
  })

  it('serialises to the same policy it was parsed from', () => {
    const again = serializePolicy(Object.fromEntries(parse(shipped))) as string
    expect(again).toBe(shipped)
  })
})

describe('parsePolicy', () => {
  it('splits directives and sources and lower-cases the directive names', () => {
    const p = parse("Default-Src 'none';  img-src 'self'   blob: ;; ")
    expect(p.get('default-src')).toEqual(["'none'"])
    expect(p.get('img-src')).toEqual(["'self'", 'blob:'])
    expect(p.size).toBe(2)
  })

  it('keeps the first of a repeated directive, as browsers do', () => {
    expect(parse("img-src 'self'; img-src *").get('img-src')).toEqual(["'self'"])
  })

  it('reads an empty or odd policy without throwing', () => {
    expect(parse('').size).toBe(0)
    expect(parse(' ; ; ').size).toBe(0)
    expect(parse('script-src').get('script-src')).toEqual([])
  })
})

describe('permits', () => {
  it('follows the fallback chain: worker-src, then child-src, then script-src, then default-src', () => {
    expect(allowed("default-src 'none'; script-src 'self'", 'worker-src', 'self')).toBe(true)
    expect(allowed("default-src 'none'; script-src 'self'; child-src 'none'", 'worker-src', 'self')).toBe(false)
    expect(allowed("default-src 'self'", 'worker-src', 'self')).toBe(true)
    expect(allowed("default-src 'none'", 'worker-src', 'self')).toBe(false)
  })

  it('lets a specific directive override default-src', () => {
    const p = "default-src 'none'; media-src 'self' blob:"
    expect(allowed(p, 'media-src', 'blob')).toBe(true)
    expect(allowed(p, 'img-src', 'blob')).toBe(false)
  })

  it('tells self, blob: and data: apart', () => {
    const p = "default-src 'none'; img-src 'self' blob:"
    expect(allowed(p, 'img-src', 'self')).toBe(true)
    expect(allowed(p, 'img-src', 'blob')).toBe(true)
    expect(allowed(p, 'img-src', 'data')).toBe(false)
  })

  it("treats 'none' as closed, unless other sources sit beside it (browsers ignore 'none' then)", () => {
    expect(allowed("img-src 'none'", 'img-src', 'self')).toBe(false)
    expect(allowed("img-src 'none' 'self'", 'img-src', 'self')).toBe(true)
  })

  it('allows anything when no directive covers the request, as an absent policy does', () => {
    expect(allowed("img-src 'self'", 'media-src', 'blob')).toBe(true)
  })

  it('needs wasm-unsafe-eval (or unsafe-eval) on top of script-src for WebAssembly', () => {
    expect(allowed("script-src 'self'", 'script-src', 'wasm')).toBe(false)
    expect(allowed("script-src 'self' 'wasm-unsafe-eval'", 'script-src', 'wasm')).toBe(true)
    expect(allowed("script-src 'wasm-unsafe-eval'", 'script-src', 'wasm')).toBe(false)
  })

  it('accepts a parsed policy as well as its text', () => {
    expect(allowed(parse("script-src 'self'"), 'script-src', 'self')).toBe(true)
  })
})

describe('assetRule', () => {
  it.each([
    ['assets/index-abc123.js', 'script-src'],
    ['assets/Tools-9fA.js', 'script-src'],
    ['assets/index-abc123.css', 'style-src'],
    ['icons/icon-192.png', 'img-src'],
    ['favicon.svg', 'img-src'],
    ['apple-touch-icon.png', 'img-src'],
    ['manifest.webmanifest', 'manifest-src'],
    ['fonts/inter.woff2', 'font-src'],
    ['audio/click.mp3', 'media-src'],
    ['data/strings.json', 'connect-src'],
  ])('%s is governed by %s', (file, directive) => {
    expect(rule(file)?.directive).toBe(directive)
  })

  it('treats the service worker and bundled workers as workers, not plain scripts', () => {
    expect(rule('sw.js')?.directive).toBe('worker-src')
    expect(rule('assets/decode.worker-BwfKGYVM.js')?.directive).toBe('worker-src')
    expect(rule('assets/other.worker.js')?.directive).toBe('worker-src')
    expect(rule('assets/networker-abc.js')?.directive).toBe('script-src')
  })

  it('asks for wasm-unsafe-eval on WebAssembly', () => {
    expect(rule('assets/codec-1a2b.wasm')).toEqual({ directive: 'script-src', kind: 'wasm' })
  })

  it('does not constrain documents and files no page loads', () => {
    expect(rule('index.html')?.directive).toBeNull()
    expect(rule('robots.txt')?.directive).toBeNull()
    expect(rule('assets/index-abc.js.map')?.directive).toBeNull()
  })

  it('ignores case and a query string, and reports a type it does not know as null', () => {
    expect(rule('ASSETS/Logo.PNG')?.directive).toBe('img-src')
    expect(rule('assets/a.js?v=2')?.directive).toBe('script-src')
    expect(rule('assets/blob.xyz')).toBeNull()
    expect(rule('LICENSE')).toBeNull()
  })
})

describe('checkAssets', () => {
  const files = ['index.html', 'sw.js', 'manifest.webmanifest', 'favicon.svg', 'icons/icon-192.png', 'assets/index-a.js', 'assets/index-a.css', 'assets/decode.worker-b.js', 'robots.txt']

  it('passes every file type the app emits today', () => {
    const r = check(files, shipped)
    expect(r.problems).toEqual([])
    expect(r.ok).toBe(true)
    expect(r.checked.find((c) => c.file === 'sw.js')?.directive).toBe('worker-src')
  })

  it('names the file, the directive and the fix when a type is blocked', () => {
    const r = check([...files, 'assets/inter.woff2'], shipped)
    expect(r.ok).toBe(false)
    expect(r.problems).toHaveLength(1)
    expect(r.problems[0]).toMatch(/assets\/inter\.woff2/)
    expect(r.problems[0]).toMatch(/font-src/)
  })

  it('refuses WebAssembly unless the policy opted in', () => {
    expect(check(['assets/x.wasm'], shipped).ok).toBe(false)
    expect(check(['assets/x.wasm'], shipped.replace("script-src 'self'", "script-src 'self' 'wasm-unsafe-eval'")).ok).toBe(true)
  })

  it('fails loudly on a file type nobody has decided about, instead of letting it through', () => {
    const r = check(['assets/model.bin'], shipped)
    expect(r.ok).toBe(false)
    expect(r.problems[0]).toMatch(/model\.bin/)
    expect(r.problems[0]).toMatch(/no CSP rule/i)
  })

  it('reports each problem once', () => {
    const r = check(['a.woff2', 'b.woff2', 'c.bin'], shipped)
    expect(r.problems).toHaveLength(3)
  })
})

describe('injectCsp', () => {
  const html = '<!doctype html>\n<html>\n  <head>\n    <meta charset="UTF-8" />\n    <title>x</title>\n    <script type="module" src="./a.js"></script>\n  </head>\n  <body></body>\n</html>'

  it('puts the policy straight after the charset, before anything that loads', () => {
    const out = inject(html)
    const at = out.indexOf('Content-Security-Policy')
    expect(at).toBeGreaterThan(out.indexOf('charset'))
    expect(at).toBeLessThan(out.indexOf('<title>'))
    expect(at).toBeLessThan(out.indexOf('<script'))
    expect(extract(out)).toBe(shipped)
  })

  it('also asks browsers not to send a referrer', () => {
    expect(inject(html)).toMatch(/<meta name="referrer" content="no-referrer" \/>/)
  })

  it('is idempotent: injecting twice leaves one policy and one referrer tag', () => {
    const twice = inject(inject(html))
    expect(twice.match(/Content-Security-Policy/g)).toHaveLength(1)
    expect(twice.match(/name="referrer"/g)).toHaveLength(1)
    expect(twice).toBe(inject(html))
  })

  it('replaces a policy that was already there', () => {
    const old = html.replace('<title>', '<meta http-equiv="Content-Security-Policy" content="default-src *"><title>')
    expect(extract(inject(old))).toBe(shipped)
    expect(inject(old).match(/Content-Security-Policy/g)).toHaveLength(1)
  })

  it('works without a charset tag by opening the head', () => {
    const out = inject('<html><head><title>x</title></head></html>')
    expect(out.indexOf('Content-Security-Policy')).toBeLessThan(out.indexOf('<title>'))
  })

  it('refuses a page with no head rather than shipping it unprotected', () => {
    expect(() => inject('<div>hello</div>')).toThrow(/head/i)
  })

  it('escapes the policy so no value can break out of the attribute', () => {
    const out = inject(html, `default-src 'none'; img-src "x" <y> & z`)
    expect(out).toContain('&quot;x&quot; &lt;y&gt; &amp; z')
    expect(extract(out)).toBe(`default-src 'none'; img-src "x" <y> & z`)
  })
})

describe('extractCsp', () => {
  it('reads either quote style and attribute order', () => {
    expect(extract(`<meta content='img-src a' http-equiv='content-security-policy'>`)).toBe('img-src a')
    expect(extract(`<META HTTP-EQUIV="Content-Security-Policy" CONTENT="img-src b">`)).toBe('img-src b')
  })

  it('returns null when there is none', () => {
    expect(extract('<head><meta charset="utf-8"></head>')).toBeNull()
  })
})
