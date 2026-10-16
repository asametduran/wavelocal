import { describe, expect, it } from 'vitest'
import { bytesSource } from '../source'
import { probeFlac } from './flac'
import { buildFlac } from '../../../test-utils/fixtures'
import { encodeFlac } from '../../../test-utils/flac-encoder'
import { buildRiff, countingSource, id3v2Blank } from '../../../test-utils/containers'

const probe = (bytes: Uint8Array) => probeFlac(bytesSource(bytes))
const PNG = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, ...Array.from({ length: 40 }, (_, i) => i)])

describe('probeFlac: stream properties', () => {
  it('reads rate, channels, bit depth and the exact duration from STREAMINFO', async () => {
    const r = await probe(buildFlac('tone-440'))
    expect(r?.format).toMatchObject({ container: 'flac', codec: 'flac', sampleRate: 44100, channels: 1, bitDepth: 16, lossless: true, vbr: false })
    expect(r?.duration).toBe(4)
    expect(r?.format.bitrate).toBeGreaterThan(0)
    expect(r?.format.bitrate).toBeLessThan(44100 * 16)
    expect(r?.tags).toEqual({})
    expect(r?.picture).toBeNull()
  })

  it('counts stereo', async () => {
    expect((await probe(buildFlac('stereo-split')))?.format.channels).toBe(2)
  })

  it('handles 24-bit audio at 96 kHz', async () => {
    const samples = Int32Array.from({ length: 96000 }, (_, i) => Math.round(Math.sin(i / 40) * 4_000_000))
    const r = await probe(encodeFlac([samples], { sampleRate: 96000, bitsPerSample: 24, subframe: 'verbatim' }))
    expect(r?.format).toMatchObject({ sampleRate: 96000, bitDepth: 24, channels: 1 })
    expect(r?.duration).toBe(1)
    expect(r?.format.bitrate).toBeGreaterThan(2_000_000)
  })

  it('works for a long file at a low rate', async () => {
    const r = await probe(buildFlac('long'))
    expect(r?.duration).toBe(30)
    expect(r?.format.sampleRate).toBe(8000)
  })

  it('finds the stream behind an ID3v2 tag', async () => {
    const r = await probe(buildFlac('tone-440', { id3v2: id3v2Blank(3000) }))
    expect(r?.duration).toBe(4)
  })

  it('has no duration when STREAMINFO does not know the sample count', async () => {
    const r = await probe(buildFlac('tone-440', { writeTotalSamples: false }))
    expect(r?.duration).toBeNull()
    expect(r?.format).toMatchObject({ sampleRate: 44100, channels: 1, bitDepth: 16 })
  })
})

describe('probeFlac: tags and artwork', () => {
  const comments = ['TITLE=Gece Yarısı', 'ARTIST=Şebnem Ferah', 'ALBUM=Aşk', 'ALBUMARTIST=Şebnem Ferah', 'DATE=2019', 'TRACKNUMBER=3', 'DISCNUMBER=1/2', 'GENRE=Pop', 'REPLAYGAIN_TRACK_GAIN=-6.50 dB']

  it('reads the Vorbis comments, including the fields jsmediatags does not expose', async () => {
    const r = await probe(buildFlac('tone-440', { vorbis: { vendor: 'test', comments } }))
    expect(r?.tags).toEqual({ title: 'Gece Yarısı', artist: 'Şebnem Ferah', album: 'Aşk', albumArtist: 'Şebnem Ferah', date: '2019', track: '3', disc: '1/2', genre: 'Pop', replayGain: '-6.50 dB' })
  })

  it('returns the cover art as a Blob with the right type and bytes', async () => {
    const r = await probe(buildFlac('tone-440', { vorbis: { vendor: 'test', comments }, picture: { mime: 'image/png', data: PNG } }))
    expect(r?.picture?.type).toBe('image/png')
    expect(r?.picture?.size).toBe(PNG.length)
    expect([...new Uint8Array((await r?.picture?.arrayBuffer()) ?? new ArrayBuffer(0))]).toEqual([...PNG])
  })

  it('skips artwork that is too large without reading it, and still reads the tags', async () => {
    const huge = new Uint8Array(9 * 1024 * 1024)
    const counted = countingSource(bytesSource(buildFlac('tone-440', { vorbis: { vendor: 'test', comments }, picture: { mime: 'image/jpeg', data: huge } })))
    const r = await probeFlac(counted)
    expect(r?.picture).toBeNull()
    expect(r?.tags.title).toBe('Gece Yarısı')
    expect(counted.bytes).toBeLessThan(64 * 1024)
  })
})

describe('probeFlac: not FLAC, damaged and cost', () => {
  it('returns null for other data', async () => {
    expect(await probe(buildRiff({ frames: 100 }))).toBeNull()
    expect(await probe(new Uint8Array(0))).toBeNull()
    expect(await probe(new Uint8Array(1000))).toBeNull()
  })

  it('returns null when STREAMINFO itself is cut off', async () => {
    expect(await probe(buildFlac('tone-440').slice(0, 20))).toBeNull()
  })

  it('does not read the audio frames', async () => {
    const counted = countingSource(bytesSource(buildFlac('long')))
    await probeFlac(counted)
    expect(counted.size).toBeGreaterThan(50_000)
    expect(counted.bytes).toBeLessThan(4096)
  })
})
