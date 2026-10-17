import { describe, expect, it } from 'vitest'
import { filterByQuery, fold, matches, parseQuery, searchEntry } from './search'
import type { Searchable } from './search'
import { FUZZ_TIMEOUT, eachSeed, int, mutateText, pick, randomText, timed } from '../test-utils/fuzz'
import type { Random } from '../test-utils/fuzz'

const QUERY = 'artist:"the beatles" -live year:1960..1969 help album:"red" +odd "quoted phrase" genre:rock İstanbul'
const WORDS = ['help', 'yesterday', 'İstanbul', 'Beyoncé', 'Yarısı', 'live', 'rock', 'blue', 'ÖZGÜR', 'straße', '日本語', 'Ünsal']

const item = (random: Random): Searchable => ({
  title: pick(random, WORDS) + ' ' + pick(random, WORDS),
  artist: pick(random, WORDS),
  album: pick(random, WORDS),
  albumArtist: random() < 0.3 ? pick(random, WORDS) : '',
  genre: pick(random, ['rock', 'pop', 'jazz', '']),
  year: random() < 0.2 ? 0 : 1950 + int(random, 80),
  path: random() < 0.5 ? `Music/${pick(random, WORDS)}` : '',
  file: { name: `${pick(random, WORDS)}.mp3` },
})

describe('search under fuzzing', { timeout: FUZZ_TIMEOUT }, () => {
  it('turns any input into a bounded query without throwing', async () => {
    await eachSeed(500, (random) => {
      const query = parseQuery(random() < 0.5 ? randomText(random, int(random, 800)) : mutateText(random, mutateText(random, QUERY)))
      expect(query.terms.length).toBeLessThanOrEqual(20)
      expect(query.empty).toBe(query.terms.length === 0)
      for (const term of query.terms) {
        expect(term.text.length).toBeLessThanOrEqual(200)
        if (term.range) {
          // an open end ("1960..") is infinite on purpose; a NaN would match nothing, silently
          expect(Number.isNaN(term.range[0]) || Number.isNaN(term.range[1])).toBe(false)
          expect(term.range[0]).toBeLessThanOrEqual(term.range[1])
        }
      }
    })
  })

  it('folds text the same way twice: a folded word folds to itself', async () => {
    await eachSeed(400, (random) => {
      const text = random() < 0.5 ? randomText(random, int(random, 80)) : mutateText(random, pick(random, WORDS))
      const once = fold(text)
      expect(fold(once)).toBe(once)
    })
  })

  it('finds words however they are cased or accented, and the Turkish dotted and dotless i', () => {
    const pairs: readonly (readonly [stored: string, typed: string])[] = [['İstanbul', 'istanbul'], ['Yarısı', 'yarisi'], ['Beyoncé', 'beyonce'], ['ÖZGÜR', 'ozgur'], ['straße', 'strasse']]
    for (const [stored, typed] of pairs) {
      const e = searchEntry({ title: stored, artist: '', album: '', albumArtist: '', genre: '', year: 0, path: '', file: { name: 'x.mp3' } })
      expect(matches(parseQuery(typed), e), `${typed} should find ${stored}`).toBe(true)
    }
  })

  it('filters to a subset in the original order, and a negated word picks exactly the rest', async () => {
    await eachSeed(200, (random) => {
      const items = Array.from({ length: 80 }, () => item(random))
      const word = fold(pick(random, WORDS)).split(' ')[0] ?? 'help'
      const kept = filterByQuery(items, parseQuery(word))
      const dropped = filterByQuery(items, parseQuery(`-${word}`))
      expect(kept.length + dropped.length).toBe(items.length)
      expect(new Set([...kept, ...dropped]).size).toBe(items.length)
      let last = -1
      for (const k of kept) {
        const at = items.indexOf(k)
        expect(at).toBeGreaterThan(last)
        last = at
      }
      // whatever the query, the answer is a subset
      const damaged = filterByQuery(items, parseQuery(mutateText(random, QUERY)))
      for (const d of damaged) expect(items).toContain(d)
    })
  })

  it('gives an empty query back the very same list', () => {
    const items = [item(() => 0.3)]
    expect(filterByQuery(items, parseQuery('   '))).toBe(items)
    expect(filterByQuery(items, parseQuery(''))).toBe(items)
  })

  const heavy: [string, string][] = [
    ['a megabyte of words', 'word '.repeat(200_000)],
    ['a megabyte of one word', 'w'.repeat(1_000_000)],
    ['quotes that never close', '"'.repeat(500_000)],
    ['a hundred thousand filters', 'artist:x '.repeat(100_000)],
    ['dashes and colons', '-:'.repeat(300_000)],
    ['year ranges', 'year:'.repeat(100_000) + '1990..2000'],
    ['combining marks', `e${'́'.repeat(300_000)}`],
  ]
  it.each(heavy)('takes a moment at most for %s', (_label, text) => {
    const { result, ms } = timed(() => parseQuery(text))
    expect(result.terms.length).toBeLessThanOrEqual(20)
    expect(ms).toBeLessThan(1000)
  })

  it('searches ten thousand tracks for a twenty-term query in a moment', () => {
    const random = () => 0.5
    const items = Array.from({ length: 10_000 }, (_, i) => ({ ...item(random), title: `Song ${i}` }))
    const query = parseQuery(Array.from({ length: 25 }, (_, i) => (i % 3 === 0 ? `-zzz${i}` : `s${i % 4}`)).join(' '))
    const { ms } = timed(() => filterByQuery(items, query))
    expect(ms).toBeLessThan(1500)
  })
})
