import { describe, expect, it } from 'vitest'
// @ts-expect-error plain ES module without type declarations (build tooling, not app code)
import { BUDGET, checkBudget, initialAssets } from './bundle-budget.mjs'

interface Asset {
  name: string
  gzip: number
}
interface Result {
  ok: boolean
  initialJs: number
  initialCss: number
  problems: string[]
}
const check = (assets: Asset[], initial: string[]): Result => checkBudget(assets, initial)
const limits = BUDGET as { initialJs: number }
const kib = (n: number) => n * 1024

describe('initialAssets', () => {
  it('finds the entry script, module preloads and stylesheets', () => {
    const html = `<head>
      <script type="module" crossorigin src="./assets/index-abc.js"></script>
      <link rel="modulepreload" crossorigin href="./assets/react-def.js">
      <link rel="stylesheet" crossorigin href="./assets/index-ghi.css">
    </head>`
    expect((initialAssets(html) as string[]).sort()).toEqual(['assets/index-abc.js', 'assets/index-ghi.css', 'assets/react-def.js'])
  })

  it('ignores icons and manifests, and normalises absolute paths', () => {
    const html = `<link rel="icon" href="./favicon.svg"><link rel="manifest" href="./manifest.webmanifest">
      <script type=module src=/assets/main.js></script>`
    expect(initialAssets(html)).toEqual(['assets/main.js'])
  })

  it('lists a file only once', () => {
    const html = '<script type="module" src="./assets/a.js"></script><link rel="modulepreload" href="./assets/a.js">'
    expect(initialAssets(html)).toEqual(['assets/a.js'])
  })
})

describe('checkBudget', () => {
  const small: Asset[] = [
    { name: 'assets/index.js', gzip: kib(40) },
    { name: 'assets/react.js', gzip: kib(70) },
    { name: 'assets/index.css', gzip: kib(6) },
    { name: 'assets/Tools.js', gzip: kib(12) },
  ]
  const eager = ['assets/index.js', 'assets/react.js', 'assets/index.css']

  it('passes a lean build and reports the totals', () => {
    const r = check(small, eager)
    expect(r.ok).toBe(true)
    expect(r.initialJs).toBe(kib(110))
    expect(r.initialCss).toBe(kib(6))
  })

  it('does not count on-demand chunks towards the startup budget', () => {
    const r = check([...small, { name: 'assets/Big.js', gzip: kib(50) }], eager)
    expect(r.ok).toBe(true)
    expect(r.initialJs).toBe(kib(110))
  })

  it('fails when the initial JavaScript grows past the limit', () => {
    const r = check([{ name: 'assets/index.js', gzip: kib(126) }], ['assets/index.js'])
    expect(r.ok).toBe(false)
    expect(r.problems[0]).toMatch(/initial JavaScript/)
  })

  it('fails when the initial CSS grows past the limit', () => {
    const r = check([{ name: 'assets/index.css', gzip: kib(11) }], ['assets/index.css'])
    expect(r.problems[0]).toMatch(/initial CSS/)
  })

  it('fails when a single on-demand chunk is too large', () => {
    const r = check([...small, { name: 'assets/Huge.js', gzip: kib(61) }], eager)
    expect(r.ok).toBe(false)
    expect(r.problems[0]).toMatch(/Huge\.js/)
  })

  it('fails when index.html references a missing file', () => {
    const r = check(small, [...eager, 'assets/gone.js'])
    expect(r.ok).toBe(false)
    expect(r.problems[0]).toMatch(/gone\.js/)
  })

  it('sitting exactly on the limit is allowed', () => {
    expect(check([{ name: 'assets/a.js', gzip: limits.initialJs }], ['assets/a.js']).ok).toBe(true)
  })
})
