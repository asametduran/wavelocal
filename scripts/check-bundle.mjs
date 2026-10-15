// `npm run size`: fail when the production build outgrows its startup budget. Run after `vite build`.
import { readFileSync, readdirSync } from 'node:fs'
import { gzipSync } from 'node:zlib'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { BUDGET, checkBudget, initialAssets, kb } from './bundle-budget.mjs'

const dist = join(fileURLToPath(new URL('.', import.meta.url)), '..', 'dist')
const html = readFileSync(join(dist, 'index.html'), 'utf8')
const dir = join(dist, 'assets')
const assets = readdirSync(dir)
  .filter((n) => /\.(js|css)$/.test(n))
  .map((n) => ({ name: `assets/${n}`, gzip: gzipSync(readFileSync(join(dir, n))).length }))
  .sort((a, b) => b.gzip - a.gzip)

const eager = initialAssets(html)
const result = checkBudget(assets, eager)

for (const a of assets) console.log(`${eager.includes(a.name) ? 'initial  ' : 'on demand'}  ${kb(a.gzip).padStart(9)}  ${a.name}`)
console.log(`\ninitial JS ${kb(result.initialJs)} / ${kb(BUDGET.initialJs)}, initial CSS ${kb(result.initialCss)} / ${kb(BUDGET.initialCss)}`)
if (!result.ok) {
  for (const p of result.problems) console.error(`BUDGET EXCEEDED: ${p}`)
  process.exit(1)
}
console.log('bundle budget ok')
