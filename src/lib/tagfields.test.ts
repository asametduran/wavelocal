import { describe, expect, it } from 'vitest'
import { fieldsFromTagValues, isCompilation, normalizeGenre, parseGainDb, parseNumberPair, parseYear, tagValuesFromJsmediatags } from './tagfields'
import type { Tags } from 'jsmediatags/dist/jsmediatags.min.js'

describe('parseNumberPair (track and disc numbers)', () => {
  it.each([
    ['3', 3, 0],
    ['3/12', 3, 12],
    [' 07 / 09 ', 7, 9],
    ['03', 3, 0],
    ['3/', 3, 0],
    ['3.0', 3, 0],
    ['0/12', 0, 12],
    [3, 3, 0],
    [{ track: 3, total: 12 }, 3, 12],
    [{ disk: 1, total: 2 }, 1, 2],
    [{ track: 3, total: 0 }, 3, 0],
  ])('reads %j as %d of %d', (input, no, total) => {
    expect(parseNumberPair(input)).toEqual({ no, total })
  })

  it.each([[''], ['abc'], ['-1'], ['A1'], ['99999'], [null], [undefined], [[3, 12]], [{}], [Number.NaN], [-4], [1e9]])('treats %j as unknown', (input) => {
    expect(parseNumberPair(input)).toEqual({ no: 0, total: 0 })
  })

  it('ignores a total that is smaller than the number or absurd', () => {
    expect(parseNumberPair('5/3')).toEqual({ no: 5, total: 0 })
    expect(parseNumberPair('5/99999')).toEqual({ no: 5, total: 0 })
  })
})

describe('parseYear', () => {
  it.each([
    ['2019', 2019],
    ['2019-05-04', 2019],
    ['2019-05-04T10:20:30', 2019],
    ['(c) 1999 Someone', 1999],
    ['May 1987', 1987],
    [2001, 2001],
    ['1969/70', 1969],
  ])('finds the year in %j', (input, year) => {
    expect(parseYear(input)).toBe(year)
  })

  it.each([[''], ['unknown'], ['0000'], ['99'], ['12345'], ['20190504'], [null], [undefined], [{}], [3100], [Number.NaN]])('has no year in %j', (input) => {
    expect(parseYear(input)).toBe(0)
  })
})

describe('normalizeGenre', () => {
  it.each([
    ['Rock', 'Rock'],
    ['  Hip   Hop ', 'Hip Hop'],
    ['(17)', 'Rock'],
    ['(13)', 'Pop'],
    ['(13)Pop', 'Pop'],
    ['(17)Rock/Pop', 'Rock/Pop'],
    ['13', 'Pop'],
    ['(17)(13)', 'Rock, Pop'],
    ['(RX)', 'Remix'],
    ['(CR)', 'Cover'],
    ['Rock\u0000Pop', 'Rock, Pop'],
    ['(147)', 'Synthpop'],
    ['(0)', 'Blues'],
  ])('turns %j into %j', (input, expected) => {
    expect(normalizeGenre(input)).toBe(expected)
  })

  it.each([[''], ['   '], ['(999)'], ['(255)'], [null], [undefined], [42]])('gives nothing for %j', (input) => {
    expect(normalizeGenre(input)).toBe('')
  })

  it('caps the length', () => {
    expect(normalizeGenre('x'.repeat(500)).length).toBe(100)
  })
})

describe('isCompilation', () => {
  it.each([['1', true], [' 1 ', true], ['true', true], ['Yes', true], [1, true], [true, true], ['0', false], ['', false], ['no', false], [0, false], [false, false], [null, false], [undefined, false], [2, true]])('reads %j as %s', (input, expected) => {
    expect(isCompilation(input)).toBe(expected)
  })
})

describe('parseGainDb', () => {
  it.each([
    ['-6.50 dB', -6.5],
    ['+3.2 dB', 3.2],
    ['-14.04', -14.04 < -12 ? -12 : -14.04],
    ['20 dB', 12],
    ['-0.04 dB', 0],
  ])('reads %j', (input, db) => {
    expect(parseGainDb(input)).toBeCloseTo(db, 1)
  })

  it.each([[''], ['loud'], [undefined], ['dB']])('gives null for %j', (input) => {
    expect(parseGainDb(input)).toBeNull()
  })
})

