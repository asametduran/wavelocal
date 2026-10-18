// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { FUZZ_TIMEOUT, eachSeed, int, pick } from '../../test-utils/fuzz'
import { MAX_BYTES, safeFileName } from './name'

const bytes = (text: string): number => new TextEncoder().encode(text).length
const FORBIDDEN = /[\\/:*?"<>|\p{Cc}\p{Cf}\p{Cs}\p{Zl}\p{Zp}]/u
/** Whether the text is valid UTF-16 (no lone surrogate): `encodeURIComponent` throws for one. */
const wellFormed = (text: string): boolean => {
  try {
    encodeURIComponent(text)
    return true
  } catch {
    return false
  }
}

describe('safeFileName', () => {
  it('keeps an ordinary name as it is, with its spaces, accents and extension', () => {
    expect(safeFileName('Night Train.mp3')).toBe('Night Train.mp3')
    expect(safeFileName('Şebnem Ferah - Gece Yarısı (live).flac')).toBe('Şebnem Ferah - Gece Yarısı (live).flac')
    expect(safeFileName('wavelocal-backup-2026-10-18.json')).toBe('wavelocal-backup-2026-10-18.json')
    expect(safeFileName('My Playlist.m3u8')).toBe('My Playlist.m3u8')
  })

  it.each([
    ['a/b', 'a_b'],
    ['a\\b', 'a_b'],
    ['a:b', 'a_b'],
    ['a*b?c"d<e>f|g', 'a_b_c_d_e_f_g'],
    ['../../etc/passwd', '_.._etc_passwd'],
    ['a\u0000b', 'a_b'],
    ['a\nb\tc', 'a_b_c'],
    ['a‮b', 'a_b'],
    ['a b', 'a_b'],
  ])('replaces what no file name may hold: %j', (name, expected) => {
    expect(safeFileName(name)).toBe(expected)
  })

  it('turns runs of spaces, of any kind, into one', () => {
    expect(safeFileName('a  b')).toBe('a b')
    expect(safeFileName('a  b')).toBe('a b')
  })

  it('takes leading and trailing dots and spaces away, so that nothing is hidden and nothing ends in a dot', () => {
    expect(safeFileName('  spaced  ')).toBe('spaced')
    expect(safeFileName('archive.')).toBe('archive')
    expect(safeFileName('. . name . .')).toBe('name')
  })

  it('never answers with nothing: the fallback, or "file"', () => {
    expect(safeFileName('')).toBe('file')
    expect(safeFileName('...')).toBe('file')
    expect(safeFileName('   ')).toBe('file')
    expect(safeFileName('', 'backup')).toBe('backup')
  })

  it('keeps an extension that is all there is, after the fallback: the share sheet types a file by it', () => {
    expect(safeFileName('.m3u8')).toBe('file.m3u8')
    expect(safeFileName(' ..json')).toBe('file.json')
    expect(safeFileName('.mp3', 'backup')).toBe('backup.mp3')
    expect(safeFileName('..hidden')).toBe('file.hidden') // an extension too, as far as a name that starts with dots can tell
  })

  it('turns a lone surrogate into an underscore, so that the name is valid text', () => {
    expect(safeFileName('a\ud800b')).toBe('a_b')
    expect(wellFormed(safeFileName('\udc00\ud800'))).toBe(true)
  })

  it('keeps an emoji, which is two UTF-16 units and one character', () => {
    expect(safeFileName('party 🎉.mp3')).toBe('party 🎉.mp3')
  })

  it('cuts a long name to the bytes a file name may have, and keeps its extension', () => {
    const long = `${'a'.repeat(400)}.mp3`
    const cut = safeFileName(long)
    expect(bytes(cut)).toBeLessThanOrEqual(MAX_BYTES)
    expect(cut.endsWith('.mp3')).toBe(true)
    expect(cut.length).toBe(MAX_BYTES)
  })

  it('cuts at a whole character, counting bytes and not characters', () => {
    const turkish = `${'ş'.repeat(300)}.flac` // two bytes each
    const cut = safeFileName(turkish)
    expect(bytes(cut)).toBeLessThanOrEqual(MAX_BYTES)
    expect(cut.endsWith('.flac')).toBe(true)
    expect(wellFormed(cut)).toBe(true)
    const emoji = safeFileName(`${'🎵'.repeat(200)}.mp3`) // four bytes each
    expect(bytes(emoji)).toBeLessThanOrEqual(MAX_BYTES)
    expect(wellFormed(emoji)).toBe(true)
    expect(emoji.endsWith('.mp3')).toBe(true)
  })

  it('cuts a long name with no extension, and one whose "extension" is a sentence', () => {
    expect(bytes(safeFileName('b'.repeat(500)))).toBeLessThanOrEqual(MAX_BYTES)
    const sentence = `${'c'.repeat(300)}.${'d'.repeat(40)}`
    const cut = safeFileName(sentence)
    expect(bytes(cut)).toBeLessThanOrEqual(MAX_BYTES)
    expect(cut).not.toMatch(/[. ]$/)
  })

  it('does not end a cut name with a dot or a space left over from the cut', () => {
    const cut = safeFileName(`${'a'.repeat(MAX_BYTES - 5)}. . . . . .mp3`)
    expect(cut).not.toMatch(/[. ]\.mp3$/)
    expect(bytes(cut)).toBeLessThanOrEqual(MAX_BYTES)
  })

  it('leaves a name of exactly the longest length alone, and cuts one byte more back to it', () => {
    const exact = `${'a'.repeat(MAX_BYTES - 4)}.mp3`
    expect(bytes(exact)).toBe(MAX_BYTES)
    expect(safeFileName(exact)).toBe(exact)
    const over = `${'a'.repeat(MAX_BYTES - 3)}.mp3`
    expect(safeFileName(over)).toBe(exact) // the stem gives up the byte, the extension stays
    // a name that fits is not touched at all, so a space before its extension survives; a cut name loses what the cut leaves at the end
    const spaced = `${'a'.repeat(MAX_BYTES - 5)} .mp3`
    expect(bytes(spaced)).toBe(MAX_BYTES)
    expect(safeFileName(spaced)).toBe(spaced)
    const over2 = `${'a'.repeat(MAX_BYTES - 5)} b.mp3` // one byte over, and the cut falls just after the space
    expect(bytes(over2)).toBe(MAX_BYTES + 1)
    expect(safeFileName(over2)).toBe(`${'a'.repeat(MAX_BYTES - 5)}.mp3`)
  })

  it('does not take a long word after the last dot for an extension', () => {
    expect(safeFileName('.thisisnotanextension')).toBe('thisisnotanextension')
    expect(safeFileName('notes.thisisnotanextension')).toBe('notes.thisisnotanextension')
  })

  it('never allows more than a component of an Android path may hold: 255 bytes', () => {
    expect(MAX_BYTES).toBeLessThanOrEqual(255)
    expect(bytes(safeFileName('x'.repeat(1000)))).toBeLessThanOrEqual(255)
    expect(bytes(safeFileName(`${'🎵'.repeat(1000)}.mp3`))).toBeLessThanOrEqual(255)
  })

  it('is the same name when asked twice', () => {
    for (const name of ['a/b:c.mp3', `${'ş'.repeat(300)}.flac`, '..x..', '\ud800\ud800']) {
      expect(safeFileName(safeFileName(name))).toBe(safeFileName(name))
    }
  })
})

describe('safeFileName: any text at all', () => {
  const PIECES = ['a', 'B', '7', ' ', '.', '..', '/', '\\', ':', '*', '?', '"', '<', '>', '|', '\u0000', '\n', '\t', 'ş', 'é', '🎉', '\ud800', '\udc00', '‮', ' ', '​', '-', '_', '(', ')', '.mp3', '.json', 'x'.repeat(60)]

  it('is always a clean, bounded, non-empty, well-formed name that a second pass leaves alone', async () => {
    await eachSeed(400, (random) => {
      let text = ''
      for (let i = int(random, 40); i > 0; i--) text += pick(random, PIECES)
      const name = safeFileName(text)
      expect(name, JSON.stringify(text)).not.toBe('')
      expect(FORBIDDEN.test(name), JSON.stringify(name)).toBe(false)
      expect(bytes(name), JSON.stringify(name)).toBeLessThanOrEqual(MAX_BYTES)
      expect(wellFormed(name), JSON.stringify(name)).toBe(true)
      expect(name, JSON.stringify(name)).not.toMatch(/^[.\s]|[.\s]$/u)
      expect(safeFileName(name), JSON.stringify(name)).toBe(name)
    })
  }, FUZZ_TIMEOUT)

  it('keeps a short ordinary extension, whatever came before it', async () => {
    await eachSeed(200, (random) => {
      let stem = ''
      for (let i = 1 + int(random, 30); i > 0; i--) stem += pick(random, PIECES)
      const name = safeFileName(`${stem}.m3u8`)
      expect(name, JSON.stringify(stem)).toMatch(/\.m3u8$/)
    })
  }, FUZZ_TIMEOUT)
})
