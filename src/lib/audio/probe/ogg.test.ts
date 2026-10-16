import { describe, expect, it } from 'vitest'
import { bytesSource } from '../source'
import { probeOgg } from './ogg'
import { buildFlac } from '../../../test-utils/fixtures'
import { buildOgg, cat, countingSource, oggPage, virtualSource, w32be } from '../../../test-utils/containers'

const probe = (bytes: Uint8Array) => probeOgg(bytesSource(bytes))
const text = (s: string): number[] => Array.from(new TextEncoder().encode(s))
const PNG = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, ...Array.from({ length: 60 }, (_, i) => i)])
const base64 = (bytes: Uint8Array): string => {
  let binary = ''
  for (let i = 0; i < bytes.length; i += 8192) binary += String.fromCharCode(...bytes.subarray(i, i + 8192))
  return btoa(binary)
}
/** A FLAC PICTURE block, which is what an Ogg stream carries base64-encoded in METADATA_BLOCK_PICTURE. */
const pictureBlock = (mime: string, data: Uint8Array, kind = 3): Uint8Array => Uint8Array.from([...w32be(kind), ...w32be(mime.length), ...text(mime), ...w32be(0), ...new Array<number>(16).fill(0), ...w32be(data.length), ...data])

describe('probeOgg: stream properties', () => {
  it('reads a Vorbis stream: rate, channels, nominal bitrate, and the duration from the last granule position', async () => {
    const r = await probe(buildOgg({ codec: 'vorbis', seconds: 12.5, sampleRate: 44100, channels: 2, nominalBitrate: 160000 }))
    expect(r?.format).toMatchObject({ container: 'ogg', codec: 'vorbis', sampleRate: 44100, channels: 2, bitrate: 160000, lossless: false })
    expect(r?.duration).toBeCloseTo(12.5, 4)
  })

  it('works out a Vorbis bitrate from the file when the header does not give one', async () => {
    const r = await probe(buildOgg({ codec: 'vorbis', seconds: 4, nominalBitrate: 0 }))
    expect(r?.format.bitrate).toBeGreaterThan(0)
  })

  it('reads an Opus stream: always 48 kHz, minus the pre-skip', async () => {
    const r = await probe(buildOgg({ codec: 'opus', seconds: 30, preSkip: 312, sampleRate: 44100, channels: 1 }))
    expect(r?.format).toMatchObject({ container: 'ogg', codec: 'opus', sampleRate: 48000, channels: 1, lossless: false })
    expect(r?.duration).toBeCloseTo(30, 4)
    expect(r?.format.bitrate).toBeGreaterThan(0)
  })

  it('uses an earlier page when the last one has no granule position', async () => {
    for (const codec of ['vorbis', 'opus'] as const) {
      const r = await probe(buildOgg({ codec, seconds: 8, unsetFinalGranule: true }))
      expect(r?.duration).toBeCloseTo(8, 4)
    }
  })

  it('ignores junk after the last page', async () => {
    const r = await probe(buildOgg({ codec: 'vorbis', seconds: 6, trailing: 5000 }))
    expect(r?.duration).toBeCloseTo(6, 4)
  })

  it('reports the length of what is really there when the file is cut short', async () => {
    const whole = buildOgg({ codec: 'vorbis', seconds: 8, audioPages: 4 })
    const r = await probe(whole.slice(0, whole.length - 30)) // the final page loses its tail
    expect(r?.duration).toBeCloseTo(6, 3) // three of four equal pages
  })
})

