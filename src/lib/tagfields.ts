import type { Tags } from 'jsmediatags/dist/jsmediatags.min.js'
import type { TagValues } from './audio/probe/types'
import { cleanField } from './tags'

/**
 * Turning what tag readers find into what a track record holds: track and disc numbers, a year, a genre name, an album
 * artist, a compilation flag. Tags are free text written by many different programs, so everything here is lenient in
 * what it accepts and strict in what it returns (whole numbers in a sane range, cleaned and capped text).
 */

/** The searchable, sortable fields read from a file's tags, with neutral values (0, '', false) for what is missing. */
export interface TagMeta {
  albumArtist: string
  trackNo: number
  trackTotal: number
  discNo: number
  discTotal: number
  year: number
  genre: string
  compilation: boolean
}

const MAX_NUMBER = 9999
const MAX_GENRE = 100

type Rec = Record<string, unknown>
const isObj = (v: unknown): v is Rec => typeof v === 'object' && v !== null && !Array.isArray(v)

const whole = (n: unknown): number => (typeof n === 'number' && Number.isInteger(n) && n >= 0 && n <= MAX_NUMBER ? n : 0)

/** "3", "3/12", " 07 / 09 ", 3, `{ track: 3, total: 12 }` or `{ disk: 1, total: 2 }` as a number and the total it is out of. */
export function parseNumberPair(v: unknown): { no: number; total: number } {
  let no = 0
  let total = 0
  if (typeof v === 'number') no = whole(Math.trunc(v))
  else if (typeof v === 'string') {
    const m = /^\s*(\d{1,6})(?:\.\d+)?\s*(?:(?:\/|\bof\b)\s*(\d{1,6}))?/i.exec(v)
    if (m) {
      no = whole(Number(m[1]))
      total = whole(Number(m[2] ?? 0))
    }
  } else if (isObj(v)) {
    no = whole(v.track ?? v.disk)
    total = whole(v.total)
  }
  return { no, total: total >= no ? total : 0 }
}

/** The first plausible year (1000-2999) in a year or a full date, or 0. */
export function parseYear(v: unknown): number {
  const s = typeof v === 'string' ? v : typeof v === 'number' && Number.isFinite(v) ? String(Math.trunc(v)) : ''
  const m = /\b([12]\d{3})\b/.exec(s)
  return m ? Number(m[1]) : 0
}

/** "1", "true", "yes" (or a number above 0): the way taggers write the compilation flag. */
export function isCompilation(v: unknown): boolean {
  if (typeof v === 'boolean') return v
  if (typeof v === 'number') return v > 0
  return typeof v === 'string' && /^(1|true|yes)$/i.test(v.trim())
}

/** A ReplayGain value such as "-6.50 dB", clamped to +-12 dB and rounded to 0.1, or null when there is no number in it. */
export function parseGainDb(text: string | undefined): number | null {
  const m = text?.match(/[-+]?\d+(?:\.\d+)?/)
  if (!m) return null
  const db = parseFloat(m[0])
  return Number.isFinite(db) ? Math.round(Math.max(-12, Math.min(12, db)) * 10) / 10 : null
}

// ---- genres ----------------------------------------------------------------------------------------------------

/** The ID3v1 genre list with the Winamp extensions: what "(17)" and "17" in an ID3v2 TCON frame refer to. */
const GENRES: readonly string[] = [
  'Blues', 'Classic Rock', 'Country', 'Dance', 'Disco', 'Funk', 'Grunge', 'Hip-Hop', 'Jazz', 'Metal', 'New Age', 'Oldies', 'Other', 'Pop', 'R&B', 'Rap', 'Reggae', 'Rock', 'Techno', 'Industrial',
  'Alternative', 'Ska', 'Death Metal', 'Pranks', 'Soundtrack', 'Euro-Techno', 'Ambient', 'Trip-Hop', 'Vocal', 'Jazz+Funk', 'Fusion', 'Trance', 'Classical', 'Instrumental', 'Acid', 'House', 'Game',
  'Sound Clip', 'Gospel', 'Noise', 'Alternative Rock', 'Bass', 'Soul', 'Punk', 'Space', 'Meditative', 'Instrumental Pop', 'Instrumental Rock', 'Ethnic', 'Gothic', 'Darkwave', 'Techno-Industrial',
  'Electronic', 'Pop-Folk', 'Eurodance', 'Dream', 'Southern Rock', 'Comedy', 'Cult', 'Gangsta', 'Top 40', 'Christian Rap', 'Pop/Funk', 'Jungle', 'Native American', 'Cabaret', 'New Wave',
  'Psychedelic', 'Rave', 'Showtunes', 'Trailer', 'Lo-Fi', 'Tribal', 'Acid Punk', 'Acid Jazz', 'Polka', 'Retro', 'Musical', 'Rock & Roll', 'Hard Rock', 'Folk', 'Folk-Rock', 'National Folk', 'Swing',
  'Fast Fusion', 'Bebop', 'Latin', 'Revival', 'Celtic', 'Bluegrass', 'Avantgarde', 'Gothic Rock', 'Progressive Rock', 'Psychedelic Rock', 'Symphonic Rock', 'Slow Rock', 'Big Band', 'Chorus',
  'Easy Listening', 'Acoustic', 'Humour', 'Speech', 'Chanson', 'Opera', 'Chamber Music', 'Sonata', 'Symphony', 'Booty Bass', 'Primus', 'Porn Groove', 'Satire', 'Slow Jam', 'Club', 'Tango',
  'Samba', 'Folklore', 'Ballad', 'Power Ballad', 'Rhythmic Soul', 'Freestyle', 'Duet', 'Punk Rock', 'Drum Solo', 'A Cappella', 'Euro-House', 'Dance Hall', 'Goa', 'Drum & Bass', 'Club-House',
  'Hardcore Techno', 'Terror', 'Indie', 'BritPop', 'Afro-Punk', 'Polsk Punk', 'Beat', 'Christian Gangsta Rap', 'Heavy Metal', 'Black Metal', 'Crossover', 'Contemporary Christian',
  'Christian Rock', 'Merengue', 'Salsa', 'Thrash Metal', 'Anime', 'JPop', 'Synthpop',
]