describe('tagValuesFromJsmediatags: shapes captured from real files', () => {
  const as = (o: unknown): Tags => o as Tags

  it('reads an ID3v2.3 tag (the shortcuts plus raw frames for what has no shortcut)', () => {
    const t = tagValuesFromJsmediatags(
      as({
        title: 'Gece Yarısı',
        artist: 'Şebnem Ferah',
        album: 'Aşk',
        year: '2019',
        track: '3/12',
        genre: 'Pop',
        TPE2: { data: 'Şebnem' },
        TPOS: { data: '1/2' },
        TXXX: { data: { user_description: 'compilation', data: '1' } },
      }),
    )
    expect(t).toEqual({ title: 'Gece Yarısı', artist: 'Şebnem Ferah', album: 'Aşk', albumArtist: 'Şebnem', date: '2019', track: '3/12', disc: '1/2', genre: 'Pop', compilation: '1' })
  })

  it('prefers the ID3v2.4 recording time (TDRC) over the year shortcut', () => {
    expect(tagValuesFromJsmediatags(as({ TDRC: { data: '2021-03-04' } })).date).toBe('2021-03-04')
    expect(tagValuesFromJsmediatags(as({ TDRC: { data: '2021-03-04' }, year: '1999' })).date).toBe('2021-03-04')
    expect(tagValuesFromJsmediatags(as({ year: '1999' })).date).toBe('1999')
  })

  it('reads the iTunes compilation frame and several TXXX frames', () => {
    expect(tagValuesFromJsmediatags(as({ TCMP: { data: '1' } })).compilation).toBe('1')
    const t = tagValuesFromJsmediatags(as({ TXXX: [{ data: { user_description: 'MOOD', data: 'calm' } }, { data: { user_description: 'COMPILATION', data: '1' } }] }))
    expect(t.compilation).toBe('1')
  })

  it('reads ID3v2.2 frame names', () => {
    const t = tagValuesFromJsmediatags(as({ TP2: { data: 'Band' }, TPA: { data: '2/3' }, TCP: { data: '1' } }))
    expect(t).toEqual({ albumArtist: 'Band', disc: '2/3', compilation: '1' })
  })

  it('reads an MP4 tag: numbers and objects instead of strings', () => {
    const t = tagValuesFromJsmediatags(
      as({
        title: 'Gece Yarısı',
        artist: 'Şebnem Ferah',
        album: 'Aşk',
        year: '2019',
        track: 3,
        genre: 'Pop',
        aART: { data: 'Şebnem' },
        cpil: { data: 1 },
        trkn: { data: { track: 3, total: 12 } },
        disk: { data: { disk: 1, total: 2 } },
        '©day': { data: '2019-05-04' },
      }),
    )
    expect(t).toEqual({ title: 'Gece Yarısı', artist: 'Şebnem Ferah', album: 'Aşk', albumArtist: 'Şebnem', date: '2019-05-04', track: '3/12', disc: '1/2', genre: 'Pop', compilation: '1' })
  })

  it('reads an MP4 tag that has a track but no total', () => {
    const t = tagValuesFromJsmediatags(as({ track: 3, trkn: { data: { track: 3, total: 0 } }, disk: { data: { disk: 1, total: 0 } } }))
    expect(t.track).toBe('3')
    expect(t.disc).toBe('1')
  })

  it('reads lyrics from the shortcut in either of its shapes', () => {
    expect(tagValuesFromJsmediatags(as({ lyrics: 'la la' })).lyrics).toBe('la la')
    expect(tagValuesFromJsmediatags(as({ lyrics: { lyrics: 'ba ba' } })).lyrics).toBe('ba ba')
  })

  it('ignores empty and malformed values and never throws', () => {
    expect(tagValuesFromJsmediatags(as({}))).toEqual({})
    expect(tagValuesFromJsmediatags(as({ title: '   ', artist: 42, TPE2: 'plain string', TPOS: { data: { odd: true } }, TXXX: 'nonsense', trkn: null, cpil: {} }))).toEqual({ albumArtist: 'plain string' })
    expect(tagValuesFromJsmediatags(undefined)).toEqual({})
  })
})

describe('fieldsFromTagValues', () => {
  it('turns raw tag text into the numbers and strings a track record holds', () => {
    expect(fieldsFromTagValues({ albumArtist: ' Şebnem  Ferah ', track: '3/12', disc: '1/2', date: '2019-05-04', genre: '(13)', compilation: '1' })).toEqual({
      albumArtist: 'Şebnem Ferah',
      trackNo: 3,
      trackTotal: 12,
      discNo: 1,
      discTotal: 2,
      year: 2019,
      genre: 'Pop',
      compilation: true,
    })
  })

  it('gives neutral values for what is missing', () => {
    expect(fieldsFromTagValues({})).toEqual({ albumArtist: '', trackNo: 0, trackTotal: 0, discNo: 0, discTotal: 0, year: 0, genre: '', compilation: false })
  })

  it('strips control characters and caps long text', () => {
    const f = fieldsFromTagValues({ albumArtist: `A\u0000B\u0007${'x'.repeat(500)}` })
    expect(f.albumArtist.length).toBe(300)
    expect(f.albumArtist.startsWith('A B ')).toBe(true)
  })
})