describe('probeOgg: tags and artwork', () => {
  const comments = ['TITLE=Gece Yarısı', 'ARTIST=Şebnem Ferah', 'ALBUM=Aşk', 'ALBUMARTIST=Şebnem Ferah', 'DATE=2019-05-04', 'TRACKNUMBER=3', 'TRACKTOTAL=12', 'GENRE=Pop', 'REPLAYGAIN_TRACK_GAIN=-6.50 dB']
  const expected = { title: 'Gece Yarısı', artist: 'Şebnem Ferah', album: 'Aşk', albumArtist: 'Şebnem Ferah', date: '2019-05-04', track: '3/12', genre: 'Pop', replayGain: '-6.50 dB' }

  it.each(['vorbis', 'opus'] as const)('reads %s comments, including the fields jsmediatags cannot see', async (codec) => {
    const r = await probe(buildOgg({ codec, seconds: 3, comments }))
    expect(r?.tags).toEqual(expected)
    expect(r?.picture).toBeNull()
  })

  it('decodes cover art from METADATA_BLOCK_PICTURE', async () => {
    const r = await probe(buildOgg({ codec: 'opus', seconds: 3, comments: [...comments, `METADATA_BLOCK_PICTURE=${base64(pictureBlock('image/png', PNG))}`] }))
    expect(r?.picture?.type).toBe('image/png')
    expect([...new Uint8Array((await r?.picture?.arrayBuffer()) ?? new ArrayBuffer(0))]).toEqual([...PNG])
  })

  it('prefers the front cover over another picture', async () => {
    const back = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 1, 1, 1])
    const r = await probe(
      buildOgg({
        codec: 'vorbis',
        seconds: 3,
        comments: [`METADATA_BLOCK_PICTURE=${base64(pictureBlock('image/png', back, 4))}`, `METADATA_BLOCK_PICTURE=${base64(pictureBlock('image/png', PNG, 3))}`],
      }),
    )
    expect(r?.picture?.size).toBe(PNG.length)
  })

  it('reads a comment header that spans many pages (big cover art), and still finds the duration', async () => {
    const big = new Uint8Array(200_000).fill(0x42)
    big.set(PNG)
    const bytes = buildOgg({ codec: 'vorbis', seconds: 5, comments: [...comments, `METADATA_BLOCK_PICTURE=${base64(pictureBlock('image/png', big))}`] })
    const r = await probe(bytes)
    expect(bytes.length).toBeGreaterThan(260_000)
    expect(r?.tags.title).toBe('Gece Yarısı')
    expect(r?.picture?.size).toBe(big.length)
    expect(r?.duration).toBeCloseTo(5, 4)
  })
})

describe('probeOgg: not an Ogg Vorbis/Opus stream', () => {
  it('returns null for other data', async () => {
    expect(await probe(new Uint8Array(0))).toBeNull()
    expect(await probe(new Uint8Array(500))).toBeNull()
    expect(await probe(buildFlac('tone-440'))).toBeNull()
  })

  it('returns null for an Ogg stream of another codec', async () => {
    const speex = oggPage({ packets: [Uint8Array.from([...text('Speex   '), ...new Array<number>(72).fill(0)])], granule: 0, headerType: 2 })
    expect(await probe(speex)).toBeNull()
    const oggFlac = oggPage({ packets: [Uint8Array.from([0x7f, ...text('FLAC'), 1, 0, 0, 1, ...text('fLaC'), ...new Array<number>(34).fill(0)])], granule: 0, headerType: 2 })
    expect(await probe(oggFlac)).toBeNull()
  })

  it('returns null when the first page is cut off', async () => {
    expect(await probe(buildOgg({ codec: 'vorbis', seconds: 2 }).slice(0, 20))).toBeNull()
  })

  it('has no duration when no page after the headers survives', async () => {
    const head = oggPage({ packets: [Uint8Array.from([1, ...text('vorbis'), 0, 0, 0, 0, 2, 0x44, 0xac, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0xb8, 1])], granule: 0, headerType: 2 })
    const r = await probe(head)
    expect(r?.format).toMatchObject({ codec: 'vorbis', sampleRate: 44100, channels: 2 })
    expect(r?.duration).toBeNull()
  })
})

describe('probeOgg: cost', () => {
  it('reads the headers and the last 64 KB of a huge file, nothing in between', async () => {
    const whole = buildOgg({ codec: 'vorbis', seconds: 90, comments: ['TITLE=Long one'] })
    const lastPage = 120 + 27 + 1 // one page of silence: header, one segment, 120 bytes
    const head = whole.slice(0, whole.length - lastPage)
    const tail = whole.slice(whole.length - lastPage)
    const counted = countingSource(virtualSource(200 * 1024 * 1024, head, tail))
    const r = await probeOgg(counted)
    expect(r?.duration).toBeCloseTo(90, 3)
    expect(r?.tags.title).toBe('Long one')
    expect(counted.bytes).toBeLessThan(100 * 1024)
    expect(counted.reads).toBeLessThan(12)
    expect(cat(head, tail).length).toBe(whole.length)
  })
})
