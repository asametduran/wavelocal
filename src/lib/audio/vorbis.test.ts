import { describe, expect, it } from 'vitest'
import { decodeBase64, parseFlacPicture, parseVorbisComments, tagsFromVorbis } from './vorbis'
import { vorbisComments, w32be, w32le } from '../../test-utils/containers'

const block = (vendor: string, comments: string[]): Uint8Array => Uint8Array.from(vorbisComments(vendor, comments))
const text = (s: string): number[] => Array.from(new TextEncoder().encode(s))

describe('parseVorbisComments', () => {
  it('reads the vendor and every NAME=value pair as UTF-8', () => {
    const r = parseVorbisComments(block('libFLAC 1.4', ['TITLE=Gece Yarısı', 'ARTIST=Şebnem Ferah', 'ALBUM=Ünlü']))
    expect(r?.vendor).toBe('libFLAC 1.4')
    expect(r?.fields).toEqual([
      ['TITLE', 'Gece Yarısı'],
      ['ARTIST', 'Şebnem Ferah'],
      ['ALBUM', 'Ünlü'],
    ])
  })

  it('upper-cases field names and keeps "=" inside values', () => {
    const r = parseVorbisComments(block('v', ['title=Mixed', 'Comment=a=b=c']))
    expect(r?.fields).toEqual([
      ['TITLE', 'Mixed'],
      ['COMMENT', 'a=b=c'],
    ])
  })

  it('keeps repeated fields in order', () => {
    const r = parseVorbisComments(block('v', ['ARTIST=One', 'ARTIST=Two']))
    expect(r?.fields).toEqual([
      ['ARTIST', 'One'],
      ['ARTIST', 'Two'],
    ])
  })

  it('ignores entries without "=" and empty ones', () => {
    const r = parseVorbisComments(block('v', ['nonsense', '', '=novalue', 'TITLE=ok']))
    expect(r?.fields).toEqual([['TITLE', 'ok']])
  })

  it('reads from an offset', () => {
    const body = block('v', ['TITLE=Shifted'])
    const padded = Uint8Array.from([9, 9, 9, ...body])
    expect(parseVorbisComments(padded, 3)?.fields).toEqual([['TITLE', 'Shifted']])
  })

  it('keeps what parsed before damage', () => {
    const good = block('v', ['TITLE=A', 'ARTIST=Bee'])
    const r = parseVorbisComments(good.slice(0, good.length - 3))
    expect(r?.fields).toEqual([['TITLE', 'A']])
  })

  it('never loops on an absurd comment count', () => {
    const huge = Uint8Array.from([...w32le(0), 0xff, 0xff, 0xff, 0xff])
    expect(parseVorbisComments(huge)?.fields).toEqual([])
  })

  it('returns null when the vendor string does not even fit', () => {
    expect(parseVorbisComments(Uint8Array.from([...w32le(500), 1, 2, 3]))).toBeNull()
    expect(parseVorbisComments(new Uint8Array(2))).toBeNull()
  })

  it('replaces invalid UTF-8 instead of throwing', () => {
    const bad = Uint8Array.from([...w32le(0), ...w32le(1), ...w32le(8), ...text('TITLE='), 0xff, 0xfe])
    expect(parseVorbisComments(bad)?.fields[0]?.[1]).toMatch(/�/)
  })
})

