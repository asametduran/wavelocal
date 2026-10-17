// Content-Security-Policy of the web / PWA / Android build, and the pure checks around it. Build tooling only (the app in
// src/ never imports this). The Vite plugin in vite-plugin-offline.mjs writes the policy into index.html as a <meta> tag
// during `vite build`, and `npm run check:dist` holds every emitted file against it.
//
// The app makes no network requests of its own: audio and artwork come from blob: object URLs, code from its own files.
// So the policy starts from default-src 'none' and opens only what that needs. Inline styles are set through the CSSOM
// (which CSP does not restrict), so no 'unsafe-inline' is needed; there is no eval and no inline script.

/** @typedef {'self' | 'blob' | 'data' | 'wasm'} SourceKind */
/** @typedef {Map<string, string[]>} ParsedPolicy */

/** The policy as data: directive -> sources. */
export const POLICY = Object.freeze({
  'default-src': ["'none'"],
  'script-src': ["'self'"],
  // the lossless decoder (module worker) and the service worker are both same-origin scripts
  'worker-src': ["'self'"],
  'style-src': ["'self'"],
  'img-src': ["'self'", 'blob:'],
  'media-src': ["'self'", 'blob:'],
  'connect-src': ["'self'"],
  'manifest-src': ["'self'"],
  'object-src': ["'none'"],
  'base-uri': ["'self'"],
  'form-action': ["'none'"],
  // frame-ancestors, report-uri and sandbox are ignored in a <meta> tag: a host that wants them sends a header
})

/**
 * What the running app loads that is not a file in dist/ (so `checkAssets` cannot see it). Each line is a reason the
 * policy must stay open somewhere; the unit test fails if an edit closes one.
 * @type {readonly { directive: string, source: SourceKind, why: string }[]}
 */
export const RUNTIME_SOURCES = Object.freeze([
  { directive: 'media-src', source: 'blob', why: 'the audio element plays every track from a blob: object URL' },
  { directive: 'img-src', source: 'blob', why: 'cover art is shown from blob: object URLs' },
  { directive: 'script-src', source: 'self', why: 'panels are loaded on demand with import()' },
  { directive: 'worker-src', source: 'self', why: 'the lossless decoder is a same-origin module worker' },
  { directive: 'worker-src', source: 'self', why: 'the offline service worker is a same-origin script' },
  { directive: 'style-src', source: 'self', why: 'stylesheets of the app and of its lazy panels' },
  { directive: 'manifest-src', source: 'self', why: 'the web app manifest' },
])

/** @param {Record<string, readonly string[]> | string} policy */
export function serializePolicy(policy = POLICY) {
  if (typeof policy === 'string') return policy
  return Object.entries(policy)
    .map(([name, sources]) => [name, ...sources].join(' '))
    .join('; ')
}

/**
 * Directive -> sources, as a browser reads it: names are case-insensitive and the first of a repeated directive wins.
 * @param {string} text
 * @returns {ParsedPolicy}
 */
export function parsePolicy(text) {
  /** @type {ParsedPolicy} */
  const out = new Map()
  for (const part of String(text).split(';')) {
    const tokens = part.trim().split(/\s+/).filter(Boolean)
    const name = tokens.shift()?.toLowerCase()
    if (!name || out.has(name)) continue
    out.set(name, tokens)
  }
  return out
}

/** Which directive a browser consults when the one asked for is absent (CSP 3, "fetch directive fallback"). */
const FALLBACK = {
  'script-src-elem': ['script-src'],
  'script-src-attr': ['script-src'],
  'style-src-elem': ['style-src'],
  'style-src-attr': ['style-src'],
  'worker-src': ['child-src', 'script-src'],
  'frame-src': ['child-src'],
}

/**
 * The source list that governs `directive`, or null when nothing in the policy does (everything is then allowed).
 * @param {string | ParsedPolicy} policy
 * @param {string} directive
 */
function sourcesFor(policy, directive) {
  const parsed = typeof policy === 'string' ? parsePolicy(policy) : policy
  const chain = [directive, ...(FALLBACK[/** @type {keyof typeof FALLBACK} */ (directive)] ?? []), 'default-src']
  for (const name of chain) {
    const sources = parsed.get(name)
    if (sources) return sources
  }
  return null
}

/**
 * Does the policy let `directive` load a resource of this kind? `self` is a file of the page's own origin.
 * @param {string | ParsedPolicy} policy
 * @param {string} directive
 * @param {SourceKind} kind
 */
export function permits(policy, directive, kind) {
  const sources = sourcesFor(policy, directive)
  if (sources === null) return true
  const set = new Set(sources.map((s) => s.toLowerCase()))
  // 'none' only means anything on its own: next to other sources a browser ignores it
  if (set.has("'none'") && set.size === 1) return false
  const ownOrigin = set.has("'self'") || set.has('*')
  switch (kind) {
    case 'self':
      return ownOrigin
    case 'blob':
      return set.has('blob:')
    case 'data':
      return set.has('data:')
    case 'wasm':
      // compiling WebAssembly is "eval-like": it needs the script to load AND an explicit opt-in
      return ownOrigin && (set.has("'wasm-unsafe-eval'") || set.has("'unsafe-eval'"))
    default:
      return false
  }
}

