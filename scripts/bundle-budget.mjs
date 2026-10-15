// Pure logic of the bundle budget check (no file system access), so it can be unit tested.

/** Gzipped-size limits in bytes. `initial` covers everything index.html loads before the app can render. */
export const BUDGET = {
  initialJs: 125 * 1024,
  initialCss: 10 * 1024,
  /** Any single chunk that is loaded on demand. */
  lazyChunk: 60 * 1024,
}

/** Asset paths (relative to dist/) that index.html loads eagerly: scripts, module preloads and stylesheets. */
export function initialAssets(html) {
  const found = new Set()
  for (const match of html.matchAll(/<(script|link)\b[^>]*>/gi)) {
    const markup = match[0]
    const tag = (match[1] ?? '').toLowerCase()
    const rel = /\brel=["']?([\w-]+)/i.exec(markup)?.[1]?.toLowerCase()
    if (tag === 'link' && rel !== 'modulepreload' && rel !== 'stylesheet') continue
    const ref = /\b(?:src|href)=["']?([^"'\s>]+)/i.exec(markup)?.[1]
    if (ref && /assets\//.test(ref)) found.add(ref.slice(ref.indexOf('assets/')))
  }
  return [...found]
}

/**
 * Compare measured gzip sizes against the budget.
 * @param {{ name: string, gzip: number }[]} assets every file in dist/assets
 * @param {string[]} initial names (as in `assets`) loaded eagerly
 * @returns {{ ok: boolean, initialJs: number, initialCss: number, problems: string[] }}
 */
export function checkBudget(assets, initial, budget = BUDGET) {
  const eager = new Set(initial)
  const problems = []
  let initialJs = 0
  let initialCss = 0
  for (const a of assets) {
    if (eager.has(a.name)) {
      if (a.name.endsWith('.css')) initialCss += a.gzip
      else if (a.name.endsWith('.js')) initialJs += a.gzip
    } else if (a.name.endsWith('.js') && a.gzip > budget.lazyChunk) {
      problems.push(`${a.name} is ${kb(a.gzip)} gzipped (limit for an on-demand chunk: ${kb(budget.lazyChunk)})`)
    }
  }
  for (const name of eager) {
    if (!assets.some((a) => a.name === name)) problems.push(`index.html references ${name}, which is missing from dist/assets`)
  }
  if (initialJs > budget.initialJs) problems.push(`initial JavaScript is ${kb(initialJs)} gzipped (limit ${kb(budget.initialJs)})`)
  if (initialCss > budget.initialCss) problems.push(`initial CSS is ${kb(initialCss)} gzipped (limit ${kb(budget.initialCss)})`)
  return { ok: problems.length === 0, initialJs, initialCss, problems }
}

export const kb = (bytes) => `${(bytes / 1024).toFixed(1)} kB`
