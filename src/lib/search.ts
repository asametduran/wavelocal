/**
 * Library search: forgiving about accents and about Turkish casing (typing `istanbul` finds `İstanbul`, `yarisi` finds
 * `Yarısı`, `beyonce` finds `Beyoncé`), every word must match in any order, and a few filters narrow it down:
 * `artist:`, `album:`, `title:`, `genre:`, `year:` (a year, `1990..1999`, `>=2000`, `1990s`), `path:` and `file:`.
 * Quotes make a phrase, a leading `-` excludes. Everything is pure and cheap enough for a library of tens of thousands.
 */

/** What search looks at: the fields of a track, nothing else (so tests need no real tracks). */
export interface Searchable {
  title: string
  artist: string
  album: string
  albumArtist: string
  genre: string
  year: number
  path: string
  file: { name: string }
}

export type Field = 'title' | 'artist' | 'album' | 'genre' | 'year' | 'path' | 'file'

export interface Term {
  /** The field it is limited to, or null for "anywhere". */
  field: Field | null
  /** Folded text to find (empty for a year range). */
  text: string
  negate: boolean
  /** Inclusive year range for `year:` terms. */
  range: [number, number] | null
}

export interface Query {
  terms: Term[]
  empty: boolean
}

// ---- folding ---------------------------------------------------------------------------------------------------

/** Letters that do not break apart into a base letter and an accent. */
const SPECIAL: Record<string, string> = { ı: 'i', ß: 'ss', æ: 'ae', œ: 'oe', ø: 'o', đ: 'd', ð: 'd', ł: 'l', þ: 'th', ħ: 'h', ŧ: 't', ς: 'σ' }
const SPECIAL_RE = /[ıßæœøđðłþħŧς]/g

/**
 * The form text is compared in: no accents, no case, no Turkish dots (`İ` is `i`, and so is the dotless `ı`),
 * ligatures and full-width letters made plain.
 */
export function fold(text: string): string {
  return text
    .normalize('NFKD')
    .replace(/\p{M}+/gu, '')
    .toLowerCase()
    .replace(SPECIAL_RE, (c) => SPECIAL[c] ?? c)
}

// ---- parsing ---------------------------------------------------------------------------------------------------

const ALIASES: Record<string, Field> = { title: 'title', song: 'title', name: 'title', artist: 'artist', by: 'artist', album: 'album', genre: 'genre', year: 'year', date: 'year', path: 'path', folder: 'path', dir: 'path', file: 'file' }

const MAX_INPUT = 500
const MAX_TERMS = 20
const MAX_TERM = 200

/** A year, an inclusive range (`1990..1999`, `1990-1999`, `..1999`, `2000..`), a comparison (`>=2000`) or a decade (`1990s`). */
function yearRange(value: string): [number, number] | null {
  let m = /^(\d{4})$/.exec(value)
  if (m) return [Number(m[1]), Number(m[1])]
  m = /^(\d{4})(?:\.\.|-)(\d{4})$/.exec(value)
  if (m) return [Math.min(Number(m[1]), Number(m[2])), Math.max(Number(m[1]), Number(m[2]))]
  m = /^(\d{4})(?:\.\.|-)$/.exec(value)
  if (m) return [Number(m[1]), Infinity]
  m = /^\.\.(\d{4})$/.exec(value)
  if (m) return [-Infinity, Number(m[1])]
  m = /^(>=|<=|>|<)(\d{4})$/.exec(value)
  if (m) {
    const y = Number(m[2])
    return m[1] === '>=' ? [y, Infinity] : m[1] === '>' ? [y + 1, Infinity] : m[1] === '<=' ? [-Infinity, y] : [-Infinity, y - 1]
  }
  m = /^(\d{3})0s$/.exec(value)
  if (m) return [Number(m[1]) * 10, Number(m[1]) * 10 + 9]
  return null
}

function toTerm(raw: string): Term | null {
  let text = raw
  let negate = false
  if (text.length > 1 && text.startsWith('-')) {
    negate = true
    text = text.slice(1)
  }
  const m = /^([A-Za-z]+):(.*)$/.exec(text)
  const field = m ? ALIASES[(m[1] ?? '').toLowerCase()] : undefined
  if (m && field) {
    const value = (m[2] ?? '').trim()
    if (!value) return null // "artist:" while it is still being typed
    if (field === 'year') {
      const range = yearRange(value)
      if (range) return { field, text: '', negate, range }
    } else {
      return { field, text: fold(value).slice(0, MAX_TERM), negate, range: null }
    }
  }
  const folded = fold(text.trim()).slice(0, MAX_TERM)
  return folded && folded !== '-' ? { field: null, text: folded, negate, range: null } : null
}

/** Split a query into terms: words, `"phrases"`, `field:value` filters, `-excluded`. Never throws. */
export function parseQuery(input: string): Query {
  const terms: Term[] = []
  let current = ''
  let quoted = false
  const flush = (): void => {
    if (current && terms.length < MAX_TERMS) {
      const term = toTerm(current)
      if (term) terms.push(term)
    }
    current = ''
  }
  for (const ch of input.slice(0, MAX_INPUT)) {
    if (ch === '"') quoted = !quoted
    else if (/\s/.test(ch) && !quoted) flush()
    else current += ch
  }
  flush()
  return { terms, empty: terms.length === 0 }
}

// ---- matching --------------------------------------------------------------------------------------------------

/** A track's searchable text, folded once. */
export interface SearchEntry {
  title: string
  artist: string
  album: string
  genre: string
  year: number
  path: string
  file: string
  /** Everything above, for words that are not limited to a field. */
  all: string
}

const entries = new WeakMap<object, SearchEntry>()

/** The folded text of a track. Computed once per track object (a patched track is a new object, so it is recomputed). */
export function searchEntry(t: Searchable): SearchEntry {
  const cached = entries.get(t)
  if (cached) return cached
  const title = fold(t.title)
  const artist = fold(`${t.artist} ${t.albumArtist}`)
  const album = fold(t.album)
  const genre = fold(t.genre)
  const path = fold(t.path)
  const file = fold(t.file.name)
  const entry: SearchEntry = { title, artist, album, genre, year: t.year, path, file, all: `${title} ${artist} ${album} ${genre} ${t.year || ''} ${path} ${file}` }
  entries.set(t, entry)
  return entry
}

function hit(term: Term, e: SearchEntry): boolean {
  if (term.range) return e.year > 0 && e.year >= term.range[0] && e.year <= term.range[1]
  const haystack = term.field && term.field !== 'year' ? e[term.field] : e.all
  return haystack.includes(term.text)
}

export const matches = (query: Query, e: SearchEntry): boolean => query.terms.every((term) => hit(term, e) !== term.negate)

/** The items that match, in their own order. An empty query returns the very same array. */
export function filterByQuery<T extends Searchable>(items: readonly T[], query: Query): readonly T[] {
  return query.empty ? items : items.filter((t) => matches(query, searchEntry(t)))
}