describe('tagsFromVorbis', () => {
  const tags = (...comments: string[]) => tagsFromVorbis(parseVorbisComments(block('v', comments)) ?? { vendor: '', fields: [] })

  it('maps the common fields', () => {
    expect(tags('TITLE=T', 'ARTIST=A', 'ALBUM=L', 'ALBUMARTIST=AA', 'GENRE=Rock', 'DATE=2019-05-04', 'TRACKNUMBER=3', 'DISCNUMBER=1', 'COMPILATION=1')).toEqual({
      title: 'T',
      artist: 'A',
      album: 'L',
      albumArtist: 'AA',
      genre: 'Rock',
      date: '2019-05-04',
      track: '3',
      disc: '1',
      compilation: '1',
    })
  })

  it('understands the other spellings of album artist, year and lyrics', () => {
    expect(tags('ALBUM ARTIST=X').albumArtist).toBe('X')
    expect(tags('ALBUM_ARTIST=Y').albumArtist).toBe('Y')
    expect(tags('YEAR=1999').date).toBe('1999')
    expect(tags('DATE=2001', 'YEAR=1999').date).toBe('2001')
    expect(tags('UNSYNCEDLYRICS=la la').lyrics).toBe('la la')
    expect(tags('LYRICS=[00:01.00]hi').lyrics).toBe('[00:01.00]hi')
  })

  it('appends the track and disc totals when they are separate fields', () => {
    expect(tags('TRACKNUMBER=3', 'TRACKTOTAL=12').track).toBe('3/12')
    expect(tags('TRACKNUMBER=3', 'TOTALTRACKS=12').track).toBe('3/12')
    expect(tags('TRACKNUMBER=3/9', 'TRACKTOTAL=12').track).toBe('3/9')
    expect(tags('DISCNUMBER=2', 'DISCTOTAL=3').disc).toBe('2/3')
    expect(tags('DISCNUMBER=2', 'TOTALDISCS=3').disc).toBe('2/3')
  })

  it('joins repeated artists and genres', () => {
    expect(tags('ARTIST=Ezhel', 'ARTIST=Ceza').artist).toBe('Ezhel, Ceza')
    expect(tags('GENRE=Rock', 'GENRE=Metal').genre).toBe('Rock, Metal')
    expect(tags('TITLE=First', 'TITLE=Second').title).toBe('First')
  })

  it('prefers the track ReplayGain value over the album one', () => {
    expect(tags('REPLAYGAIN_ALBUM_GAIN=-3.00 dB', 'REPLAYGAIN_TRACK_GAIN=-7.10 dB').replayGain).toBe('-7.10 dB')
    expect(tags('REPLAYGAIN_ALBUM_GAIN=-3.00 dB').replayGain).toBe('-3.00 dB')
  })

  it('leaves out what is missing and blank', () => {
    expect(tags('TITLE=   ', 'ARTIST=')).toEqual({})
  })
})

describe('parseFlacPicture', () => {
  const picture = (mime: string, data: number[], kind = 3): Uint8Array =>
    Uint8Array.from([...w32be(kind), ...w32be(mime.length), ...text(mime), ...w32be(0), ...new Array<number>(16).fill(0), ...w32be(data.length), ...data])

  it('returns the mime type, the picture kind and where the image bytes are', () => {
    const block = picture('image/png', [1, 2, 3, 4, 5])
    const ref = parseFlacPicture(block)
    expect(ref).toMatchObject({ mime: 'image/png', kind: 3, length: 5 })
    expect([...block.subarray(ref?.start, (ref?.start ?? 0) + (ref?.length ?? 0))]).toEqual([1, 2, 3, 4, 5])
  })

  it('skips a description', () => {
    const body = Uint8Array.from([...w32be(3), ...w32be(10), ...text('image/jpeg'), ...w32be(4), ...text('Cove'), ...new Array<number>(16).fill(0), ...w32be(2), 7, 8])
    const ref = parseFlacPicture(body)
    expect(ref).toMatchObject({ mime: 'image/jpeg', length: 2 })
    expect([...body.subarray(ref?.start, (ref?.start ?? 0) + 2)]).toEqual([7, 8])
  })

  it('rejects a block that is truncated or whose image does not fit', () => {
    const block = picture('image/png', [1, 2, 3, 4, 5])
    expect(parseFlacPicture(block.slice(0, block.length - 1))).toBeNull()
    expect(parseFlacPicture(block.slice(0, 10))).toBeNull()
    expect(parseFlacPicture(new Uint8Array(0))).toBeNull()
  })

  it('rejects an implausible mime length', () => {
    expect(parseFlacPicture(Uint8Array.from([...w32be(3), ...w32be(0x7fffffff), 1, 2, 3, 4]))).toBeNull()
  })
})

describe('decodeBase64', () => {
  it('decodes standard base64 with and without padding', () => {
    expect([...(decodeBase64('AQID') ?? [])]).toEqual([1, 2, 3])
    expect([...(decodeBase64('AQI=') ?? [])]).toEqual([1, 2])
    expect([...(decodeBase64('AQI') ?? [])]).toEqual([1, 2])
  })

  it('returns null for text that is not base64 or is empty', () => {
    expect(decodeBase64('not base64!')).toBeNull()
    expect(decodeBase64('')).toBeNull()
  })
})