const genreName = (ref: string): string => (ref === 'RX' ? 'Remix' : ref === 'CR' ? 'Cover' : (GENRES[Number(ref)] ?? ''))

/** One genre value: "(17)", "(17)Rock", "(17)(13)", "17" or plain text; text after references refines them and wins. */
function genreEntry(value: string): string {
  let rest = value.trim()
  const refs: string[] = []
  for (let m = /^\((\d{1,3}|RX|CR)\)/.exec(rest); m; m = /^\((\d{1,3}|RX|CR)\)/.exec(rest)) {
    refs.push(m[1] ?? '')
    rest = rest.slice(m[0].length).trimStart()
  }
  if (rest) return !refs.length && /^\d{1,3}$/.test(rest) ? genreName(rest) : rest
  return refs.map(genreName).filter(Boolean).join(', ')
}

/** A readable genre: numeric ID3 references become names, several values (separated by NUL) are joined with commas. */
export function normalizeGenre(raw: unknown): string {
  if (typeof raw !== 'string') return ''
  const parts = raw.split('\u0000').map(genreEntry).filter(Boolean)
  return cleanField(parts.join(', ')).slice(0, MAX_GENRE)
}

// ---- from jsmediatags ----------------------------------------------------------------------------------------------

/** The value of a raw frame: its `data` when it has one, otherwise the frame itself. */
const payload = (frame: unknown): unknown => (isObj(frame) && 'data' in frame ? frame.data : frame)

const text = (v: unknown): string | undefined => (typeof v === 'string' && v.trim() ? v : undefined)

/** A track or disc value as text: strings and numbers as they are, `{ track | disk, total }` as "n/total". */
function pairText(v: unknown): string | undefined {
  if (typeof v === 'string') return v.trim() || undefined
  if (typeof v === 'number') return Number.isFinite(v) ? String(v) : undefined
  if (isObj(v)) {
    const no = v.track ?? v.disk
    if (typeof no !== 'number') return undefined
    return typeof v.total === 'number' && v.total > 0 ? `${no}/${v.total}` : String(no)
  }
  return undefined
}

/** The `{ user_description, data }` of a TXXX frame, whether the reader wrapped it in `data` or not. */
function txxx(frame: unknown): Rec | undefined {
  const inner = isObj(frame) ? frame.data : undefined
  return isObj(inner) ? inner : isObj(frame) ? frame : undefined
}

function compilationText(t: Rec): string | undefined {
  for (const v of [payload(t.TCMP), payload(t.TCP), payload(t.cpil)]) {
    const s = typeof v === 'number' ? String(v) : typeof v === 'boolean' ? (v ? '1' : '0') : text(v)
    if (s) return s
  }
  for (const frame of Array.isArray(t.TXXX) ? (t.TXXX as unknown[]) : [t.TXXX]) {
    const p = txxx(frame)
    if (p && typeof p.user_description === 'string' && p.user_description.trim().toLowerCase() === 'compilation' && typeof p.data === 'string') return p.data
  }
  return undefined
}

/**
 * Raw tag text from what jsmediatags returns for MP3 (ID3v1, v2.2, v2.3, v2.4) and MP4: its shortcuts for title,
 * artist, album, year, track and genre, and the raw frames and atoms for everything it has no shortcut for.
 */
export function tagValuesFromJsmediatags(tags: Tags | undefined): TagValues {
  const t = (tags ?? {}) as unknown as Rec
  const out: TagValues = {}
  const set = (key: keyof TagValues, value: string | undefined): void => {
    if (value) out[key] = value
  }
  set('title', text(t.title))
  set('artist', text(t.artist))
  set('album', text(t.album))
  set('albumArtist', text(payload(t.TPE2)) ?? text(payload(t.TP2)) ?? text(payload(t.aART)))
  set('track', pairText(payload(t.trkn)) ?? pairText(payload(t.TRCK)) ?? pairText(payload(t.TRK)) ?? pairText(t.track))
  set('disc', pairText(payload(t.disk)) ?? pairText(payload(t.TPOS)) ?? pairText(payload(t.TPA)))
  set('date', text(payload(t.TDRC)) ?? text(payload(t['©day'])) ?? text(t.year))
  set('genre', text(t.genre) ?? text(payload(t.TCON)))
  set('compilation', compilationText(t))
  const lyrics = typeof t.lyrics === 'string' ? t.lyrics : isObj(t.lyrics) && typeof t.lyrics.lyrics === 'string' ? t.lyrics.lyrics : undefined
  set('lyrics', lyrics?.trim() ? lyrics : undefined)
  return out
}

/** The record fields for raw tag text. */
export function fieldsFromTagValues(v: TagValues): TagMeta {
  const track = parseNumberPair(v.track)
  const disc = parseNumberPair(v.disc)
  return {
    albumArtist: cleanField(v.albumArtist ?? ''),
    trackNo: track.no,
    trackTotal: track.total,
    discNo: disc.no,
    discTotal: disc.total,
    year: parseYear(v.date),
    genre: normalizeGenre(v.genre),
    compilation: isCompilation(v.compilation),
  }
}
