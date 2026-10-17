// `npm run check:dist` (also the last step of `npm run build`): hold the finished build in dist/ to what the app promises.
//  - index.html carries the Content-Security-Policy of csp.mjs, has nothing the policy would block, and every emitted file
//    type is one the policy lets a page load;
//  - the offline copy is whole: sw.js is a classic script that carries this very build's id, its record matches the files
//    on disk byte for byte, and everything index.html and the chunks refer to is part of it.
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join, posix } from 'node:path'
import { fileURLToPath } from 'node:url'
import vm from 'node:vm'
import { POLICY, checkAssets, extractCsp, serializePolicy } from './csp.mjs'
import { MANIFEST_FILE, WORKER_FILE, buildManifest, listFiles, versionOf } from './precache.mjs'

const read = (/** @type {string} */ dir, /** @type {string} */ file) => readFileSync(join(dir, file), 'utf8')

/** Relative files a page or script refers to, as paths from dist/. External addresses and fragments are not files of the build. */
function references(/** @type {string} */ text, /** @type {string} */ from, /** @type {RegExp} */ pattern) {
  const found = new Set()
  for (const match of text.matchAll(pattern)) {
    const ref = (match[1] ?? '').split(/[?#]/)[0] ?? ''
    if (!ref || /^[a-z][a-z0-9+.-]*:|^\/\//i.test(ref)) continue
    found.add(posix.normalize(ref.startsWith('/') ? ref.slice(1) : posix.join(dirname(from), ref)))
  }
  return [...found]
}

/**
 * @param {string} dist the build folder
 * @returns {{ ok: boolean, problems: string[], summary: { files: number, bytes: number, version: string | null } }}
 */
export function checkDist(dist) {
  /** @type {string[]} */
  const problems = []
  const summary = { files: 0, bytes: 0, version: /** @type {string | null} */ (null) }
  if (!existsSync(join(dist, 'index.html'))) return { ok: false, problems: [`${dist} has no index.html: run the build first`], summary }

  const files = listFiles(dist)
  const html = read(dist, 'index.html')

  // ---- the page and its policy ----
  const shipped = extractCsp(html)
  if (!shipped) problems.push('index.html has no Content-Security-Policy meta tag (is the wavelocal:csp plugin running?)')
  else {
    if (shipped !== serializePolicy(POLICY)) problems.push('The policy in index.html is not POLICY from scripts/csp.mjs')
    problems.push(...checkAssets(files, shipped).problems)
  }
  // a policy without 'unsafe-inline' blocks all of these, silently: they must not be in the page
  if (/<script\b(?![^>]*\bsrc\s*=)[^>]*>\s*\S[\s\S]*?<\/script>/i.test(html)) problems.push('index.html has an inline <script>, which the policy blocks')
  if (/<[a-z][^>]*\son[a-z]+\s*=/i.test(html)) problems.push('index.html has an inline event handler, which the policy blocks')
  if (/<[a-z][^>]*\sstyle\s*=/i.test(html)) problems.push('index.html has a style attribute, which the policy blocks')

  // ---- the offline copy ----
  if (!files.includes(WORKER_FILE) || !files.includes(MANIFEST_FILE)) {
    problems.push(`${WORKER_FILE} or ${MANIFEST_FILE} is missing: the offline copy was not built (is the wavelocal:service-worker plugin running?)`)
    return { ok: false, problems, summary }
  }
  const code = read(dist, WORKER_FILE)
  try {
    new vm.Script(code, { filename: WORKER_FILE })
  } catch (error) {
    problems.push(`${WORKER_FILE} is not a valid classic script (no import or export): ${error instanceof Error ? error.message : error}`)
  }

  /** @type {ReturnType<typeof buildManifest>} */
  let manifest = []
  try {
    manifest = buildManifest(dist)
  } catch (error) {
    problems.push(error instanceof Error ? error.message : String(error))
    return { ok: false, problems, summary }
  }
  const version = versionOf(manifest)
  summary.files = manifest.length
  summary.bytes = manifest.reduce((sum, entry) => sum + entry.size, 0)
  summary.version = version

  /** @type {{ version?: string, entries?: unknown }} */
  let record = {}
  try {
    record = JSON.parse(read(dist, MANIFEST_FILE))
  } catch {
    problems.push(`${MANIFEST_FILE} is not valid JSON`)
  }
  if (record.version !== version || JSON.stringify(record.entries) !== JSON.stringify(manifest)) {
    problems.push(`${MANIFEST_FILE} does not describe the files in dist/ (something changed them after the service worker was built)`)
  }
  if (!code.includes(version)) problems.push(`${WORKER_FILE} does not carry this build's id ${version}`)

  // everything the shell and the chunks refer to has to be in the offline copy, or a panel would be missing offline
  const stored = new Set(manifest.map((entry) => entry.url))
  const missing = new Set()
  for (const ref of references(html, 'index.html', /\b(?:src|href)\s*=\s*["']?([^"'\s>]+)/gi)) if (!stored.has(ref)) missing.add(`${ref} (from index.html)`)
  for (const entry of manifest) {
    if (!/\.(?:js|css)$/.test(entry.url)) continue
    const text = read(dist, entry.url)
    // a chunk imports its siblings as "./Name-hash.js"; the preload helper lists them as "assets/Name-hash.js"
    for (const ref of references(text, entry.url, /["'`](\.\/[\w.-]+-[\w-]{6,}\.(?:js|css))["'`]/g)) if (!stored.has(ref)) missing.add(`${ref} (from ${entry.url})`)
    for (const ref of references(text, 'index.html', /["'`](assets\/[\w.-]+-[\w-]{6,}\.(?:js|css))["'`]/g)) if (!stored.has(ref)) missing.add(`${ref} (from ${entry.url})`)
    // a worker is started with new URL("name.worker-hash.js", import.meta.url): relative to the chunk that starts it
    for (const ref of references(text, entry.url, /new URL\(\s*["'`]([\w.-]+\.worker-[\w-]+\.js)["'`]/g)) if (!stored.has(ref)) missing.add(`${ref} (from ${entry.url})`)
  }
  for (const item of missing) problems.push(`not part of the offline copy: ${item}`)

  return { ok: problems.length === 0, problems, summary }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const dist = join(fileURLToPath(new URL('.', import.meta.url)), '..', 'dist')
  const { ok, problems, summary } = checkDist(dist)
  if (summary.version) console.log(`dist: ${summary.files} files, ${(summary.bytes / 1024).toFixed(0)} kB offline, build ${summary.version}`)
  if (!ok) {
    for (const problem of problems) console.error(`DIST CHECK FAILED: ${problem}`)
    process.exit(1)
  }
  console.log('dist ok: policy covers every file, offline copy is whole')
}