const EXTENSIONS = {
  script: ['js', 'mjs'],
  style: ['css'],
  img: ['png', 'jpg', 'jpeg', 'gif', 'webp', 'avif', 'svg', 'ico', 'bmp'],
  font: ['woff', 'woff2', 'ttf', 'otf', 'eot'],
  media: ['mp3', 'wav', 'ogg', 'opus', 'flac', 'm4a', 'aac', 'mp4', 'webm'],
  // pages never load these (documents, robots.txt, source maps are read by tools): no directive applies
  inert: ['html', 'htm', 'txt', 'map', 'md'],
}

/**
 * Which directive governs loading a file of dist/, by its name. `{ directive: null }` for files no page loads;
 * null when the type is unknown, which `checkAssets` reports so that a new kind of asset is a deliberate decision.
 * @param {string} file path relative to dist/ (a query string is ignored)
 * @returns {{ directive: string | null, kind?: SourceKind } | null}
 */
export function assetRule(file) {
  const name = file.split('?')[0]?.toLowerCase() ?? ''
  const ext = name.slice(name.lastIndexOf('.') + 1)
  if (name === 'sw.js' || /(^|\/)[^/]*\.worker(-[^/]*)?\.js$/.test(name)) return { directive: 'worker-src' }
  if (EXTENSIONS.script.includes(ext)) return { directive: 'script-src' }
  if (ext === 'wasm') return { directive: 'script-src', kind: 'wasm' }
  if (EXTENSIONS.style.includes(ext)) return { directive: 'style-src' }
  if (EXTENSIONS.img.includes(ext)) return { directive: 'img-src' }
  if (EXTENSIONS.font.includes(ext)) return { directive: 'font-src' }
  if (EXTENSIONS.media.includes(ext)) return { directive: 'media-src' }
  if (ext === 'webmanifest') return { directive: 'manifest-src' }
  if (ext === 'json') return { directive: 'connect-src' }
  if (EXTENSIONS.inert.includes(ext)) return { directive: null }
  return null
}

/**
 * Hold every emitted file against the policy: each must be loadable by the directive that governs its type.
 * @param {readonly string[]} files paths relative to dist/
 * @param {string | ParsedPolicy} policy
 * @returns {{ ok: boolean, problems: string[], checked: { file: string, directive: string | null }[] }}
 */
export function checkAssets(files, policy) {
  const problems = []
  const checked = []
  for (const file of files) {
    const rule = assetRule(file)
    if (!rule) {
      problems.push(`${file}: no CSP rule for this file type; add it to assetRule() in scripts/csp.mjs (and to the policy if pages load it)`)
      continue
    }
    checked.push({ file, directive: rule.directive })
    if (rule.directive === null) continue
    if (!permits(policy, rule.directive, rule.kind ?? 'self')) {
      const need = rule.kind === 'wasm' ? "'self' and 'wasm-unsafe-eval'" : "'self'"
      problems.push(`${file}: blocked by the policy; ${rule.directive} would have to allow ${need}`)
    }
  }
  return { ok: problems.length === 0, problems, checked }
}

const escapeAttribute = (text) => text.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
const unescapeAttribute = (text) => text.replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&')

const CSP_META = /<meta\b(?=[^>]*\bhttp-equiv\s*=\s*["']?content-security-policy["']?)[^>]*>\s*/gi
const REFERRER_META = /<meta\b(?=[^>]*\bname\s*=\s*["']?referrer["']?)[^>]*>\s*/gi

/**
 * Put the policy into a page as the first thing after the charset (a meta policy only governs what comes after it).
 * Idempotent: an existing policy or referrer tag is replaced.
 * @param {string} html
 * @param {string | Record<string, readonly string[]>} [policy]
 */
export function injectCsp(html, policy = POLICY) {
  const text = serializePolicy(policy)
  const clean = html.replace(CSP_META, '').replace(REFERRER_META, '')
  const tags = `<meta http-equiv="Content-Security-Policy" content="${escapeAttribute(text)}" />\n    <meta name="referrer" content="no-referrer" />`
  const anchor = /<meta\s+charset=[^>]*>/i.exec(clean) ?? /<head\b[^>]*>/i.exec(clean)
  if (!anchor) throw new Error('Cannot add a Content-Security-Policy: the page has no <head>')
  const end = anchor.index + anchor[0].length
  return `${clean.slice(0, end)}\n    ${tags}${clean.slice(end)}`
}

/**
 * The policy a page declares in its meta tag, or null.
 * @param {string} html
 */
export function extractCsp(html) {
  const tag = /<meta\b(?=[^>]*\bhttp-equiv\s*=\s*["']?content-security-policy["']?)[^>]*>/i.exec(html)?.[0]
  if (!tag) return null
  const value = /\bcontent\s*=\s*(?:"([^"]*)"|'([^']*)')/i.exec(tag)
  const raw = value?.[1] ?? value?.[2]
  return raw === undefined ? null : unescapeAttribute(raw)
}
