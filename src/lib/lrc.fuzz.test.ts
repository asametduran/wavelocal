import { describe, expect, it } from 'vitest'
import { MAX_LINES, parseLrc } from './lrc'
import { FUZZ_TIMEOUT, eachSeed, int, mutateText, randomText, timed } from '../test-utils/fuzz'
import type { Lyrics } from '../types'

const VALID = ['[ti:Song]', '[ar:Artist]', '[offset:250]', '[00:01.00]first line', '[00:02.50][01:02.5]shared <00:03.00>line', 'plain words', '[99:59.999]late', '[00:00:30]colon fractions'].join('\n')

/** What every result has to be, whatever went in. */
function wellFormed(result: Lyrics | null): void {
  if (!result) return
  expect(result.lines.length).toBeGreaterThan(0)
  expect(result.lines.length).toBeLessThanOrEqual(MAX_LINES)
  let previous = 0
  for (const line of result.lines) {
    expect(typeof line.text).toBe('string')
    if (result.synced) {
      expect(Number.isFinite(line.t), `a time of ${line.t}`).toBe(true)
      expect(line.t as number).toBeGreaterThanOrEqual(previous)
      previous = line.t as number
    } else {
      expect(line.t).toBeNull()
    }
  }
}

describe('parseLrc under fuzzing', { timeout: FUZZ_TIMEOUT }, () => {
  it('survives random text, odd characters and all', async () => {
    await eachSeed(300, (random) => wellFormed(parseLrc(randomText(random, int(random, 3000)))))
  })

  it('survives damaged lyrics, and the damage is only ever to the damaged part', async () => {
    await eachSeed(400, (random) => wellFormed(parseLrc(mutateText(random, mutateText(random, VALID)))))
  })

  it('refuses anything that is not text, without throwing', () => {
    for (const input of [null, undefined, 0, Number.NaN, 1, true, {}, [], () => 1, Symbol('x'), 10n, new String('[00:01.00]boxed'), ['[00:01.00]a']]) {
      expect(parseLrc(input)).toBeNull()
    }
  })

  it('keeps every time finite, whatever the offset says (a huge number parses to Infinity)', () => {
    for (const offset of ['9'.repeat(400), `-${'9'.repeat(400)}`, '99999999999999', '-99999999999999', '0', '-0', '1e999']) {
      const result = parseLrc(`[offset:${offset}]\n[00:01.00]a\n[00:02.00]b`)
      wellFormed(result)
      expect(result?.synced).toBe(true)
      expect(result?.lines).toHaveLength(2)
    }
  })

  it('never gives a line a time before the start', () => {
    const result = parseLrc('[offset:5000]\n[00:01.00]early\n[00:09.00]later')
    expect(result?.lines.map((line) => line.t)).toEqual([0, 4])
  })

  it('stops at a limit instead of building millions of lines', () => {
    const result = parseLrc('[00:00.00]x\n'.repeat(MAX_LINES + 5000))
    expect(result?.lines).toHaveLength(MAX_LINES)
    const plain = parseLrc('words\n'.repeat(MAX_LINES + 5000))
    expect(plain?.lines).toHaveLength(MAX_LINES)
  })

  const heavy: [string, string][] = [
    ['two hundred thousand stamps on one line', '[00:00.00]'.repeat(200_000)],
    ['a hundred thousand stamped lines', Array.from({ length: 100_000 }, (_, i) => `[${String(i % 60).padStart(2, '0')}:00.00]line ${i}`).join('\n')],
    ['brackets that never close', '['.repeat(300_000)],
    ['stamps that never close', '[00:'.repeat(80_000)],
    ['word tags that never close', '<00:'.repeat(80_000)],
    ['an offset followed by endless spaces', `[offset:${' '.repeat(300_000)}`],
    ['digits without end', `[${'9'.repeat(300_000)}`],
    ['line breaks only', '\r\n'.repeat(300_000)],
    ['one enormous plain line', 'la '.repeat(500_000)],
  ]
  it.each(heavy)('takes a moment at most for %s', (_label, text) => {
    const { result, ms } = timed(() => parseLrc(text))
    wellFormed(result)
    expect(ms).toBeLessThan(2500)
  })
})
